import test from 'node:test'
import assert from 'node:assert/strict'
import nbt from 'prismarine-nbt'
import { ScoreboardTracker } from '../src/scoreboard.js'
import { FakeClient, sleep } from './helpers.js'

const setup = () => {
  const client = new FakeClient()
  const t = new ScoreboardTracker()
  t.attach(client)
  return { client, t }
}
const json = text => JSON.stringify({ text })

test('legacy score packets with team prefix/suffix rows (<= 1.20.2)', () => {
  const { client, t } = setup()
  client.emit('scoreboard_objective', { name: 'side', action: 0, displayText: json('§6Title'), type: 0 })
  client.emit('scoreboard_display_objective', { position: 1, name: 'side' })
  client.emit('teams', { team: 'r0', mode: 0, prefix: json('Money: '), suffix: json('$5'), players: ['§0'] })
  client.emit('teams', { team: 'r1', mode: 0, prefix: json('Shards: '), suffix: json('9'), players: ['§1'] })
  client.emit('scoreboard_score', { itemName: '§0', action: 0, scoreName: 'side', value: 2 })
  client.emit('scoreboard_score', { itemName: '§1', action: 0, scoreName: 'side', value: 1 })
  const snap = t.snapshotSidebar(true)
  assert.equal(snap.title, 'Title')
  assert.deepEqual(snap.lines, ['Money: $5', 'Shards: 9'])
  assert.equal(snap.raw[0].prefix, json('Money: '))
})

test('1.20.3+ score display names (NBT) and reset_score', () => {
  const { client, t } = setup()
  client.emit('scoreboard_objective', { name: 'side', action: 0, displayText: nbt.comp({ text: nbt.string('T') }), type: 0 })
  client.emit('scoreboard_display_objective', { position: 1, name: 'side' })
  client.emit('scoreboard_score', { itemName: 'a', scoreName: 'side', value: 3, display_name: nbt.comp({ text: nbt.string('Money: $7') }) })
  client.emit('scoreboard_score', { itemName: 'b', scoreName: 'side', value: 1, display_name: nbt.comp({ text: nbt.string('Other') }) })
  assert.deepEqual(t.snapshotSidebar().lines, ['Money: $7', 'Other'])
  client.emit('reset_score', { entity_name: 'a', objective_name: 'side' })
  assert.deepEqual(t.snapshotSidebar().lines, ['Other'])
  client.emit('reset_score', { entity_name: 'b' }) // no objective: removes from all
  assert.deepEqual(t.snapshotSidebar().lines, [])
})

test('team modes: numeric and the named form used from 1.21.8', () => {
  const { client, t } = setup()
  client.emit('scoreboard_objective', { name: 'side', action: 0, displayText: json('T') })
  client.emit('scoreboard_display_objective', { position: 1, name: 'side' })
  client.emit('scoreboard_score', { itemName: 'e', action: 0, scoreName: 'side', value: 1 })
  client.emit('teams', { team: 'x', mode: 'add', prefix: json('P1 '), suffix: json(''), players: [] })
  client.emit('teams', { team: 'x', mode: 'join', players: ['e'] })
  assert.deepEqual(t.snapshotSidebar().lines, ['P1 e'])
  client.emit('teams', { team: 'x', mode: 'change', prefix: json('P2 '), suffix: json('!') })
  assert.deepEqual(t.snapshotSidebar().lines, ['P2 e!'])
  client.emit('teams', { team: 'x', mode: 'leave', players: ['e'] })
  assert.deepEqual(t.snapshotSidebar().lines, ['e'])
  client.emit('teams', { team: 'x', mode: 'remove' })
  assert.equal(t.teams.size, 0)
  // numeric equivalents
  client.emit('teams', { team: 'y', mode: 0, prefix: json('N '), suffix: json(''), players: ['e'] })
  assert.deepEqual(t.snapshotSidebar().lines, ['N e'])
  client.emit('teams', { team: 'y', mode: 1 })
  assert.deepEqual(t.snapshotSidebar().lines, ['e'])
})

test('only slot 1 is the sidebar, and removing the objective clears it', () => {
  const { client, t } = setup()
  client.emit('scoreboard_objective', { name: 'tab', action: 0, displayText: json('T') })
  client.emit('scoreboard_display_objective', { position: 0, name: 'tab' })
  assert.equal(t.snapshotSidebar(), null)
  client.emit('scoreboard_display_objective', { position: 1, name: 'tab' })
  assert.ok(t.snapshotSidebar())
  client.emit('scoreboard_objective', { name: 'tab', action: 1 })
  assert.equal(t.snapshotSidebar(), null)
})

test('score removal (<= 1.20.2 action 1) and ordering by score', () => {
  const { client, t } = setup()
  client.emit('scoreboard_objective', { name: 's', action: 0, displayText: json('T') })
  client.emit('scoreboard_display_objective', { position: 1, name: 's' })
  for (const [name, value] of [['low', 1], ['high', 9], ['mid', 5]]) client.emit('scoreboard_score', { itemName: name, action: 0, scoreName: 's', value })
  assert.deepEqual(t.snapshotSidebar().lines, ['high', 'mid', 'low'])
  client.emit('scoreboard_score', { itemName: 'mid', action: 1, scoreName: 's' })
  assert.deepEqual(t.snapshotSidebar().lines, ['high', 'low'])
})

test('tab header and footer', () => {
  const { client, t } = setup()
  client.emit('playerlist_header', { header: json('Head'), footer: json('Foot\nMoney: $1') })
  assert.deepEqual(t.snapshotTab(), { header: 'Head', footer: 'Foot\nMoney: $1' })
})

test('collections are bounded', () => {
  const { client, t } = setup()
  client.emit('scoreboard_objective', { name: 's', action: 0, displayText: json('T') })
  client.emit('scoreboard_display_objective', { position: 1, name: 's' })
  for (let i = 0; i < 500; i++) client.emit('scoreboard_score', { itemName: 'e' + i, action: 0, scoreName: 's', value: i })
  assert.equal(t.snapshotSidebar().lines.length, 64)
  for (let i = 0; i < 20; i++) client.emit('scoreboard_objective', { name: 'o' + i, action: 0, displayText: json('x') })
  assert.ok(t.objectives.size <= 8)
  for (let i = 0; i < 3000; i++) client.emit('teams', { team: 't' + i, mode: 0, prefix: json(''), suffix: json(''), players: [] })
  assert.equal(t.teams.size, 1024)
})

test('waitFor resolves on a later change and on timeout', async () => {
  const { client, t } = setup()
  const find = () => t.snapshotSidebar()?.lines.find(l => l.startsWith('Money'))
  const pending = t.waitFor(find, 1000)
  client.emit('scoreboard_objective', { name: 's', action: 0, displayText: json('T') })
  client.emit('scoreboard_display_objective', { position: 1, name: 's' })
  setTimeout(() => client.emit('scoreboard_score', { itemName: 'Money: 5', action: 0, scoreName: 's', value: 1 }), 20)
  assert.equal(await pending, 'Money: 5')
  assert.equal(t.waiters.size, 0)
  assert.equal(await t.waitFor(() => null, 30), null)
  assert.equal(t.waiters.size, 0)
})

test('detach removes every listener', async () => {
  const { client, t } = setup()
  assert.ok(client.listenerCount('teams') > 0)
  t.detach()
  for (const ev of ['scoreboard_objective', 'scoreboard_display_objective', 'scoreboard_score', 'reset_score', 'teams', 'playerlist_header']) {
    assert.equal(client.listenerCount(ev), 0, ev)
  }
  await sleep(1)
})
