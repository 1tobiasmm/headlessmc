import test from 'node:test'
import assert from 'node:assert/strict'
import nbt from 'prismarine-nbt'
import { componentToText, stripFormatting } from '../src/text.js'

test('plain strings and formatting codes', () => {
  assert.equal(componentToText('hello'), 'hello')
  assert.equal(componentToText('§aGreen §lBold§r plain'), 'Green Bold plain')
  assert.equal(stripFormatting('§x§1§2§3§4§5§6hex'), 'hex')
})

test('JSON string components (<= 1.20.2)', () => {
  assert.equal(componentToText('{"text":"Money: ","extra":[{"text":"$5","color":"gold"}]}'), 'Money: $5')
  assert.equal(componentToText('[{"text":"a"},{"text":"b"}]'), 'ab')
  assert.equal(componentToText('"quoted"'), 'quoted')
})

test('text that merely starts with a brace is kept as text', () => {
  assert.equal(componentToText('{not json'), '{not json')
})

test('anonymous NBT components (>= 1.20.3)', () => {
  const c = nbt.comp({ text: nbt.string('Balance: '), extra: nbt.list(nbt.comp([{ text: nbt.string('$1,000') }])) })
  assert.equal(componentToText(c), 'Balance: $1,000')
  assert.equal(componentToText(nbt.string('just a string')), 'just a string')
})

test('translate components render their arguments', () => {
  assert.equal(componentToText({ translate: 'chat.type.text', with: [{ text: 'Bob' }, { text: 'hi' }] }), 'Bob hi')
  assert.equal(componentToText({ translate: 'x', fallback: '<%s> %s', with: ['Bob', 'hi'] }), '<Bob> hi')
})

test('null, numbers and junk do not throw', () => {
  assert.equal(componentToText(null), '')
  assert.equal(componentToText(undefined), '')
  assert.equal(componentToText(42), '42')
  assert.equal(componentToText({ foo: 1 }), '')
})

test('output length and nesting are bounded', () => {
  assert.equal(componentToText('x'.repeat(100000)).length, 4096)
  let deep = { text: 'a' }
  for (let i = 0; i < 100; i++) deep = { text: '', extra: [deep] }
  assert.doesNotThrow(() => componentToText(deep))
})
