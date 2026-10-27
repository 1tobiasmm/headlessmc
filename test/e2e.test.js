import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mc from 'minecraft-protocol'
import { startMockServer } from '../scripts/mock-server.js'
import { createApi } from '../src/api.js'
import { BotManager } from '../src/manager.js'
import { VersionResolver } from '../src/version.js'
import { makeConfig, sleep, waitUntil } from './helpers.js'

// Everything here talks to a local mock server over real sockets. The server's balance wording is
// synthetic; these tests prove the plumbing across protocol versions, not any real server's format.

const VERSIONS = ['1.16.5', '1.19.4', '1.20.1', '1.20.4', '1.21.4', '1.21.8']
const REPLY = 'Mock balance: $1,234.50'

async function withBot (mockOpts, cfgOver, fn) {
  const mock = await startMockServer(mockOpts)
  const clients = []
  const config = makeConfig({ server: { host: '127.0.0.1', port: mock.port, version: mock.version, connectTimeoutMs: 6000 }, ...cfgOver })
  const m = new BotManager(config, { createClient: o => { const c = mc.createClient(o); clients.push(c); return c } })
  try { return await fn({ m, mock, clients, config }) } finally { await m.shutdown(); await mock.close() }
}

for (const version of VERSIONS) {
  test(`[${version}] command source: join, send /bal, parse reply, report`, async () => {
    await withBot({ version, command: '/bal', reply: REPLY }, {}, async ({ m, mock }) => {
      m.startConfigured(['Alpha1'])
      await waitUntil(() => m.get('Alpha1').balance, 8000)
      assert.equal(m.get('Alpha1').balance.amount, 1234.5)
      assert.equal(m.get('Alpha1').balance.raw, REPLY)
      assert.deepEqual(mock.stats.commands, ['/bal'])
      assert.equal(m.reports.recent({ type: 'balance' })[0].source, 'command')
    })
  })

  for (const style of ['team', 'display_name']) {
    test(`[${version}] sidebar source (${style} rows)`, async () => {
      await withBot({ version, sidebar: ['Title', 'Money: $2,000', 'Shards: 3'], sidebarStyle: style },
        { balance: { source: 'sidebar' } }, async ({ m }) => {
          m.startConfigured(['Alpha1'])
          await waitUntil(() => m.get('Alpha1').balance, 8000)
          assert.equal(m.get('Alpha1').balance.amount, 2000)
          assert.equal(m.get('Alpha1').balance.source, 'sidebar')
        })
    })
  }
}

test('tab footer surface', async () => {
  await withBot({ version: '1.21.4', tab: { header: 'Header', footer: 'Online: 3\nMoney: $77' } },
    { balance: { source: 'sidebar', sidebar: { labelPattern: '^Money: (?<amount>\\$\\d+)', surfaces: ['tabFooter'] } } }, async ({ m }) => {
      m.startConfigured(['Alpha1'])
      await waitUntil(() => m.get('Alpha1').balance, 8000)
      assert.equal(m.get('Alpha1').balance.amount, 77)
    })
})

test('action-bar reply is read only when accepted', async () => {
  await withBot({ version: '1.21.4', command: '/bal', reply: REPLY, replyKind: 'actionbar' }, {
    balance: { readTimeoutMs: 400, command: { text: '/bal', replyPattern: 'Mock balance: (?<amount>\\$[\\d,.]+)', accept: ['actionbar'] } }
  }, async ({ m }) => {
    m.startConfigured(['Alpha1'])
    await waitUntil(() => m.get('Alpha1').balance, 8000)
    assert.equal(m.get('Alpha1').balance.amount, 1234.5)
  })
})

test('kick after login: kicked, not retried, cooldown enforced', async () => {
  await withBot({ version: '1.21.4', kickText: 'You have been banned for cheating' }, { kick: { globalPauseSeconds: 0 } }, async ({ m, mock }) => {
    m.startConfigured(['Alpha1'])
    await waitUntil(() => m.get('Alpha1').state === 'kicked', 8000)
    const s = m.get('Alpha1').status()
    assert.equal(s.reason, 'banned')
    assert.match(s.kick.text, /banned for cheating/)
    await sleep(500) // would be ~10 reconnect attempts at the test's 40 ms backoff
    assert.equal(mock.stats.logins, 1)
    assert.equal(m.startConfigured(['Alpha1']).rejected[0].error, 'cooling_down')
    assert.equal(m.reports.recent({ type: 'kick' }).length, 1)
  })
})

