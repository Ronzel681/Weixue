"""Canonical six-level rating scale shared by backend analytics."""

RATING_VALUES = {
    "A+": 4.0,
    "A": 3.5,
    "A-": 3.0,
    "B+": 2.5,
    "B": 2.0,
    "B-": 1.0,
}

RATING_OPTIONS = tuple(RATING_VALUES)


def rating_to_value(rating: str):
    """Return a numeric value, or None for an invalid/legacy rating."""
    return RATING_VALUES.get(rating)


# 维度 key 归一化：无论 LLM 返回中文维度名还是旧版英文 key，都统一为五维度标准 key。
DIMENSION_KEY_ALIASES = {
    # 中文标签（LLM 常直接把维度名当 key 返回）
    "立意（观点鲜明）": "position", "立意": "position",
    "选材（言之有物）": "material", "选材": "material",
    "结构（条理清晰）": "structure", "结构": "structure",
    "语言（用词准确）": "language", "语言": "language",
    "视角（换位思考）": "perspective", "视角": "perspective",
    # 旧版英文 key
    "clarity": "position", "interpretation": "position",
    "evidence_awareness": "material", "evidence_use": "material",
    "relevance": "structure", "inference": "structure",
    "argument_evaluation": "structure",
    "depth_breadth": "perspective", "self_regulation": "perspective",
}


def normalize_dimension_scores(scores):
    """Map any legacy/Chinese dimension keys to the canonical five-dimension keys."""
    if not isinstance(scores, dict):
        return scores
    out = {}
    for key, value in scores.items():
        out[DIMENSION_KEY_ALIASES.get(key, key)] = value
    return out
