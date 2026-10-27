#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { HELP, parseLine } from './cli-parser.js'

const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

function parseArgs (argv, env) {
  const o = {
    url: env.HMC_API_URL ?? 'http://127.0.0.1:8787',
    tokenEnv: 'HMC_API_TOKEN',
    window: Number(env.HMC_CLI_WINDOW_MS ?? 3000),
    bot: null,
    help: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--url') o.url = argv[++i]
    else if (a === '--token-env') o.tokenEnv = argv[++i]
    else if (a === '--window') o.window = Number(argv[++i])
    else if (a === '--bot') o.bot = argv[++i]
    else if (a === '-h' || a === '--help') o.help = true
    else throw new Error(`unknown argument ${a}`)
  }
  if (!Number.isInteger(o.window) || o.window < 0 || o.window > 60000) throw new Error('--window must be an integer 0-60000 (ms)')
  return o
}

const USAGE = `usage: node src/cli.js [--url http://127.0.0.1:8787] [--token-env HMC_API_TOKEN] [--window 3000] [--bot <id>]
  The API token is read from the environment variable (default HMC_API_TOKEN); the CLI refuses to start without it.
  Only loopback API URLs are accepted. Over SSH, run the CLI on the bot host (or use ssh -L to a loopback port).`

/**
 * Runs the interactive CLI against the local HTTP API.
 * @param {{input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, errput?: NodeJS.WritableStream,
 *          env?: NodeJS.ProcessEnv, argv?: string[], fetchImpl?: typeof fetch}} [io]
 * @returns {{done: Promise<number>, interrupt: () => void}} `done` resolves to the exit code
 */
