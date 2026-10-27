import test from 'node:test'
import assert from 'node:assert/strict'
import { createApi } from '../src/api.js'
import { ConfigError } from '../src/config.js'
import { BotManager } from '../src/manager.js'
import { ReportHub } from '../src/reports.js'
import { FakeBot, makeConfig, waitUntil } from './helpers.js'

const TOKEN = 'test-token-123'
const auth = { authorization: `Bearer ${TOKEN}` }

function rig (over = {}, apiOver = {}) {
  const audit = []
  FakeBot.created = []
  FakeBot.handshakeMs = 5
  const config = makeConfig({ accounts: [{ username: 'Alpha1' }, { username: 'Beta_2' }], ...over })
  const manager = new BotManager(config, {
    botFactory: (a, c) => {
      const b = new FakeBot(a, c)
      b.balance = null
      b.lastReadError = null
      b.refresh = async (actor) => { b.lastActor = actor; return { type: 'balance', id: b.id, amount: 5 } }
      b.say = async (text, windowMs, actor) => { b.said = { text, windowMs, actor }; return { sent: text, kind: text.startsWith('/') ? 'command' : 'chat', windowMs, messages: [{ ts: 1700000000000, kind: 'system', text: 'reply', raw: '{"text":"reply"}' }] } }
      b.sidebar = () => ({ sidebar: { title: 'T', lines: ['Money: 5'] }, tab: { header: 'h', footer: 'f' } })
      return b
    },
    reports: new ReportHub({ file: null, keepRecent: 50, webhook: null }),
    audit: { write: e => audit.push(e) }
  })
  const api = createApi({ manager, token: TOKEN, version: '9.9.9', ...apiOver })
  const call = (method, path, body, headers = auth) => {
    const [p, q] = path.split('?')
    return api.handle({ method, path: p, query: new URLSearchParams(q), headers, body })
  }
  return { manager, api, call, audit }
}

test('refuses to be created without a token', () => {
  const { manager } = rig()
  assert.throws(() => createApi({ manager, token: '' }), /token/)
})

test('/health is open; everything else needs the bearer token', async () => {
  const { call, manager } = rig()
  const h = await call('GET', '/health', undefined, {})
  assert.equal(h.status, 200)
  assert.equal(h.body.status, 'ok')
  assert.equal(h.body.version, '9.9.9')
  for (const [m, p] of [['GET', '/bots'], ['POST', '/bots/start'], ['POST', '/bots/stop'], ['GET', '/reports'], ['GET', '/bots/x/balance'], ['POST', '/config/reload']]) {
    assert.equal((await call(m, p, {}, {})).status, 401, `${m} ${p} without token`)
    assert.equal((await call(m, p, {}, { authorization: 'Bearer wrong' })).status, 401)
    assert.equal((await call(m, p, {}, { authorization: TOKEN })).status, 401, 'scheme required')
  }
  assert.equal((await call('GET', '/bots', undefined, { authorization: 'bearer ' + TOKEN })).status, 200)
  await manager.shutdown()
})

test('401 does not leak whether a route exists', async () => {
  const { call, manager } = rig()
  const r = await call('GET', '/nope', undefined, {})
  assert.equal(r.status, 401)
  await manager.shutdown()
})

test('POST /bots/start by ids, all, and inline accounts', async () => {
  const { call, manager } = rig()
  let r = await call('POST', '/bots/start', { ids: ['Alpha1'] })
  assert.equal(r.status, 202)
  assert.deepEqual(r.body.accepted.map(a => a.id), ['Alpha1'])
  r = await call('POST', '/bots/start', { all: true })
  assert.equal(r.status, 202)
  assert.deepEqual(r.body.accepted.map(a => a.id), ['Beta_2'])
  assert.deepEqual(r.body.rejected.map(a => [a.id, a.error]), [['Alpha1', 'already_running']])
  r = await call('POST', '/bots/start', { accounts: [{ username: 'Adhoc_3' }, { username: 'x' }, { username: 'Bad Name' }] })
  assert.equal(r.status, 202)
  assert.deepEqual(r.body.accepted.map(a => a.id), ['Adhoc_3'])
  assert.equal(r.body.rejected.filter(x => x.error === 'invalid_account').length, 2)
  assert.equal((await call('GET', '/bots')).body.bots.length, 3)
  await manager.shutdown()
})

