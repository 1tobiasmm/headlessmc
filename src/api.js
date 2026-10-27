import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { z } from 'zod'
import { normaliseActor } from './audit.js'
import { ConfigError, parseAccount } from './config.js'

const MAX_BODY = 64 * 1024

const startBody = z.object({
  ids: z.array(z.string()).max(5000).optional(),
  all: z.boolean().optional(),
  accounts: z.array(z.unknown()).max(5000).optional()
}).strict().refine(b => b.ids || b.all || b.accounts, 'provide ids, accounts or all')

const stopBody = z.object({
  ids: z.array(z.string()).max(5000).optional(),
  all: z.boolean().optional()
}).strict().refine(b => b.ids || b.all, 'provide ids or all')

const sayBody = z.object({
  // 1..256 chars is the protocol's chat limit; control characters (incl. newlines) are never sent
  text: z.string().min(1).max(256).refine(t => !/[\u0000-\u001f\u007f]/.test(t), 'text must not contain control characters'),
  windowMs: z.number().int().min(0).optional()
}).strict()

const iso = m => ({ ...m, ts: new Date(m.ts).toISOString() })

const digest = s => createHash('sha256').update(s).digest()

/**
 * @param {{manager: import('./manager.js').BotManager, token: string, reload?: () => object, version?: string}} deps
 */
