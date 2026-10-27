import test from 'node:test'
import assert from 'node:assert/strict'
import { AuditLog, normaliseActor } from '../src/audit.js'
import { collectWindow, MessageRing } from '../src/messages.js'
import { rawComponentJson } from '../src/text.js'
import nbt from 'prismarine-nbt'
import { mkdtempSync, readFileSync, chmodSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sleep } from './helpers.js'

const msg = (text, kind = 'system') => ({ ts: Date.now(), kind, text, raw: '' })

test('ring keeps only the last N and numbers messages monotonically', () => {
  const r = new MessageRing(3)
  for (let i = 1; i <= 5; i++) assert.equal(r.push(msg('m' + i)), i)
  assert.deepEqual(r.items.map(m => m.text), ['m3', 'm4', 'm5'])
  assert.equal(r.seq, 5)
  assert.deepEqual(r.since(3).map(m => m.seq), [4, 5])
  assert.deepEqual(r.since(0, 2).map(m => m.seq), [4, 5], 'limit returns the newest')
  assert.deepEqual(r.last(2).map(m => m.text), ['m4', 'm5'])
  assert.equal(r.items.length, 3, 'memory stays bounded')
})

test('capacity 0 stores nothing but still counts', () => {
  const r = new MessageRing(0)
  r.push(msg('a'))
  assert.equal(r.items.length, 0)
  assert.equal(r.seq, 1)
})

test('wait resolves as soon as a message arrives, on timeout, and on abort', async () => {
  const r = new MessageRing(10)
  const p = r.wait(0, { timeoutMs: 1000 })
  setTimeout(() => r.push(msg('late')), 30)
  const t0 = Date.now()
  assert.deepEqual((await p).map(m => m.text), ['late'])
  assert.ok(Date.now() - t0 < 500)
  assert.equal(r.waiters.size, 0)

  assert.deepEqual(await r.wait(r.seq, { timeoutMs: 40 }), [])
  const ac = new AbortController()
  const p2 = r.wait(r.seq, { timeoutMs: 5000, signal: ac.signal })
  setTimeout(() => ac.abort(), 20)
  assert.deepEqual(await p2, [])
  assert.equal(r.waiters.size, 0, 'no leaked waiter')
  assert.deepEqual((await r.wait(0, { timeoutMs: 0 })).length, 1, 'immediate when data exists')
})

// ---- reply collection window ----

function source () {
  const subs = new Set()
  return { subs, subscribe: fn => { subs.add(fn); return () => subs.delete(fn) }, emit: m => subs.forEach(f => f(m)) }
}

test('window collects replies that arrive after a delay, in order, and then stops', async () => {
  const src = source()
  const started = Date.now()
  const p = collectWindow({ subscribe: src.subscribe, start: () => {
    setTimeout(() => src.emit(msg('instant')), 5)
    setTimeout(() => src.emit(msg('delayed')), 120)
    setTimeout(() => src.emit(msg('too late')), 400)
  }, windowMs: 250 })
  const got = await p
  assert.deepEqual(got.map(m => m.text), ['instant', 'delayed'])
  assert.ok(Date.now() - started >= 240, 'waits the whole window, not just for the first reply')
  assert.equal(src.subs.size, 0, 'unsubscribed afterwards')
  await sleep(250)
  assert.equal(got.length, 2, 'late message did not leak into the result')
})

test('window subscribes BEFORE sending, so an immediate reply is not lost', async () => {
  const src = source()
  const got = await collectWindow({ subscribe: src.subscribe, start: () => src.emit(msg('sync reply')), windowMs: 20 })
  assert.deepEqual(got.map(m => m.text), ['sync reply'])
})

test('messages from before the command are not included', async () => {
  const src = source()
  src.emit(msg('before'))
  const got = await collectWindow({ subscribe: src.subscribe, start: () => src.emit(msg('after')), windowMs: 10 })
  assert.deepEqual(got.map(m => m.text), ['after'])
})

test('window is bounded by max and ends early on abort', async () => {
  const src = source()
  const got = await collectWindow({ subscribe: src.subscribe, start: () => { for (let i = 0; i < 500; i++) src.emit(msg('x' + i)) }, windowMs: 10, max: 50 })
  assert.equal(got.length, 50)

  const ac = new AbortController()
  const t0 = Date.now()
  const p = collectWindow({ subscribe: src.subscribe, start: () => setTimeout(() => ac.abort(), 20), windowMs: 5000, signal: ac.signal })
  await p
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(src.subs.size, 0)
})

test('if sending throws, the window rejects and unsubscribes', async () => {
  const src = source()
  await assert.rejects(collectWindow({ subscribe: src.subscribe, start: () => { throw new Error('audit failed') }, windowMs: 1000 }), /audit failed/)
  assert.equal(src.subs.size, 0)
})

// ---- audit + raw ----

test('audit log appends JSON lines (0600) and fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hmc-audit-'))
  const file = join(dir, 'a', 'audit.jsonl')
  const log = new AuditLog(file)
  log.write({ actor: 'cli', action: 'send', bot: 'b1', text: '/bal' })
  log.write({ actor: 'poll', action: 'send', bot: 'b1', text: '/bal' })
  const lines = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(lines.map(l => [l.actor, l.action, l.bot, l.text]), [['cli', 'send', 'b1', '/bal'], ['poll', 'send', 'b1', '/bal']])
  assert.ok(lines[0].ts)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  chmodSync(join(dir, 'a'), 0o500)
  if (process.getuid?.() !== 0) assert.throws(() => log.write({ actor: 'cli', action: 'send' }))
  chmodSync(join(dir, 'a'), 0o700)
})

test('actor header is validated', () => {
  assert.equal(normaliseActor('cli'), 'cli')
  assert.equal(normaliseActor('ops.team-1'), 'ops.team-1')
  for (const bad of [undefined, '', 'CLI', 'a b', 'x'.repeat(33), 'a"b', '../x']) assert.equal(normaliseActor(bad), 'api', String(bad))
})

test('rawComponentJson: JSON strings pass through, NBT becomes JSON, long values are capped', () => {
  assert.equal(rawComponentJson('{"text":"hi"}'), '{"text":"hi"}')
  assert.equal(rawComponentJson(nbt.comp({ text: nbt.string('Money: '), extra: nbt.list(nbt.comp([{ text: nbt.string('$5') }])) })), '{"text":"Money: ","extra":[{"text":"$5"}]}')
  assert.equal(rawComponentJson({ a: 1n }), '{"a":"1"}')
  assert.ok(rawComponentJson('x'.repeat(5000)).length <= 2001)
  assert.equal(rawComponentJson(undefined), '')
})
