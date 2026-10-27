import { readFileSync } from 'node:fs'
import mc from 'minecraft-protocol'
import { z } from 'zod'
import YAML from 'yaml'
import { compileAmountPattern } from './amount.js'

const ID = /^[A-Za-z0-9_.-]{1,64}$/
const ENV_NAME = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name')
const posInt = z.number().int().positive()
const nonNegInt = z.number().int().min(0)

export const accountSchema = z.object({
  id: z.string().regex(ID).optional(),
  username: z.string().min(3).max(64).regex(/^[A-Za-z0-9_@.+-]+$/),
  auth: z.enum(['offline', 'microsoft', 'token']).default('offline'),
  // auth: token. Names of environment variables; the values are never stored in the config.
  accessTokenEnv: ENV_NAME.optional(),
  profileIdEnv: ENV_NAME.optional()
}).strict().superRefine((a, ctx) => {
  if (a.auth === 'offline' && !/^\w{3,16}$/.test(a.username)) {
    ctx.addIssue({ code: 'custom', path: ['username'], message: 'offline usernames are 3-16 characters of [A-Za-z0-9_]' })
  }
  if (a.auth === 'token' && !(a.accessTokenEnv && a.profileIdEnv)) {
    ctx.addIssue({ code: 'custom', path: ['accessTokenEnv'], message: 'auth "token" needs accessTokenEnv and profileIdEnv' })
  }
})

const groupSchema = z.object({
  idPrefix: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/),
  usernamePrefix: z.string().regex(/^\w{1,12}$/).optional(),
  count: z.number().int().min(1).max(5000),
  start: nonNegInt.default(1),
  pad: z.number().int().min(0).max(6).default(3)
}).strict()

const serverSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(25565),
  // "auto" pings the server once (cached) and picks the matching protocol; or pin e.g. "1.21.4"
  version: z.string().default('auto').superRefine((v, ctx) => {
    if (v !== 'auto' && !mc.supportedVersions.includes(v)) {
      ctx.addIssue({ code: 'custom', message: `unsupported version "${v}"; use "auto" or one of ${mc.supportedVersions.at(-6)}..${mc.supportedVersions.at(-1)} (see supportedVersions in minecraft-protocol)` })
    }
  }),
  connectTimeoutMs: posInt.default(20000)
}).strict()

const limitsSchema = z.object({
  maxBots: posInt.default(1000),
  maxConcurrentBots: posInt.default(50),
  maxConcurrentConnecting: posInt.default(3),
  maxQueue: posInt.default(1000),
  joinDelayMs: nonNegInt.default(3000),
  joinJitterMs: nonNegInt.default(500)
}).strict()

const reconnectSchema = z.object({
  enabled: z.boolean().default(true),
  initialDelayMs: posInt.default(5000),
  maxDelayMs: posInt.default(300000),
  factor: z.number().min(1).max(10).default(2),
  jitter: z.number().min(0).max(1).default(0.2),
  maxAttempts: nonNegInt.default(0), // 0 = unlimited
  resetAfterMs: posInt.default(60000)
}).strict()

const kickSchema = z.object({
  cooldownSeconds: nonNegInt.default(900),
  banCooldownSeconds: nonNegInt.default(86400),
  banPattern: z.string().default('\\bban(?:ned)?\\b|blacklist'),
  // Whole-message server shutdown notices (vanilla/Paper "Server closed"); treated as a dropped connection, not a kick. '' disables.
  transientPattern: z.string().default('^\\s*(?:server closed|server is (?:restarting|stopping|shutting down)|server (?:restart|shutdown|stopping))\\s*[.!]?\\s*$'),
  globalPauseSeconds: nonNegInt.default(60)
}).strict()

const budgetSchema = z.object({
  enabled: z.boolean().default(true),
  memoryMBPerBot: z.number().positive().default(60),
  cpuPercentPerBot: z.number().positive().default(3),
  maxRssMB: nonNegInt.default(0), // 0 = no absolute cap
  checkIntervalMs: posInt.default(5000),
  minBotsForAverage: posInt.default(5)
}).strict()