export function createApi ({ manager, token, reload, version = '0.0.0' }) {
  if (!token) throw new Error('API token is empty; refusing to create an unauthenticated API')
  const tokenDigest = digest(token)

  const json = (status, body, headers) => ({ status, body, headers })
  const err = (status, error, message, extra) => json(status, { error, message, ...extra })

  function authorized (headers) {
    const h = headers.authorization ?? ''
    const m = /^Bearer (.+)$/i.exec(h)
    return Boolean(m) && timingSafeEqual(digest(m[1]), tokenDigest)
  }

  /**
   * @param {{method: string, path: string, query?: URLSearchParams, headers?: Record<string, string>, body?: unknown}} req
   * @returns {Promise<{status: number, body: object, headers?: object}>}
   */
  async function handle (req) {
    const method = req.method.toUpperCase()
    const parts = req.path.split('/').filter(Boolean)
    const query = req.query ?? new URLSearchParams()
    const actor = normaliseActor((req.headers ?? {})['x-actor'])

    if (method === 'GET' && parts.length === 1 && parts[0] === 'health') {
      return json(200, { ...manager.health(), version })
    }
    if (!authorized(req.headers ?? {})) {
      return json(401, { error: 'unauthorized', message: 'missing or invalid bearer token' }, { 'www-authenticate': 'Bearer' })
    }

    if (parts[0] === 'bots') {
      if (parts.length === 1 && method === 'GET') return json(200, { bots: manager.list() })

      if (parts.length === 2 && parts[1] === 'start' && method === 'POST') return start(req.body, actor)
      if (parts.length === 2 && parts[1] === 'stop' && method === 'POST') return stop(req.body, actor)

      if (parts.length === 2 && method === 'GET') {
        const bot = manager.get(parts[1])
        return bot ? json(200, bot.status()) : err(404, 'not_found', `no bot with id ${parts[1]}`)
      }
      if (parts.length === 3 && parts[2] === 'balance' && method === 'GET') {
        const bot = manager.get(parts[1])
        if (!bot) return err(404, 'not_found', `no bot with id ${parts[1]}`)
        return json(200, { id: bot.id, state: bot.state, balance: bot.balance, lastError: bot.lastReadError })
      }
      if (parts.length === 4 && parts[2] === 'balance' && parts[3] === 'refresh' && method === 'POST') {
        const bot = manager.get(parts[1])
        if (!bot) return err(404, 'not_found', `no bot with id ${parts[1]}`)
        return refresh(bot, actor)
      }
      if (parts.length === 3 && parts[2] === 'say' && method === 'POST') {
        const bot = manager.get(parts[1])
        return bot ? say(bot, req.body, actor) : err(404, 'not_found', `no bot with id ${parts[1]}`)
      }
      if (parts.length === 3 && parts[2] === 'messages' && method === 'GET') {
        const bot = manager.get(parts[1])
        return bot ? messages(bot, query, req.signal) : err(404, 'not_found', `no bot with id ${parts[1]}`)
      }
      if (parts.length === 3 && parts[2] === 'sidebar' && method === 'GET') {
        const bot = manager.get(parts[1])
        if (!bot) return err(404, 'not_found', `no bot with id ${parts[1]}`)
        const snap = bot.sidebar(query.get('raw') === '1')
        return json(200, { id: bot.id, state: bot.state, tracking: Boolean(snap), sidebar: snap?.sidebar ?? null, tab: snap?.tab ?? null })
      }
    }

    if (parts.length === 1 && parts[0] === 'reports' && method === 'GET') {
      const limit = Math.min(500, Math.max(1, Number(query.get('limit') ?? 100) || 100))
      return json(200, { reports: manager.reports.recent({ limit, id: query.get('id') ?? undefined, type: query.get('type') ?? undefined }) })
    }

    if (parts.length === 2 && parts[0] === 'config' && parts[1] === 'reload' && method === 'POST') {
      if (!reload) return err(501, 'not_supported', 'this process was not started from a config file')
      try {
        return json(200, { reloaded: true, ...reload() })
      } catch (e) {
        if (e instanceof ConfigError) return err(400, 'invalid_config', e.message)
        throw e
      }
    }

    return err(404, 'not_found', `no route for ${method} ${req.path}`)
  }

  function start (body, actor) {
    const parsed = startBody.safeParse(body ?? {})
    if (!parsed.success) return err(400, 'bad_request', parsed.error.issues.map(i => i.message).join('; '))
    const { ids, all, accounts } = parsed.data
    const result = { accepted: [], rejected: [] }
    const merge = r => { result.accepted.push(...r.accepted); result.rejected.push(...r.rejected) }

    if (all) merge(manager.startConfigured(manager.config.accounts.map(a => a.id)))
    else if (ids) merge(manager.startConfigured(ids))
    if (accounts) {
      const valid = []
      accounts.forEach((raw, i) => {
        try { valid.push(parseAccount(raw)) } catch (e) { result.rejected.push({ id: raw?.id ?? raw?.username ?? `accounts[${i}]`, error: 'invalid_account', message: e.message }) }
      })
      merge(manager.start(valid))
    }
    if (result.accepted.length) manager.audit.write({ actor, action: 'start', detail: { ids: result.accepted.map(a => a.id) } })
    const status = result.accepted.length > 0 || result.rejected.length === 0 ? 202 : 409
    return json(status, result)
  }

  function stop (body, actor) {
    const parsed = stopBody.safeParse(body ?? {})
    if (!parsed.success) return err(400, 'bad_request', parsed.error.issues.map(i => i.message).join('; '))
    const { stopped, notFound } = manager.stop(parsed.data.all ? 'all' : parsed.data.ids)
    if (stopped.length) manager.audit.write({ actor, action: 'stop', detail: { ids: stopped } })
    return json(notFound.length && !stopped.length ? 404 : 200, { stopped, notFound })
  }

  async function refresh (bot, actor) {
    try {
      const report = await bot.refresh(actor)
      if (!report) return err(409, 'interrupted', 'the bot disconnected during the read')
      return json(report.type === 'balance' ? 200 : 502, report)
    } catch (e) {
      const status = { not_online: 409, busy: 409, too_soon: 429 }[e.code]
      if (!status) throw e
      return err(status, e.code, e.message, e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : undefined)
    }
  }

  async function say (bot, body, actor) {
    const parsed = sayBody.safeParse(body ?? {})
    if (!parsed.success) return err(400, 'bad_request', parsed.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
    const maxWindow = manager.config.observe.maxReplyWindowMs
    const windowMs = Math.min(maxWindow, parsed.data.windowMs ?? 3000)
    try {
      const r = await bot.say(parsed.data.text, windowMs, actor)
      return json(200, { id: bot.id, ...r, messages: r.messages.map(iso) })
    } catch (e) {
      if (e.code === 'not_online') return err(409, 'not_online', e.message)
      throw e
    }
  }

  async function messages (bot, query, signal) {
    const num = (k, d, max) => Math.min(max, Math.max(0, Math.floor(Number(query.get(k) ?? d)) || 0))
    const since = num('since', 0, Number.MAX_SAFE_INTEGER)
    const limit = num('limit', 100, 2000)
    const wait = num('wait', 0, 25_000)
    const list = limit === 0 ? [] : await bot.ring.wait(since, { timeoutMs: wait, limit, signal })
    return json(200, {
      id: bot.id,
      state: bot.state,
      capacity: bot.ring.capacity,
      latest: bot.ring.seq,
      messages: list.map(m => ({ ...iso(m), bot: bot.id }))
    })
  }

  /** Binds a node:http server around handle(). Resolves once listening. */
  function listen ({ bind, port }) {
    const server = createServer(async (req, res) => {
      const send = (status, body, headers = {}) => {
        const data = JSON.stringify(body)
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store', ...headers })
        res.end(data)
      }
      try {
        const url = new URL(req.url, 'http://localhost')
        let body
        if (req.method === 'POST') {
          const chunks = []
          let size = 0
          for await (const c of req) {
            size += c.length
            if (size > MAX_BODY) return send(413, { error: 'too_large', message: `body exceeds ${MAX_BODY} bytes` })
            chunks.push(c)
          }
          const text = Buffer.concat(chunks).toString('utf8')
          if (text.trim()) {
            try { body = JSON.parse(text) } catch { return send(400, { error: 'bad_request', message: 'body is not valid JSON' }) }
          }
        }
        const ac = new AbortController()
        res.on('close', () => ac.abort())
        const out = await handle({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body, signal: ac.signal })
        send(out.status, out.body, out.headers)
      } catch (e) {
        manager.log.error('api handler failed', { error: e.message })
        send(500, { error: 'internal', message: 'internal error' })
      }
    })
    server.requestTimeout = 15_000
    server.headersTimeout = 10_000
    server.maxHeadersCount = 50
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, bind, () => resolve(server))
    })
  }

  return { handle, listen }
}
