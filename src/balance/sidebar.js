import { extractAmount } from '../amount.js'
import { BalanceError } from './errors.js'

/**
 * Source (c): a money row on the sidebar scoreboard and/or the tab list header/footer.
 * `labelPattern` is matched against each row's plain text and must capture `amount`.
 */
export class SidebarSource {
  /** @param {object} balanceCfg config.balance @param {RegExp} re compiled labelPattern */
  constructor (balanceCfg, re) {
    this.name = 'sidebar'
    this.needs = { scoreboard: true, chat: false }
    this.cfg = balanceCfg
    this.re = re
    this.opts = { suffixes: balanceCfg.suffixes, currencySymbols: balanceCfg.currencySymbols }
    this.surfaces = balanceCfg.sidebar.surfaces
  }

  async read (session) {
    const tracker = session.tracker
    const find = () => {
      for (const surface of this.surfaces) {
        let lines
        if (surface === 'sidebar') lines = tracker.snapshotSidebar()?.lines
        else {
          const tab = tracker.snapshotTab()
          lines = (surface === 'tabHeader' ? tab.header : tab.footer).split('\n')
        }
        for (const line of lines ?? []) {
          const result = extractAmount(line, this.re, this.opts)
          if (result) return { surface, line, result }
        }
      }
      return null
    }
    const hit = await tracker.waitFor(find, this.cfg.readTimeoutMs)
    if (!hit) throw new BalanceError('timeout', `no ${this.surfaces.join('/')} row matched the label pattern within ${this.cfg.readTimeoutMs} ms`)
    if (hit.result.amount === null) throw new BalanceError('unparseable', hit.result.error, { raw: hit.line })
    return { amount: hit.result.amount, raw: hit.line, source: 'sidebar', detail: { surface: hit.surface, matched: hit.result.matched } }
  }
}
