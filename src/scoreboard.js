import { componentToText, stripFormatting } from './text.js'

const MAX_OBJECTIVES = 8
const MAX_SCORES_PER_OBJECTIVE = 64
const MAX_TEAMS = 1024
const SIDEBAR_SLOT = 1
// Newer minecraft-data (1.21.8+) names the teams `mode` instead of leaving it numeric.
const TEAM_MODES = { add: 0, remove: 1, change: 2, join: 3, leave: 4 }

/**
 * Tracks the sidebar scoreboard and the tab list header/footer from raw packets.
 * Stores raw components and flattens only when a snapshot is requested, so the
 * per-packet cost is a few Map operations. All collections are size-capped.
 *
 * Sidebar row text is `team prefix + entry + team suffix`, or the score's own
 * display name on protocols that send one (1.20.3+).
 */
export class ScoreboardTracker {
  constructor () {
    this.objectives = new Map() // name -> { title: raw, scores: Map<entry, { value, display }> }
    this.sidebar = null
    this.teams = new Map() // name -> { prefix, suffix, players:Set }
    this.teamOf = new Map() // entry -> team name
    this.header = null
    this.footer = null
    this.version = 0 // bumps on every relevant packet
    this.waiters = new Set() // callbacks run on every change; non-empty only while a read is waiting
    this._handlers = null
    this._client = null
  }

  /** @param {import('node:events').EventEmitter} client */
  attach (client) {
    if (this._client) return
    this._client = client
    this._handlers = {
      scoreboard_objective: p => this._objective(p),
      scoreboard_display_objective: p => this._display(p),
      scoreboard_score: p => this._score(p),
      reset_score: p => this._reset(p),
      teams: p => this._team(p),
      playerlist_header: p => { this.header = p.header; this.footer = p.footer; this._touch() }
    }
    for (const [ev, fn] of Object.entries(this._handlers)) client.on(ev, fn)
  }

  detach () {
    if (!this._client) return
    for (const [ev, fn] of Object.entries(this._handlers)) this._client.off(ev, fn)
    this._client = null
    this._handlers = null
    this.clear()
  }

  clear () {
    this.objectives.clear()
    this.teams.clear()
    this.teamOf.clear()
    this.sidebar = null
    this.header = this.footer = null
  }

  _touch () {
    this.version++
    for (const w of this.waiters) w()
  }

  _objective (p) {
    if (p.action === 1) {
      this.objectives.delete(p.name)
      if (this.sidebar === p.name) this.sidebar = null
    } else {
      const o = this.objectives.get(p.name)
      if (o) o.title = p.displayText
      else if (this.objectives.size < MAX_OBJECTIVES) this.objectives.set(p.name, { title: p.displayText, scores: new Map() })
    }
    this._touch()
  }

  _display (p) {
    if (p.position === SIDEBAR_SLOT) {
      this.sidebar = p.name || null
      this._touch()
    }
  }

  _score (p) {
    const o = this.objectives.get(p.scoreName)
    if (!o) return
    if (p.action === 1) o.scores.delete(p.itemName) // <= 1.20.2 remove
    else if (o.scores.has(p.itemName) || o.scores.size < MAX_SCORES_PER_OBJECTIVE) {
      o.scores.set(p.itemName, { value: p.value, display: p.display_name })
    }
    this._touch()
  }

  _reset (p) {
    // 1.20.3+: objective_name absent means "remove this entry from every objective"
    if (p.objective_name) this.objectives.get(p.objective_name)?.scores.delete(p.entity_name)
    else for (const o of this.objectives.values()) o.scores.delete(p.entity_name)
    this._touch()
  }

  _team (p) {
    const { team } = p
    const mode = typeof p.mode === 'string' ? TEAM_MODES[p.mode] : p.mode
    if (mode === 1) {
      const t = this.teams.get(team)
      if (t) for (const e of t.players) if (this.teamOf.get(e) === team) this.teamOf.delete(e)
      this.teams.delete(team)
    } else if (mode === 0 || mode === 2) {
      let t = this.teams.get(team)
      if (!t) {
        if (mode !== 0 || this.teams.size >= MAX_TEAMS) return
        t = { prefix: null, suffix: null, players: new Set() }
        this.teams.set(team, t)
      }
      t.prefix = p.prefix
      t.suffix = p.suffix
      if (mode === 0) this._addPlayers(team, t, p.players)
    } else if (mode === 3) {
      const t = this.teams.get(team)
      if (t) this._addPlayers(team, t, p.players)
    } else if (mode === 4) {
      const t = this.teams.get(team)
      if (t) for (const e of p.players ?? []) { t.players.delete(e); if (this.teamOf.get(e) === team) this.teamOf.delete(e) }
    }
    this._touch()
  }

  _addPlayers (team, t, players) {
    for (const e of players ?? []) {
      t.players.add(e)
      this.teamOf.set(e, team)
    }
  }

  /**
   * Plain-text view of the sidebar, highest score first.
   * @param {boolean} [withRaw] include the raw components for debug dumps
   * @returns {{title: string, lines: string[], raw?: object[]} | null}
   */
  snapshotSidebar (withRaw = false) {
    const o = this.sidebar && this.objectives.get(this.sidebar)
    if (!o) return null
    const rows = [...o.scores].sort((a, b) => b[1].value - a[1].value || (a[0] < b[0] ? 1 : -1))
    const lines = []
    const raw = withRaw ? [] : null
    for (const [entry, s] of rows) {
      const team = this.teams.get(this.teamOf.get(entry))
      const text = s.display != null
        ? componentToText(s.display)
        : stripFormatting(`${team ? componentToText(team.prefix) : ''}${entry}${team ? componentToText(team.suffix) : ''}`)
      lines.push(text)
      raw?.push({ entry, value: s.value, display: s.display ?? null, prefix: team?.prefix ?? null, suffix: team?.suffix ?? null })
    }
    const snap = { title: componentToText(o.title), lines }
    if (raw) snap.raw = raw
    return snap
  }

  /** @returns {{header: string, footer: string}} */
  snapshotTab () {
    return { header: componentToText(this.header), footer: componentToText(this.footer) }
  }

  /**
   * Resolves when `fn()` returns a truthy value, checking now and after each change.
   * @template T
   * @param {() => T} fn
   * @param {number} timeoutMs
   * @returns {Promise<T | null>} null on timeout
   */
  waitFor (fn, timeoutMs) {
    const now = fn()
    if (now) return Promise.resolve(now)
    return new Promise(resolve => {
      const check = () => { const v = fn(); if (v) done(v) }
      const done = v => { clearTimeout(timer); this.waiters.delete(check); resolve(v) }
      const timer = setTimeout(() => done(null), timeoutMs)
      this.waiters.add(check)
    })
  }
}
