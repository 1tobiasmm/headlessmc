import { AuditLog } from './audit.js'
import { Bot } from './bot.js'
import { createBalanceSource } from './balance/index.js'
import { ResourceBudget } from './budget.js'
import { diffConfig, RESTART_REQUIRED } from './config.js'
import { DumpHub } from './dump.js'
import { nullLogger } from './log.js'
import { ReportHub } from './reports.js'
import { JoinScheduler } from './scheduler.js'
import { VersionResolver } from './version.js'

const RUNNING = new Set(['connecting', 'online', 'reconnecting'])

/**
 * Owns every Bot, the join scheduler, report fan-out and the resource budget.
 * Configuration is read live (getConfig), so a reload takes effect on the next connect,
 * read or limit check without restarting bots.
 */
export class BotManager {
  /**
   * @param {object} config validated config
   * @param {{reports?: ReportHub, dump?: DumpHub, versions?: VersionResolver, env?: NodeJS.ProcessEnv, log?: object,
   *          botFactory?: (account: object, ctx: object) => Bot, createClient?: Function, fetch?: Function}} [deps]
   */
  constructor (config, deps = {}) {
    this.config = config
    this.env = deps.env ?? process.env
    this.log = deps.log ?? nullLogger
    this.reports = deps.reports ?? new ReportHub(config.reports, { env: this.env, log: this.log })
    this.dump = deps.dump ?? new DumpHub(config.debug.dump)
    this.audit = deps.audit ?? new AuditLog(config.audit.file)
    this.versions = deps.versions ?? new VersionResolver()
    this.botFactory = deps.botFactory ?? ((account, ctx) => new Bot(account, ctx))
    this.fetch = deps.fetch
    this.source = createBalanceSource(config, { env: this.env, fetch: this.fetch })
    this.startedAt = Date.now()
    /** @type {Map<string, Bot>} */
    this.bots = new Map()
    /** @type {Map<string, number>} id -> epoch ms until which a kicked bot may not be restarted */
    this.cooldowns = new Map()

    this.budget = new ResourceBudget(() => this.config.budget, () => this.countState('online'))
    this.scheduler = new JoinScheduler({
      getLimits: () => this.config.limits,
      isOverBudget: () => this.budget.isOverBudget()
    })
    this.ctx = {
      getConfig: () => this.config,
      getSource: () => this.source,
      versions: this.versions,
      dump: this.dump,
      env: this.env,
      log: this.log,
      createClient: deps.createClient,
      hooks: {
        stateChanged: (bot, prev) => this._onState(bot, prev),
        phaseChanged: bot => this.scheduler.phaseChanged(bot),
        requestConnect: bot => this.scheduler.enqueue(bot, { force: true }),
        report: r => this.reports.emit(r),
        audit: entry => this.audit.write(entry),
        kicked: (bot, info) => this._onKick(bot, info)
      }
    }
    this.budget.start()
  }

  // ---- queries ----

  countState (state) {
    let n = 0
    for (const b of this.bots.values()) if (b.state === state) n++
    return n
  }

  list () { return [...this.bots.values()].map(b => b.status()) }

  get (id) { return this.bots.get(id) }

  health () {
    const byState = { connecting: 0, online: 0, reconnecting: 0, kicked: 0, stopped: 0 }
    for (const b of this.bots.values()) byState[b.state]++
    return {
      status: 'ok',
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      bots: { total: this.bots.size, byState, joinQueue: this.scheduler.queued },
      joinsPausedUntil: this.scheduler.pausedUntil > Date.now() ? new Date(this.scheduler.pausedUntil).toISOString() : null,
      resources: this.budget.snapshot(),
      reports: this.reports.stats
    }
  }

  // ---- commands ----

