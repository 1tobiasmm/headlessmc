export class BalanceError extends Error {
  /**
   * @param {'timeout'|'unparseable'|'http'|'not_online'|'config'} code
   * @param {string} message
   * @param {{raw?: string}} [extra]
   */
  constructor (code, message, extra = {}) {
    super(message)
    this.code = code
    this.raw = extra.raw
  }
}
