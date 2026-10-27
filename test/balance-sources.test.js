import test from 'node:test'
import assert from 'node:assert/strict'
import { createBalanceSource } from '../src/balance/index.js'
import { getPath } from '../src/balance/http.js'
import { ScoreboardTracker } from '../src/scoreboard.js'
import { FakeClient, makeConfig } from './helpers.js'

// All reply texts and rows below are synthetic fixtures for the parsing rules.

/** Session whose chat replies arrive when the command is sent. */
function chatSession (replies, { username = 'Alpha1' } = {}) {
  const sent = []
  let deliver
  return {
    username,
    uuid: 'u-1',
    sent,
    waitForChat (match, ms, accept) {
      return new Promise(resolve => {
        const t = setTimeout(() => resolve(null), ms)
        deliver = () => {
          for (const r of replies) {
            if (!accept.has(r.kind)) continue
            const result = match(r.text)
            if (result) { clearTimeout(t); return resolve({ kind: r.kind, text: r.text, raw: r.text, result }) }
          }
        }
      })
    },
    sendCommand (text) { sent.push(text); queueMicrotask(() => deliver()) }
  }
}

const withBalance = (b) => makeConfig({ balance: { source: 'command', ...b } })

test('command: sends the configured text and parses the first matching reply', async () => {
  const src = createBalanceSource(makeConfig())
  const s = chatSession([{ kind: 'system', text: 'unrelated' }, { kind: 'system', text: 'Mock balance: $1,234.50' }])
  const r = await src.read(s)
  assert.deepEqual(s.sent, ['/bal'])
  assert.equal(r.amount, 1234.5)
  assert.equal(r.raw, 'Mock balance: $1,234.50')
  assert.equal(r.source, 'command')
})

test('command: player chat is ignored unless accepted (spoofing guard)', async () => {
  const cfg = withBalance({ readTimeoutMs: 60, command: { text: '/bal', replyPattern: 'Mock balance: (?<amount>\\$[\\d,.]+)' } })
  const src = createBalanceSource(cfg)
  await assert.rejects(src.read(chatSession([{ kind: 'player', text: 'Mock balance: $999,999' }])), { code: 'timeout' })
  const open = createBalanceSource(withBalance({ command: { text: '/bal', replyPattern: 'Mock balance: (?<amount>\\$[\\d,.]+)', accept: ['system', 'player'] } }))
  assert.equal((await open.read(chatSession([{ kind: 'player', text: 'Mock balance: $5' }]))).amount, 5)
})

test('command: action-bar replies need accept: [actionbar]', async () => {
  const cfg = withBalance({ command: { text: '/bal', replyPattern: 'Mock balance: (?<amount>\\$[\\d,.]+)', accept: ['actionbar'] } })
  const r = await createBalanceSource(cfg).read(chatSession([{ kind: 'actionbar', text: 'Mock balance: $7' }]))
  assert.equal(r.amount, 7)
})

test('command: timeout, and matched-but-unparseable keeps the raw text', async () => {
  const cfg = withBalance({ readTimeoutMs: 50, command: { text: '/bal', replyPattern: 'Mock balance: (?<amount>\\S+)' } })
  const src = createBalanceSource(cfg)
  await assert.rejects(src.read(chatSession([])), { code: 'timeout' })
  await assert.rejects(src.read(chatSession([{ kind: 'system', text: 'Mock balance: lots' }])), e => e.code === 'unparseable' && e.raw === 'Mock balance: lots')
})

test('command: suffix multipliers come from config only', async () => {
  const text = [{ kind: 'system', text: 'Mock balance: $1.5M' }]
  const base = { command: { text: '/bal', replyPattern: 'Mock balance: (?<amount>\\S+)' } }
  await assert.rejects(createBalanceSource(withBalance(base)).read(chatSession(text)), { code: 'unparseable' })
  const r = await createBalanceSource(withBalance({ ...base, suffixes: { M: 1e6 } })).read(chatSession(text))
  assert.equal(r.amount, 1500000)
})

function sidebarSession (setup) {
  const client = new FakeClient()
  const tracker = new ScoreboardTracker()
  tracker.attach(client)
  setup(client)
  return { username: 'Alpha1', tracker, client }
}
const J = text => JSON.stringify({ text })
const sidebarCfg = (sidebar) => makeConfig({ balance: { source: 'sidebar', readTimeoutMs: 80, sidebar } })

test('sidebar: finds the row by label pattern', async () => {
  const s = sidebarSession(c => {
    c.emit('scoreboard_objective', { name: 's', action: 0, displayText: J('T') })
    c.emit('scoreboard_display_objective', { position: 1, name: 's' })
    c.emit('scoreboard_score', { itemName: 'Shards: 3', action: 0, scoreName: 's', value: 2 })
    c.emit('scoreboard_score', { itemName: 'Money: $1,500', action: 0, scoreName: 's', value: 1 })
  })
  const r = await createBalanceSource(sidebarCfg({ labelPattern: '^Money: (?<amount>\\$[\\d,]+)' })).read(s)
  assert.equal(r.amount, 1500)
  assert.equal(r.raw, 'Money: $1,500')
  assert.equal(r.detail.surface, 'sidebar')
})

