#!/usr/bin/env node
/**
 * Measures memory and CPU of the real bot process holding N bots against a local mock server.
 *
 *   npm run bench -- --bots 10,50,100 --duration 30 --traffic idle --lean both
 *
 * The mock server runs in its own process, so the measured process contains only the bots.
 * What this does and does not tell you:
 *  - It measures this program's own cost per bot (sockets, protocol parsing, our state) under
 *    synthetic traffic from a loopback mock. It does not include a real server's chunk/entity
 *    traffic, TLS/auth, or network latency, so real-server CPU will be higher.
 *  - Numbers depend on the machine; the report prints the CPU model and Node version.
 * Linux only (reads /proc).
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, platform, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

if (platform() !== 'linux') { process.stderr.write('benchmark needs Linux (/proc)\n'); process.exit(2) }

const root = fileURLToPath(new URL('..', import.meta.url))
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def }
const botCounts = arg('bots', '10,50,100').split(',').map(Number)
const durationSec = Number(arg('duration', 30))
const version = arg('version', '1.21.4')
const traffic = arg('traffic', 'idle') // idle | busy
const leanModes = arg('lean', 'on') === 'both' ? [true, false] : [arg('lean', 'on') !== 'off']
const outFile = arg('out', null)
const observe = arg('observe', 'on') !== 'off' // off = no message ring, no scoreboard tracking (CLI features disabled)

const TRAFFIC = {
  idle: { moves: 0, sidebarUpdates: 1, chat: 0 }, // keep-alives + a 1 Hz sidebar change per bot
  busy: { moves: 50, sidebarUpdates: 1, chat: 1 } // + 50 entity-move packets/s and 1 chat line/s per bot
}[traffic]
if (!TRAFFIC) { process.stderr.write('--traffic must be idle or busy\n'); process.exit(2) }

const CLK = Number(await new Promise(resolve => {
  const p = spawn('getconf', ['CLK_TCK']); let o = ''; p.stdout.on('data', d => (o += d)); p.on('close', () => resolve(o.trim() || 100))
}))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = m => process.stderr.write(m + '\n')

const freePort = () => new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })

function procStat (pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const cpuSec = (Number(f[11]) + Number(f[12])) / CLK // utime + stime
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  const rssKB = Number(/VmRSS:\s+(\d+)/.exec(status)[1])
  let pssKB = null
  try { pssKB = Number(/Pss:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))[1]) } catch { /* needs permission */ }
  return { cpuSec, rssMB: rssKB / 1024, pssMB: pssKB == null ? null : pssKB / 1024 }
}
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d)

async function runOnce (n, lean) {
  const dir = mkdtempSync(join(tmpdir(), 'hmc-bench-'))
  const mockPort = await freePort()
  const apiPort = await freePort()
  const children = []
  const kill = () => children.forEach(c => { try { c.kill('SIGKILL') } catch { /* gone */ } })
  process.once('exit', kill)
  try {
    const mock = spawn(process.execPath, [join(root, 'scripts/mock-server.js'), '--version', version, '--port', String(mockPort),
      '--moves', String(TRAFFIC.moves), '--sidebar-updates', String(TRAFFIC.sidebarUpdates), '--chat', String(TRAFFIC.chat)], { stdio: ['ignore', 'pipe', 'inherit'] })
    children.push(mock)
    await new Promise((resolve, reject) => { mock.stdout.on('data', d => /listening/.test(String(d)) && resolve()); mock.on('exit', () => reject(new Error('mock server exited'))) })

    const cfgPath = join(dir, 'config.yaml')
    writeFileSync(cfgPath, JSON.stringify({
      server: { host: '127.0.0.1', port: mockPort, version, connectTimeoutMs: 30000 },
      accountGroups: [{ idPrefix: 'b', usernamePrefix: 'Bench', count: n, pad: 4 }],
      limits: { maxBots: n, maxConcurrentBots: n, maxConcurrentConnecting: 10, maxQueue: n, joinDelayMs: 15, joinJitterMs: 5 },
      client: { lean },
      observe: observe ? {} : { messageBuffer: 0, trackScoreboard: false },
      audit: { file: join(dir, 'audit.jsonl') },
      budget: { enabled: false },
      balance: { source: 'command', pollIntervalSec: 30, minReadIntervalSec: 30, readyDelayMs: 1000, command: { text: '/bal', replyPattern: 'Mock balance: (?<amount>\\$[\\d,.]+)' } },
      reports: { file: join(dir, 'reports.jsonl'), keepRecent: 100 },
      debug: { dump: { enabled: false } },
      api: { port: apiPort }
    }))
    const bot = spawn(process.execPath, [join(root, 'src/main.js'), '--config', cfgPath], { env: { ...process.env, HMC_API_TOKEN: 'bench', HMC_LOG_LEVEL: 'error' }, stdio: ['ignore', 'inherit', 'inherit'] })
    children.push(bot)
    const api = (path, init = {}) => fetch(`http://127.0.0.1:${apiPort}${path}`, { ...init, headers: { authorization: 'Bearer bench' } }).then(r => r.json())

    for (let i = 0; i < 100; i++) { try { await api('/health'); break } catch { await sleep(100) } }
    await sleep(1500)
    const idle = procStat(bot.pid)
    const base = []
    for (let i = 0; i < 3; i++) { base.push(procStat(bot.pid).rssMB); await sleep(500) }
    const baselineRss = median(base)

    const rampStart = Date.now()
    const cpu0 = procStat(bot.pid).cpuSec
    await api('/bots/start', { method: 'POST', body: JSON.stringify({ all: true }) })
    let h
    for (;;) {
      h = await api('/health')
      if (h.bots.byState.online >= n) break
      if (Date.now() - rampStart > 120000) throw new Error(`only ${h.bots.byState.online}/${n} online after 120 s`)
      await sleep(250)
    }
    const rampSec = (Date.now() - rampStart) / 1000
    const rampCpu = procStat(bot.pid).cpuSec - cpu0
    await sleep(3000) // let join-time garbage settle

    const samples = []
    let prev = procStat(bot.pid)
    let prevMock = procStat(mock.pid)
    let prevT = Date.now()
    for (let i = 0; i < durationSec; i++) {
      await sleep(1000)
      const cur = procStat(bot.pid)
      const curMock = procStat(mock.pid)
      const t = Date.now()
      samples.push({ rssMB: cur.rssMB, pssMB: cur.pssMB, cpuPct: ((cur.cpuSec - prev.cpuSec) / ((t - prevT) / 1000)) * 100, mockCpuPct: ((curMock.cpuSec - prevMock.cpuSec) / ((t - prevT) / 1000)) * 100 })
      prev = cur; prevMock = curMock; prevT = t
    }
    h = await api('/health')
    const rss = median(samples.map(s => s.rssMB))
    const pss = samples[0].pssMB == null ? null : median(samples.map(s => s.pssMB))
    const cpu = samples.reduce((a, s) => a + s.cpuPct, 0) / samples.length
    const result = {
      bots: n,
      lean,
      online: h.bots.byState.online,
      stillOnline: h.bots.byState.online === n,
      rampSeconds: round(rampSec),
      rampCpuSeconds: round(rampCpu),
      baselineRssMB: round(baselineRss),
      steadyRssMB: round(rss),
      steadyPssMB: round(pss),
      heapUsedMB: round(h.resources.heapUsedMB),
      marginalMBPerBot: round((rss - baselineRss) / n, 3),
      steadyCpuPercentTotal: round(cpu),
      cpuPercentPerBot: round(cpu / n, 4),
      botsPerGB: round((1024 - baselineRss) / ((rss - baselineRss) / n), 0),
      mockServerCpuPercent: round(samples.reduce((a, s) => a + s.mockCpuPct, 0) / samples.length),
      idleRssBeforeStartMB: round(idle.rssMB)
    }
    log(`  n=${n} lean=${lean}: ${JSON.stringify(result)}`)
    return result
  } finally {
    kill()
    await sleep(300)
  }
}