test('disconnect during login (e.g. whitelist) is final', async () => {
  await withBot({ version: '1.21.4', loginKickText: 'You are not whitelisted on this server!' }, {}, async ({ m, mock }) => {
    m.startConfigured(['Alpha1'])
    await waitUntil(() => m.get('Alpha1').state === 'kicked', 8000)
    assert.match(m.get('Alpha1').kick.text, /not whitelisted/)
    await sleep(400)
    assert.equal(mock.stats.logins, 0)
    assert.equal(m.get('Alpha1').attempts, 1)
  })
})

for (const polite of [false, true]) {
  test(`server restart (${polite ? 'sends "Server closed"' : 'connection dropped'}): reconnecting with backoff, then rejoins`, async () => {
    const mock = await startMockServer({ version: '1.21.4', command: '/bal', reply: REPLY })
    const port = mock.port
    const config = makeConfig({ server: { host: '127.0.0.1', port, version: '1.21.4', connectTimeoutMs: 3000 }, reconnect: { initialDelayMs: 50, maxDelayMs: 200, jitter: 0 } })
    const m = new BotManager(config)
    let mock2
    try {
      m.startConfigured(['Alpha1'])
      await waitUntil(() => m.get('Alpha1').balance, 8000)
      await mock.close(polite ? { kick: 'Server closed' } : {})
      await waitUntil(() => m.get('Alpha1').state === 'reconnecting', 5000)
      await waitUntil(() => m.get('Alpha1').status().failures >= 2, 5000) // refused while the server is down
      assert.equal(m.get('Alpha1').kick, null, 'a shutdown notice is not a kick')
      mock2 = await startMockServer({ version: '1.21.4', port, command: '/bal', reply: REPLY })
      await waitUntil(() => m.get('Alpha1').state === 'online' && m.get('Alpha1').reads >= 2, 10000)
      assert.ok(m.reports.recent({ type: 'balance' }).length >= 2)
    } finally {
      await m.shutdown()
      await mock2?.close()
    }
  })
}

test('only a whole-message shutdown notice is transient; other kick text is final', async () => {
  await withBot({ version: '1.21.4', kickText: 'Server closed for cheating' }, {}, async ({ m, mock }) => {
    m.startConfigured(['Alpha1'])
    await waitUntil(() => m.get('Alpha1').state === 'kicked', 8000)
    assert.equal(mock.stats.logins, 1)
  })
})

test('lean parsing drops unused packets before deserialising; off parses them', async () => {
  const counts = {}
  for (const lean of [true, false]) {
    await withBot({ version: '1.21.4', command: '/bal', reply: REPLY, traffic: { entityMovesPerSec: 200 } }, { client: { lean } }, async ({ m, clients }) => {
      m.startConfigured(['Alpha1'])
      await waitUntil(() => m.get('Alpha1').balance, 8000)
      const c = clients[0]
      let moves = 0
      let skipped = 0
      c.on('rel_entity_move', () => moves++)
      c.on('lean_skipped', () => skipped++)
      await sleep(600)
      counts[lean] = { moves, skipped }
      assert.equal(m.get('Alpha1').state, 'online', 'chat still works')
    })
  }
  assert.equal(counts.true.moves, 0)
  assert.ok(counts.true.skipped > 50, JSON.stringify(counts))
  assert.ok(counts.false.moves > 50, JSON.stringify(counts))
  assert.equal(counts.false.skipped, 0)
})

test('first-connect dump records raw sidebar, chat components and the command; only once per bot', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hmc-dump-')), 'd.jsonl')
  await withBot({ version: '1.21.4', command: '/bal', reply: REPLY, sidebar: ['Title', 'Money: $5'] },
    { debug: { dump: { enabled: true, file, maxBots: 1, windowSec: 2, maxLines: 100 } }, reconnect: { initialDelayMs: 40, jitter: 0 } }, async ({ m, mock }) => {
      m.startConfigured(['Alpha1'])
      await waitUntil(() => m.get('Alpha1').balance, 8000)
      await sleep(1300) // let the sidebar snapshot interval fire
      const lines = () => readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
      const kinds = lines().map(l => l.kind)
      assert.ok(kinds.includes('meta') && kinds.includes('chat') && kinds.includes('sidebar') && kinds.includes('command_sent'), kinds.join())
      const chat = lines().find(l => l.kind === 'chat')
      assert.equal(chat.data.text, REPLY)
      assert.equal(chat.data.kind, 'system')
      assert.ok(chat.data.raw, 'raw component preserved')
      const side = lines().find(l => l.kind === 'sidebar' && l.data)
      assert.deepEqual(side.data.lines, ['Title', 'Money: $5'])
      assert.ok(side.data.raw[0].prefix, 'raw team prefix preserved')
      assert.equal(lines().find(l => l.kind === 'command_sent').data.text, '/bal')
      // reconnect: no second dump for the same bot
      const before = lines().length
      for (const c of mock.clients) c.socket.destroy()
      await waitUntil(() => mock.stats.logins >= 2, 8000)
      await sleep(300)
      assert.equal(lines().length, before)
    })
  assert.ok(existsSync(file))
})

