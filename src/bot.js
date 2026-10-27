import mc from 'minecraft-protocol'
import minecraftData from 'minecraft-data'
import { backoffDelay } from './backoff.js'
import { LeanClient } from './lean.js'
import { ScoreboardTracker } from './scoreboard.js'
import { componentToText, rawComponentJson } from './text.js'
import { collectWindow, MessageRing } from './messages.js'
import { BalanceError } from './balance/errors.js'

/** @typedef {'connecting'|'online'|'reconnecting'|'kicked'|'stopped'} BotState */

const noop = () => {}
const KICK_TEXT_LIMIT = 500
const AUTH_ERROR = /invalid session|forbidden|unauthorized|invalidcredentials|\b40[13]\b/i

class AuthRequiredError extends Error {
  constructor () {
    super('Microsoft sign-in required: no cached tokens for this account')
    this.code = 'AUTH_REQUIRED'
  }
}

/**
 * One bot account: connection lifecycle, balance reads and the state machine
 * connecting -> online -> reconnecting -> ... | kicked | stopped.
 *
 * A bot never retries after the server kicked it (kick or ban text): it enters `kicked`
 * and stays there; the manager refuses to restart it until the cooldown has passed.
 */
export class Bot {
  /**
   * @param {object} account entry from config.accounts
   * @param {object} ctx { getConfig, getSource, hooks, versions, dump, env, log, createClient? }
   */
  constructor (account, ctx) {
    this.account = account
    this.id = account.id
    this.ctx = ctx
    /** @type {BotState} */
    this.state = 'connecting'
    this.reason = null
    this.detail = 'queued'
    this.since = Date.now()
    /** 'idle' (no socket) | 'handshake' (socket open, not yet in game) | 'online' */
    this.phase = 'idle'
    this.failures = 0
    this.attempts = 0
    this.onlineAt = null
    this.nextAttemptAt = null
    this.lastError = null
    this.kick = null
    this.balance = null
    this.lastReadError = null
    this.reads = 0
    this.readErrors = 0
    this.stopped = false

    this.generation = 0
    this.client = null
    this.tracker = null
    this.dump = null
    this.reading = false
    this.lastReadStartedAt = 0
    this.timers = { connect: null, reconnect: null, read: null }
    this._waiters = new Set()
    this._chatSubs = new Set()
    this._chatHandlers = null
    this._authRequired = false
    this.ring = new MessageRing(ctx.getConfig().observe.messageBuffer)
    this._ringSub = null
    this._aborts = new Set()
  }

  _event (text) {
    this.ring.push({ ts: Date.now(), kind: 'event', text, raw: '' })
  }

  _wantsTracker () {
    return this.ctx.getSource().needs.scoreboard || this.ctx.getConfig().observe.trackScoreboard
  }

  // ---- state ----

  _set (state, detail = null, reason = null) {
    const prev = this.state
    this.state = state
    this.detail = detail
    this.reason = reason
    if (prev !== state) {
      this.since = Date.now()
      this.ctx.hooks.stateChanged(this, prev)
    }
  }

  _setPhase (phase) {
    if (this.phase === phase) return
    this.phase = phase
    this.ctx.hooks.phaseChanged(this)
  }

  status () {
    return {
      id: this.id,
      username: this.account.username,
      state: this.state,
      reason: this.reason,
      detail: this.detail,
      since: new Date(this.since).toISOString(),
      onlineSince: this.state === 'online' && this.onlineAt ? new Date(this.onlineAt).toISOString() : null,
      nextAttemptAt: this.nextAttemptAt ? new Date(this.nextAttemptAt).toISOString() : null,
      attempts: this.attempts,
      failures: this.failures,
      lastError: this.lastError,
      kick: this.kick,
      balance: this.balance,
      lastReadError: this.lastReadError,
      reads: this.reads,
      readErrors: this.readErrors
    }
  }

  // ---- connection ----

