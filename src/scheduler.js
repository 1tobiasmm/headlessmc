/**
 * Admits connection attempts one at a time. A bot may start connecting only when
 *  - fewer than limits.maxConcurrentBots bots hold a connection or handshake,
 *  - fewer than limits.maxConcurrentConnecting are mid-handshake,
 *  - at least joinDelayMs (+ random joinJitterMs) passed since the previous start,
 *  - joins are not paused (after a kick) and the resource budget is not exceeded.
 * Reconnects go through the same queue, so backoff timers cannot cause a join storm.
 */
export class JoinScheduler {
  /**
   * @param {{getLimits: () => object, isOverBudget?: () => boolean, now?: () => number, budgetRecheckMs?: number}} deps
   */
  constructor ({ getLimits, isOverBudget = () => false, now = Date.now, budgetRecheckMs = 2000 }) {
    this.getLimits = getLimits
    this.isOverBudget = isOverBudget
    this.now = now
    this.budgetRecheckMs = budgetRecheckMs
    this.queue = []
    this.connecting = new Set()
    this.active = new Set()
    this.lastStartAt = 0
    this.gap = 0
    this.pausedUntil = 0
    this.timer = null
    this.pumpQueued = false
  }

  get queued () { return this.queue.length }

  /** @returns {boolean} false when the queue is full */
  enqueue (bot, { force = false } = {}) {
    if (this.queue.includes(bot)) return true
    if (!force && this.queue.length >= this.getLimits().maxQueue) return false
    this.queue.push(bot)
    this.kick()
    return true
  }

  remove (bot) {
    const i = this.queue.indexOf(bot)
    if (i >= 0) this.queue.splice(i, 1)
    this.connecting.delete(bot)
    this.active.delete(bot)
  }

  /** Bot reported a phase change; updates the slot accounting and re-evaluates the queue. */
  phaseChanged (bot) {
    if (bot.phase === 'handshake') { this.connecting.add(bot); this.active.add(bot) } else if (bot.phase === 'online') { this.connecting.delete(bot); this.active.add(bot) } else { this.connecting.delete(bot); this.active.delete(bot) }
    this.kick()
  }

  pause (ms) {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms)
  }

  /** Coalesces re-evaluation requests into one microtask. */
  kick () {
    if (this.pumpQueued) return
    this.pumpQueued = true
    queueMicrotask(() => { this.pumpQueued = false; this.pump() })
  }

  _wake (ms) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.pump() }, Math.max(1, ms))
    this.timer.unref?.()
  }

  pump () {
    clearTimeout(this.timer)
    this.timer = null
    while (this.queue.length) {
      const bot = this.queue[0]
      if (bot.stopped || bot.state !== 'connecting' || bot.phase !== 'idle') { this.queue.shift(); continue }
      const L = this.getLimits()
      if (this.active.size >= L.maxConcurrentBots || this.connecting.size >= L.maxConcurrentConnecting) return // a phase change re-pumps
      const now = this.now()
      if (this.pausedUntil > now) return this._wake(this.pausedUntil - now)
      if (this.isOverBudget()) return this._wake(this.budgetRecheckMs)
      const wait = this.lastStartAt + this.gap - now
      if (wait > 0) return this._wake(wait)
      this.queue.shift()
      this.lastStartAt = now
      this.gap = L.joinDelayMs + Math.random() * L.joinJitterMs
      bot.connect() // sets phase 'handshake' synchronously, which updates the counters via phaseChanged
    }
  }

  stop () {
    clearTimeout(this.timer)
    this.timer = null
    this.queue.length = 0
  }
}
