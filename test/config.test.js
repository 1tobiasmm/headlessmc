import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, diffConfig, loadConfig, parseAccount, validateConfig } from '../src/config.js'

const minimal = (extra = {}) => ({
  server: { host: 'mc.example.test' },
  balance: { source: 'sidebar', sidebar: { labelPattern: 'Money: (?<amount>[\\d,]+)' } },
  ...extra
})

test('defaults are applied', () => {
  const c = validateConfig(minimal())
  assert.equal(c.server.port, 25565)
  assert.equal(c.server.version, 'auto')
  assert.equal(c.limits.maxConcurrentConnecting, 3)
  assert.equal(c.api.bind, '127.0.0.1')
  assert.equal(c.api.tokenEnv, 'HMC_API_TOKEN')
  assert.equal(c.client.viewDistance, 2)
  assert.equal(c.reconnect.factor, 2)
})

test('server.host is required', () => {
  assert.throws(() => validateConfig({ balance: minimal().balance }), ConfigError)
})

test('unknown keys are rejected so typos do not silently do nothing', () => {
  assert.throws(() => validateConfig(minimal({ limts: {} })), /limts/)
  assert.throws(() => validateConfig(minimal({ limits: { maxBot: 1 } })), /maxBot/)
})

test('balance source needs its own section', () => {
  assert.throws(() => validateConfig({ server: { host: 'x' }, balance: { source: 'command' } }), /balance\.command is missing/)
  assert.throws(() => validateConfig({ server: { host: 'x' }, balance: { source: 'http' } }), /balance\.http is missing/)
  assert.throws(() => validateConfig({ server: { host: 'x' }, balance: { source: 'nope' } }), ConfigError)
})

test('patterns must expose a named amount group', () => {
  assert.throws(() => validateConfig(minimal({ balance: { source: 'sidebar', sidebar: { labelPattern: 'Money: ([\\d,]+)' } } })), /\(\?<amount>/)
  assert.throws(() => validateConfig(minimal({ balance: { source: 'command', command: { text: '/bal', replyPattern: '(?<amount>[' } } })), ConfigError)
})

test('poll interval cannot undercut the minimum read interval', () => {
  const b = { source: 'sidebar', pollIntervalSec: 10, sidebar: { labelPattern: '(?<amount>\\d+)' } }
  assert.throws(() => validateConfig(minimal({ balance: b })), /at least minReadIntervalSec/)
  assert.doesNotThrow(() => validateConfig(minimal({ balance: { ...b, pollIntervalSec: 0 } })))
  assert.doesNotThrow(() => validateConfig(minimal({ balance: { ...b, pollIntervalSec: 30 } })))
})

test('accounts: id defaults to username, duplicates rejected', () => {
  const c = validateConfig(minimal({ accounts: [{ username: 'Alice_1' }, { id: 'b', username: 'Bob_2' }] }))
  assert.deepEqual(c.accounts.map(a => a.id), ['Alice_1', 'b'])
  assert.throws(() => validateConfig(minimal({ accounts: [{ username: 'Alice_1' }, { id: 'Alice_1', username: 'Other_2' }] })), /duplicate account id/)
})

test('offline usernames follow Minecraft rules', () => {
  assert.throws(() => validateConfig(minimal({ accounts: [{ username: 'has space' }] })), ConfigError)
  assert.throws(() => validateConfig(minimal({ accounts: [{ username: 'waytoolongusername1' }] })), /3-16/)
})

test('token auth needs both environment variable names and never accepts the secret inline', () => {
  assert.throws(() => validateConfig(minimal({ accounts: [{ username: 'Alice_1', auth: 'token' }] })), /accessTokenEnv/)
  assert.throws(() => validateConfig(minimal({ accounts: [{ username: 'Alice_1', auth: 'token', accessToken: 'secret' }] })), /accessToken/)
  const ok = validateConfig(minimal({ accounts: [{ username: 'Alice_1', auth: 'token', accessTokenEnv: 'A_TOKEN', profileIdEnv: 'A_UUID' }] }))
  assert.equal(ok.accounts[0].accessTokenEnv, 'A_TOKEN')
  assert.throws(() => validateConfig(minimal({ accounts: [{ username: 'Alice_1', auth: 'token', accessTokenEnv: 'not a name', profileIdEnv: 'X' }] })), ConfigError)
})

test('account groups expand deterministically', () => {
  const c = validateConfig(minimal({ accountGroups: [{ idPrefix: 'bench', usernamePrefix: 'Bench', count: 3, pad: 2 }] }))
  assert.deepEqual(c.accounts.map(a => [a.id, a.username]), [['bench01', 'Bench01'], ['bench02', 'Bench02'], ['bench03', 'Bench03']])
  assert.ok(c.accounts.every(a => a.auth === 'offline'))
  assert.throws(() => validateConfig(minimal({ accountGroups: [{ idPrefix: 'g', usernamePrefix: 'LongPrefix12', count: 5, pad: 6 }] })), /invalid username/)
})

test('maxConcurrentConnecting is clamped to maxConcurrentBots', () => {
  const c = validateConfig(minimal({ limits: { maxConcurrentBots: 2, maxConcurrentConnecting: 9 } }))
  assert.equal(c.limits.maxConcurrentConnecting, 2)
})

test('http source: urls must be urls and env names must be names', () => {
  const h = (x) => minimal({ balance: { source: 'http', http: { url: 'https://api.example.test/bal/{username}', jsonPath: 'result.money', ...x } } })
  assert.doesNotThrow(() => validateConfig(h({ bearerTokenEnv: 'MY_KEY' })))
  assert.throws(() => validateConfig(h({ url: 'not a url' })), ConfigError)
  assert.throws(() => validateConfig(h({ bearerTokenEnv: 'bad name' })), ConfigError)
})

test('loadConfig reads YAML and reports file errors as ConfigError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hmc-cfg-'))
  const file = join(dir, 'c.yaml')
  writeFileSync(file, 'server:\n  host: mc.example.test\n  port: 25570\nbalance:\n  source: sidebar\n  sidebar:\n    labelPattern: "Money: (?<amount>[\\\\d,]+)"\n')
  const c = loadConfig(file)
  assert.equal(c.server.port, 25570)
  assert.throws(() => loadConfig(join(dir, 'missing.yaml')), ConfigError)
  writeFileSync(file, 'server: [unclosed')
  assert.throws(() => loadConfig(file), /cannot parse/)
})