  /** Called by the scheduler once a join slot is available. */
  async connect () {
    if (this.stopped || this.phase !== 'idle') return
    const cfg = this.ctx.getConfig()
    const token = ++this.generation
    this.attempts++
    this._authRequired = false
    this._setPhase('handshake')
    this._set('connecting', 'handshaking')
    try {
      const version = await this.ctx.versions.resolve(cfg.server)
      if (token !== this.generation) return
      const opts = await this._clientOptions(cfg, version)
      if (token !== this.generation) return
      const client = (this.ctx.createClient ?? mc.createClient)(opts)
      this.client = client
      this._wire(client, cfg, token)
    } catch (e) {
      if (token === this.generation) this._failed(e)
    }
  }

  async _clientOptions (cfg, version) {
    const a = this.account
    const opts = {
      host: cfg.server.host,
      port: cfg.server.port,
      username: a.username,
      version,
      hideErrors: true,
      keepAlive: true,
      checkTimeoutInterval: cfg.client.keepAliveTimeoutMs,
      closeTimeout: cfg.client.keepAliveTimeoutMs,
      disableChatSigning: cfg.client.disableChatSigning,
      clientSettings: { viewDistance: cfg.client.viewDistance, locale: cfg.client.locale }
    }
    if (cfg.client.lean) opts.Client = LeanClient

    if (a.auth === 'microsoft') {
      // Never prompt: a cold cache means the account needs `npm run auth` once.
      opts.auth = 'microsoft'
      opts.profilesFolder = cfg.auth.profilesFolder
      opts.onMsaCode = () => { this._authRequired = true; throw new AuthRequiredError() }
    } else if (a.auth === 'token') {
      const accessToken = this.ctx.env[a.accessTokenEnv]
      const profileId = this.ctx.env[a.profileIdEnv]
      if (!accessToken || !profileId) {
        const e = new Error(`environment variable ${!accessToken ? a.accessTokenEnv : a.profileIdEnv} is not set`)
        e.code = 'AUTH_ENV_MISSING'
        throw e
      }
      opts.auth = (client, options) => {
        const profile = { id: profileId.replaceAll('-', ''), name: a.username }
        client.username = a.username
        client.session = { accessToken, selectedProfile: profile, availableProfile: [profile] }
        options.accessToken = accessToken
        options.haveCredentials = true
        client.emit('session', client.session)
        options.connect(client)
      }
    } else {
      opts.auth = 'offline'
    }
    return opts
  }

  _wire (client, cfg, token) {
    const live = () => token === this.generation && this.client === client
    const write = (name, data) => { try { client.write(name, data) } catch { /* packet not valid in this state/version */ } }

    this.timers.connect = setTimeout(() => {
      if (live() && this.phase === 'handshake') this._failed(new Error(`connect timeout after ${cfg.server.connectTimeoutMs} ms`))
    }, cfg.server.connectTimeoutMs)

    const needTracker = this._wantsTracker()
    this.dump = this.ctx.dump.begin(this.id, { account: this.account.username, version: client.version, host: cfg.server.host, port: cfg.server.port })
    if (needTracker || this.dump) {
      this.tracker = new ScoreboardTracker()
      this.tracker.attach(client)
    }

    // Protocol upkeep a vanilla client does; all cheap, none of it evasive.
    client.on('ping', p => write('pong', { id: p.id }))
    client.on('chunk_batch_finished', () => write('chunk_batch_received', { chunksPerTick: 1 }))
    // Resource packs are always declined. A server that requires one will kick us, and that is then final.
    const decline = p => write('resource_pack_receive', { uuid: p.uuid, hash: p.hash ?? '', result: 1 })
    client.on('add_resource_pack', decline)
    client.on('resource_pack_send', decline)

    client.once('login', () => { if (live()) this._onLogin(client, cfg) })
    const onKick = p => { if (live()) this._onKick(p.reason) }
    client.on('disconnect', onKick)
    client.on('kick_disconnect', onKick)
    client.on('error', e => {
      if (!live()) return
      this.lastError = { message: String(e?.message ?? e).slice(0, 300), at: new Date().toISOString() }
      if (this.phase === 'handshake') this._failed(e)
    })
    client.on('end', reason => { if (live()) this._ended(reason) })
  }