test('sidebar: waits for a row that arrives after the read starts', async () => {
  const s = sidebarSession(c => {
    c.emit('scoreboard_objective', { name: 's', action: 0, displayText: J('T') })
    c.emit('scoreboard_display_objective', { position: 1, name: 's' })
  })
  setTimeout(() => s.client.emit('scoreboard_score', { itemName: 'Money: 42', action: 0, scoreName: 's', value: 1 }), 15)
  const r = await createBalanceSource(sidebarCfg({ labelPattern: '^Money: (?<amount>\\d+)' })).read(s)
  assert.equal(r.amount, 42)
})

test('sidebar: no matching row times out; tab footer is a separate surface', async () => {
  const s = sidebarSession(c => {
    c.emit('scoreboard_objective', { name: 's', action: 0, displayText: J('T') })
    c.emit('scoreboard_display_objective', { position: 1, name: 's' })
    c.emit('scoreboard_score', { itemName: 'Nothing here', action: 0, scoreName: 's', value: 1 })
    c.emit('playerlist_header', { header: J('hdr'), footer: J('Online: 3\nMoney: $88') })
  })
  await assert.rejects(createBalanceSource(sidebarCfg({ labelPattern: '^Money: (?<amount>\\$\\d+)' })).read(s), { code: 'timeout' })
  const r = await createBalanceSource(sidebarCfg({ labelPattern: '^Money: (?<amount>\\$\\d+)', surfaces: ['sidebar', 'tabFooter'] })).read(s)
  assert.equal(r.amount, 88)
  assert.equal(r.detail.surface, 'tabFooter')
})

// ---- http ----

const httpCfg = (http, extra = {}) => makeConfig({ balance: { source: 'http', readTimeoutMs: 200, http: { url: 'https://api.example.test/bal/{username}', jsonPath: 'result.money', ...http }, ...extra } })
const fakeFetch = (handler) => async (url, init) => handler(url, init)
const resp = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

test('http: substitutes username, sends the bearer token from the environment, reads the json path', async () => {
  let seen
  const src = createBalanceSource(httpCfg({ bearerTokenEnv: 'MY_KEY' }), { env: { MY_KEY: 's3cret' }, fetch: fakeFetch((url, init) => { seen = { url, init }; return resp(200, { result: { money: 1234.5 } }) }) })
  const r = await src.read({ username: 'Al ice', uuid: 'u1' })
  assert.equal(seen.url, 'https://api.example.test/bal/Al%20ice')
  assert.equal(seen.init.headers.authorization, 'Bearer s3cret')
  assert.equal(r.amount, 1234.5)
  assert.equal(r.source, 'http')
  assert.ok(!JSON.stringify(r).includes('s3cret'))
})

test('http: numeric strings go through the strict parser; failures are typed', async () => {
  const mk = (res) => createBalanceSource(httpCfg({}), { fetch: fakeFetch(() => res) })
  assert.equal((await mk(resp(200, { result: { money: '2,000.5' } })).read({ username: 'a' })).amount, 2000.5)
  await assert.rejects(mk(resp(200, { result: { money: 'lots' } })).read({ username: 'a' }), { code: 'unparseable' })
  await assert.rejects(mk(resp(200, { other: 1 })).read({ username: 'a' }), { code: 'unparseable' })
  await assert.rejects(mk(resp(200, 'not json')).read({ username: 'a' }), { code: 'unparseable' })
  await assert.rejects(mk(resp(503, 'down')).read({ username: 'a' }), e => e.code === 'http' && /503/.test(e.message))
})

test('http: missing credential environment variable is a config error, not a request', async () => {
  let called = false
  const src = createBalanceSource(httpCfg({ bearerTokenEnv: 'ABSENT' }), { env: {}, fetch: fakeFetch(() => { called = true; return resp(200, {}) }) })
  await assert.rejects(src.read({ username: 'a' }), { code: 'config' })
  assert.equal(called, false)
})

test('http: network failure and timeout are reported', async () => {
  const boom = createBalanceSource(httpCfg({}), { fetch: fakeFetch(() => { throw new Error('ECONNRESET') }) })
  await assert.rejects(boom.read({ username: 'a' }), { code: 'http' })
  const slow = createBalanceSource(httpCfg({}), {
    fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
  })
  const keepAlive = setTimeout(() => {}, 2000) // AbortSignal.timeout is unref'd; the real process has its server socket
  await assert.rejects(slow.read({ username: 'a' }), { code: 'timeout' })
  clearTimeout(keepAlive)
})

test('getPath handles nesting, indexes and misses', () => {
  const o = { a: { b: [{ c: 5 }] } }
  assert.equal(getPath(o, 'a.b.0.c'), 5)
  assert.equal(getPath(o, 'a.x.y'), undefined)
  assert.equal(getPath(null, 'a'), undefined)
})