test('POST /bots/start: nothing accepted is a 409; bad bodies are 400', async () => {
  const { call, manager } = rig()
  let r = await call('POST', '/bots/start', { ids: ['ghost'] })
  assert.equal(r.status, 409)
  assert.equal(r.body.rejected[0].error, 'unknown_account')
  for (const body of [undefined, {}, { ids: 'Alpha1' }, { ids: [1] }, { bogus: true }, []]) {
    r = await call('POST', '/bots/start', body)
    assert.equal(r.status, 400, JSON.stringify(body))
  }
  await manager.shutdown()
})

test('a bot in cooldown reports retryAfterSec through the API', async () => {
  const { call, manager } = rig()
  await call('POST', '/bots/start', { ids: ['Alpha1'] })
  await waitUntil(() => manager.get('Alpha1').state === 'online')
  manager.get('Alpha1').kickNow('kicked', false)
  const r = await call('POST', '/bots/start', { ids: ['Alpha1'] })
  assert.equal(r.status, 409)
  assert.equal(r.body.rejected[0].error, 'cooling_down')
  assert.ok(r.body.rejected[0].retryAfterSec > 0)
  await manager.shutdown()
})

test('POST /bots/stop by ids and all', async () => {
  const { call, manager } = rig()
  await call('POST', '/bots/start', { all: true })
  let r = await call('POST', '/bots/stop', { ids: ['Alpha1', 'ghost'] })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { stopped: ['Alpha1'], notFound: ['ghost'] })
  r = await call('POST', '/bots/stop', { ids: ['ghost'] })
  assert.equal(r.status, 404)
  r = await call('POST', '/bots/stop', { all: true })
  assert.deepEqual(r.body.stopped.sort(), ['Alpha1', 'Beta_2'])
  assert.equal((await call('POST', '/bots/stop', {})).status, 400)
  const list = (await call('GET', '/bots')).body.bots
  assert.ok(list.every(b => b.state === 'stopped'))
  await manager.shutdown()
})

test('GET /bots, /bots/{id}, /bots/{id}/balance', async () => {
  const { call, manager } = rig()
  await call('POST', '/bots/start', { ids: ['Alpha1'] })
  await waitUntil(() => manager.get('Alpha1').state === 'online')
  assert.equal((await call('GET', '/bots/Alpha1')).body.state, 'online')
  assert.equal((await call('GET', '/bots/ghost')).status, 404)
  assert.equal((await call('GET', '/bots/ghost/balance')).status, 404)
  let r = await call('GET', '/bots/Alpha1/balance')
  assert.equal(r.status, 200)
  assert.equal(r.body.balance, null)
  manager.get('Alpha1').balance = { amount: 12.5, raw: 'Money: 12.5', source: 'sidebar', at: '2026-01-01T00:00:00.000Z' }
  r = await call('GET', '/bots/Alpha1/balance')
  assert.deepEqual(r.body.balance, { amount: 12.5, raw: 'Money: 12.5', source: 'sidebar', at: '2026-01-01T00:00:00.000Z' })
  await manager.shutdown()
})

test('POST /bots/{id}/balance/refresh maps outcomes to status codes', async () => {
  const { call, manager } = rig()
  await call('POST', '/bots/start', { ids: ['Alpha1'] })
  await waitUntil(() => manager.get('Alpha1').state === 'online')
  const bot = manager.get('Alpha1')
  assert.equal((await call('POST', '/bots/ghost/balance/refresh')).status, 404)
  assert.equal((await call('POST', '/bots/Alpha1/balance/refresh')).status, 200)
  bot.refresh = async () => ({ type: 'balance_error', error: 'timeout' })
  assert.equal((await call('POST', '/bots/Alpha1/balance/refresh')).status, 502)
  bot.refresh = async () => { const e = new Error('slow down'); e.code = 'too_soon'; e.retryAfterSec = 12; throw e }
  let r = await call('POST', '/bots/Alpha1/balance/refresh')
  assert.equal(r.status, 429)
  assert.equal(r.body.retryAfterSec, 12)
  bot.refresh = async () => { const e = new Error('offline'); e.code = 'not_online'; throw e }
  assert.equal((await call('POST', '/bots/Alpha1/balance/refresh')).status, 409)
  bot.refresh = async () => null
  assert.equal((await call('POST', '/bots/Alpha1/balance/refresh')).status, 409)
  await manager.shutdown()
})

