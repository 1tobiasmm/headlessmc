import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { startMockServer } from '../scripts/mock-server.js'
import { createApi } from '../src/api.js'
import { runCli } from '../src/cli.js'
import { BotManager } from '../src/manager.js'
import { makeConfig, sleep, waitUntil } from './helpers.js'

const REPLY = 'Mock balance: $1,234.50'
const TOKEN = 'cli-test-token'

function terminal (argv, env) {
  const input = new PassThrough()
  const output = new PassThrough()
  const errput = new PassThrough()
  let text = ''
  let err = ''
  output.on('data', d => { text += d })
  errput.on('data', d => { err += d })
  const h = runCli({ input, output, errput, env, argv })
  return { send: l => input.write(l + '\n'), end: () => input.end(), interrupt: h.interrupt, done: h.done, get text () { return text }, get err () { return err } }
}

async function stack (mockOpts = {}, cfgOver = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hmc-cli-'))
  const mock = await startMockServer({ version: '1.21.4', commands: { '/bal': REPLY }, replyDelayMs: 300, sidebar: ['Title', 'Money: $2,000'], ...mockOpts })
  const config = makeConfig({
    server: { host: '127.0.0.1', port: mock.port, version: '1.21.4' },
    audit: { file: join(dir, 'audit.jsonl') },
    balance: { minReadIntervalSec: 1 },
    ...cfgOver
  })
  const manager = new BotManager(config)
  const api = createApi({ manager, token: TOKEN })
  const server = await api.listen({ bind: '127.0.0.1', port: 0 })
  const url = `http://127.0.0.1:${server.address().port}`
  const audit = () => readFileSync(config.audit.file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  return {
    dir, mock, manager, url, audit,
    cli: (extra = []) => terminal(['--url', url, ...extra], { HMC_API_TOKEN: TOKEN }),
    async stop () { await new Promise(r => server.close(r)); await manager.shutdown(); await mock.close() }
  }
}

test('refuses to start without the token, with a non-loopback URL, or with bad arguments', async () => {
  let t = terminal([], {})
  assert.equal(await t.done, 2)
  assert.match(t.err, /HMC_API_TOKEN is not set/)
  t = terminal(['--url', 'http://192.168.1.5:8787'], { HMC_API_TOKEN: 'x' })
  assert.equal(await t.done, 2)
  assert.match(t.err, /non-loopback/)
  t = terminal(['--window', '999999'], { HMC_API_TOKEN: 'x' })
  assert.equal(await t.done, 2)
  t = terminal(['--token-env', 'MY_TOKEN'], { HMC_API_TOKEN: 'x' })
  assert.equal(await t.done, 2)
  assert.match(t.err, /MY_TOKEN/)
  t = terminal(['--bogus'], { HMC_API_TOKEN: 'x' })
  assert.equal(await t.done, 2)
})

test('full session: bots, use, /command with delayed reply, say, bal, sidebar, raw, dump, leave, quit', async () => {
  const s = await stack()
  try {
    s.manager.startConfigured(['Alpha1'])
    await waitUntil(() => s.manager.get('Alpha1').balance, 8000)
    await sleep(1100) // past minReadIntervalSec so `bal` is allowed
    const dumpFile = join(s.dir, 'dump.json')

    const t = s.cli(['--window', '800'])
    t.send('bots')
    t.send('say before-select')
    t.send('use Alpha1')
    t.send('/bal')
    t.send('foo bar')
    t.send('say hello world')
    t.send('bal')
    t.send('sidebar')
    t.send('raw on')
    t.send('/bal')
    t.send(`dump ${dumpFile} 50`)
    t.send(`dump ${dumpFile} 50`)
    t.send('leave')
    t.send('quit')
    assert.equal(await t.done, 0)
    const out = t.text

    assert.match(out, /Alpha1\s+online/)
    assert.match(out, /error: no bot selected/)
    assert.match(out, /using Alpha1 \(online\)/)
    assert.match(out, /hmc\[Alpha1\]> /, 'prompt shows the selected bot')

    // the reply arrives 300 ms after the command and is printed under it, inside the window
    const cmdAt = out.indexOf('-> Alpha1: /bal')
    const replyAt = out.indexOf(REPLY, cmdAt)
    assert.ok(cmdAt >= 0 && replyAt > cmdAt, 'delayed reply is printed after the command that caused it')
    assert.match(out.slice(cmdAt, replyAt + 40), /\[Alpha1\]\s+system\s+Mock balance/)
    assert.match(out, /\d{4}-\d\d-\d\dT[\d:.]+Z \[Alpha1\]/, 'ISO timestamp and bot id on every message')

    assert.match(out, /unknown command "foo".*nothing was sent/)
    assert.ok(!s.mock.stats.commands.includes('foo bar'))

    assert.match(out, /balance: 1234\.5\s+\[source: command\]/)
    assert.match(out, /raw:\s+"Mock balance: \$1,234\.50"/)

    assert.match(out, /sidebar: Mock/)
    assert.match(out, /Money: \$2,000/)
    assert.match(out, /tab header: ""/)

    assert.match(out, /raw: \{"text":"Mock balance: \$1,234\.50"\}/, 'raw JSON component shown once raw is on')

    assert.match(out, /saved \d+ messages and the sidebar to /)
    assert.match(out, /already exists; choose another name/)
    const dump = JSON.parse(readFileSync(dumpFile, 'utf8'))
    assert.equal(dump.bot, 'Alpha1')
    assert.ok(dump.messages.some(m => m.text === REPLY && m.raw.includes('Mock balance')))
    assert.deepEqual(dump.sidebar.lines, ['Title', 'Money: $2,000'])

    assert.match(out, /Alpha1: stopped/)
    await waitUntil(() => s.manager.get('Alpha1').state === 'stopped')

    // audit: everything the CLI sent is on record with actor "cli"
    const sent = s.audit().filter(a => a.action === 'send')
    const byActor = a => sent.filter(x => x.actor === a).map(x => x.text)
    assert.deepEqual(byActor('cli'), ['/bal', 'hello world', '/bal', '/bal'], 'say /bal, say hello, bal (refresh), say /bal')
    assert.deepEqual(byActor('poll'), ['/bal'], 'the automatic read is labelled "poll"')
    assert.deepEqual(s.mock.stats.commands.filter(c => c === '/bal').length, 4 + 0, 'every audited /bal really reached the server')
    assert.ok(s.audit().some(a => a.action === 'stop' && a.actor === 'cli'))
  } finally { await s.stop() }
})

test('reply window: delay inside the window is shown, delay outside is not', async () => {
  const s = await stack({ replyDelayMs: 500 })
  try {
    s.manager.startConfigured(['Alpha1'])
    await waitUntil(() => s.manager.get('Alpha1').balance, 8000)
    const t = s.cli(['--bot', 'Alpha1', '--window', '150'])
    t.send('/bal')
    await waitUntil(() => /no messages received in 150 ms/.test(t.text), 3000)
    assert.ok(!t.text.slice(t.text.indexOf('-> Alpha1')).includes('Mock balance'), 'late reply is not printed under the command')
    t.send('window 1500')
    t.send('/bal')
    await waitUntil(() => t.text.slice(t.text.lastIndexOf('-> Alpha1')).includes('Mock balance: $1,234.50'), 4000)
    assert.ok(t.text.lastIndexOf('reply window 1500 ms') < t.text.lastIndexOf('-> Alpha1'))
    t.send('quit')
    assert.equal(await t.done, 0)
  } finally { await s.stop() }
})

test('tail streams new messages with timestamp and bot id until interrupted, then the prompt returns', async () => {
  const s = await stack()
  try {
    s.manager.startConfigured(['Alpha1'])
    await waitUntil(() => s.manager.get('Alpha1').balance, 8000)
    const t = s.cli(['--bot', 'Alpha1'])
    t.send('tail')
    await waitUntil(() => t.text.includes('tailing Alpha1'), 3000)
    for (const c of s.mock.clients) s.mock.sendSystem(c, 'Server notice one')
    for (const c of s.mock.clients) s.mock.sendSystem(c, 'Hotbar text', 'actionbar')
    await waitUntil(() => t.text.includes('Hotbar text'), 3000)
    assert.match(t.text, /\d{4}-\d\d-\d\dT[\d:.]+Z \[Alpha1\] system\s+Server notice one/)
    assert.match(t.text, /\[Alpha1\] actionbar\s+Hotbar text/)
    assert.ok(!t.text.includes('tail stopped'))
    t.interrupt() // Ctrl+C
    await waitUntil(() => t.text.includes('-- tail stopped --'), 3000)
    t.send('bots') // the CLI is still alive and the prompt works
    await waitUntil(() => /Alpha1\s+online/.test(t.text.slice(t.text.indexOf('tail stopped'))), 3000)
    t.send('quit')
    assert.equal(await t.done, 0)
  } finally { await s.stop() }
})

test('tail N shows backlog first; raw on shows the component under each line', async () => {
  const s = await stack()
  try {
    s.manager.startConfigured(['Alpha1'])
    await waitUntil(() => s.manager.get('Alpha1').balance, 8000)
    const t = s.cli(['--bot', 'Alpha1'])
    t.send('raw on')
    t.send('tail 5')
    await waitUntil(() => t.text.includes('tailing Alpha1'), 3000)
    assert.match(t.text, /\[Alpha1\] system\s+Mock balance: \$1,234\.50\n\s+raw: \{"text":"Mock balance: \$1,234\.50"\}/)
    assert.match(t.text, /\[Alpha1\] event\s+online/)
    t.interrupt()
    t.send('quit')
    assert.equal(await t.done, 0)
  } finally { await s.stop() }
})

test('errors are shown, never thrown: unknown bot, API down, wrong token, rate-limited bal', async () => {
  const s = await stack()
  try {
    s.manager.startConfigured(['Alpha1'])
    await waitUntil(() => s.manager.get('Alpha1').balance, 8000)
    const t = s.cli()
    t.send('use ghost')
    t.send('use Alpha1')
    t.send('bal') // within minReadIntervalSec of the automatic read
    t.send('join') // already running
    t.send('quit')
    assert.equal(await t.done, 0)
    assert.match(t.text, /error: not_found: no bot with id ghost/)
    assert.match(t.text, /rate-limited: retry in \d+ s/)
    assert.match(t.text, /Alpha1: already_running/)

    const wrong = terminal(['--url', s.url], { HMC_API_TOKEN: 'wrong' })
    wrong.send('bots')
    wrong.send('quit')
    await wrong.done
    assert.match(wrong.text, /error: unauthorized/)

    const down = terminal(['--url', 'http://127.0.0.1:1'], { HMC_API_TOKEN: 'x' })
    down.send('bots')
    down.send('quit')
    await down.done
    assert.match(down.text, /cannot reach the API at http:\/\/127\.0\.0\.1:1/)
  } finally { await s.stop() }
})

test('piped, non-interactive use works (no TTY)', async () => {
  const s = await stack()
  try {
    s.manager.startConfigured(['Alpha1'])
    await waitUntil(() => s.manager.get('Alpha1').balance, 8000)
    const t = s.cli(['--bot', 'Alpha1', '--window', '600'])
    t.send('/bal')
    t.end() // EOF instead of quit
    assert.equal(await t.done, 0)
    assert.match(t.text, /Mock balance: \$1,234\.50/, 'output is flushed before exit on EOF')
  } finally { await s.stop() }
})

test('dump refuses to clobber and writes with mode 0600', async () => {
  const s = await stack()
  try {
    s.manager.startConfigured(['Alpha1'])
    await waitUntil(() => s.manager.get('Alpha1').balance, 8000)
    const f = join(s.dir, 'existing.json')
    writeFileSync(f, 'precious')
    const t = s.cli(['--bot', 'Alpha1'])
    t.send(`dump ${f}`)
    t.send(`dump ${join(s.dir, 'new.json')} 10`)
    t.send('quit')
    await t.done
    assert.equal(readFileSync(f, 'utf8'), 'precious')
    assert.ok(existsSync(join(s.dir, 'new.json')))
    const { statSync } = await import('node:fs')
    assert.equal(statSync(join(s.dir, 'new.json')).mode & 0o777, 0o600)
  } finally { await s.stop() }
})
