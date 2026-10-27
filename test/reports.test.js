import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReportHub } from '../src/reports.js'
import { sleep, waitUntil } from './helpers.js'

const cfg = (over = {}) => ({ file: null, keepRecent: 3, webhook: null, ...over })
const wh = (over = {}) => ({ url: 'https://hook.example.test/in', tokenEnv: undefined, timeoutMs: 100, maxQueue: 3, maxAttempts: 3, ...over })
const ok = () => new Response(null, { status: 204 })

test('ring keeps the newest N, newest first, with filters', () => {
  const h = new ReportHub(cfg())
  for (let i = 0; i < 5; i++) h.emit({ type: i % 2 ? 'balance' : 'kick', id: 'a' + i })
  assert.deepEqual(h.recent().map(r => r.id), ['a4', 'a3', 'a2'])
  assert.deepEqual(h.recent({ type: 'balance' }).map(r => r.id), ['a3'])
  assert.deepEqual(h.recent({ id: 'a2' }).map(r => r.id), ['a2'])
  assert.equal(h.recent({ limit: 1 }).length, 1)
  assert.ok(h.recent()[0].ts)
})

test('writes JSON lines to the file', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hmc-rep-')), 'sub', 'r.jsonl')
  const h = new ReportHub(cfg({ file }))
  h.emit({ type: 'balance', id: 'a', amount: 5 })
  h.emit({ type: 'balance', id: 'b', amount: 6 })
  await h.close()
  const lines = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(lines.map(l => [l.id, l.amount]), [['a', 5], ['b', 6]])
})

test('webhook posts every report as JSON with the bearer token from the environment', async () => {
  const calls = []
  const h = new ReportHub(cfg({ webhook: wh({ tokenEnv: 'HOOK_TOKEN' }) }), { env: { HOOK_TOKEN: 'tok' }, fetch: async (url, init) => { calls.push({ url, init }); return ok() } })
  h.emit({ type: 'balance', id: 'a', amount: 1 })
  h.emit({ type: 'balance', id: 'b', amount: 2 })
  await waitUntil(() => h.stats.webhookSent === 2)
  assert.equal(calls[0].url, 'https://hook.example.test/in')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok')
  assert.equal(JSON.parse(calls[1].init.body).id, 'b')
  await h.close()
})

test('webhook retries 5xx with backoff, then gives up; 4xx is not retried', async () => {
  let n = 0
  const sleeps = []
  const h = new ReportHub(cfg({ webhook: wh() }), { sleep: async ms => sleeps.push(ms), fetch: async () => { n++; return new Response(null, { status: 503 }) } })
  h.emit({ type: 'balance', id: 'a' })
  await waitUntil(() => h.stats.webhookFailed === 1)
  assert.equal(n, 3)
  assert.deepEqual(sleeps, [1000, 2000])

  n = 0
  const h2 = new ReportHub(cfg({ webhook: wh() }), { fetch: async () => { n++; return new Response(null, { status: 400 }) } })
  h2.emit({ type: 'balance', id: 'a' })
  await waitUntil(() => h2.stats.webhookFailed === 1)
  assert.equal(n, 1)
  await h.close(); await h2.close()
})

test('webhook queue is bounded: oldest reports are dropped', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const seen = []
  const h = new ReportHub(cfg({ webhook: wh({ maxQueue: 2 }) }), { fetch: async (u, init) => { seen.push(JSON.parse(init.body).id); await gate; return ok() } })
  for (const id of ['a', 'b', 'c', 'd', 'e']) h.emit({ type: 'balance', id })
  await sleep(10)
  assert.equal(h.stats.webhookDropped, 2) // a is in flight; b,c queued then pushed out by d,e
  release()
  await waitUntil(() => h.stats.webhookSent === 3)
  assert.deepEqual(seen, ['a', 'd', 'e'])
  await h.close()
})

test('a failing webhook never blocks or throws into emit', async () => {
  const h = new ReportHub(cfg({ webhook: wh({ maxAttempts: 1 }) }), { fetch: async () => { throw new Error('down') } })
  assert.doesNotThrow(() => h.emit({ type: 'balance', id: 'a' }))
  await waitUntil(() => h.stats.webhookFailed === 1)
  await h.close()
})
