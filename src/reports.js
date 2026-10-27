import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { nullLogger } from './log.js'

const MAX_FILE_BACKLOG = 1 << 20

/**
 * Fan-out for reports: a bounded in-memory ring, an append-only JSON-lines file and an
 * optional webhook with a bounded retry queue. Every queue drops its oldest entry rather than grow.
 */
export class ReportHub {
  /**
   * @param {object} cfg config.reports
   * @param {{env?: NodeJS.ProcessEnv, fetch?: typeof fetch, log?: object, sleep?: (ms: number) => Promise<void>}} [deps]
   */
  constructor (cfg, { env = process.env, fetch: fetchImpl = globalThis.fetch, log = nullLogger, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    this.env = env
    this.fetch = fetchImpl
    this.log = log
    this.sleep = sleep
    this.ring = []
    this.queue = []
    this.pumping = false
    this.closed = false
    this.stats = { emitted: 0, fileWritten: 0, fileDropped: 0, webhookSent: 0, webhookFailed: 0, webhookDropped: 0 }
    this.stream = null
    this.configure(cfg)
  }

  configure (cfg) {
    this.cfg = cfg
    this.stream?.end()
    this.stream = null
    if (cfg.file) {
      mkdirSync(dirname(cfg.file), { recursive: true })
      this.stream = createWriteStream(cfg.file, { flags: 'a', mode: 0o600 })
      this.stream.on('error', e => this.log.error('report file error', { error: e.message }))
    }
    while (this.ring.length > cfg.keepRecent) this.ring.shift()
  }

  /** @param {object} report must have a `type`; `ts` is added if missing */
  emit (report) {
    if (this.closed) return
    const r = { ts: new Date().toISOString(), ...report }
    this.stats.emitted++
    this.ring.push(r)
    if (this.ring.length > this.cfg.keepRecent) this.ring.shift()

    if (this.stream) {
      if (this.stream.writableLength > MAX_FILE_BACKLOG) this.stats.fileDropped++
      else { this.stream.write(JSON.stringify(r) + '\n'); this.stats.fileWritten++ }
    }
    const wh = this.cfg.webhook
    if (wh) {
      if (this.queue.length >= wh.maxQueue) { this.queue.shift(); this.stats.webhookDropped++ }
      this.queue.push(r)
      this._pump()
    }
  }

  /** @param {{limit?: number, id?: string, type?: string}} [q] newest first */
  recent ({ limit = 100, id, type } = {}) {
    const out = []
    for (let i = this.ring.length - 1; i >= 0 && out.length < limit; i--) {
      const r = this.ring[i]
      if ((id && r.id !== id) || (type && r.type !== type)) continue
      out.push(r)
    }
    return out
  }

  async _pump () {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length && !this.closed) {
        const wh = this.cfg.webhook
        if (!wh) { this.queue.length = 0; break }
        const report = this.queue.shift()
        if (await this._post(wh, report)) this.stats.webhookSent++
        else this.stats.webhookFailed++
      }
    } finally {
      this.pumping = false
    }
  }

  async _post (wh, report) {
    const headers = { 'content-type': 'application/json' }
    const token = wh.tokenEnv && this.env[wh.tokenEnv]
    if (token) headers.authorization = `Bearer ${token}`
    const body = JSON.stringify(report)
    for (let attempt = 1; attempt <= wh.maxAttempts; attempt++) {
      try {
        const res = await this.fetch(wh.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(wh.timeoutMs) })
        res.body?.cancel?.().catch(() => {})
        if (res.ok) return true
        // 4xx other than 408/429 will not improve on retry
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          this.log.warn('webhook rejected report', { status: res.status })
          return false
        }
      } catch (e) {
        this.log.debug('webhook attempt failed', { attempt, error: e.message })
      }
      if (attempt < wh.maxAttempts) await this.sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)))
    }
    this.log.warn('webhook delivery failed', { attempts: wh.maxAttempts })
    return false
  }

  /** Flushes the file and gives the webhook queue a short grace period. */
  async close (graceMs = 2000) {
    const deadline = Date.now() + graceMs
    while ((this.queue.length || this.pumping) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
    this.closed = true
    await new Promise(resolve => (this.stream ? this.stream.end(resolve) : resolve()))
  }
}
