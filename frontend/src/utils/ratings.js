/**
 * Shared rating helpers.
 * Keep in sync with backend RATING_TO_NUM in backend/main.py.
 */
export const RATING_TO_NUM = { 'A+': 4, 'A': 3.5, 'A-': 3, 'B+': 2.5, 'B': 2, 'B-': 1 };

export const avgRating = (scores) => {
  if (!scores) return 0;
  const vals = Object.values(scores).map(r => RATING_TO_NUM[r] ?? 0);
  return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
};