test('config.compiled holds regexes and is not serialised', () => {
  const c = validateConfig(minimal())
  assert.ok(c.compiled.sidebarRe instanceof RegExp)
  assert.ok(!JSON.stringify(c).includes('compiled'))
})

test('parseAccount validates ad-hoc API accounts', () => {
  assert.equal(parseAccount({ username: 'Adhoc_1' }).id, 'Adhoc_1')
  assert.throws(() => parseAccount({ username: 'x' }), ConfigError)
})

test('diffConfig lists changed leaves', () => {
  const a = validateConfig(minimal())
  const b = validateConfig(minimal({ limits: { maxConcurrentBots: 7 }, api: { port: 9999 } }))
  assert.deepEqual(diffConfig(a, b).sort(), ['api.port', 'limits.maxConcurrentBots'])
})

test('server.version must be "auto" or a version the library supports', () => {
  assert.doesNotThrow(() => validateConfig(minimal({ server: { host: 'x', version: 'auto' } })))
  assert.doesNotThrow(() => validateConfig(minimal({ server: { host: 'x', version: '1.21.4' } })))
  assert.throws(() => validateConfig(minimal({ server: { host: 'x', version: '1.2.3' } })), /unsupported version "1.2.3"/)
})

test('kick.transientPattern: default matches only whole shutdown notices; empty disables', () => {
  const re = validateConfig(minimal()).compiled.transientRe
  for (const t of ['Server closed', 'server closed.', 'Server is restarting', 'Server is shutting down']) assert.ok(re.test(t), t)
  for (const t of ['Server closed for cheating', 'You are banned: server closed', 'Kicked', 'Flying is not enabled']) assert.ok(!re.test(t), t)
  assert.equal(validateConfig(minimal({ kick: { transientPattern: '' } })).compiled.transientRe, null)
})
