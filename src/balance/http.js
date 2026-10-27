import { parseAmount } from '../amount.js'
import { BalanceError } from './errors.js'

const RAW_LIMIT = 1000

/** Reads a dot path such as "result.money" or "data.0.balance". */
export function getPath (obj, path) {
  let cur = obj
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[key]
  }
  return cur
}

/**
 * Source (a): an HTTP endpoint that returns the balance. The URL, the credential
 * (read from environment variables) and the JSON path all come from the config.
 */
export class HttpSource {
  /**
   * @param {object} balanceCfg config.balance
   * @param {{env?: NodeJS.ProcessEnv, fetch?: typeof fetch}} [deps]
   */
  constructor (balanceCfg, { env = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
    this.name = 'http'
    this.needs = { scoreboard: false, chat: false }
    this.cfg = balanceCfg
    this.env = env
    this.fetch = fetchImpl
    this.opts = { suffixes: balanceCfg.suffixes, currencySymbols: balanceCfg.currencySymbols }
  }

  async read (session) {
    const h = this.cfg.http
    const url = h.url.replaceAll('{username}', encodeURIComponent(session.username)).replaceAll('{uuid}', encodeURIComponent(session.uuid ?? ''))
    const headers = { accept: 'application/json' }
    if (h.bearerTokenEnv) {
      const token = this.env[h.bearerTokenEnv]
      if (!token) throw new BalanceError('config', `environment variable ${h.bearerTokenEnv} is not set`)
      headers.authorization = `Bearer ${token}`
    }
    for (const [name, envName] of Object.entries(h.headersFromEnv)) {
      const v = this.env[envName]
      if (!v) throw new BalanceError('config', `environment variable ${envName} is not set`)
      headers[name] = v
    }
    let res
    let text
    try {
      res = await this.fetch(url, { method: h.method, headers, signal: AbortSignal.timeout(this.cfg.readTimeoutMs) })
      text = await res.text()
    } catch (e) {
      throw new BalanceError(e.name === 'TimeoutError' ? 'timeout' : 'http', `request failed: ${e.message}`)
    }
    const raw = text.slice(0, RAW_LIMIT)
    if (!res.ok) throw new BalanceError('http', `HTTP ${res.status}`, { raw })
    let json
    try { json = JSON.parse(text) } catch { throw new BalanceError('unparseable', 'response is not JSON', { raw }) }
    const value = getPath(json, h.jsonPath)
    const amount = typeof value === 'number' ? value : typeof value === 'string' ? parseAmount(value, this.opts) : null
    if (amount === null || !Number.isFinite(amount)) {
      throw new BalanceError('unparseable', `no numeric value at "${h.jsonPath}"`, { raw })
    }
    return { amount, raw, source: 'http', detail: { status: res.status } }
  }
}
