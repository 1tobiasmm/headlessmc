import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLine } from '../src/cli-parser.js'

const t = line => parseLine(line)

test('blank lines are ignored', () => {
  assert.deepEqual(t(''), { type: 'empty' })
  assert.deepEqual(t('   \t '), { type: 'empty' })
})

test('a leading slash sends a command, verbatim', () => {
  assert.deepEqual(t('/bal'), { type: 'say', text: '/bal' })
  assert.deepEqual(t('  /pay Steve 10  '), { type: 'say', text: '/pay Steve 10' })
  assert.deepEqual(t('/msg  Bob   hi  there'), { type: 'say', text: '/msg  Bob   hi  there' }, 'inner spacing is preserved')
  assert.equal(t('/').type, 'error')
})

test('say <text> sends chat; say /x sends a command; spacing preserved', () => {
  assert.deepEqual(t('say hello world'), { type: 'say', text: 'hello world' })
  assert.deepEqual(t('SAY  Hello   World '), { type: 'say', text: 'Hello   World' })
  assert.deepEqual(t('say /home'), { type: 'say', text: '/home' })
  assert.equal(t('say').type, 'error')
  assert.equal(t('say   ').type, 'error')
})

test('unknown words are errors and are NEVER sent as chat', () => {
  for (const line of ['hello', 'balanse', 'pay Steve 10', 'sayhello', 'Hi there everyone']) {
    assert.equal(t(line).type, 'error', line)
  }
  assert.match(t('balanse').message, /nothing was sent/)
  assert.equal(t('help').type, 'help')
})

test('text limits: 256 characters, no control characters', () => {
  assert.equal(t('say ' + 'x'.repeat(256)).type, 'say')
  assert.match(t('say ' + 'x'.repeat(257)).message, /limit is 256/)
  assert.match(t('/' + 'x'.repeat(256)).message, /limit is 256/)
  assert.match(t('say a\u0007b').message, /control/)
  assert.match(t('/a\u001bb').message, /control/)
})

test('bots, bal, sidebar, join, leave, quit take no arguments', () => {
  for (const w of ['bots', 'bal', 'sidebar', 'join', 'leave']) {
    assert.deepEqual(t(w), { type: w })
    assert.equal(t(`${w} extra`).type, 'error', w)
  }
  assert.deepEqual(t('quit'), { type: 'quit' })
  assert.deepEqual(t('exit'), { type: 'quit' })
  assert.deepEqual(t('Balance'), { type: 'bal' })
})

test('use needs exactly one valid bot id', () => {
  assert.deepEqual(t('use bot-1'), { type: 'use', id: 'bot-1' })
  assert.equal(t('use').type, 'error')
  assert.equal(t('use a b').type, 'error')
  assert.equal(t('use bad/id').type, 'error')
  assert.equal(t('use ' + 'x'.repeat(65)).type, 'error')
})

test('raw on|off', () => {
  assert.deepEqual(t('raw on'), { type: 'raw', on: true })
  assert.deepEqual(t('raw off'), { type: 'raw', on: false })
  assert.equal(t('raw').type, 'error')
  assert.equal(t('raw maybe').type, 'error')
})

test('tail [lastN]', () => {
  assert.deepEqual(t('tail'), { type: 'tail', count: 0 })
  assert.deepEqual(t('tail 20'), { type: 'tail', count: 20 })
  for (const bad of ['tail -1', 'tail 201', 'tail x', 'tail 1 2', 'tail 1.5']) assert.equal(t(bad).type, 'error', bad)
})

test('dump <file> [lastN]', () => {
  assert.deepEqual(t('dump out.json'), { type: 'dump', file: 'out.json', count: 100 })
  assert.deepEqual(t('dump /tmp/x.json 25'), { type: 'dump', file: '/tmp/x.json', count: 25 })
  for (const bad of ['dump', 'dump a 0', 'dump a 2001', 'dump a b', 'dump a 1 2']) assert.equal(t(bad).type, 'error', bad)
})

test('window <ms>', () => {
  assert.deepEqual(t('window 5000'), { type: 'window', ms: 5000 })
  assert.deepEqual(t('window 0'), { type: 'window', ms: 0 })
  for (const bad of ['window', 'window -1', 'window 60001', 'window x']) assert.equal(t(bad).type, 'error', bad)
})