test('VersionResolver: auto-detects from the status ping and caches', async () => {
  const mock = await startMockServer({ version: '1.20.4' })
  let pings = 0
  const r = new VersionResolver({ ping: o => { pings++; return mc.ping(o) } })
  try {
    const server = { host: '127.0.0.1', port: mock.port, version: 'auto' }
    assert.equal(await r.resolve(server), '1.20.4')
    assert.equal(await r.resolve(server), '1.20.4')
    const [a, b] = await Promise.all([r.resolve({ ...server, port: mock.port }), r.resolve(server)])
    assert.equal(a, b)
    assert.equal(pings, 1)
    assert.equal(await r.resolve({ ...server, version: '1.19.4' }), '1.19.4')
  } finally { await mock.close() }
})

test('many bots through the API: bounded concurrency, staggered joins, reports file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hmc-many-'))
  const reportFile = join(dir, 'reports.jsonl')
  const mock = await startMockServer({ version: '1.21.4', command: '/bal', reply: REPLY })
  const config = makeConfig({
    server: { host: '127.0.0.1', port: mock.port, version: '1.21.4', connectTimeoutMs: 8000 },
    accounts: [],
    accountGroups: [{ idPrefix: 'n', usernamePrefix: 'Nbot', count: 12, pad: 2 }],
    limits: { maxConcurrentBots: 5, maxConcurrentConnecting: 2, joinDelayMs: 30, joinJitterMs: 10 },
    reports: { file: reportFile }
  })
  const m = new BotManager(config)
  const api = createApi({ manager: m, token: 't' })
  const server = await api.listen({ bind: '127.0.0.1', port: 0 })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { authorization: 'Bearer t' }
  try {
    const res = await (await fetch(`${base}/bots/start`, { method: 'POST', headers, body: JSON.stringify({ all: true }) })).json()
    assert.equal(res.accepted.length, 12)
    let maxActive = 0
    await waitUntil(async () => {
      maxActive = Math.max(maxActive, mock.stats.clientsNow)
      return (await (await fetch(`${base}/reports?type=balance&limit=100`, { headers })).json()).reports.length >= 5
    }, 10000)
    assert.ok(maxActive <= 5, `max simultaneously online ${maxActive}`)
    const bots = (await (await fetch(`${base}/bots`, { headers })).json()).bots
    assert.equal(bots.filter(b => b.state === 'online').length, 5)
    assert.equal(bots.filter(b => b.state === 'connecting' && b.detail === 'queued').length, 7)
    // stop one: a queued bot takes its slot
    await fetch(`${base}/bots/stop`, { method: 'POST', headers, body: JSON.stringify({ ids: [bots.find(b => b.state === 'online').id] }) })
    await waitUntil(() => m.countState('online') === 5 && m.countState('stopped') === 1, 8000)
    const bal = await (await fetch(`${base}/bots/${bots.find(b => b.state === 'online').id}/balance`, { headers })).json()
    assert.equal(bal.balance.amount, 1234.5)
    await m.reports.close()
    const lines = readFileSync(reportFile, 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(lines.length >= 5 && lines.every(l => l.type === 'balance' && l.amount === 1234.5))
  } finally {
    await new Promise(resolve => server.close(resolve))
    await m.shutdown()
    await mock.close()
  }
})

test('config reload: a new command applies to the next read; a new source applies after reconnect', async () => {
  await withBot({ version: '1.21.4', commands: { '/bal': REPLY, '/money': 'Wallet: 77 coins' }, sidebar: ['Title', 'Money: $9'] }, { balance: { minReadIntervalSec: 1 } }, async ({ m, config }) => {
    m.startConfigured(['Alpha1'])
    await waitUntil(() => m.get('Alpha1').balance, 8000)
    assert.equal(m.get('Alpha1').balance.amount, 1234.5)

    const reloaded = m.applyConfig(makeConfig({ server: config.server, balance: { minReadIntervalSec: 1, command: { text: '/money', replyPattern: 'Wallet: (?<amount>\\d+) coins' } } }))
    assert.ok(reloaded.changed.includes('balance.command.text'))
    await sleep(1100)
    const r1 = await m.get('Alpha1').refresh()
    assert.equal(r1.amount, 77)

    m.applyConfig(makeConfig({ server: config.server, balance: { source: 'sidebar', minReadIntervalSec: 1 } }))
    m.stop(['Alpha1'])
    m.startConfigured(['Alpha1'])
    await waitUntil(() => m.get('Alpha1').balance?.source === 'sidebar', 8000)
    assert.equal(m.get('Alpha1').balance.amount, 9)
  })
})
