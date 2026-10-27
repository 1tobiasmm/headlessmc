import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const LINE_LIMIT = 16 * 1024
const bigintSafe = (_, v) => (typeof v === 'bigint' ? v.toString() : v)

/**
 * Discovery aid: on a bot's first connection, records the raw sidebar rows, tab header/footer,
 * chat/system/action-bar messages and the command it sent, for `windowSec` seconds.
 * The balance parsers are written from this file; nothing is guessed in advance.
 * The file can contain other players' chat. It is created with mode 0600.
 */
export class DumpHub {
  /** @param {object} cfg config.debug.dump */
  constructor (cfg) {
    this.cfg = cfg
    this.dumped = new Set()
    this.stream = null
  }

  configure (cfg) { this.cfg = cfg }

  wants (id) {
    return this.cfg.enabled && !this.dumped.has(id) && this.dumped.size < this.cfg.maxBots
  }

  /** @returns {DumpSession | null} */
  begin (id, meta) {
    return this.wants(id) ? new DumpSession(this, id, meta) : null
  }

  _write (obj) {
    if (!this.stream) {
      mkdirSync(dirname(this.cfg.file), { recursive: true })
      this.stream = createWriteStream(this.cfg.file, { flags: 'a', mode: 0o600 })
      this.stream.on('error', () => { this.stream = null })
    }
    let line = JSON.stringify(obj, bigintSafe)
    if (line.length > LINE_LIMIT) line = JSON.stringify({ ...obj, data: '[truncated]', truncatedFrom: line.length })
    this.stream.write(line + '\n')
  }

  close () { return new Promise(resolve => (this.stream ? this.stream.end(resolve) : resolve())) }
}

class DumpSession {
  constructor (hub, id, meta) {
    this.hub = hub
    this.id = id
    this.meta = meta
    this.lines = 0
    this.active = false
    this.tracker = null
    this.lastVersion = -1
    this.timers = []
  }

  /** Starts the window. Returns false when another bot took the last slot. */
  start (tracker) {
    if (!this.hub.wants(this.id)) return false
    this.hub.dumped.add(this.id)
    this.active = true
    this.tracker = tracker
    this.write('meta', this.meta)
    if (tracker) this.timers.push(setInterval(() => this.snapshot(), 1000))
    this.timers.push(setTimeout(() => this.stop(), this.hub.cfg.windowSec * 1000))
    this.onEnd = null
    return true
  }

  write (kind, data) {
    if (!this.active || this.lines >= this.hub.cfg.maxLines) return
    this.lines++
    this.hub._write({ ts: new Date().toISOString(), bot: this.id, kind, data })
  }

  snapshot () {
    const t = this.tracker
    if (!t || t.version === this.lastVersion) return
    this.lastVersion = t.version
    this.write('sidebar', t.snapshotSidebar(true))
    this.write('tab', t.snapshotTab())
  }

  stop () {
    if (!this.active) return
    this.snapshot()
    this.active = false
    for (const t of this.timers) { clearInterval(t); clearTimeout(t) }
    this.timers = []
    this.onEnd?.()
  }
}
