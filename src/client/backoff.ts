// Exponential backoff with full jitter: a random delay between 0 and the
// capped exponential. Without jitter, every client that lost the same server
// reconnects at the same instant and hits it together.
export function backoffDelay(
  attempt: number,
  random: () => number = Math.random,
  baseMs = 500,
  capMs = 15_000,
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.max(100, Math.round(random() * ceiling));
}