  _onLogin (client, cfg) {
    clearTimeout(this.timers.connect)
    this.onlineAt = Date.now()
    this._setPhase('online')
    this._set('online')
    this._event('online')
    this.ring.capacity = cfg.observe.messageBuffer
    while (this.ring.items.length > this.ring.capacity) this.ring.items.shift()
    if (this.ring.capacity > 0) {
      this._ringSub = (kind, text, raw) => this.ring.push({ ts: Date.now(), kind, text, raw: rawComponentJson(raw) })
      this._chatSubs.add(this._ringSub)
      this._syncChatListeners()
    }

    const data = minecraftData(client.version)
    if (!data.supportFeature('hasConfigurationState')) {
      // Newer versions already sent client information (with our view distance) during configuration.
      try {
        client.write('settings', {
          locale: cfg.client.locale,
          viewDistance: cfg.client.viewDistance,
          chatFlags: 0,
          chatColors: true,
          skinParts: 127,
          mainHand: 1,
          enableTextFiltering: false,
          enableServerListing: true,
          particleStatus: 0
        })
      } catch { /* ignore */ }
    }

    if (this.dump) {
      if (this.dump.start(this.tracker)) {
        const sub = (kind, text, raw) => this.dump.write('chat', { kind, text, raw })
        this._chatSubs.add(sub)
        this._syncChatListeners()
        this.dump.onEnd = () => {
          this._chatSubs.delete(sub)
          this._syncChatListeners()
          if (!this._wantsTracker()) this._dropTracker()
        }
      } else {
        this.dump = null
        if (!this._wantsTracker()) this._dropTracker()
      }
    }

    this._scheduleRead(cfg.balance.readyDelayMs)
  }

  _dropTracker () {
    this.tracker?.detach()
    this.tracker = null
  }

  _onKick (reason) {
    let text
    try { text = componentToText(reason) } catch { text = String(reason) }
    text = text.slice(0, KICK_TEXT_LIMIT)
    const cfg = this.ctx.getConfig()
    if (cfg.compiled.transientRe?.test(text)) return this._enterReconnect(`server notice: ${text}`.slice(0, 120))
    const ban = cfg.compiled.banRe.test(text)
    const cooldownSec = ban ? cfg.kick.banCooldownSeconds : cfg.kick.cooldownSeconds
    this._teardown()
    this._event(`kicked: ${text}`)
    this.kick = { text, ban, at: new Date().toISOString(), until: new Date(Date.now() + cooldownSec * 1000).toISOString() }
    this._set('kicked', null, ban ? 'banned' : 'kicked')
    this.ctx.hooks.kicked(this, this.kick)
  }

  _ended (reason) {
    this._enterReconnect(typeof reason === 'string' ? reason : 'connection closed')
  }

  _failed (err) {
    if (this.stopped) return
    const message = String(err?.message ?? err).slice(0, 300)
    this.lastError = { message, at: new Date().toISOString() }
    if (this._authRequired || err?.code === 'AUTH_REQUIRED') return this._terminal('auth_required')
    if (err?.code === 'AUTH_ENV_MISSING') return this._terminal('auth_env_missing')
    if (err?.code === 'UNSUPPORTED_VERSION' || /unsupported protocol version/i.test(message)) return this._terminal('unsupported_version')
    if (this.account.auth !== 'offline' && AUTH_ERROR.test(message)) return this._terminal('auth_failed')
    this._enterReconnect(message)
  }

  _terminal (reason) {
    this._teardown()
    this._set('stopped', null, reason)
  }

  _enterReconnect (cause) {
    const cfg = this.ctx.getConfig()
    const uptime = this.onlineAt ? Date.now() - this.onlineAt : 0
    if (this.phase === 'online') this._event(`connection lost: ${cause}`.slice(0, 200))
    this._teardown()
    if (uptime >= cfg.reconnect.resetAfterMs) this.failures = 0
    this.failures++
    if (!cfg.reconnect.enabled) return this._set('stopped', null, 'reconnect_disabled')
    if (cfg.reconnect.maxAttempts > 0 && this.failures > cfg.reconnect.maxAttempts) return this._set('stopped', null, 'max_attempts')
    const delay = backoffDelay(this.failures, cfg.reconnect)
    this.nextAttemptAt = Date.now() + delay
    this._set('reconnecting', cause.slice(0, 120))
    this.timers.reconnect = setTimeout(() => {
      this.timers.reconnect = null
      this.nextAttemptAt = null
      if (this.stopped || this.state !== 'reconnecting') return
      this._set('connecting', 'queued')
      this.ctx.hooks.requestConnect(this)
    }, delay)
  }

