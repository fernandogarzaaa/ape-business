/**
 * Wilson-interval statistics.
 *
 * Shared by the assurance module's false-accept/false-reject reporting: every
 * rate carries a Wilson interval rather than a bare point estimate, because at
 * small probe-suite sizes the intervals are wide and saying so is part of the
 * deliverable.
 */

export interface Interval {
  readonly point: number;
  readonly low: number;
  readonly high: number;
  readonly n: number;
}

/**
 * Wilson score interval at 95%.
 *
 * Chosen over the normal approximation because these proportions cluster near
 * 0 and 1 — exactly where the normal approximation produces intervals that
 * extend below zero and quietly mislead.
 */
export function wilson(successes: number, total: number, z = 1.959963984540054): Interval {
  if (total === 0) return { point: 0, low: 0, high: 0, n: 0 };

  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const spread = (z / denominator) * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));

  return {
    point: round(p),
    low: round(Math.max(0, center - spread)),
    high: round(Math.min(1, center + spread)),
    n: total,
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function formatInterval(interval: Interval): string {
  if (interval.n === 0) return "n/a (no cases)";
  return (
    `${(interval.point * 100).toFixed(1)}% ` +
    `[${(interval.low * 100).toFixed(1)}–${(interval.high * 100).toFixed(1)}%, n=${interval.n}]`
  );
}
