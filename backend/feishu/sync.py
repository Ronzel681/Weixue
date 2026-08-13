"""Two-way sync between local assessment data and Feishu Bitable (多维表格).

Design:
- Local SQLite stays the source of truth for content/AI fields; Bitable is
  the display & review surface. Push (sync_course / sync_response) writes
  local state up; pull (pull_course) imports teacher-owned edits back.
- ``FeishuBinding`` stores the local entity -> remote record_id mapping so
  that repeated syncs use batch_update instead of creating duplicates, and
  keeps a ``last_synced_hash`` snapshot of the teacher-owned fields so pull
  can tell real remote edits apart from echoes of our own pushes.
- Field ownership (responses table): backend owns 原始/清洗文本、AI* 列、
  来源、更新时间; teachers own 教师评分 / 教师标签 / 教师批注 / 状态. Pull
  only ever reads the teacher-owned columns, and only moves 状态 towards
  教师已审 (never un-reviews). Remote rows without a local binding are
  reported as unmatched, never auto-created.
- Every sync is guarded: missing credentials or API errors never break the
  assessment flow. Failures are reported in the returned summary and are
  visible via GET /api/feishu/bitable/status.

Feishu console prerequisites (build these tables before first sync):
- 4 tables named courses / topics / students / responses with the field
  schemas from feishu/bitable.py.
- Single-select options that must exist before write:
  * 来源: 手动录入 / 音频转写
  * 认知梯段: 基础层 / 发展层 / 进阶层
  * 类型: 两难 / 事实观点 / 因果
  * AI置信度: 高 / 低 / 不确定
  * 状态: 待评估 / AI已评 / 教师已审
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from database import (
    Course,
    FeishuBinding,
    PrepPlan,
    Student,
    StudentResponse,
)

from .bitable import BitableService
from .client import FeishuClient, FeishuConfig

TABLE_KEYS = ("courses", "topics", "students", "responses", "prep_plans")
ENTITY_TYPE_BY_TABLE = {
    "courses": "course",
    "topics": "topic",
    "students": "student",
    "responses": "response",
    "prep_plans": "prep_plan",
}

_SOURCE_LABELS = {
    "manual": "手动录入",
    "teacher": "手动录入",
    "asr": "音频转写",
    "audio": "音频转写",
    "student_device": "音频转写",
}
_TIER_LABELS = {"basic": "基础层", "developing": "发展层", "advancing": "进阶层"}
_TYPE_LABELS = {"dilemma": "两难", "fact_opinion": "事实观点", "causal": "因果"}
_CONFIDENCE_LABELS = {
    "certain_good": "高",
    "certain_weak": "低",
    "uncertain": "不确定",
}
_STATUS_LABELS = {"pending": "待评估", "assessed": "AI已评", "reviewed": "教师已审"}

# Teacher-owned columns per table: the only fields pull() reads back. Backend
# pushes them too, but remote changes between pushes are treated as teacher
# edits (detected via FeishuBinding.last_synced_hash).
TEACHER_FIELDS_BY_TABLE = {
    "responses": ("教师评分", "教师标签", "教师批注", "状态"),
    "students": ("评语草稿",),
}


# ── Pure record builders (testable without a Feishu connection) ─────────

def _single(value: str) -> str:
    # Verified against live API (2026-08): single-select fields accept the
    # option name as a plain string; {"text": ...} fails with
    # SingleSelectFieldConvFail.
    return str(value)


def _multi(values) -> list[str]:
    # Multi-select fields take a plain array of option-name strings.
    return [str(v) for v in (values or []) if v]


def _ms(dt) -> int:
    if not dt:
        dt = datetime.utcnow()
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


_DIM_LABELS = {
    "position": "立意", "material": "选材", "structure": "结构",
    "language": "语言", "perspective": "视角",
}
_DIM_LABELS_INV = {v: k for k, v in _DIM_LABELS.items()}


# ── Pull-side helpers (pure, testable without a Feishu connection) ──────

def _field_str(value) -> str:
    """Read a remote field value back as a plain string, tolerating both the
    plain-string shape we write and object/segment shapes some field types
    return on read."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        return str(value.get("text") or "").strip()
    if isinstance(value, list):
        return "".join(_field_str(v) for v in value).strip()
    return str(value)