  /** Stops the bot for good (until the manager starts it again). */
  stop (reason = 'user') {
    if (this.stopped) return
    this.stopped = true
    this._teardown()
    this._set('stopped', null, reason)
  }

  _teardown () {
    this.generation++
    for (const k of Object.keys(this.timers)) { clearTimeout(this.timers[k]); this.timers[k] = null }
    this.nextAttemptAt = null
    for (const finish of [...this._waiters]) finish(null)
    for (const a of this._aborts) a.abort()
    this._aborts.clear()
    this._ringSub = null
    this._chatSubs.clear()
    this._syncChatListeners()
    this.dump?.stop()
    this.dump = null
    this._dropTracker()
    const client = this.client
    this.client = null
    this.onlineAt = null
    if (client) {
      client.on('error', noop) // an 'error' with no listener would throw
      client.removeAllListeners('login')
      try { client.end('bot closing') } catch { /* already closed */ }
      client.socket?.destroy()
    }
    this._setPhase('idle')
    this.reading = false
  }

  // ---- chat tap (listeners exist only while something is waiting or dumping) ----

  _syncChatListeners () {
    const client = this.client
    if (!client) { this._chatHandlers = null; return }
    if (this._chatSubs.size > 0 && !this._chatHandlers) {
      const emit = (kind, raw) => {
        if (raw == null) return
        const text = componentToText(raw)
        for (const sub of this._chatSubs) sub(kind, text, raw)
      }
      this._chatHandlers = {
        chat: p => emit(p.position === 0 ? 'player' : p.position === 2 ? 'actionbar' : 'system', p.message), // <= 1.18
        system_chat: p => emit(p.isActionBar || p.type === 2 ? 'actionbar' : 'system', p.content),
        player_chat: p => emit('player', p.unsignedChatContent || p.signedChatContent || p.plainMessage),
        profileless_chat: p => emit('player', p.message),
        action_bar: p => emit('actionbar', p.text)
      }
      for (const [ev, fn] of Object.entries(this._chatHandlers)) client.on(ev, fn)
    } else if (this._chatSubs.size === 0 && this._chatHandlers) {
      for (const [ev, fn] of Object.entries(this._chatHandlers)) client.off(ev, fn)
      this._chatHandlers = null
    }
  }

  /**
   * @param {(text: string) => any} match returns a truthy value for the reply
   * @param {number} timeoutMs
   * @param {Set<string>} accept message kinds: system | actionbar | player
   * @returns {Promise<{kind: string, text: string, raw: any, result: any} | null>}
   */
  _waitForChat (match, timeoutMs, accept) {
    return new Promise(resolve => {
      const finish = v => {
        clearTimeout(timer)
        this._waiters.delete(finish)
        this._chatSubs.delete(sub)
        this._syncChatListeners()
        resolve(v)
      }
      const sub = (kind, text, raw) => {
        if (!accept.has(kind)) return
        const result = match(text)
        if (result) finish({ kind, text, raw, result })
      }
      const timer = setTimeout(() => finish(null), timeoutMs)
      this._waiters.add(finish)
      this._chatSubs.add(sub)
      this._syncChatListeners()
    })
  }

  /** Records the send in the audit log first (a failed write aborts the send), then sends. */
  _send (text, actor) {
    const cfg = this.ctx.getConfig()
    if (actor !== 'poll' || cfg.audit.polls) this.ctx.hooks.audit({ actor, action: 'send', bot: this.id, text })
    this.dump?.write('command_sent', { text, actor })
    this.client.chat(text)
  }

  _sendCommand (text, actor) {
    this._send(text.startsWith('/') ? text : '/' + text, actor)
  }

