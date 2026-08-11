"""Shared teacher-review persistence used by both the web API and Feishu cards.

The web endpoint (``main.review_response``) and the card callback
(``feishu.routes.feishu_card``) must produce identical DB effects: calibration
records when the teacher changes AI scores, DimensionTag use-count updates, and
the ``teacher_reviewed`` / ``processing_status`` flags. Keeping that logic in
one place avoids the two paths drifting apart.
"""

from __future__ import annotations

from typing import Any, Optional

from sqlalchemy.orm import Session

from database import CalibrationRecord, DimensionTag
from grading.ratings import normalize_dimension_scores


def sync_tags_to_library(
    db: Session, course_id: int, tag_names: list[str], source: str = "teacher"
) -> None:
    """Ensure each tag name exists in DimensionTag and increment use_count."""
    for name in tag_names:
        if not name or not name.strip():
            continue
        tag = (
            db.query(DimensionTag)
            .filter(DimensionTag.course_id == course_id, DimensionTag.name == name)
            .first()
        )
        if tag:
            tag.use_count = (tag.use_count or 0) + 1
        else:
            db.add(
                DimensionTag(
                    course_id=course_id,
                    name=name,
                    source="ai_new" if source == "ai" else "teacher",
                    use_count=1,
                )
            )


def apply_teacher_review(
    db: Session,
    resp: Any,
    *,
    dimension_scores: Optional[dict[str, str]] = None,
    confidence_override: Optional[str] = None,
    tags: Optional[list[str]] = None,
    note: str = "",
    rating: str = "",
) -> bool:
    """Persist a teacher review on a StudentResponse; return True if a
    calibration record was created (i.e. the teacher changed AI scores).

    Caller is responsible for ``db.commit()`` (and any background Bitable sync).
    """
    created = False

    # 统一维度 key：无论 AI 返回中文维度名还是旧 key，落库前归一化为五维度标准 key。
    dimension_scores = normalize_dimension_scores(dimension_scores or {}) or None
    ai_scores = normalize_dimension_scores(resp.ai_dimension_scores or {}) or None

    # Calibration record only when the teacher actually modified AI scores.
    if dimension_scores and ai_scores:
        modifications = []
        for dim, new_rating in dimension_scores.items():
            old_rating = ai_scores.get(dim)
            if old_rating and old_rating != new_rating:
                modifications.append(
                    {
                        "dimension": dim,
                        "from_rating": old_rating,
                        "to_rating": new_rating,
                        "reason": note or "",
                    }
                )
        if modifications:
            db.add(
                CalibrationRecord(
                    response_id=resp.id,
                    teacher_id="default",
                    ai_original_scores=ai_scores,
                    teacher_final_scores=dimension_scores,
                    modifications=modifications,
                    note=note,
                )
            )
            created = True

    resp.teacher_dimension_scores = dimension_scores
    resp.teacher_confidence_override = confidence_override

    # Diff teacher-selected tags against the previous set.
    old_tags = set(resp.teacher_tags or [])
    new_tags = set(tags or [])
    course_id = resp.topic.course_id

    # Removed tags -> decrement use_count.
    for name in old_tags - new_tags:
        tag = (
            db.query(DimensionTag)
            .filter(DimensionTag.course_id == course_id, DimensionTag.name == name)
            .first()
        )
        if tag:
            tag.use_count = max((tag.use_count or 0) - 1, 0)

    resp.teacher_tags = tags if tags is not None else []
    resp.teacher_note = note or ""
    resp.teacher_reviewed = True
    resp.teacher_rating = rating or ""
    resp.processing_status = "processed"

    # Newly selected tags -> find-or-create + increment.
    sync_tags_to_library(db, course_id, list(new_tags - old_tags), source="teacher")
    return created
