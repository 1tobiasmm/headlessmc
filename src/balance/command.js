import { extractAmount } from '../amount.js'
import { BalanceError } from './errors.js'

/**
 * Source (b): send the server's own balance command and parse the reply.
 * The reply pattern is supplied by the operator; the first message of an accepted kind
 * that matches it within the timeout is the reply.
 */
export class CommandSource {
  /** @param {object} balanceCfg config.balance @param {RegExp} re compiled replyPattern */
  constructor (balanceCfg, re) {
    this.name = 'command'
    this.needs = { scoreboard: false, chat: true }
    this.cfg = balanceCfg
    this.re = re
    this.opts = { suffixes: balanceCfg.suffixes, currencySymbols: balanceCfg.currencySymbols }
    this.accept = new Set(balanceCfg.command.accept)
  }

  async read (session) {
    const wait = session.waitForChat(text => extractAmount(text, this.re, this.opts), this.cfg.readTimeoutMs, this.accept)
    session.sendCommand(this.cfg.command.text)
    const hit = await wait
    if (!hit) throw new BalanceError('timeout', `no reply matching the pattern within ${this.cfg.readTimeoutMs} ms`)
    if (hit.result.amount === null) throw new BalanceError('unparseable', hit.result.error, { raw: hit.text })
    return { amount: hit.result.amount, raw: hit.text, source: 'command', detail: { kind: hit.kind, matched: hit.result.matched } }
  }
}