  /**
   * Sends `text` as chat, or as a command when it starts with "/", then collects every message the bot
   * receives for `windowMs`, so a delayed reply is returned with the command that caused it.
   * @returns {Promise<{sent: string, kind: 'chat'|'command', windowMs: number, messages: object[]}>}
   */
  async say (text, windowMs, actor = 'api') {
    if (this.phase !== 'online' || !this.client) {
      throw Object.assign(new Error(`bot is ${this.state}`), { code: 'not_online' })
    }
    const abort = new AbortController()
    this._aborts.add(abort)
    try {
      const messages = await collectWindow({
        subscribe: fn => {
          const sub = (kind, t, raw) => fn({ ts: Date.now(), kind, text: t, raw: rawComponentJson(raw) })
          this._chatSubs.add(sub)
          this._syncChatListeners()
          return () => { this._chatSubs.delete(sub); this._syncChatListeners() }
        },
        start: () => this._send(text, actor),
        windowMs,
        signal: abort.signal
      })
      return { sent: text, kind: text.startsWith('/') ? 'command' : 'chat', windowMs, messages }
    } finally {
      this._aborts.delete(abort)
    }
  }

  /** Sidebar and tab text as currently tracked, or null if scoreboard tracking is off for this bot. */
  sidebar (withRaw = false) {
    if (!this.tracker) return null
    return { sidebar: this.tracker.snapshotSidebar(withRaw), tab: this.tracker.snapshotTab() }
  }

  _session (actor = 'poll') {
    // A reload may have switched to a source that needs the scoreboard; it then fills from the next packets.
    if (!this.tracker && this.client && this.ctx.getSource().needs.scoreboard) {
      this.tracker = new ScoreboardTracker()
      this.tracker.attach(this.client)
    }
    return {
      username: this.client?.username ?? this.account.username,
      uuid: this.client?.uuid,
      tracker: this.tracker,
      waitForChat: (match, ms, accept) => this._waitForChat(match, ms, accept),
      sendCommand: text => this._sendCommand(text, actor)
    }
  }

  // ---- balance ----

  _scheduleRead (delayMs) {
    clearTimeout(this.timers.read)
    this.timers.read = setTimeout(() => { this.timers.read = null; this._read() }, delayMs)
  }

  /**
   * Requests an immediate read, subject to the per-bot minimum interval.
   * @returns {Promise<object>} the report
   */
  refresh (actor = 'api') {
    const cfg = this.ctx.getConfig()
    if (this.phase !== 'online') return Promise.reject(new BalanceError('not_online', `bot is ${this.state}`))
    if (this.reading) return Promise.reject(new BalanceError('busy', 'a read is already in progress'))
    const wait = this.lastReadStartedAt + cfg.balance.minReadIntervalSec * 1000 - Date.now()
    if (wait > 0) {
      const e = new BalanceError('too_soon', `last read was too recent; retry in ${Math.ceil(wait / 1000)} s`)
      e.retryAfterSec = Math.ceil(wait / 1000)
      return Promise.reject(e)
    }
    clearTimeout(this.timers.read)
    return this._read(actor)
  }

  async _read (actor = 'poll') {
    if (this.phase !== 'online' || this.reading) return null
    const token = this.generation
    const cfg = this.ctx.getConfig()
    this.reading = true
    this.lastReadStartedAt = Date.now()
    let report
    try {
      const r = await this.ctx.getSource().read(this._session(actor))
      if (token !== this.generation) return null
      const at = new Date().toISOString()
      this.balance = { amount: r.amount, raw: r.raw, source: r.source, at }
      this.lastReadError = null
      this.reads++
      report = { type: 'balance', id: this.id, username: this.account.username, amount: r.amount, raw: r.raw, source: r.source, at, detail: r.detail }
    } catch (e) {
      if (token !== this.generation) return null
      this.readErrors++
      const err = { code: e.code ?? 'error', message: String(e.message).slice(0, 300), raw: e.raw, at: new Date().toISOString() }
      this.lastReadError = err
      report = { type: 'balance_error', id: this.id, username: this.account.username, source: cfg.balance.source, error: err.code, message: err.message, raw: err.raw }
    } finally {
      if (token === this.generation) {
        this.reading = false
        if (cfg.balance.pollIntervalSec > 0) {
          this._scheduleRead(cfg.balance.pollIntervalSec * 1000 * (0.9 + Math.random() * 0.2))
        }
      }
    }
    this.ctx.hooks.report(report)
    return report
  }
}
