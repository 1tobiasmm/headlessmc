/**
 * Fixed-size ring of the last N messages a bot received, with a monotonically increasing
 * sequence number so readers can ask "everything after seq X" and long-poll for more.
 * Memory is bounded by `capacity` entries (each raw string is already capped by the caller).
 */
export class MessageRing {
  /** @param {number} capacity 0 disables storage (push becomes a no-op that still advances seq) */
  constructor (capacity) {
    this.capacity = capacity
    this.items = []
    this.seq = 0
    this.waiters = new Set()
  }

  /** @param {{ts: number, kind: string, text: string, raw?: string}} m @returns {number} the seq */
  push (m) {
    const seq = ++this.seq
    if (this.capacity > 0) {
      this.items.push({ seq, ...m })
      if (this.items.length > this.capacity) this.items.shift()
    }
    for (const w of [...this.waiters]) w()
    return seq
  }

  /** Messages with seq > `since`, oldest first, at most `limit` (the newest ones if more). */
  since (since = 0, limit = 100) {
    const out = this.items.filter(m => m.seq > since)
    return out.length > limit ? out.slice(out.length - limit) : out
  }

  last (n) { return this.items.slice(Math.max(0, this.items.length - n)) }

  /**
   * Resolves with new messages as soon as any exist after `since`, or [] after `timeoutMs` / on abort.
   * @param {number} since
   * @param {{timeoutMs?: number, limit?: number, signal?: AbortSignal}} [o]
   */
  wait (since, { timeoutMs = 25_000, limit = 100, signal } = {}) {
    const ready = this.since(since, limit)
    if (ready.length || timeoutMs <= 0) return Promise.resolve(ready)
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer)
        this.waiters.delete(check)
        signal?.removeEventListener('abort', finish)
        resolve(this.since(since, limit))
      }
      const check = () => { if (this.items.some(m => m.seq > since)) finish() }
      const timer = setTimeout(finish, timeoutMs)
      this.waiters.add(check)
      signal?.addEventListener('abort', finish, { once: true })
    })
  }
}

/**
 * Collects whatever `subscribe` delivers for `windowMs` after `start()` is called, bounded to `max`
 * entries. This is the "reply window" used after a command is sent: late replies are included,
 * anything arriving after the window closes is not.
 * @param {{subscribe: (fn: Function) => () => void, start: () => void, windowMs: number, max?: number, signal?: AbortSignal}} o
 * @returns {Promise<object[]>}
 */
export function collectWindow ({ subscribe, start, windowMs, max = 200, signal }) {
  return new Promise((resolve, reject) => {
    const got = []
    let unsubscribe = () => {}
    let timer = null
    const done = () => { clearTimeout(timer); unsubscribe(); signal?.removeEventListener('abort', done); resolve(got) }
    try {
      unsubscribe = subscribe(m => { if (got.length < max) got.push(m) }) // subscribe first so nothing is missed
      timer = setTimeout(done, windowMs)
      signal?.addEventListener('abort', done, { once: true })
      start()
    } catch (e) {
      clearTimeout(timer)
      unsubscribe()
      reject(e)
    }
  })
}
