import test from 'node:test'
import assert from 'node:assert/strict'
import { compileAmountPattern, extractAmount, parseAmount } from '../src/amount.js'

// These patterns and texts are synthetic. They exercise the parser's rules; they are NOT a
// claim about what any real server prints. The real pattern comes from the config, written
// after reading the first-connect dump.

test('plain and comma-grouped numbers', () => {
  assert.equal(parseAmount('1234'), 1234)
  assert.equal(parseAmount('1,234'), 1234)
  assert.equal(parseAmount('1,234,567.89'), 1234567.89)
  assert.equal(parseAmount('0.5'), 0.5)
  assert.equal(parseAmount('-12.5'), -12.5)
})

test('leading currency symbol is accepted only if configured', () => {
  assert.equal(parseAmount('$1,000.25'), 1000.25)
  assert.equal(parseAmount('$ 1,000'), 1000)
  assert.equal(parseAmount('€1,000'), null)
  assert.equal(parseAmount('€1,000', { currencySymbols: '€$' }), 1000)
})

test('malformed numbers are rejected, never guessed', () => {
  for (const bad of ['', ' ', 'abc', '1,23', '1,2345', '12,34,567', '1..2', '.5', '5.', '1e5', '--1', '1 2', '$', '1,000.']) {
    assert.equal(parseAmount(bad), null, JSON.stringify(bad))
  }
})

test('suffixes are off by default and exact when configured', () => {
  assert.equal(parseAmount('1.5M'), null)
  const suffixes = { K: 1e3, M: 1e6, B: 1e9 }
  assert.equal(parseAmount('1.5M', { suffixes }), 1500000)
  assert.equal(parseAmount('$2k', { suffixes }), 2000)
  assert.equal(parseAmount('1.1K', { suffixes }), 1100) // not 1100.0000000000002
  assert.equal(parseAmount('3B', { suffixes }), 3e9)
  assert.equal(parseAmount('3T', { suffixes }), null)
  assert.equal(parseAmount('1,500K', { suffixes }), 1500000)
})

test('pattern must have an amount group', () => {
  assert.throws(() => compileAmountPattern('Money: (\\d+)'), /\(\?<amount>/)
  assert.ok(compileAmountPattern('Money: (?<amount>\\d+)') instanceof RegExp)
})

test('global/sticky flags are stripped so matching is stateless', () => {
  const re = compileAmountPattern('(?<amount>\\d+)', 'gi')
  assert.equal(re.global, false)
  assert.equal(extractAmount('a 5', re).amount, 5)
  assert.equal(extractAmount('a 5', re).amount, 5)
})

test('extractAmount: match, no match, matched-but-unparseable', () => {
  const re = compileAmountPattern('^Balance: (?<amount>\\S+)$')
  assert.deepEqual(extractAmount('Balance: $1,000', re), { amount: 1000, matched: 'Balance: $1,000', captured: '$1,000' })
  assert.equal(extractAmount('Something else', re), null)
  const bad = extractAmount('Balance: lots', re)
  assert.equal(bad.amount, null)
  assert.match(bad.error, /unparseable/)
  assert.equal(bad.captured, 'lots')
})

test('pattern matching is case-insensitive by default', () => {
  const re = compileAmountPattern('money: (?<amount>[\\d,]+)')
  assert.equal(extractAmount('MONEY: 1,500', re).amount, 1500)
})
