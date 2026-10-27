import test from 'node:test'
import assert from 'node:assert/strict'
import nbt from 'prismarine-nbt'
import { BotManager } from '../src/manager.js'
import { ReportHub } from '../src/reports.js'
import { FakeClient, makeConfig, sleep, waitUntil } from './helpers.js'

/** Manager whose bots talk to scripted FakeClients. `script(client, opts, n)` runs after creation. */
function rig (over = {}, script = () => {}, env = {}) {
  const clients = []
  const optsSeen = []
  const createClient = (opts) => {
    const c = new FakeClient()
    clients.push(c)
    optsSeen.push(opts)
    setTimeout(() => script(c, opts, clients.length), 0)
    return c
  }
  const config = makeConfig({ server: { host: '127.0.0.1', port: 1, version: '1.21.4', connectTimeoutMs: 300 }, ...over })
  const reports = new ReportHub({ file: null, keepRecent: 50, webhook: null })
  const audit = []
  const m = new BotManager(config, { createClient, reports, env, audit: { write: e => audit.push(e) } })
  return { m, clients, optsSeen, reports, audit, bot: id => m.get(id) }
}
const online = c => c.emit('login', {})
const sysChat = (c, text) => c.emit('system_chat', { content: nbt.comp({ text: nbt.string(text) }), isActionBar: false })

test('happy path: login, command sent, reply parsed, report emitted', async () => {
  const { m, clients, reports } = rig({}, c => {
    online(c)
    c.chat = text => { c.written.push(['chat', text]); setTimeout(() => sysChat(c, 'Mock balance: $10,000.50'), 5) }
  })
  m.startConfigured(['Alpha1'])
  await waitUntil(() => m.get('Alpha1').balance)
  assert.equal(m.get('Alpha1').state, 'online')
  assert.deepEqual(clients[0].written.filter(w => w[0] === 'chat'), [['chat', '/bal']])
  const r = reports.recent({ type: 'balance' })[0]
  assert.equal(r.amount, 10000.5)
  assert.equal(r.raw, 'Mock balance: $10,000.50')
  assert.equal(r.source, 'command')
  assert.equal(r.id, 'Alpha1')
  // the read's own listener is gone; only the message-ring tap (observe.messageBuffer) remains
  assert.equal(clients[0].listenerCount('system_chat'), 1)
  await m.shutdown()
})

test('no reply: balance_error report, bot stays online and does not hammer the command', async () => {
  const { m, clients, reports } = rig({ balance: { readTimeoutMs: 80 } }, c => { online(c) })
  m.startConfigured(['Alpha1'])
  await waitUntil(() => reports.recent({ type: 'balance_error' }).length === 1)
  assert.equal(m.get('Alpha1').state, 'online')
  assert.equal(reports.recent({ type: 'balance_error' })[0].error, 'timeout')
  await sleep(200)
  assert.equal(clients[0].written.filter(w => w[0] === 'chat').length, 1, 'pollIntervalSec 0 reads once')
  await m.shutdown()
})

test('kick text stops the bot for good: no reconnect, state kicked', async () => {
  const { m, clients, reports } = rig({}, c => { online(c); setTimeout(() => c.emit('kick_disconnect', { reason: JSON.stringify({ text: 'Flying is not enabled' }) }), 10) })
  m.startConfigured(['Alpha1'])
  await waitUntil(() => m.get('Alpha1').state === 'kicked')
  await sleep(300) // several backoff periods
  assert.equal(clients.length, 1)
  const s = m.get('Alpha1').status()
  assert.equal(s.state, 'kicked')
  assert.equal(s.reason, 'kicked')
  assert.equal(s.kick.text, 'Flying is not enabled')
  assert.equal(s.kick.ban, false)
  assert.equal(clients[0].ended, true)
  assert.equal(reports.recent({ type: 'kick' }).length, 1)
  await m.shutdown()
})

test('ban text is classified as banned and gets the longer cooldown', async () => {
  const { m } = rig({ kick: { cooldownSeconds: 60, banCooldownSeconds: 7200 } }, c => { c.emit('disconnect', { reason: JSON.stringify({ text: 'You are permanently banned from this server' }) }) })
  m.startConfigured(['Alpha1'])
  await waitUntil(() => m.get('Alpha1').state === 'kicked')
  const s = m.get('Alpha1').status()
  assert.equal(s.reason, 'banned')
  assert.equal(s.kick.ban, true)
  assert.ok(m.cooldowns.get('Alpha1') - Date.now() > 7000 * 1000)
  await m.shutdown()
})