const clientSchema = z.object({
  viewDistance: z.number().int().min(2).max(32).default(2),
  locale: z.string().default('en_us'),
  lean: z.boolean().default(true), // skip deserializing packets this program never uses
  disableChatSigning: z.boolean().default(false),
  keepAliveTimeoutMs: posInt.default(30000)
}).strict()

const balanceSchema = z.object({
  source: z.enum(['http', 'command', 'sidebar']),
  pollIntervalSec: nonNegInt.default(300), // 0 = read once after joining
  minReadIntervalSec: z.number().int().min(1).default(30), // floor between reads per bot, polling and manual
  readyDelayMs: nonNegInt.default(3000),
  readTimeoutMs: posInt.default(15000),
  currencySymbols: z.string().default('$'),
  suffixes: z.record(z.string(), z.number().positive()).default({}),
  command: z.object({
    text: z.string().min(1),
    replyPattern: z.string().min(1),
    accept: z.array(z.enum(['system', 'actionbar', 'player'])).min(1).default(['system'])
  }).strict().optional(),
  sidebar: z.object({
    labelPattern: z.string().min(1),
    surfaces: z.array(z.enum(['sidebar', 'tabHeader', 'tabFooter'])).min(1).default(['sidebar'])
  }).strict().optional(),
  http: z.object({
    url: z.string().url(), // may contain {username} and {uuid}
    method: z.enum(['GET', 'POST']).default('GET'),
    bearerTokenEnv: ENV_NAME.optional(),
    headersFromEnv: z.record(z.string(), ENV_NAME).default({}), // header name -> env var holding its value
    jsonPath: z.string().min(1) // dot path into the JSON response, e.g. "result.money"
  }).strict().optional()
}).strict().superRefine((b, ctx) => {
  if (b.pollIntervalSec !== 0 && b.pollIntervalSec < b.minReadIntervalSec) {
    ctx.addIssue({ code: 'custom', path: ['pollIntervalSec'], message: `use 0 (read once) or at least minReadIntervalSec (${b.minReadIntervalSec})` })
  }
  if (!b[b.source]) ctx.addIssue({ code: 'custom', path: [b.source], message: `balance.source is "${b.source}" but balance.${b.source} is missing` })
})

const dumpSchema = z.object({
  enabled: z.boolean().default(true),
  file: z.string().default('./data/debug/first-connect.jsonl'),
  maxBots: posInt.default(2),
  windowSec: posInt.default(30),
  maxLines: posInt.default(500)
}).strict()

const reportsSchema = z.object({
  file: z.string().nullable().default('./data/reports.jsonl'),
  keepRecent: posInt.default(500),
  webhook: z.object({
    url: z.string().url(),
    tokenEnv: ENV_NAME.optional(),
    timeoutMs: posInt.default(5000),
    maxQueue: posInt.default(500),
    maxAttempts: posInt.default(3)
  }).strict().nullable().default(null)
}).strict()

const observeSchema = z.object({
  // Last N chat/system/action-bar messages kept per bot for the CLI (`tail`, `dump`). 0 = keep none.
  messageBuffer: nonNegInt.max(2000).default(100),
  // Keep sidebar/tab state for every bot so the CLI `sidebar` works. Small cost; see README benchmark.
  trackScoreboard: z.boolean().default(true),
  maxReplyWindowMs: posInt.max(60000).default(30000)
}).strict()

const auditSchema = z.object({
  file: z.string().min(1).default('./data/audit.jsonl'),
  polls: z.boolean().default(true) // also record the configured balance command sent by scheduled polls
}).strict()

const apiSchema = z.object({
  bind: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(8787),
  tokenEnv: ENV_NAME.default('HMC_API_TOKEN')
}).strict()

