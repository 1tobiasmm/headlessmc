/**
 * Exponential backoff with symmetric jitter.
 * @param {number} failures consecutive failures so far, >= 1
 * @param {{initialDelayMs: number, maxDelayMs: number, factor: number, jitter: number}} cfg
 * @param {() => number} [rand] returns [0, 1)
 */
export function backoffDelay (failures, cfg, rand = Math.random) {
  const base = Math.min(cfg.maxDelayMs, cfg.initialDelayMs * cfg.factor ** (Math.max(1, failures) - 1))
  const spread = (rand() * 2 - 1) * cfg.jitter
  return Math.max(0, Math.round(base * (1 + spread)))
}
