/** Source map clock: seconds since the map's animations and lightstyles started.
 * Lightstyles step on a 10 Hz integer tick, so the clock stays non-negative and far
 * below Number.MAX_SAFE_INTEGER / 10. One billion seconds (about 31 years) is well
 * past any page lifetime or recorded take. */
export const SOURCE_TIME_LIMIT_SECONDS = 1e9;

/** A recorded or requested map clock that every Source renderer accepts. */
export function validSourceTime(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= SOURCE_TIME_LIMIT_SECONDS;
}

/** Clamp a review/export clock into range; NaN and negatives become 0. */
export function clampSourceTime(value: number): number {
  return value >= 0 ? Math.min(value, SOURCE_TIME_LIMIT_SECONDS) : 0;
}
