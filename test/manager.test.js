import test from 'node:test'
import assert from 'node:assert/strict'
import { backoffDelay } from '../src/backoff.js'
import { BotManager } from '../src/manager.js'
import { ReportHub } from '../src/reports.js'
import { JoinScheduler } from '../src/scheduler.js'
import { FakeBot, makeConfig, sleep, waitUntil } from './helpers.js'

const group = (n) => ({ accountGroups: [{ idPrefix: 'b', usernamePrefix: 'Bot', count: n, pad: 2 }], accounts: [] })

function manager (over = {}, deps = {}) {
  FakeBot.created = []
  FakeBot.handshakeMs = 10
  const config = makeConfig({ ...group(5), ...over })
  const m = new BotManager(config, { botFactory: (a, c) => new FakeBot(a, c), reports: new ReportHub({ file: null, keepRecent: 50, webhook: null }), ...deps })
  return m
}
const ids = (m) => m.config.accounts.map(a => a.id)
const active = m => [...m.bots.values()].filter(b => b.phase !== 'idle').length

test('backoffDelay: exponential, capped, jittered', () => {
  const cfg = { initialDelayMs: 1000, maxDelayMs: 10000, factor: 2, jitter: 0 }
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(n => backoffDelay(n, cfg)), [1000, 2000, 4000, 8000, 10000, 10000])
  assert.equal(backoffDelay(0, cfg), 1000)
  const j = { ...cfg, jitter: 0.2 }
  assert.equal(backoffDelay(1, j, () => 0), 800)
  assert.equal(backoffDelay(1, j, () => 0.5), 1000)
  assert.equal(backoffDelay(1, j, () => 0.999999), 1200)
  for (let i = 0; i < 200; i++) {
    const d = backoffDelay(3, j)
    assert.ok(d >= 3200 && d <= 4800, String(d))
  }
})

test('maxConcurrentBots bounds simultaneous connections; extra bots wait in the queue', async () => {
  const m = manager({ limits: { maxConcurrentBots: 2, maxConcurrentConnecting: 2 } })
  const res = m.start(m.config.accounts)
  assert.equal(res.accepted.length, 5)
  await waitUntil(() => m.countState('online') === 2)
  await sleep(80)
  assert.equal(active(m), 2)
  assert.equal(m.countState('online'), 2)
  assert.equal(m.scheduler.queued, 3)
  // freeing a slot admits exactly one more
  m.stop([ids(m)[0]])
  await waitUntil(() => m.countState('online') === 2 && m.scheduler.queued === 2)
  assert.equal(active(m), 2)
  await m.shutdown()
})

test('maxConcurrentConnecting limits simultaneous handshakes', async () => {
  const m = manager({ limits: { maxConcurrentBots: 10, maxConcurrentConnecting: 2 } })
  FakeBot.handshakeMs = 60
  m.start(m.config.accounts)
  await sleep(30)
  const handshaking = [...m.bots.values()].filter(b => b.phase === 'handshake').length
  assert.equal(handshaking, 2)
  await waitUntil(() => m.countState('online') === 5, 3000)
  await m.shutdown()
})

test('joins are staggered by joinDelayMs', async () => {
  const m = manager({ limits: { joinDelayMs: 60, joinJitterMs: 0, maxConcurrentConnecting: 5, maxConcurrentBots: 5 } })
  m.start(m.config.accounts.slice(0, 4))
  await waitUntil(() => FakeBot.created.every(b => b.startedAt), 3000)
  const times = FakeBot.created.map(b => b.startedAt).sort((a, b) => a - b)
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 55, `gap ${i}: ${times[i] - times[i - 1]}`)
  await m.shutdown()
})

test('start rejects running bots, unknown ids, queue overflow and maxBots', async () => {
  const m = manager({ limits: { maxBots: 3, maxQueue: 2, maxConcurrentBots: 1, maxConcurrentConnecting: 1, joinDelayMs: 1000 } })
  let r = m.startConfigured(['b01', 'b01', 'nope'])
  assert.deepEqual(r.accepted.map(a => a.id), ['b01'])
  assert.deepEqual(r.rejected.map(x => [x.id, x.error]).sort(), [['b01', 'already_running'], ['nope', 'unknown_account']])
  r = m.startConfigured(['b02', 'b03', 'b04'])
  const errs = Object.fromEntries(r.rejected.map(x => [x.id, x.error]))
  assert.ok(Object.values(errs).includes('max_bots') || Object.values(errs).includes('queue_full'), JSON.stringify(r))
  await m.shutdown()
})

test('stop by id and stop all; unknown ids are reported', async () => {
  const m = manager()
  m.start(m.config.accounts)
  await waitUntil(() => m.countState('online') >= 1)
  const r = m.stop(['b01', 'ghost'])
  assert.deepEqual(r, { stopped: ['b01'], notFound: ['ghost'] })
  assert.equal(m.get('b01').state, 'stopped')
  m.stop('all')
  assert.ok([...m.bots.values()].every(b => b.state === 'stopped'))
  assert.equal(m.scheduler.queued, 0)
  assert.equal(active(m), 0)
  await m.shutdown()
})