  /**
   * Starts bots for the given accounts. Never throws for per-bot problems; each account is
   * reported as accepted or rejected with a code.
   * @param {object[]} accounts normalised accounts
   * @returns {{accepted: object[], rejected: object[]}}
   */
  start (accounts) {
    const accepted = []
    const rejected = []
    const lim = this.config.limits
    for (const account of accounts) {
      const existing = this.bots.get(account.id)
      if (existing && RUNNING.has(existing.state)) { rejected.push({ id: account.id, error: 'already_running', state: existing.state }); continue }
      const until = this.cooldowns.get(account.id)
      if (until && until > Date.now()) {
        rejected.push({ id: account.id, error: 'cooling_down', retryAfterSec: Math.ceil((until - Date.now()) / 1000) })
        continue
      }
      this.cooldowns.delete(account.id)
      const live = [...this.bots.values()].filter(b => RUNNING.has(b.state)).length
      if (live >= lim.maxBots) { rejected.push({ id: account.id, error: 'max_bots', max: lim.maxBots }); continue }
      const bot = this.botFactory(account, this.ctx)
      if (!this.scheduler.enqueue(bot)) { rejected.push({ id: account.id, error: 'queue_full', max: lim.maxQueue }); continue }
      if (existing) this.scheduler.remove(existing)
      this.bots.set(account.id, bot)
      accepted.push({ id: account.id, state: bot.state })
    }
    return { accepted, rejected }
  }

  /** Starts configured accounts by id; unknown ids are rejected. */
  startConfigured (ids) {
    const byId = new Map(this.config.accounts.map(a => [a.id, a]))
    const accounts = []
    const unknown = []
    for (const id of ids) (byId.has(id) ? accounts : unknown).push(byId.get(id) ?? id)
    const res = this.start(accounts)
    for (const id of unknown) res.rejected.push({ id, error: 'unknown_account' })
    return res
  }

  /** @param {string[] | 'all'} ids */
  stop (ids) {
    const targets = ids === 'all' ? [...this.bots.keys()] : ids
    const stopped = []
    const notFound = []
    for (const id of targets) {
      const bot = this.bots.get(id)
      if (!bot) { notFound.push(id); continue }
      this.scheduler.remove(bot)
      bot.stop('user')
      stopped.push(id)
    }
    return { stopped, notFound }
  }

  // ---- hooks ----

  _onState (bot, prev) {
    this.log.info('bot state', { id: bot.id, from: prev, to: bot.state, reason: bot.reason ?? bot.detail })
    if (bot.state === 'stopped' || bot.state === 'kicked') this.scheduler.remove(bot)
  }

  _onKick (bot, info) {
    const cfg = this.config.kick
    const cooldownSec = info.ban ? cfg.banCooldownSeconds : cfg.cooldownSeconds
    this.cooldowns.set(bot.id, Date.now() + cooldownSec * 1000)
    // Back off for everyone: a kick (and especially a ban) may apply to the whole address.
    this.scheduler.pause(1000 * (info.ban ? Math.max(cfg.globalPauseSeconds, cfg.cooldownSeconds) : cfg.globalPauseSeconds))
    this.log.warn('bot kicked; not retrying', { id: bot.id, ban: info.ban, text: info.text })
    this.reports.emit({ type: 'kick', id: bot.id, username: bot.account.username, ban: info.ban, text: info.text, until: info.until })
  }

  // ---- config ----

  /**
   * Swaps in a freshly validated config. Running bots keep their sockets; limits, backoff,
   * balance source, report sinks and kick settings apply from now on.
   * @returns {{changed: string[], restartRequired: string[]}}
   */
  applyConfig (next) {
    const changed = diffConfig(this.config, next)
    const restartRequired = changed.filter(p => RESTART_REQUIRED.includes(p))
    const prev = this.config
    // Keep the live API settings: those need a restart, and nothing else reads them from here.
    this.config = { ...next, api: prev.api }
    Object.defineProperty(this.config, 'compiled', { value: next.compiled, enumerable: false })
    this.source = createBalanceSource(this.config, { env: this.env, fetch: this.fetch })
    if (changed.some(p => p.startsWith('reports'))) this.reports.configure(this.config.reports)
    this.dump.configure(this.config.debug.dump)
    if (changed.includes('audit.file')) this.audit = new AuditLog(this.config.audit.file)
    if (changed.some(p => p.startsWith('server'))) this.versions.invalidate()
    this.scheduler.kick()
    return { changed, restartRequired }
  }

  async shutdown () {
    this.budget.stop()
    this.scheduler.stop()
    for (const bot of this.bots.values()) bot.stop('shutdown')
    await this.dump.close()
    await this.reports.close()
  }
}