test('GET /reports honours limit, id and type', async () => {
  const { call, manager } = rig()
  for (let i = 0; i < 6; i++) manager.reports.emit({ type: i % 2 ? 'balance' : 'balance_error', id: i < 3 ? 'a' : 'b', n: i })
  assert.equal((await call('GET', '/reports')).body.reports.length, 6)
  assert.deepEqual((await call('GET', '/reports?limit=2')).body.reports.map(r => r.n), [5, 4])
  assert.deepEqual((await call('GET', '/reports?id=a&type=balance')).body.reports.map(r => r.n), [1])
  assert.equal((await call('GET', '/reports?limit=banana')).body.reports.length, 6)
  await manager.shutdown()
})

test('POST /config/reload', async () => {
  let r = await rig()
  assert.equal((await r.call('POST', '/config/reload')).status, 501)
  await r.manager.shutdown()

  r = await rig({}, { reload: () => ({ changed: ['limits.maxBots'], restartRequired: [] }) })
  const ok = await r.call('POST', '/config/reload')
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { reloaded: true, changed: ['limits.maxBots'], restartRequired: [] })
  await r.manager.shutdown()

  r = await rig({}, { reload: () => { throw new ConfigError('invalid config: nope') } })
  const bad = await r.call('POST', '/config/reload')
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error, 'invalid_config')
  await r.manager.shutdown()
})

test('unknown routes and methods are 404', async () => {
  const { call, manager } = rig()
  assert.equal((await call('GET', '/nope')).status, 404)
  assert.equal((await call('DELETE', '/bots')).status, 404)
  assert.equal((await call('GET', '/bots/start')).status, 404) // treated as a bot id, which does not exist
  await manager.shutdown()
})

test('over real HTTP: auth, JSON handling, size limit, loopback bind', async () => {
  const { api, manager } = rig()
  const server = await api.listen({ bind: '127.0.0.1', port: 0 })
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200)
    assert.equal((await fetch(`${base}/bots`)).status, 401)
    const list = await fetch(`${base}/bots`, { headers: auth })
    assert.equal(list.status, 200)
    assert.deepEqual(await list.json(), { bots: [] })
    const started = await fetch(`${base}/bots/start`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['Alpha1'] }) })
    assert.equal(started.status, 202)
    assert.equal((await fetch(`${base}/bots/start`, { method: 'POST', headers: auth, body: '{not json' })).status, 400)
    assert.equal((await fetch(`${base}/bots/start`, { method: 'POST', headers: auth, body: JSON.stringify({ ids: ['x'.repeat(70000)] }) })).status, 413)
    assert.equal(server.address().address, '127.0.0.1')
  } finally {
    await new Promise(resolve => server.close(resolve))
    await manager.shutdown()
  }
})

// ---- CLI support routes ----

const online = async (call, manager) => { await call('POST', '/bots/start', { ids: ['Alpha1'] }); await waitUntil(() => manager.get('Alpha1').state === 'online') }

test('POST /bots/{id}/say: validates text, clamps the window, passes the actor', async () => {
  const { call, manager } = rig()
  await online(call, manager)
  let r = await call('POST', '/bots/Alpha1/say', { text: '/bal' }, { ...auth, 'x-actor': 'cli' })
  assert.equal(r.status, 200)
  assert.deepEqual(manager.get('Alpha1').said, { text: '/bal', windowMs: 3000, actor: 'cli' })
  assert.equal(r.body.kind, 'command')
  assert.equal(r.body.messages[0].ts, '2023-11-14T22:13:20.000Z')
  assert.equal(r.body.messages[0].text, 'reply')

  await call('POST', '/bots/Alpha1/say', { text: 'hi', windowMs: 999999 })
  assert.equal(manager.get('Alpha1').said.windowMs, 30000, 'clamped to observe.maxReplyWindowMs')
  assert.equal(manager.get('Alpha1').said.actor, 'api', 'no header -> "api"')
  await call('POST', '/bots/Alpha1/say', { text: 'hi' }, { ...auth, 'x-actor': 'Bad Actor!' })
  assert.equal(manager.get('Alpha1').said.actor, 'api', 'invalid actor falls back')

  for (const body of [undefined, {}, { text: '' }, { text: 'x'.repeat(257) }, { text: 'a\nb' }, { text: 'a\u0000b' }, { text: 5 }, { text: 'ok', extra: 1 }, { text: 'ok', windowMs: -1 }]) {
    assert.equal((await call('POST', '/bots/Alpha1/say', body)).status, 400, JSON.stringify(body))
  }
  assert.equal((await call('POST', '/bots/ghost/say', { text: 'hi' })).status, 404)
  assert.equal((await call('POST', '/bots/Alpha1/say', { text: 'hi' }, {})).status, 401)
  manager.get('Alpha1').say = async () => { throw Object.assign(new Error('bot is stopped'), { code: 'not_online' }) }
  assert.equal((await call('POST', '/bots/Alpha1/say', { text: 'hi' })).status, 409)
  await manager.shutdown()
})

