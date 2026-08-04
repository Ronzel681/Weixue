export const RATING_VALUES = Object.freeze({
  'A+': 4,
  'A': 3.5,
  'A-': 3,
  'B+': 2.5,
  'B': 2,
  'B-': 1,
});

export const RATING_OPTIONS = Object.freeze(Object.keys(RATING_VALUES));

export const ratingToNumber = (rating) => RATING_VALUES[rating] ?? null;

export const averageRating = (scores) => {
  if (!scores || typeof scores !== 'object') return 0;
  const values = Object.values(scores)
    .map(ratingToNumber)
    .filter(value => value !== null);
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
};

// Compatibility aliases for components introduced in the collaborator branch.
export const RATING_TO_NUM = RATING_VALUES;
export const avgRating = averageRating;