test('a stopped bot can be started again', async () => {
  const m = manager()
  m.startConfigured(['b01'])
  await waitUntil(() => m.get('b01').state === 'online')
  m.stop(['b01'])
  const r = m.startConfigured(['b01'])
  assert.equal(r.accepted.length, 1)
  await waitUntil(() => m.get('b01').state === 'online')
  assert.equal(FakeBot.created.length, 2)
  await m.shutdown()
})

test('a kick starts a cooldown, blocks restart, and pauses everyone\'s joins', async () => {
  const m = manager({ kick: { cooldownSeconds: 30, globalPauseSeconds: 5 }, limits: { maxConcurrentBots: 1, maxConcurrentConnecting: 1 } })
  m.start(m.config.accounts.slice(0, 2))
  await waitUntil(() => m.get('b01').state === 'online')
  m.get('b01').kickNow('You were kicked')
  assert.equal(m.get('b01').state, 'kicked')
  const r = m.startConfigured(['b01'])
  assert.equal(r.rejected[0].error, 'cooling_down')
  assert.ok(r.rejected[0].retryAfterSec > 25 && r.rejected[0].retryAfterSec <= 30)
  // the second bot is queued but joins are paused
  await sleep(100)
  assert.equal(m.get('b02').phase, 'idle')
  assert.ok(m.scheduler.pausedUntil > Date.now() + 3000)
  assert.equal(m.reports.recent({ type: 'kick' }).length, 1)
  // stopping a kicked bot does not clear its cooldown
  m.stop(['b01'])
  assert.equal(m.startConfigured(['b01']).rejected[0].error, 'cooling_down')
  await m.shutdown()
})

test('a ban-text kick pauses joins at least as long as the cooldown', async () => {
  const m = manager({ kick: { cooldownSeconds: 120, globalPauseSeconds: 5, banCooldownSeconds: 3600 } })
  m.startConfigured(['b01'])
  await waitUntil(() => m.get('b01').state === 'online')
  m.get('b01').kickNow('You are banned', true)
  assert.ok(m.scheduler.pausedUntil > Date.now() + 100_000)
  assert.ok(m.cooldowns.get('b01') > Date.now() + 3_500_000)
  await m.shutdown()
})

test('applyConfig swaps live settings and reports what needs a restart', async () => {
  const m = manager()
  const next = makeConfig({ ...group(5), limits: { maxConcurrentBots: 9 }, api: { port: 9999 } })
  const r = m.applyConfig(next)
  assert.ok(r.changed.includes('limits.maxConcurrentBots'))
  assert.deepEqual(r.restartRequired, ['api.port'])
  assert.equal(m.config.limits.maxConcurrentBots, 9)
  assert.equal(m.config.api.port, 8787, 'API settings stay as started')
  assert.ok(m.config.compiled.commandRe)
  await m.shutdown()
})

test('health summarises states', async () => {
  const m = manager()
  m.start(m.config.accounts.slice(0, 2))
  await waitUntil(() => m.countState('online') === 2)
  const h = m.health()
  assert.equal(h.status, 'ok')
  assert.equal(h.bots.total, 2)
  assert.equal(h.bots.byState.online, 2)
  assert.ok(h.resources.rssMB > 0)
  await m.shutdown()
})

test('scheduler: budget gate holds joins until the budget recovers', async () => {
  let over = true
  const s = new JoinScheduler({ getLimits: () => ({ maxConcurrentBots: 5, maxConcurrentConnecting: 5, maxQueue: 10, joinDelayMs: 0, joinJitterMs: 0 }), isOverBudget: () => over, budgetRecheckMs: 20 })
  const started = []
  const bot = { stopped: false, state: 'connecting', phase: 'idle', connect () { started.push(1); this.phase = 'handshake'; s.phaseChanged(this) } }
  s.enqueue(bot)
  await sleep(70)
  assert.equal(started.length, 0)
  over = false
  await sleep(60)
  assert.equal(started.length, 1)
  s.stop()
})

test('scheduler: stale queue entries are skipped', async () => {
  const s = new JoinScheduler({ getLimits: () => ({ maxConcurrentBots: 5, maxConcurrentConnecting: 5, maxQueue: 10, joinDelayMs: 0, joinJitterMs: 0 }) })
  let started = 0
  const dead = { stopped: true, state: 'stopped', phase: 'idle', connect () { started++ } }
  const live = { stopped: false, state: 'connecting', phase: 'idle', connect () { started++; this.phase = 'handshake'; s.phaseChanged(this) } }
  s.enqueue(dead); s.enqueue(live)
  await sleep(30)
  assert.equal(started, 1)
  assert.equal(s.enqueue(live, { force: true }), true)
  s.stop()
})
