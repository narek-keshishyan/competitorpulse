export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Injected for deterministic tests. */
  random?: () => number;
}

/**
 * Exponential backoff with "equal jitter": the delay doubles per attempt (capped), and the
 * actual wait is a random point in the upper half of it so retries don't arrive in bursts.
 */
export function backoffMs(
  attempt: number,
  { baseMs, maxMs, random = Math.random }: BackoffOptions,
) {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential / 2 + (exponential / 2) * random());
}
