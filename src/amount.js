/**
 * Turns a user-configured regular expression plus a text line into a balance reading.
 * Nothing here knows what any particular server prints: the pattern comes from the
 * config and must name a capture group `amount`.
 */

const PLAIN_NUMBER = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/

/**
 * Parses the text captured by the `amount` group.
 * Accepts an optional leading currency symbol from `currencySymbols`, plain digits or
 * comma-grouped digits, an optional decimal part, and an optional suffix that must be a
 * key of `suffixes` (empty by default, so "1.5M" is rejected unless configured).
 * Returns null for anything else rather than guessing.
 * @param {string} text
 * @param {{suffixes?: Record<string, number>, currencySymbols?: string}} [opts]
 * @returns {number | null}
 */
export function parseAmount (text, opts = {}) {
  const suffixes = opts.suffixes ?? {}
  const symbols = opts.currencySymbols ?? '$'
  let s = text.trim()
  if (s.length > 0 && symbols.includes(s[0])) s = s.slice(1).trimStart()

  let mult = 1
  const m = /^(.*?\d)\s*([A-Za-z]+)$/.exec(s)
  if (m) {
    const key = Object.hasOwn(suffixes, m[2]) ? m[2] : Object.keys(suffixes).find(k => k.toLowerCase() === m[2].toLowerCase())
    if (key === undefined) return null
    mult = suffixes[key]
    s = m[1]
  }
  if (!PLAIN_NUMBER.test(s)) return null
  const n = Number(s.replaceAll(',', ''))
  if (!Number.isFinite(n)) return null
  // toPrecision strips binary noise such as 1.1 * 1000 = 1100.0000000000002
  return mult === 1 ? n : Number((n * mult).toPrecision(15))
}

/**
 * Compiles a user pattern and checks it exposes the `amount` group.
 * @param {string} source
 * @param {string} [flags]
 */
export function compileAmountPattern (source, flags = 'i') {
  const re = new RegExp(source, flags.replace(/[gy]/g, ''))
  if (!/\(\?<amount>/.test(source)) {
    throw new Error(`pattern must contain a named group (?<amount>...): ${source}`)
  }
  return re
}

/**
 * @param {string} text line or message to inspect
 * @param {RegExp} re compiled with compileAmountPattern
 * @param {{suffixes?: Record<string, number>, currencySymbols?: string}} [opts]
 * @returns {{amount: number, matched: string, captured: string} | {amount: null, matched: string, captured: string, error: string} | null}
 *   null when the pattern does not match at all; amount null when it matched but the captured text is not a number
 */
export function extractAmount (text, re, opts) {
  const m = re.exec(text)
  if (!m) return null
  const captured = m.groups.amount ?? ''
  const amount = parseAmount(captured, opts)
  if (amount === null) return { amount: null, matched: m[0], captured, error: `unparseable amount ${JSON.stringify(captured)}` }
  return { amount, matched: m[0], captured }
}