const results = []
for (const lean of leanModes) for (const n of botCounts) { log(`running ${n} bots, lean=${lean}, traffic=${traffic}, ${durationSec}s steady state`); results.push(await runOnce(n, lean)) }

/** Least-squares line through (bots, RSS) for each lean mode: the slope is the true per-bot cost, free of one-time costs. */
const fits = []
for (const lean of leanModes) {
  const pts = results.filter(r => r.lean === lean && r.stillOnline)
  if (pts.length < 2) continue
  const mx = pts.reduce((a, r) => a + r.bots, 0) / pts.length
  const my = pts.reduce((a, r) => a + r.steadyRssMB, 0) / pts.length
  const slope = pts.reduce((a, r) => a + (r.bots - mx) * (r.steadyRssMB - my), 0) / pts.reduce((a, r) => a + (r.bots - mx) ** 2, 0)
  const intercept = my - slope * mx
  const cpuSlope = pts.reduce((a, r) => a + (r.bots - mx) * (r.steadyCpuPercentTotal - pts.reduce((b, q) => b + q.steadyCpuPercentTotal, 0) / pts.length), 0) / pts.reduce((a, r) => a + (r.bots - mx) ** 2, 0)
  fits.push({ lean, sizes: pts.map(r => r.bots), rssMBPerBot: round(slope, 3), rssInterceptMB: round(intercept), botsPerGB: round((1024 - intercept) / slope, 0), cpuPercentPerBot: round(cpuSlope, 4) })
}

const env = {
  node: process.version, cpu: cpus()[0]?.model, cores: cpus().length, totalMemGB: round(totalmem() / 2 ** 30, 1),
  minecraftVersion: version, traffic, observe: observe ? 'on (messageBuffer 100, trackScoreboard)' : 'off', trafficPerBotPerSec: TRAFFIC, durationSec, server: 'local mock (loopback)'
}
const out = { env, results, fits }
if (outFile) writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify(out, null, 2))
console.log('\n bots  lean   RSS MB  base MB  +MB/bot  bots/GB  CPU%   CPU%/bot  online  mock CPU%')
for (const r of results) {
  console.log([r.bots, r.lean ? 'on ' : 'off', r.steadyRssMB, r.baselineRssMB, r.marginalMBPerBot, r.botsPerGB, r.steadyCpuPercentTotal, r.cpuPercentPerBot, `${r.online}/${r.bots}`, r.mockServerCpuPercent]
    .map((v, i) => String(v).padStart([5, 5, 8, 8, 8, 8, 7, 9, 7, 9][i])).join(' '))
}
if (fits.length) {
  console.log('\nlinear fit over the sizes above (per-bot cost without one-time overhead):')
  for (const f of fits) console.log(`  lean=${f.lean ? 'on ' : 'off'}  ${f.rssMBPerBot} MB/bot  (intercept ${f.rssInterceptMB} MB)  => ${f.botsPerGB} bots per GB   CPU slope ${f.cpuPercentPerBot} %/bot`)
}
process.exit(0)