export const configSchema = z.object({
  server: serverSchema,
  accounts: z.array(accountSchema).default([]),
  accountGroups: z.array(groupSchema).default([]),
  auth: z.object({ profilesFolder: z.string().default('./data/auth') }).strict().prefault({}),
  limits: limitsSchema.prefault({}),
  reconnect: reconnectSchema.prefault({}),
  kick: kickSchema.prefault({}),
  budget: budgetSchema.prefault({}),
  client: clientSchema.prefault({}),
  balance: balanceSchema,
  debug: z.object({ dump: dumpSchema.prefault({}) }).strict().prefault({}),
  reports: reportsSchema.prefault({}),
  observe: observeSchema.prefault({}),
  audit: auditSchema.prefault({}),
  api: apiSchema.prefault({})
}).strict()

/** Sections that cannot change without a restart; reload reports them instead of applying. */
export const RESTART_REQUIRED = ['api.bind', 'api.port', 'api.tokenEnv']

/**
 * Validates a raw config object and returns the normalised config.
 * `accounts` is the explicit list plus every expanded group. Compiled patterns live on
 * `config.compiled` (non-serialisable, rebuilt on each load).
 * @param {unknown} raw
 */
export function validateConfig (raw) {
  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) {
    const msg = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n  ')
    throw new ConfigError(`invalid config:\n  ${msg}`)
  }
  const cfg = parsed.data

  const accounts = []
  const seen = new Set()
  const add = a => {
    if (seen.has(a.id)) throw new ConfigError(`duplicate account id "${a.id}"`)
    seen.add(a.id)
    accounts.push(Object.freeze(a))
  }
  for (const a of cfg.accounts) add({ ...a, id: a.id ?? a.username })
  for (const g of cfg.accountGroups) {
    const prefix = g.usernamePrefix ?? g.idPrefix.replace(/\W/g, '').slice(0, 12)
    for (let i = 0; i < g.count; i++) {
      const n = String(g.start + i).padStart(g.pad, '0')
      const username = `${prefix}${n}`
      if (!/^\w{3,16}$/.test(username)) throw new ConfigError(`group "${g.idPrefix}" produces invalid username "${username}"`)
      add({ id: `${g.idPrefix}${n}`, username, auth: 'offline' })
    }
  }
  if (cfg.limits.maxConcurrentConnecting > cfg.limits.maxConcurrentBots) {
    cfg.limits.maxConcurrentConnecting = cfg.limits.maxConcurrentBots
  }

  const b = cfg.balance
  const compiled = { banRe: null, transientRe: null, commandRe: null, sidebarRe: null }
  try {
    compiled.banRe = new RegExp(cfg.kick.banPattern, 'i')
    if (cfg.kick.transientPattern) compiled.transientRe = new RegExp(cfg.kick.transientPattern, 'i')
    if (b.command) compiled.commandRe = compileAmountPattern(b.command.replyPattern)
    if (b.sidebar) compiled.sidebarRe = compileAmountPattern(b.sidebar.labelPattern)
  } catch (e) {
    throw new ConfigError(`invalid config:\n  ${e.message}`)
  }

  const config = { ...cfg, accounts }
  delete config.accountGroups
  Object.defineProperty(config, 'compiled', { value: Object.freeze(compiled), enumerable: false })
  return config
}

/**
 * Reads and validates a YAML (or JSON) config file.
 * @param {string} path
 */
export function loadConfig (path) {
  let text
  try { text = readFileSync(path, 'utf8') } catch (e) { throw new ConfigError(`cannot read config ${path}: ${e.message}`) }
  let raw
  try { raw = YAML.parse(text) } catch (e) { throw new ConfigError(`cannot parse ${path}: ${e.message}`) }
  return validateConfig(raw)
}

/** Validates one ad-hoc account supplied through the API. */
export function parseAccount (raw) {
  const r = accountSchema.safeParse(raw)
  if (!r.success) throw new ConfigError(r.error.issues.map(i => `${i.path.join('.') || 'account'}: ${i.message}`).join('; '))
  return Object.freeze({ ...r.data, id: r.data.id ?? r.data.username })
}

/** Dot paths of the leaf sections that differ between two configs. */
export function diffConfig (a, b) {
  const out = []
  const walk = (x, y, path) => {
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], path ? `${path}.${k}` : k)
    } else if (JSON.stringify(x) !== JSON.stringify(y)) out.push(path)
  }
  walk(a, b, '')
  return out
}

export class ConfigError extends Error {}