test('start, stop and refresh are audited with the caller\'s actor', async () => {
  const { call, manager, audit } = rig()
  await call('POST', '/bots/start', { ids: ['Alpha1'] }, { ...auth, 'x-actor': 'cli' })
  await waitUntil(() => manager.get('Alpha1').state === 'online')
  await call('POST', '/bots/Alpha1/balance/refresh', undefined, { ...auth, 'x-actor': 'cli' })
  assert.equal(manager.get('Alpha1').lastActor, 'cli')
  await call('POST', '/bots/stop', { ids: ['Alpha1'] }, { ...auth, 'x-actor': 'cli' })
  assert.deepEqual(audit.map(a => [a.actor, a.action]), [['cli', 'start'], ['cli', 'stop']])
  assert.deepEqual(audit[0].detail, { ids: ['Alpha1'] })
  await manager.shutdown()
})

test('GET /bots/{id}/messages: backlog, since, latest, limit=0 and long-poll', async () => {
  const { call, manager } = rig()
  await online(call, manager)
  const ring = manager.get('Alpha1').ring
  for (let i = 1; i <= 7; i++) ring.push({ ts: 1700000000000 + i, kind: 'system', text: 'm' + i, raw: '' })
  let r = await call('GET', '/bots/Alpha1/messages')
  assert.deepEqual(r.body.messages.map(m => m.text), ['m3', 'm4', 'm5', 'm6', 'm7'])
  assert.equal(r.body.latest, 7)
  assert.equal(r.body.capacity, 5)
  assert.equal(r.body.messages[0].bot, 'Alpha1')
  assert.ok(r.body.messages[0].ts.endsWith('Z'))
  r = await call('GET', '/bots/Alpha1/messages?since=5')
  assert.deepEqual(r.body.messages.map(m => m.seq), [6, 7])
  r = await call('GET', '/bots/Alpha1/messages?limit=2')
  assert.deepEqual(r.body.messages.map(m => m.seq), [6, 7])
  r = await call('GET', '/bots/Alpha1/messages?limit=0')
  assert.deepEqual([r.body.messages.length, r.body.latest], [0, 7])

  const waiting = call('GET', '/bots/Alpha1/messages?since=7&wait=2000')
  setTimeout(() => ring.push({ ts: Date.now(), kind: 'actionbar', text: 'fresh', raw: '' }), 30)
  const t0 = Date.now()
  r = await waiting
  assert.deepEqual(r.body.messages.map(m => m.text), ['fresh'])
  assert.ok(Date.now() - t0 < 1000, 'returned on arrival, not at timeout')
  r = await call('GET', '/bots/Alpha1/messages?since=8&wait=40')
  assert.deepEqual(r.body.messages, [])
  assert.equal((await call('GET', '/bots/ghost/messages')).status, 404)
  assert.equal((await call('GET', '/bots/Alpha1/messages', undefined, {})).status, 401)
  await manager.shutdown()
})

test('GET /bots/{id}/sidebar', async () => {
  const { call, manager } = rig()
  await online(call, manager)
  let r = await call('GET', '/bots/Alpha1/sidebar')
  assert.deepEqual(r.body, { id: 'Alpha1', state: 'online', tracking: true, sidebar: { title: 'T', lines: ['Money: 5'] }, tab: { header: 'h', footer: 'f' } })
  manager.get('Alpha1').sidebar = () => null
  r = await call('GET', '/bots/Alpha1/sidebar')
  assert.equal(r.body.tracking, false)
  assert.equal((await call('GET', '/bots/ghost/sidebar')).status, 404)
  await manager.shutdown()
})
