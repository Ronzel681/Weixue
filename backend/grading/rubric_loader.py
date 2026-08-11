"""Rubric loader: cognitive-tier-aware prompt assembly.

Loads RubricTemplate from database by cognitive_tier and builds
complete evaluation prompts with dimension definitions, weights,
negative indicators, and optional teacher calibration examples.
"""

from typing import Optional
from sqlalchemy.orm import Session
from database import RubricTemplate, CalibrationRecord, StudentResponse, Student, get_cognitive_tier
from companion import build_dialogue_block


class RubricLoader:
    """Loads and assembles cognitive-tier-specific evaluation prompts."""

    def __init__(self, db: Session):
        self.db = db
        self._cache: dict[str, RubricTemplate] = {}

    def get_template(self, cognitive_tier: str) -> Optional[RubricTemplate]:
        """Load RubricTemplate by cognitive_tier, with in-memory caching."""
        if cognitive_tier in self._cache:
            return self._cache[cognitive_tier]

        template = (
            self.db.query(RubricTemplate)
            .filter(RubricTemplate.cognitive_tier == cognitive_tier)
            .first()
        )
        if template:
            self._cache[cognitive_tier] = template
        return template

    def build_system_prompt(
        self,
        cognitive_tier: str,
        calibration_records: list[CalibrationRecord] | None = None,
    ) -> str:
        """Build the complete system prompt for a given cognitive tier.

        Args:
            cognitive_tier: basic / developing / advancing
            calibration_records: optional list of teacher calibration records
                to inject as few-shot examples

        Returns:
            Complete system prompt string for the LLM evaluator.
        """
        template = self.get_template(cognitive_tier)
        if not template:
            return self._fallback_prompt(cognitive_tier)

        prompt = template.prompt_template

        # Inject dimension definitions
        definitions_block = self._build_definitions_block(
            template.active_dimensions,
            template.rubric_definitions,
            template.dimension_weights,
        )
        prompt = prompt.replace("{DIMENSION_DEFINITIONS}", definitions_block)

        # Inject negative indicators
        negatives_block = self._build_negatives_block(template.negative_indicators)
        prompt = prompt.replace("{NEGATIVE_INDICATORS}", negatives_block)

        # Inject calibration examples if available
        if calibration_records:
            calibration_block = self._build_calibration_block(calibration_records)
            prompt = prompt.replace("{CALIBRATION_EXAMPLES}", calibration_block)
        else:
            prompt = prompt.replace("{CALIBRATION_EXAMPLES}", "")

        # Enterprise-alignment reminder (negative list + tier focus + tone)
        prompt += (
            "\n\n【企业评分口径提醒】\n"
            "- 评估聚焦底层逻辑：观点是否清楚、有无具体事实/例子支撑、条理是否合理、"
            "用词是否符合语境、是否多角度换位思考。\n"
            "- 明确不评：流利度、表达漂亮与否、好词好句、引经据典。\n"
            "- 低年级（1-3 年级）重点看\"敢说、说清楚\"（观点表达完整性）；"
            "高年级重点看逻辑论证严谨度（理由充分、反驳有力）。\n"
            "- 评语基调：肯定式、发现闪光点，避免应试式纠错口吻。\n"
        )

        # 输出格式硬性要求（防止模型截断/字面换行导致 JSON 解析失败）
        prompt += (
            "\n\n【输出格式硬性要求】\n"
            "- 整个回答只输出一个 JSON 对象，不要 Markdown 代码块，不要前后说明文字。\n"
            "- 字符串内的换行用 \\n 转义，不要输出字面换行。\n"
        )

        return prompt

    def build_user_prompt(
        self,
        topic_title: str,
        topic_type: str,
        stimulus_material: str,
        reference_arguments: list[str],
        student_text: str,
        student_grade: int,
        dialogue_turns: list | None = None,
    ) -> str:
        """Build the user prompt for a specific student response.

        Args:
            topic_title: the debate question
            topic_type: dilemma / fact_opinion / causal
            stimulus_material: any provided context material
            reference_arguments: list of reference pro/con arguments
            student_text: the student's response (cleaned or raw)
            student_grade: student's grade (1-7)

        Returns:
            User prompt string.
        """
        parts = [
            f"思辨主题：{topic_title}",
            f"议题类型：{self._topic_type_label(topic_type)}",
            f"学生年级：{student_grade}年级",
        ]

        if stimulus_material:
            parts.append(f"引导材料：\n{stimulus_material}")

        if reference_arguments:
            args_str = "\n".join(f"  - {a}" for a in reference_arguments)
            parts.append(f"参考论据库：\n{args_str}")

        if dialogue_turns:
            block = build_dialogue_block(dialogue_turns)
            if block:
                parts.append(block)

        parts.append(f"\n学生作答：\n{student_text}")
        if dialogue_turns:
            parts.append(
                "\n说明：学生的作答是“初始口述 + 追问后的多轮补充”（见上方对话记录）。"
                "请把它当作一个完整的思辨过程来评估：初始表达与每一轮补充都计入维度评分，"
                "并关注学生在追问后是否有提升，而不是只按最后一段判断。"
            )
        parts.append("\n请按上述系统指令中的评估维度逐一分析该学生的作答。")

        return "\n\n".join(parts)

    def get_calibration_records(
        self,
        teacher_id: str = "default",
        cognitive_tier: str | None = None,
        limit: int = 5,
    ) -> list[CalibrationRecord]:
        """Retrieve recent teacher calibration records for few-shot injection.

        In a production system, this would use semantic similarity search.
        For the demo, we filter by cognitive_tier (via the student's grade)
        and return the most recent records.
        """
        query = (
            self.db.query(CalibrationRecord)
            .join(StudentResponse)
            .join(Student)
            .filter(CalibrationRecord.teacher_id == teacher_id)
        )

        if cognitive_tier:
            # Filter students whose grade maps to this cognitive_tier
            valid_grades = []
            for g in range(1, 8):
                if get_cognitive_tier(g) == cognitive_tier:
                    valid_grades.append(g)
            query = query.filter(Student.grade.in_(valid_grades))

        records = (
            query
            .order_by(CalibrationRecord.created_at.desc())
            .limit(limit)
            .all()
        )
        return records

    # ── Internal builders ───────────────────────────────────

    @staticmethod
    def _build_definitions_block(
        active_dimensions: list[str],
        rubric_definitions: dict,
        dimension_weights: dict,
    ) -> str:
        """Build the dimension definitions section of the prompt."""
        lines = ["你需要从以下维度评估学生的作答：\n"]

        for dim in active_dimensions:
            defn = rubric_definitions.get(dim, {})
            weight = dimension_weights.get(dim, 0)
            name = defn.get("name", dim)
            description = defn.get("description", "")
            weight_pct = f"{int(weight * 100)}%"

            lines.append(f"【{name}】（权重 {weight_pct}）")
            lines.append(f"  {description}")

            # Level definitions (A+/A/A-/B+/B/B-)
            levels = defn.get("levels", {})
            if levels:
                for level_key in ["A+", "A", "A-", "B+", "B", "B-"]:
                    if level_key in levels:
                        lines.append(f"  {level_key}级：{levels[level_key]}")

            lines.append("")

        return "\n".join(lines)

    @staticmethod
    def _build_negatives_block(negative_indicators: dict) -> str:
        """Build the negative indicators section."""
        if not negative_indicators:
            return ""

        lines = [
            "【反向指标 — 以下特征应导致对应维度降级】\n"
        ]
        for dim, indicator in negative_indicators.items():
            lines.append(f"- {dim}：{indicator}")

        return "\n".join(lines)

    @staticmethod
    def _build_calibration_block(records: list[CalibrationRecord]) -> str:
        """Build few-shot calibration examples from teacher records.

        Compact format: AI scores → teacher scores → reason (if any).
        """
        if not records:
            return ""

        dim_labels = {
            "position": "立意（观点鲜明）", "material": "选材（言之有物）",
            "structure": "结构（条理清晰）", "language": "语言（用词准确）",
            "perspective": "视角（换位思考）",
        }

        def format_scores(scores: dict) -> str:
            if not scores:
                return "无"
            parts = []
            for dim, rating in scores.items():
                label = dim_labels.get(dim, dim)
                parts.append(f"{label}{rating}")
            return "、".join(parts)

        lines = [
            "【教师校准偏好参考 — 请参照以下历史修正记录调整你的评分倾向】\n"
        ]

        for i, rec in enumerate(records, 1):
            ai_scores = format_scores(rec.ai_original_scores or {})
            teacher_scores = format_scores(rec.teacher_final_scores or {})

            # Extract reasons from modifications
            reasons = []
            for m in (rec.modifications or []):
                if isinstance(m, dict):
                    reason = m.get("reason", "")
                    if reason:
                        reasons.append(reason)
            reason_str = "；".join(reasons) if reasons else (rec.note or "")

            lines.append(f"校准{i}  AI评分：{ai_scores}")
            lines.append(f"        教师修正：{teacher_scores}")
            if reason_str:
                lines.append(f"        教师理由：{reason_str}")
            lines.append("")

        return "\n".join(lines)

    @staticmethod
    def _topic_type_label(topic_type: str) -> str:
        """Map topic_type enum to Chinese label."""
        labels = {
            "dilemma": "两难抉择类",
            "fact_opinion": "事实与观点区分类",
            "causal": "因果推导类",
        }
        return labels.get(topic_type, topic_type)

    @staticmethod
    def _fallback_prompt(cognitive_tier: str) -> str:
        """Fallback prompt when no RubricTemplate is found in database."""
        return (
            f"你是一位经验丰富的思辨课教师，正在评估学生的思辨能力表现。\n"
            f"当前学生的认知梯段为：{cognitive_tier}\n"
            f"请按企业统一标准从五个维度评估：立意（观点鲜明）、选材（言之有物）、"
            f"结构（条理清晰）、语言（用词准确）、视角（换位思考）。\n"
            f"对每个维度给出 A+/A/A-/B+/B/B- 评级，并说明评级理由。\n"
            f"如命中加分项（有自己/有新意），在 bonus_flags 中列出。\n"
            f"请按 JSON 格式返回结果。"
        )