def _field_list(value) -> list[str]:
    """Read a multi-select field back as a list of option-name strings."""
    if value is None:
        return []
    if isinstance(value, list):
        return [s for s in (_field_str(v) for v in value) if s]
    text = _field_str(value)
    return [text] if text else []


def teacher_fields_hash(fields: dict, keys: tuple) -> str:
    """Stable hash of the teacher-owned subset of a record's fields.

    Both sides normalize through _field_str/_field_list before hashing, so a
    push followed by a pull of unchanged remote data hashes identically
    (echo suppression).
    """
    subset = {}
    for key in keys:
        raw = fields.get(key)
        if key in ("教师标签",):
            subset[key] = _field_list(raw)
        else:
            subset[key] = _field_str(raw)
    payload = json.dumps(subset, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _parse_score_summary(text: str) -> dict:
    """Parse a pushed 教师评分 summary like '立意:A；选材:B+' back into
    {'position': 'A', 'material': 'B+'}. Unknown labels are kept verbatim;
    malformed segments are skipped."""
    scores: dict = {}
    for part in (text or "").replace(";", "；").split("；"):
        part = part.strip()
        if not part:
            continue
        for sep in (":", "："):
            if sep in part:
                label, _, grade = part.partition(sep)
                label, grade = label.strip(), grade.strip()
                if label and grade:
                    scores[_DIM_LABELS_INV.get(label, label)] = grade
                break
    return scores


def _format_scores(scores) -> str:
    """Format dimension scores for Bitable, using enterprise five-dimension labels."""
    if not scores:
        return ""
    return "；".join(f"{_DIM_LABELS.get(k, k)}:{v}" for k, v in scores.items())


def build_course_record(course) -> dict:
    return {
        "fields": {
            "班级名": course.class_name,
            "年级": course.grade_level,
            "创建时间": _ms(course.created_at),
        }
    }


def build_topic_record(topic) -> dict:
    return {
        "fields": {
            "标题": topic.title,
            "类型": _single(_TYPE_LABELS.get(topic.topic_type, topic.topic_type or "")),
            "认知梯段": _single(
                _TIER_LABELS.get(topic.cognitive_tier or "", topic.cognitive_tier or "")
            ),
            "引导材料": topic.stimulus_material or "",
            "参考论据": "\n".join(topic.reference_arguments or []),
            "顺序": topic.order or 0,
        }
    }


def build_student_record(student) -> dict:
    return {
        "fields": {
            "姓名": student.name,
            "年级": student.grade,
            "认知梯段": _single(_TIER_LABELS.get(student.cognitive_tier, student.cognitive_tier)),
            "班级": student.course.class_name if student.course else "",
            "评语草稿": student.comment_draft or "",
        }
    }


def build_response_record(response, student, topic) -> dict:
    if response.teacher_reviewed:
        status = _STATUS_LABELS["reviewed"]
    elif response.ai_dimension_scores:
        status = _STATUS_LABELS["assessed"]
    else:
        status = _STATUS_LABELS["pending"]
    source = _SOURCE_LABELS.get(response.source or "", "手动录入")
    confidence = _CONFIDENCE_LABELS.get(
        response.ai_confidence or "", response.ai_confidence or "不确定"
    )
    return {
        "fields": {
            "学生": student.name,
            "辩题": topic.title,
            "来源": _single(source),
            "原始文本": response.raw_text or "",
            "清洗文本": response.cleaned_text or "",
            "AI评分摘要": _format_scores(response.ai_dimension_scores),
            "AI置信度": _single(confidence),
            "AI建议标签": _multi(response.ai_suggested_tags),
            "加分项": _multi(response.ai_bonus_flags),
            "教师评分": _format_scores(response.teacher_dimension_scores or {}),
            "教师标签": _multi(response.teacher_tags),
            "教师批注": response.teacher_note or "",
            "状态": _single(status),
            "更新时间": _ms(datetime.utcnow()),
        }
    }


def build_prep_plan_record(plan, course, topic_map: dict) -> dict:
    """Bitable row for one course's lesson-prep plan."""
    order_lines = []
    note_lines = []
    for idx, tid in enumerate(plan.lesson_plan or [], start=1):
        topic = topic_map.get(tid)
        title = topic.title if topic else f"辩题#{tid}"
        order_lines.append(f"{idx}. {title}")
        note = (plan.notes or {}).get(str(tid), "")
        if note:
            note_lines.append(f"{idx}. {title}：{note}")
    summary = getattr(plan, "summary", None) or {}
    summary_text = "\n".join(
        x for x in (
            str(summary.get("overview") or ""),
            str(summary.get("problems") or ""),
        ) if x
    )
    return {
        "fields": {
            "班级": course.class_name,
            "计划状态": _single("已确认" if plan.confirmed else "草稿"),
            "讲评顺序": "\n".join(order_lines),
            "备注": "\n".join(note_lines),
            "AI总结": summary_text,
            "更新时间": _ms(plan.updated_at or datetime.utcnow()),
        }
    }


# ── Configuration & status (no secrets) ─────────────────────────────────

def bitable_is_configured(config: FeishuConfig) -> bool:
    table_ids = config.bitable_table_ids or {}
    return bool(config.bitable_app_token and table_ids.get("responses"))


def bitable_status(config: FeishuConfig) -> dict[str, Any]:
    table_ids = config.bitable_table_ids or {}
    return {
        "mode": "ready" if bitable_is_configured(config) else "deferred",
        "configured": bool(config.bitable_app_token),
        "app_token": (
            config.bitable_app_token[:8] + "..." if config.bitable_app_token else ""
        ),
        "table_ids": {k: bool(v) for k, v in table_ids.items()},
    }


# ── Sync service ────────────────────────────────────────────────────────

class BitableSyncer:
    def __init__(
        self,
        client: FeishuClient,
        config: Optional[FeishuConfig] = None,
    ) -> None:
        self.client = client
        self.config = config or client.config
        self.service = BitableService(client)

    @property
    def available(self) -> bool:
        return bitable_is_configured(self.config)

    def _table_id(self, key: str) -> str:
        return (self.config.bitable_table_ids or {}).get(key, "")

    def _snapshot_binding(
        self, db: Session, binding: FeishuBinding, table_key: str, record: dict
    ) -> None:
        """Store the teacher-field hash we just pushed, so a later pull treats
        this exact remote state as 'already synced' (echo suppression)."""
        keys = TEACHER_FIELDS_BY_TABLE.get(table_key)
        if not keys:
            return
        binding.last_synced_hash = teacher_fields_hash(record.get("fields") or {}, keys)
        binding.last_synced_at = datetime.utcnow()
        db.commit()

    async def _upsert(
        self,
        db: Session,
        table_key: str,
        entity_type: str,
        entity_id: int,
        record: dict,
    ) -> dict:
        table_id = self._table_id(table_key)
        if not table_id:
            return {"status": "skipped", "reason": f"table {table_key} not configured"}

        binding = (
            db.query(FeishuBinding)
            .filter(
                FeishuBinding.entity_type == entity_type,
                FeishuBinding.entity_id == entity_id,
                FeishuBinding.table_key == table_key,
            )
            .first()
        )
        try:
            if binding and binding.remote_record_id:
                await self.service.batch_update_records(
                    table_id,
                    [{"record_id": binding.remote_record_id, **record}],
                )
                self._snapshot_binding(db, binding, table_key, record)
                return {"status": "updated"}

            data = await self.service.batch_create_records(table_id, [record])
            records = (data or {}).get("records") or []
            remote_id = str(records[0].get("record_id") or "") if records else ""
            if not remote_id:
                return {"status": "error", "reason": "batch_create returned no record_id"}
            if binding is None:
                binding = FeishuBinding(
                    entity_type=entity_type,
                    entity_id=entity_id,
                    table_key=table_key,
                )
                db.add(binding)
            binding.remote_record_id = remote_id
            db.commit()
            self._snapshot_binding(db, binding, table_key, record)
            return {"status": "created"}
        except Exception as exc:  # noqa: BLE001 - sync must never break the main flow
            db.rollback()
            return {"status": "error", "reason": str(exc)}

    async def _sync_one(
        self,
        db: Session,
        table_key: str,
        entity,
        record: dict,
        summary: dict,
    ) -> None:
        entity_type = ENTITY_TYPE_BY_TABLE[table_key]
        result = await self._upsert(
            db, table_key, entity_type, entity.id, record
        )
        counters = summary["tables"][table_key]
        status = result["status"]
        if status in counters:
            counters[status] += 1
        else:
            counters["errors"] += 1

    async def sync_course(self, db: Session, course_id: int) -> dict:
        if not self.available:
            return {"configured": False, "mode": "deferred", "tables": {}}
        summary = {
            "configured": True,
            "tables": {
                key: {"created": 0, "updated": 0, "errors": 0, "skipped": 0}
                for key in TABLE_KEYS
            },
        }
        course = db.get(Course, course_id)
        if not course:
            return {"configured": True, "error": "course not found"}

        await self._sync_one(db, "courses", course, build_course_record(course), summary)
        for topic in course.topics:
            await self._sync_one(db, "topics", topic, build_topic_record(topic), summary)
        for student in course.students:
            await self._sync_one(db, "students", student, build_student_record(student), summary)
        responses = (
            db.query(StudentResponse)
            .join(Student, StudentResponse.student_id == Student.id)
            .filter(Student.course_id == course_id)
            .all()
        )
        for resp in responses:
            await self._sync_one(
                db,
                "responses",
                resp,
                build_response_record(resp, resp.student, resp.topic),
                summary,
            )
        plan = db.query(PrepPlan).filter(PrepPlan.course_id == course_id).first()
        if plan:
            topic_map = {t.id: t for t in course.topics}
            await self._sync_one(
                db,
                "prep_plans",
                plan,
                build_prep_plan_record(plan, course, topic_map),
                summary,
            )
        return summary

    async def sync_prep_plan(self, db: Session, course_id: int) -> dict:
        """Sync only the course's lesson-prep plan (after save/confirm)."""
        if not self.available:
            return {"configured": False, "mode": "deferred", "tables": {}}
        course = db.get(Course, course_id)
        if not course:
            return {"configured": True, "error": "course not found"}
        plan = db.query(PrepPlan).filter(PrepPlan.course_id == course_id).first()
        if not plan:
            return {"configured": True, "status": "skipped", "reason": "no plan"}
        summary = {
            "configured": True,
            "tables": {
                "prep_plans": {"created": 0, "updated": 0, "errors": 0, "skipped": 0}
            },
        }
        topic_map = {t.id: t for t in course.topics}
        await self._sync_one(
            db,
            "prep_plans",
            plan,
            build_prep_plan_record(plan, course, topic_map),
            summary,
        )
        return summary

    async def sync_response(self, db: Session, response_id: int) -> dict:
        if not self.available:
            return {"configured": False, "mode": "deferred", "tables": {}}
        resp = db.get(StudentResponse, response_id)
        if not resp:
            return {"configured": True, "error": "response not found"}
        summary = {
            "configured": True,
            "tables": {
                "responses": {"created": 0, "updated": 0, "errors": 0, "skipped": 0}
            },
        }
        await self._sync_one(
            db,
            "responses",
            resp,
            build_response_record(resp, resp.student, resp.topic),
            summary,
        )
        return summary

    # ── Pull: import teacher edits from Bitable back into the local DB ──

    async def _iter_remote_records(self, table_id: str):
        """Yield all records of a table, following search pagination."""
        page_token = ""
        while True:
            data = await self.service.search_records(
                table_id, page_size=500, page_token=page_token
            )
            data = data or {}
            for item in data.get("items") or []:
                yield item
            if not data.get("has_more"):
                break
            page_token = data.get("page_token") or ""
            if not page_token:
                break

    async def _pull_responses(self, db: Session, course_id: int, summary: dict) -> None:
        table_id = self._table_id("responses")
        keys = TEACHER_FIELDS_BY_TABLE["responses"]
        counters = summary["tables"]["responses"]

        responses = (
            db.query(StudentResponse)
            .join(Student, StudentResponse.student_id == Student.id)
            .filter(Student.course_id == course_id)
            .all()
        )
        if not responses:
            return
        by_entity = {r.id: r for r in responses}
        bindings = (
            db.query(FeishuBinding)
            .filter(
                FeishuBinding.entity_type == "response",
                FeishuBinding.table_key == "responses",
                FeishuBinding.entity_id.in_(list(by_entity)),
            )
            .all()
        )
        remote_map = {b.remote_record_id: (b, by_entity[b.entity_id]) for b in bindings}

        async for record in self._iter_remote_records(table_id):
            remote_id = str(record.get("record_id") or "")
            fields = record.get("fields") or {}
            match = remote_map.get(remote_id)
            if match is None:
                summary["unmatched_remote"] += 1
                continue
            binding, resp = match
            counters["checked"] += 1
            normalized = {
                "教师评分": _field_str(fields.get("教师评分")),
                "教师标签": _field_list(fields.get("教师标签")),
                "教师批注": _field_str(fields.get("教师批注")),
                "状态": _field_str(fields.get("状态")),
            }
            remote_hash = teacher_fields_hash(normalized, keys)
            if not (binding.last_synced_hash or ""):
                # Pre-two-way binding with no baseline: adopt the current
                # remote state as the baseline instead of applying it, so an
                # empty/stale remote can't wipe locally-entered reviews.
                binding.last_synced_hash = remote_hash
                binding.last_synced_at = datetime.utcnow()
                counters["unchanged"] += 1
                continue
            if remote_hash == binding.last_synced_hash:
                counters["unchanged"] += 1
                continue
            resp.teacher_note = normalized["教师批注"]
            resp.teacher_tags = normalized["教师标签"]
            resp.teacher_dimension_scores = _parse_score_summary(normalized["教师评分"])
            # Safe direction only: a remote 状态 can move a response towards
            # 教师已审 but never un-review an already-reviewed response.
            if normalized["状态"] == _STATUS_LABELS["reviewed"]:
                resp.teacher_reviewed = True
            binding.last_synced_hash = remote_hash
            binding.last_synced_at = datetime.utcnow()
            counters["updated"] += 1

    async def _pull_students(self, db: Session, course_id: int, summary: dict) -> None:
        table_id = self._table_id("students")
        keys = TEACHER_FIELDS_BY_TABLE["students"]
        counters = summary["tables"]["students"]

        students = (
            db.query(Student).filter(Student.course_id == course_id).all()
        )
        if not students:
            return
        by_entity = {s.id: s for s in students}
        bindings = (
            db.query(FeishuBinding)
            .filter(
                FeishuBinding.entity_type == "student",
                FeishuBinding.table_key == "students",
                FeishuBinding.entity_id.in_(list(by_entity)),
            )
            .all()
        )
        remote_map = {b.remote_record_id: (b, by_entity[b.entity_id]) for b in bindings}

        async for record in self._iter_remote_records(table_id):
            remote_id = str(record.get("record_id") or "")
            fields = record.get("fields") or {}
            match = remote_map.get(remote_id)
            if match is None:
                summary["unmatched_remote"] += 1
                continue
            binding, student = match
            counters["checked"] += 1
            normalized = {"评语草稿": _field_str(fields.get("评语草稿"))}
            remote_hash = teacher_fields_hash(normalized, keys)
            if not (binding.last_synced_hash or ""):
                binding.last_synced_hash = remote_hash
                binding.last_synced_at = datetime.utcnow()
                counters["unchanged"] += 1
                continue
            if remote_hash == binding.last_synced_hash:
                counters["unchanged"] += 1
                continue
            remote_draft = normalized["评语草稿"]
            if remote_draft != (student.comment_draft or ""):
                student.comment_draft = remote_draft
                student.comment_delivery_status = "not_sent"
                student.comment_delivery_hash = ""
                student.comment_delivery_error = ""
                student.comment_delivered_at = None
            binding.last_synced_hash = remote_hash
            binding.last_synced_at = datetime.utcnow()
            counters["updated"] += 1

    async def pull_course(self, db: Session, course_id: int) -> dict:
        """Pull teacher-owned edits (教师评分/标签/批注/状态, 评语草稿) from
        Bitable back into the local DB for one course. Manual trigger only;
        remote rows without a local binding are counted, never auto-created."""
        if not self.available:
            return {"configured": False, "mode": "deferred", "tables": {}}
        course = db.get(Course, course_id)
        if not course:
            return {"configured": True, "error": "course not found"}
        summary = {
            "configured": True,
            "direction": "pull",
            "tables": {
                key: {"checked": 0, "updated": 0, "unchanged": 0}
                for key in ("responses", "students")
            },
            "unmatched_remote": 0,
        }
        try:
            if self._table_id("responses"):
                await self._pull_responses(db, course_id, summary)
            if self._table_id("students"):
                await self._pull_students(db, course_id, summary)
            db.commit()
        except Exception as exc:  # noqa: BLE001 - pull must never break the app
            db.rollback()
            summary["error"] = str(exc)
        return summary
