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