export function runCli ({ input = process.stdin, output = process.stdout, errput = process.stderr, env = process.env, argv = [], fetchImpl = globalThis.fetch } = {}) {
  const fail = (msg) => ({ done: (errput.write(msg + '\n'), Promise.resolve(2)), interrupt () {} })

  let opts
  try { opts = parseArgs(argv, env) } catch (e) { return fail(`${e.message}\n${USAGE}`) }
  if (opts.help) { output.write(USAGE + '\n'); return { done: Promise.resolve(0), interrupt () {} } }
  const token = env[opts.tokenEnv]
  if (!token) return fail(`environment variable ${opts.tokenEnv} is not set; refusing to start without the API token.\n${USAGE}`)
  let base
  try { base = new URL(opts.url) } catch { return fail(`invalid --url ${opts.url}`) }
  if (!LOOPBACK.has(base.hostname)) return fail(`refusing to connect to non-loopback host ${base.hostname}: the API is local-only and the token must not cross a network`)

  const out = s => output.write(s + '\n')
  const state = { bot: opts.bot, raw: false, window: opts.window, tailAbort: null }

  async function api (method, path, body, signal) {
    let res
    try {
      res = await fetchImpl(new URL(path, base), {
        method,
        headers: { authorization: `Bearer ${token}`, 'x-actor': 'cli', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal
      })
    } catch (e) {
      if (e.name === 'AbortError') throw e
      throw new CliError(`cannot reach the API at ${base.origin}: ${e.cause?.code ?? e.message}`)
    }
    const data = await res.json().catch(() => ({}))
    return { status: res.status, ok: res.ok, data }
  }
  const must = (r) => { if (!r.ok) throw new CliError(`${r.data.error ?? r.status}: ${r.data.message ?? JSON.stringify(r.data)}`) ; return r.data }
  const needBot = () => { if (!state.bot) throw new CliError('no bot selected: use <botId> (type bots to list them)'); return state.bot }
  const enc = encodeURIComponent

  const fmtMsg = m => {
    const line = `${m.ts} [${m.bot ?? state.bot}] ${m.kind.padEnd(9)} ${m.text}`
    return state.raw && m.raw ? `${line}\n    raw: ${m.raw}` : line
  }

  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY), prompt: '' })
  const setPrompt = () => rl.setPrompt(state.bot ? `hmc[${state.bot}]> ` : 'hmc> ')

  const handlers = {
    async help () { out(HELP) },

    async bots () {
      const { bots } = must(await api('GET', '/bots'))
      if (!bots.length) return out('no bots (start one with: use <id> then join)')
      out(`${'ID'.padEnd(20)} ${'STATE'.padEnd(13)} ${'REASON/DETAIL'.padEnd(22)} BALANCE`)
      for (const b of bots) {
        const bal = b.balance ? `${b.balance.amount} (${b.balance.source}, ${b.balance.at})` : '-'
        out(`${(b.id === state.bot ? '*' : ' ') + b.id.padEnd(19)} ${b.state.padEnd(13)} ${String(b.reason ?? b.detail ?? '').slice(0, 22).padEnd(22)} ${bal}`)
      }
    },

    async use ({ id }) {
      const b = must(await api('GET', `/bots/${enc(id)}`))
      state.bot = id
      setPrompt()
      out(`using ${id} (${b.state})`)
    },

    async say ({ text }) {
      const id = needBot()
      out(`-> ${id}: ${text}   (audited as cli; collecting replies for ${state.window} ms)`)
      const r = must(await api('POST', `/bots/${enc(id)}/say`, { text, windowMs: state.window }))
      if (!r.messages.length) out(`   (no messages received in ${r.windowMs} ms)`)
      for (const m of r.messages) out('   ' + fmtMsg({ ...m, bot: id }).replaceAll('\n', '\n   '))
    },

    async bal () {
      const id = needBot()
      const r = await api('POST', `/bots/${enc(id)}/balance/refresh`)
      if (r.status === 429) throw new CliError(`rate-limited: retry in ${r.data.retryAfterSec} s (balance.minReadIntervalSec)`)
      if (!r.ok && r.status !== 502) must(r)
      const rep = r.data
      if (rep.type === 'balance') {
        out(`balance: ${rep.amount}   [source: ${rep.source}]`)
        out(`raw:     ${JSON.stringify(rep.raw)}`)
      } else {
        out(`balance read failed: ${rep.error}: ${rep.message}`)
        if (rep.raw) out(`raw:     ${JSON.stringify(rep.raw)}`)
      }
    },

    async tail ({ count }) {
      const id = needBot()
      const ac = new AbortController()
      state.tailAbort = ac
      let since = 0
      try {
        const first = must(await api('GET', `/bots/${enc(id)}/messages?limit=${count}`, undefined, ac.signal))
        for (const m of first.messages) out(fmtMsg(m))
        since = first.latest
        out(`-- tailing ${id} (capacity ${first.capacity}); Ctrl+C to stop --`)
        while (!ac.signal.aborted) {
          const r = must(await api('GET', `/bots/${enc(id)}/messages?since=${since}&limit=200&wait=20000`, undefined, ac.signal))
          for (const m of r.messages) out(fmtMsg(m))
          since = r.messages.length ? r.messages.at(-1).seq : since
        }
      } catch (e) {
        if (e.name !== 'AbortError') throw e
      } finally {
        state.tailAbort = null
      }
      out('-- tail stopped --')
    },

    async sidebar () {
      const id = needBot()
      const r = must(await api('GET', `/bots/${enc(id)}/sidebar?raw=${state.raw ? 1 : 0}`))
      if (!r.tracking) return out(`${id} is ${r.state}: scoreboard is not tracked (offline, or observe.trackScoreboard is false)`)
      if (r.sidebar) {
        out(`sidebar: ${r.sidebar.title}`)
        r.sidebar.lines.forEach((l, i) => out(`  ${String(i + 1).padStart(2)}  ${l}`))
        if (state.raw && r.sidebar.raw) for (const x of r.sidebar.raw) out(`      raw: ${JSON.stringify(x)}`)
      } else out('sidebar: (none shown)')
      out(`tab header: ${JSON.stringify(r.tab.header)}`)
      out(`tab footer: ${JSON.stringify(r.tab.footer)}`)
    },

    async raw ({ on }) { state.raw = on; out(`raw ${on ? 'on' : 'off'}`) },

    async window ({ ms }) { state.window = ms; out(`reply window ${ms} ms`) },

    async dump ({ file, count }) {
      const id = needBot()
      const msgs = must(await api('GET', `/bots/${enc(id)}/messages?limit=${count}`))
      const side = must(await api('GET', `/bots/${enc(id)}/sidebar?raw=1`))
      const doc = { bot: id, savedAt: new Date().toISOString(), messages: msgs.messages, sidebar: side.sidebar, tab: side.tab }
      try {
        writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      } catch (e) {
        throw new CliError(e.code === 'EEXIST' ? `${file} already exists; choose another name (existing files are never overwritten)` : `cannot write ${file}: ${e.message}`)
      }
      out(`saved ${msgs.messages.length} messages${side.sidebar ? ' and the sidebar' : ''} to ${file}`)
    },

    async join () {
      const id = needBot()
      const r = await api('POST', '/bots/start', { ids: [id] })
      if (r.data.accepted?.length) out(`${id}: starting (join is staggered; check with bots)`)
      else for (const x of r.data.rejected ?? []) out(`${x.id}: ${x.error}${x.retryAfterSec ? ` (retry in ${x.retryAfterSec} s)` : ''}`)
      if (!r.data.accepted && !r.data.rejected) must(r)
    },

    async leave () {
      const id = needBot()
      must(await api('POST', '/bots/stop', { ids: [id] }))
      out(`${id}: stopped`)
    }
  }

  // Lines are handled strictly one at a time so replies stay under their command, also with piped input.
  let chain = Promise.resolve()
  let closing = false
  const finish = new Promise(resolve => {
    const close = () => { if (!closing) { closing = true; chain.then(() => resolve(0)) } }
    rl.on('close', close)
    rl.on('line', line => {
      chain = chain.then(async () => {
        const cmd = parseLine(line)
        if (cmd.type === 'empty') return
        if (cmd.type === 'quit') { rl.close(); return }
        try {
          if (cmd.type === 'error') throw new CliError(cmd.message)
          await handlers[cmd.type](cmd)
        } catch (e) {
          out(`error: ${e instanceof CliError ? e.message : (e.stack ?? e.message)}`)
        }
        if (!closing) { rl.prompt() }
      })
    })
  })

  const interrupt = () => {
    if (state.tailAbort) state.tailAbort.abort()
    else { out('(use quit to leave the CLI)'); rl.prompt() }
  }
  rl.on('SIGINT', interrupt)

  out('headless-balance-bot CLI. Type help. Commands you send are audited as actor "cli".')
  if (state.bot) {
    chain = chain.then(() => handlers.use({ id: state.bot }).catch(e => { state.bot = null; out(`error: ${e.message}`) })).then(() => { setPrompt(); rl.prompt() })
  } else { setPrompt(); rl.prompt() }

  return { done: finish, interrupt }
}

class CliError extends Error {}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { done } = runCli({ argv: process.argv.slice(2) })
  process.on('SIGINT', () => {}) // with a TTY readline owns Ctrl+C; without one, ignore it rather than die mid-command
  done.then(code => process.exit(code))
}
