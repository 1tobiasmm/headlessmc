import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { MessageRing } from '../src/messages.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateConfig } from '../src/config.js'

const testDir = mkdtempSync(join(tmpdir(), 'hmc-test-'))
export const AUDIT_FILE = join(testDir, 'audit.jsonl')

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function waitUntil (fn, timeoutMs = 5000, stepMs = 20) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`condition not met within ${timeoutMs} ms`)
    await sleep(stepMs)
  }
}

/** Minimal valid config; override any section. */
export function makeConfig (over = {}) {
  const base = {
    server: { host: '127.0.0.1', port: 25565, version: '1.21.4' },
    accounts: [{ username: 'Alpha1' }],
    limits: { joinDelayMs: 0, joinJitterMs: 0 },
    reconnect: { initialDelayMs: 40, maxDelayMs: 200, jitter: 0 },
    balance: {
      source: 'command',
      pollIntervalSec: 0,
      readyDelayMs: 50,
      readTimeoutMs: 1500,
      minReadIntervalSec: 1,
      command: { text: '/bal', replyPattern: 'Mock balance: (?<amount>\\$[\\d,.]+)' },
      sidebar: { labelPattern: '^Money: (?<amount>\\$[\\d,]+)' }
    },
    budget: { enabled: false },
    reports: { file: null },
    debug: { dump: { enabled: false } },
    audit: { file: AUDIT_FILE }
  }
  const merged = { ...base }
  for (const [k, v] of Object.entries(over)) {
    merged[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] ? { ...base[k], ...v } : v
  }
  return validateConfig(merged)
}

/** Stand-in for a Bot used to test the scheduler and manager without sockets. */
export class FakeBot {
  constructor (account, ctx) {
    this.account = account
    this.id = account.id
    this.ctx = ctx
    this.state = 'connecting'
    this.phase = 'idle'
    this.stopped = false
    this.startedAt = null
    this.ring = new MessageRing(5)
    FakeBot.created.push(this)
  }

  async connect () {
    this.startedAt = Date.now()
    this.phase = 'handshake'
    this.ctx.hooks.phaseChanged(this)
    await sleep(FakeBot.handshakeMs)
    if (this.stopped) return
    this.phase = 'online'
    this.state = 'online'
    this.ctx.hooks.stateChanged(this, 'connecting')
    this.ctx.hooks.phaseChanged(this)
  }

  stop (reason) {
    this.stopped = true
    this.phase = 'idle'
    this.state = 'stopped'
    this.reason = reason
    this.ctx.hooks.stateChanged(this, 'online')
    this.ctx.hooks.phaseChanged(this)
  }

  kickNow (text = 'kicked', ban = false) {
    this.phase = 'idle'
    this.state = 'kicked'
    this.ctx.hooks.stateChanged(this, 'online')
    this.ctx.hooks.phaseChanged(this)
    this.ctx.hooks.kicked(this, { text, ban, at: new Date().toISOString(), until: new Date(Date.now() + 1000).toISOString() })
  }

  status () { return { id: this.id, username: this.account.username, state: this.state } }
}
FakeBot.created = []
FakeBot.handshakeMs = 10

/** An EventEmitter shaped like a protocol client, for tests that script packets. */
export class FakeClient extends EventEmitter {
  constructor () {
    super()
    this.version = '1.21.4'
    this.username = 'Alpha1'
    this.uuid = '00000000-0000-0000-0000-000000000000'
    this.written = []
    this.ended = false
  }

  write (name, data) { this.written.push([name, data]) }
  end () { this.ended = true }
  chat (text) { this.written.push(['chat', text]) }
}
