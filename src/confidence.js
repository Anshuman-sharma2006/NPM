export const CONFIDENCE = Object.freeze({
  high: 'high',
  medium: 'medium',
  low: 'low',
  veryHigh: 'very-high'
});

export function confidenceForEvidence(evidence) {
  if (evidence === 'runtime' || evidence === 'static+runtime') return CONFIDENCE.veryHigh;
  if (evidence === 'possible') return CONFIDENCE.medium;
  if (evidence === 'static') return CONFIDENCE.high;
  return CONFIDENCE.low;
}
