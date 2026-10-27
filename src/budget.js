const MB = 1024 * 1024
const CPU_SLACK_PERCENT = 10 // flat allowance for the process itself and join bursts

/**
 * Process-level resource budget. One Node process cannot meter individual bots, so this is
 * an average-based admission control: new joins are held back while the measured memory per
 * online bot or total CPU exceeds what the config allows per bot. It never kills running bots.
 * For hard isolation run several processes under cgroup limits (see README).
 */
export class ResourceBudget {
  /**
   * @param {() => object} getCfg returns config.budget
   * @param {() => number} getOnline number of online bots
   * @param {{usage?: () => {rss: number, heapUsed: number}, cpu?: () => {user: number, system: number}, now?: () => number}} [probes]
   */
  constructor (getCfg, getOnline, { usage = () => process.memoryUsage(), cpu = () => process.cpuUsage(), now = () => performance.now() } = {}) {
    this.getCfg = getCfg
    this.getOnline = getOnline
    this.usage = usage
    this.cpu = cpu
    this.now = now
    this.timer = null
    this.baselineRssMB = usage().rss / MB
    this.last = { cpu: cpu(), at: now() }
    this.rssMB = this.baselineRssMB
    this.heapMB = usage().heapUsed / MB
    this.cpuPercent = 0
    this.exceededReasons = []
  }

  start () {
    this.stop()
    const run = () => {
      this.sample()
      this.timer = setTimeout(run, this.getCfg().checkIntervalMs)
      this.timer.unref?.()
    }
    run()
  }

  stop () { clearTimeout(this.timer); this.timer = null }

  sample () {
    const u = this.usage()
    this.rssMB = u.rss / MB
    this.heapMB = u.heapUsed / MB
    const c = this.cpu()
    const t = this.now()
    const cpuMs = (c.user - this.last.cpu.user + c.system - this.last.cpu.system) / 1000
    const wallMs = t - this.last.at
    this.cpuPercent = wallMs > 0 ? (cpuMs / wallMs) * 100 : 0
    this.last = { cpu: c, at: t }

    const online = this.getOnline()
    if (online === 0) this.baselineRssMB = Math.min(this.rssMB, this.baselineRssMB) // idle floor
    this.exceededReasons = this._evaluate(online)
  }

  get perBotMB () {
    const n = this.getOnline()
    return n > 0 ? Math.max(0, this.rssMB - this.baselineRssMB) / n : 0
  }

  _evaluate (online) {
    const cfg = this.getCfg()
    const out = []
    if (!cfg.enabled) return out
    if (cfg.maxRssMB > 0 && this.rssMB >= cfg.maxRssMB) out.push('maxRssMB')
    if (online >= cfg.minBotsForAverage) {
      if (this.perBotMB > cfg.memoryMBPerBot) out.push('memoryMBPerBot')
      if (this.cpuPercent > cfg.cpuPercentPerBot * online + CPU_SLACK_PERCENT) out.push('cpuPercentPerBot')
    }
    return out
  }

  /** True when new joins should wait. */
  isOverBudget () { return this.exceededReasons.length > 0 }

  snapshot () {
    const online = this.getOnline()
    return {
      enabled: this.getCfg().enabled,
      rssMB: round(this.rssMB),
      heapUsedMB: round(this.heapMB),
      baselineRssMB: round(this.baselineRssMB),
      memoryPerOnlineBotMB: round(this.perBotMB),
      cpuPercent: round(this.cpuPercent),
      cpuPercentPerOnlineBot: online ? round(this.cpuPercent / online) : null,
      exceeded: this.exceededReasons
    }
  }
}

const round = n => Math.round(n * 100) / 100