test('a login-state disconnect (e.g. throttling) is final too', async () => {
  const { m, clients } = rig({}, c => { c.emit('disconnect', { reason: JSON.stringify({ text: 'Connection throttled! Please wait before reconnecting.' }) }) })
  m.startConfigured(['Alpha1'])
  await waitUntil(() => m.get('Alpha1').state === 'kicked')
  await sleep(200)
  assert.equal(clients.length, 1)
  await m.shutdown()
})

test('dropped connection: reconnecting with exponential backoff, then back online', async () => {
  const { m, clients } = rig({ reconnect: { initialDelayMs: 60, maxDelayMs: 1000, factor: 2, jitter: 0, resetAfterMs: 60000 } }, (c, o, n) => {
    if (n <= 2) { c.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:1')) } else online(c)
  })
  m.startConfigured(['Alpha1'])
  await waitUntil(() => m.get('Alpha1').state === 'reconnecting')
  let s = m.get('Alpha1').status()
  assert.equal(s.failures, 1)
  const d1 = Date.parse(s.nextAttemptAt) - Date.now()
  assert.ok(d1 > 0 && d1 <= 60, `first delay ${d1}`)
  await waitUntil(() => m.get('Alpha1').status().failures === 2)
  s = m.get('Alpha1').status()
  const d2 = Date.parse(s.nextAttemptAt) - Date.now()
  assert.ok(d2 > 60 && d2 <= 120, `second delay ${d2}`)
  await waitUntil(() => m.get('Alpha1').state === 'online', 3000)
  assert.equal(clients.length, 3)
  assert.equal(m.get('Alpha1').status().attempts, 3)
  await m.shutdown()
})

test('failures reset after a long enough stay online', async () => {
  const { m } = rig({ reconnect: { initialDelayMs: 30, maxDelayMs: 100, factor: 2, jitter: 0, resetAfterMs: 40 } }, (c, o, n) => {
    if (n === 1) { c.emit('error', new Error('refused')) } else if (n === 2) { online(c); setTimeout(() => c.emit('end', 'socketClosed'), 80) } else online(c)
  })
  m.startConfigured(['Alpha1'])
  await waitUntil(() => m.get('Alpha1').status().attempts === 3 && m.get('Alpha1').state === 'online', 3000)
  assert.equal(m.get('Alpha1').status().failures, 1, 'one failure after the long stay, not two')
  await m.shutdown()
})

test('maxAttempts turns persistent failure into stopped', async () => {
  const { m } = rig({ reconnect: { initialDelayMs: 20, maxDelayMs: 20, jitter: 0, maxAttempts: 2 } }, c => { c.emit('error', new Error('refused')) })
  m.startConfigured(['Alpha1'])
  await waitUntil(() => m.get('Alpha1').state === 'stopped', 3000)
  assert.equal(m.get('Alpha1').reason, 'max_attempts')
  await m.shutdown()
})

test('reconnect disabled: a drop ends the bot', async () => {
  const { m } = rig({ reconnect: { enabled: false } }, c => { online(c); setTimeout(() => c.emit('end', 'socketClosed'), 10) })
  m.startConfigured(['Alpha1'])
  await waitUntil(() => m.get('Alpha1').state === 'stopped')
  assert.equal(m.get('Alpha1').reason, 'reconnect_disabled')
  await m.shutdown()
})

test('connect timeout counts as a failure and retries', async () => {
  const { m } = rig({ server: { connectTimeoutMs: 60 } }, () => {})
  m.startConfigured(['Alpha1'])
  await waitUntil(() => m.get('Alpha1').state === 'reconnecting')
  assert.match(m.get('Alpha1').lastError.message, /connect timeout/)
  await m.shutdown()
})

test('microsoft account with a cold cache stops with auth_required instead of prompting', async () => {
  const { m, optsSeen } = rig({ accounts: [{ username: 'Msa_1', auth: 'microsoft' }] }, (c, opts) => {
    try { opts.onMsaCode({ message: 'visit microsoft.com/link' }) } catch (e) { c.emit('error', e) }
  })
  m.startConfigured(['Msa_1'])
  await waitUntil(() => m.get('Msa_1').state === 'stopped')
  assert.equal(m.get('Msa_1').reason, 'auth_required')
  assert.equal(optsSeen[0].auth, 'microsoft')
  assert.ok(optsSeen[0].profilesFolder)
  await sleep(100)
  assert.equal(optsSeen.length, 1, 'no retry loop against Microsoft')
  await m.shutdown()
})

test('token accounts read credentials from the environment; missing env stops the bot', async () => {
  const acct = { username: 'Tok_1', auth: 'token', accessTokenEnv: 'T_ACCESS', profileIdEnv: 'T_UUID' }
  const missing = rig({ accounts: [acct] })
  missing.m.startConfigured(['Tok_1'])
  await waitUntil(() => missing.m.get('Tok_1').state === 'stopped')
  assert.equal(missing.m.get('Tok_1').reason, 'auth_env_missing')
  await missing.m.shutdown()

  const ok = rig({ accounts: [acct] }, c => online(c), { T_ACCESS: 'tkn', T_UUID: '11111111-2222-3333-4444-555555555555' })
  ok.m.startConfigured(['Tok_1'])
  await waitUntil(() => ok.m.get('Tok_1').state === 'online')
  const opts = ok.optsSeen[0]
  assert.equal(typeof opts.auth, 'function')
  const fake = new FakeClient()
  let connected = false
  opts.auth(fake, { connect: () => { connected = true } })
  assert.equal(fake.session.accessToken, 'tkn')
  assert.equal(fake.session.selectedProfile.id, '11111111222233334444555555555555')
  assert.equal(connected, true)
  assert.ok(!JSON.stringify(ok.m.list()).includes('tkn'), 'secrets never appear in status')
  await ok.m.shutdown()
})

test('an unsupported protocol version is terminal', async () => {
  const { m, clients } = rig({}, c => { c.emit('error', new Error("Unsupported protocol version '999'")) })
  m.startConfigured(['Alpha1'])
  await waitUntil(() => m.get('Alpha1').state === 'stopped')
  assert.equal(m.get('Alpha1').reason, 'unsupported_version')
  await sleep(100)
  assert.equal(clients.length, 1)
  await m.shutdown()
})

test('protocol upkeep: resource packs declined, ping answered, chunk batches acknowledged', async () => {
  const { m, clients } = rig({ balance: { readyDelayMs: 5000 } }, c => online(c))
  m.startConfigured(['Alpha1'])
  await waitUntil(() => m.get('Alpha1').state === 'online')
  const c = clients[0]
  c.emit('add_resource_pack', { uuid: 'aaaa', url: 'http://x', hash: 'h', forced: true })
  c.emit('ping', { id: 7 })
  c.emit('chunk_batch_finished', { batchSize: 3 })
  assert.deepEqual(c.written.map(w => w[0]), ['resource_pack_receive', 'pong', 'chunk_batch_received'])
  assert.equal(c.written[0][1].result, 1)
  assert.equal(c.written[1][1].id, 7)
  await m.shutdown()
})

test('stop() during the handshake leaves no timers or sockets behind', async () => {
  const { m, clients } = rig({ server: { connectTimeoutMs: 5000 } }, () => {})
  m.startConfigured(['Alpha1'])
  await waitUntil(() => clients.length === 1)
  const bot = m.get('Alpha1')
  assert.ok(bot.timers.connect)
  m.stop(['Alpha1'])
  assert.deepEqual(Object.values(bot.timers), [null, null, null])
  assert.equal(clients[0].ended, true)
  assert.equal(bot.phase, 'idle')
  assert.equal(clients[0].listenerCount('login'), 0)
  assert.doesNotThrow(() => clients[0].emit('error', new Error('late')), 'late errors are swallowed, not thrown')
  await m.shutdown()
})

test('manual refresh is rate-limited by minReadIntervalSec', async () => {
  const { m } = rig({ balance: { minReadIntervalSec: 60, readTimeoutMs: 50 } }, c => {
    online(c)
    c.chat = () => setTimeout(() => sysChat(c, 'Mock balance: $1'), 5)
  })
  m.startConfigured(['Alpha1'])
  await waitUntil(() => m.get('Alpha1').balance)
  await assert.rejects(m.get('Alpha1').refresh(), e => e.code === 'too_soon' && e.retryAfterSec > 50)
  await m.shutdown()
})

test('polling schedules repeated reads at the configured interval', async () => {
  let replies = 0
  const { m, reports } = rig({ balance: { pollIntervalSec: 1, minReadIntervalSec: 1, readyDelayMs: 10 } }, c => {
    online(c)
    c.chat = () => setTimeout(() => sysChat(c, `Mock balance: $${++replies}`), 5)
  })
  m.startConfigured(['Alpha1'])
  await waitUntil(() => reports.recent({ type: 'balance' }).length >= 2, 4000)
  assert.deepEqual(reports.recent({ type: 'balance' }).map(r => r.amount).reverse().slice(0, 2), [1, 2])
  await m.shutdown()
})

// ---- say / audit / message ring (CLI support) ----

/** A rig whose fake client answers `/bal` after `delay` ms and ignores everything else. */
function chatRig (over = {}, delay = 30) {
  return rig({ balance: { readyDelayMs: 60000 }, ...over }, c => {
    online(c)
    c.chat = text => { c.written.push(['chat', text]); if (text === '/bal') setTimeout(() => sysChat(c, 'Mock balance: $42'), delay) }
  })
}

test('say: sends text, audits it with the actor BEFORE sending, and returns delayed replies', async () => {
  const r = chatRig({}, 120)
  r.m.startConfigured(['Alpha1'])
  await waitUntil(() => r.m.get('Alpha1').state === 'online')
  const res = await r.m.get('Alpha1').say('/bal', 400, 'cli')
  assert.equal(res.kind, 'command')
  assert.deepEqual(res.messages.map(m => m.text), ['Mock balance: $42'])
  assert.equal(res.messages[0].kind, 'system')
  assert.ok(res.messages[0].raw.includes('Mock balance'))
  assert.deepEqual(r.audit.filter(a => a.action === 'send'), [{ actor: 'cli', action: 'send', bot: 'Alpha1', text: '/bal' }])
  assert.equal(r.clients[0].listenerCount('system_chat'), 1, 'only the ring tap remains after the window')
  await r.m.shutdown()
})

test('say: a reply arriving after the window is not attached to the command', async () => {
  const r = chatRig({}, 300)
  r.m.startConfigured(['Alpha1'])
  await waitUntil(() => r.m.get('Alpha1').state === 'online')
  const res = await r.m.get('Alpha1').say('/bal', 100, 'cli')
  assert.deepEqual(res.messages, [])
  await sleep(300)
  assert.ok(r.m.get('Alpha1').ring.items.some(m => m.text === 'Mock balance: $42'), 'but tail / the ring still sees it')
  await r.m.shutdown()
})

test('say: plain text is chat; not-online bots refuse; audit failure prevents the send', async () => {
  const r = chatRig()
  r.m.startConfigured(['Alpha1'])
  await waitUntil(() => r.m.get('Alpha1').state === 'online')
  const bot = r.m.get('Alpha1')
  assert.equal((await bot.say('hello there', 0, 'cli')).kind, 'chat')
  assert.deepEqual(r.clients[0].written.at(-1), ['chat', 'hello there'])

  const before = r.clients[0].written.length
  r.m.audit = { write () { throw new Error('disk full') } }
  await assert.rejects(bot.say('/bal', 50, 'cli'), /disk full/)
  assert.equal(r.clients[0].written.length, before, 'nothing was sent without an audit record')
  assert.equal(bot._chatSubs.size, 1, 'window subscription cleaned up after the failure')

  bot.stop()
  await assert.rejects(bot.say('/bal', 10, 'cli'), { code: 'not_online' })
  await r.m.shutdown()
})

test('stopping the bot ends an open reply window immediately', async () => {
  const r = chatRig()
  r.m.startConfigured(['Alpha1'])
  await waitUntil(() => r.m.get('Alpha1').state === 'online')
  const t0 = Date.now()
  const p = r.m.get('Alpha1').say('hello', 10000, 'cli')
  setTimeout(() => r.m.stop(['Alpha1']), 30)
  await p
  assert.ok(Date.now() - t0 < 2000)
  await r.m.shutdown()
})

test('scheduled polls are audited as actor "poll" unless audit.polls is false; API refresh uses its actor', async () => {
  const a = chatRig({ balance: { readyDelayMs: 10 } })
  a.m.startConfigured(['Alpha1'])
  await waitUntil(() => a.m.get('Alpha1').balance)
  assert.deepEqual(a.audit.filter(x => x.action === 'send'), [{ actor: 'poll', action: 'send', bot: 'Alpha1', text: '/bal' }])
  await a.m.shutdown()

  const b = chatRig({ balance: { readyDelayMs: 10 }, audit: { polls: false } })
  b.m.startConfigured(['Alpha1'])
  await waitUntil(() => b.m.get('Alpha1').balance)
  assert.deepEqual(b.audit, [])
  await sleep(1100)
  await b.m.get('Alpha1').refresh('cli')
  assert.deepEqual(b.audit, [{ actor: 'cli', action: 'send', bot: 'Alpha1', text: '/bal' }], 'a CLI-triggered read is always audited')
  await b.m.shutdown()
})

test('ring: captures chat/system/action-bar with raw JSON, plus connection events; bounded; survives reconnect', async () => {
  const r = rig({ observe: { messageBuffer: 3 }, reconnect: { initialDelayMs: 30, jitter: 0 } }, (c, o, n) => {
    online(c)
    if (n === 1) setTimeout(() => c.emit('end', 'socketClosed'), 150)
  })
  r.m.startConfigured(['Alpha1'])
  await waitUntil(() => r.m.get('Alpha1').state === 'online')
  const c = r.clients[0]
  c.emit('system_chat', { content: JSON.stringify({ text: 'one', color: 'red' }), isActionBar: false })
  c.emit('system_chat', { content: nbt.comp({ text: nbt.string('two') }), isActionBar: true })
  c.emit('player_chat', { plainMessage: 'three', unsignedChatContent: null })
  const ring = r.m.get('Alpha1').ring
  assert.deepEqual(ring.items.map(m => [m.kind, m.text]), [['system', 'one'], ['actionbar', 'two'], ['player', 'three']])
  assert.equal(ring.items[0].raw, '{"text":"one","color":"red"}')
  assert.equal(ring.items[1].raw, '{"text":"two"}')
  assert.equal(ring.items.length, 3, 'capacity respected (the online event was pushed out)')
  await waitUntil(() => ring.items.some(m => m.text.startsWith('connection lost')) || r.clients.length === 2, 3000)
  await waitUntil(() => r.m.get('Alpha1').state === 'online' && r.clients.length === 2)
  assert.ok(ring.seq > 3 && ring.items.length === 3)
  await r.m.shutdown()
})

test('ring records the kick text; messageBuffer 0 keeps nothing but say still collects', async () => {
  const k = rig({}, c => { online(c); setTimeout(() => c.emit('kick_disconnect', { reason: JSON.stringify({ text: 'Bye now' }) }), 20) })
  k.m.startConfigured(['Alpha1'])
  await waitUntil(() => k.m.get('Alpha1').state === 'kicked')
  assert.ok(k.m.get('Alpha1').ring.items.some(m => m.kind === 'event' && m.text === 'kicked: Bye now'))
  await k.m.shutdown()

  const z = chatRig({ observe: { messageBuffer: 0 } }, 20)
  z.m.startConfigured(['Alpha1'])
  await waitUntil(() => z.m.get('Alpha1').state === 'online')
  assert.equal(z.clients[0].listenerCount('system_chat'), 0, 'no permanent tap when the buffer is off')
  const res = await z.m.get('Alpha1').say('/bal', 200, 'cli')
  assert.equal(res.messages.length, 1)
  assert.equal(z.m.get('Alpha1').ring.items.length, 0)
  await z.m.shutdown()
})

test('sidebar() is available while online and tracks scoreboard packets; null when tracking is off', async () => {
  const on = rig({}, c => online(c))
  on.m.startConfigured(['Alpha1'])
  await waitUntil(() => on.m.get('Alpha1').state === 'online')
  const c = on.clients[0]
  c.emit('scoreboard_objective', { name: 's', action: 0, displayText: JSON.stringify({ text: 'T' }) })
  c.emit('scoreboard_display_objective', { position: 1, name: 's' })
  c.emit('scoreboard_score', { itemName: 'Money: 5', action: 0, scoreName: 's', value: 1 })
  assert.deepEqual(on.m.get('Alpha1').sidebar().sidebar.lines, ['Money: 5'])
  await on.m.shutdown()

  const off = rig({ observe: { trackScoreboard: false } }, c => online(c))
  off.m.startConfigured(['Alpha1'])
  await waitUntil(() => off.m.get('Alpha1').state === 'online')
  assert.equal(off.m.get('Alpha1').sidebar(), null)
  await off.m.shutdown()
})
