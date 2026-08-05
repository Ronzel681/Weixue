import unittest

from grading.ratings import RATING_OPTIONS, RATING_VALUES, rating_to_value


class RatingScaleTests(unittest.TestCase):
    def test_six_level_order_and_values(self):
        self.assertEqual(RATING_OPTIONS, ("A+", "A", "A-", "B+", "B", "B-"))
        self.assertEqual(
            RATING_VALUES,
            {"A+": 4.0, "A": 3.5, "A-": 3.0, "B+": 2.5, "B": 2.0, "B-": 1.0},
        )

    def test_legacy_or_unknown_rating_is_not_silently_coerced(self):
        self.assertIsNone(rating_to_value("C"))
        self.assertIsNone(rating_to_value(""))


if __name__ == "__main__":
    unittest.main()
