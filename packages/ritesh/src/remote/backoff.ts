// Reconnect policy: which close codes end the attempts, and how long to wait.

export const BACKOFF_BASE_MS = 1000
export const BACKOFF_MAX_MS = 30_000

/** Close codes the client never retries: bad hello, unauthorized, origin, session replaced. */
export const NO_RETRY_CODES: ReadonlySet<number> = new Set([4000, 4001, 4003, 4040])

/**
 * Exponential backoff with full jitter: uniform in [0, ceiling), where the
 * ceiling doubles from 1 s with each consecutive failure and stops at 30 s.
 */
export function backoffDelay(failures: number, random: () => number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(Math.max(failures, 0), 16))
  return Math.floor(random() * ceiling)
}
