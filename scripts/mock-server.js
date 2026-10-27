#!/usr/bin/env node
/**
 * A scriptable fake Minecraft server for tests and benchmarks (offline mode, no world).
 * It speaks the real protocol for any version minecraft-protocol supports, but everything
 * it sends is synthetic: the balance wording below is made up for the tests and is NOT
 * the format of any real server.
 */
import mc from 'minecraft-protocol'
import minecraftData from 'minecraft-data'
import nbt from 'prismarine-nbt'
import { fileURLToPath } from 'node:url'

/**
 * @param {object} [opts]
 * @param {string} [opts.version]
 * @param {number} [opts.port] 0 = pick a free port
 * @param {string} [opts.command] command the bot sends, e.g. "/bal"
 * @param {string} [opts.reply] chat text sent back for that command
 * @param {Record<string, string>} [opts.commands] additional command -> reply map
 * @param {number} [opts.replyDelayMs] delay before a command reply is sent
 * @param {'system'|'actionbar'} [opts.replyKind]
 * @param {string[]} [opts.sidebar] plain-text sidebar rows, top first
 * @param {'team'|'display_name'} [opts.sidebarStyle]
 * @param {string} [opts.sidebarTitle]
 * @param {{header: string, footer: string}} [opts.tab]
 * @param {string} [opts.kickText] kick right after login
 * @param {string} [opts.loginKickText] disconnect during login
 * @param {{entityMovesPerSec?: number, sidebarUpdatesPerSec?: number, chatPerSec?: number}} [opts.traffic]
 */
export async function startMockServer (opts = {}) {
  const version = opts.version ?? '1.21.4'
  const data = minecraftData(version)
  const useNbt = data.supportFeature('chatPacketsUseNbtComponents')
  const comp = text => (useNbt ? nbt.comp({ text: nbt.string(String(text)) }) : JSON.stringify({ text: String(text) }))
  const modernScores = data.supportFeature('hasConfigurationState') && data.version.version >= 765 // 1.20.3+
  const teamsModeIsNamed = data.protocol.play.toClient.types.packet_teams?.[1]?.[1]?.type?.[0] === 'mapper'
  const stats = { logins: 0, commands: [], clientsNow: 0, maxClients: 0 }

  const server = mc.createServer({
    'online-mode': false,
    version,
    host: '127.0.0.1',
    port: opts.port ?? 0,
    maxPlayers: 100000,
    hideErrors: true,
    keepAlive: true,
    motd: 'mock',
    // Disconnect while still in the login state, like a whitelist or ban check does.
    beforeLogin: client => { if (opts.loginKickText) client.end('mock', JSON.stringify({ text: opts.loginKickText })) }
  })
  await new Promise(resolve => server.once('listening', resolve))
  const port = server.socketServer.address().port

  const sendSystem = (client, text, kind = 'system') => {
    if (data.supportFeature('signedChat')) {
      client.write('system_chat', data.version.version >= 760 ? { content: comp(text), isActionBar: kind === 'actionbar' } : { content: comp(text), type: kind === 'actionbar' ? 2 : 1 })
    } else {
      client.write('chat', { message: comp(text), position: kind === 'actionbar' ? 2 : 1, sender: '0' })
    }
  }

  const sendSidebar = client => {
    const rows = opts.sidebar
    if (!rows) return
    client.write('scoreboard_objective', { name: 'side', action: 0, displayText: comp(opts.sidebarTitle ?? 'Mock'), type: 0 })
    client.write('scoreboard_display_objective', { position: 1, name: 'side' })
    rows.forEach((row, i) => {
      const value = rows.length - i
      if (opts.sidebarStyle === 'display_name' && modernScores) {
        client.write('scoreboard_score', { itemName: `row${i}`, scoreName: 'side', value, display_name: comp(row) })
      } else {
        const entry = `§${i.toString(16)}§r`
        client.write('teams', {
          team: `row${i}`, mode: teamsModeIsNamed ? 'add' : 0, name: comp(`row${i}`), friendlyFire: 0, flags: 0, nameTagVisibility: 'always', collisionRule: 'always',
          formatting: 21, prefix: comp(row), suffix: comp(''), players: [entry]
        })
        client.write('scoreboard_score', modernScores
          ? { itemName: entry, scoreName: 'side', value }
          : { itemName: entry, action: 0, scoreName: 'side', value })
      }
    })
  }

  const clients = new Set()
  server.on('playerJoin', client => {
    stats.logins++
    clients.add(client)
    stats.clientsNow = clients.size
    stats.maxClients = Math.max(stats.maxClients, clients.size)
    client.on('end', () => { clients.delete(client); stats.clientsNow = clients.size })
    client.on('error', () => {})
    client.write('login', { levelType: 'default', ...data.loginPacket, entityId: client.id })
    if (opts.kickText) {
      client.write('kick_disconnect', { reason: comp(opts.kickText) })
      setTimeout(() => client.socket?.end(), 20)
      return
    }
    sendSidebar(client)
    if (opts.tab) client.write('playerlist_header', { header: comp(opts.tab.header), footer: comp(opts.tab.footer) })

    const onCommand = raw => {
      stats.commands.push(raw)
      const reply = opts.commands?.[raw] ?? (opts.command && raw === opts.command ? opts.reply : undefined)
      if (reply != null) setTimeout(() => { try { sendSystem(client, reply, opts.replyKind ?? 'system') } catch { /* client gone */ } }, opts.replyDelayMs ?? 0)
    }
    client.on('chat_command', p => onCommand('/' + p.command))
    client.on('chat_command_signed', p => onCommand('/' + p.command))
    client.on('chat_message', p => onCommand(p.message))
    client.on('chat', p => onCommand(p.message))
  })

  const timers = []
  const t = opts.traffic ?? {}
  const TICK = 100
  if (t.entityMovesPerSec || t.sidebarUpdatesPerSec || t.chatPerSec) {
    let tick = 0
    timers.push(setInterval(() => {
      tick++
      for (const c of clients) {
        try {
          for (let i = 0; i < (t.entityMovesPerSec ?? 0) * TICK / 1000; i++) {
            c.write('rel_entity_move', { entityId: 1 + (i % 50), dX: 1, dY: 0, dZ: 1, onGround: true })
          }
          if (t.sidebarUpdatesPerSec && tick % Math.max(1, Math.round(1000 / TICK / t.sidebarUpdatesPerSec)) === 0 && opts.sidebar) {
            c.write('scoreboard_score', modernScores
              ? { itemName: '§0§r', scoreName: 'side', value: tick }
              : { itemName: '§0§r', action: 0, scoreName: 'side', value: tick })
          }
          if (t.chatPerSec && tick % Math.max(1, Math.round(1000 / TICK / t.chatPerSec)) === 0) sendSystem(c, 'Server notice')
        } catch { /* client gone */ }
      }
    }, TICK))
  }

  return {
    server,
    port,
    version,
    stats,
    sendSystem,
    clients,
    /** @param {{kick?: string}} [o] by default sockets are dropped (a crash); pass kick for a polite "Server closed" */
    async close (o = {}) {
      for (const x of timers) clearInterval(x)
      if (o.kick) {
        for (const c of clients) c.write('kick_disconnect', { reason: comp(o.kick) })
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      // Drop the sockets before closing: Server.close() itself would send a "ServerShutdown" kick.
      for (const c of clients) c.socket?.destroy()
      await new Promise(resolve => { server.once('close', resolve); server.close() })
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def }
  const mock = await startMockServer({
    version: arg('version', '1.21.4'),
    port: Number(arg('port', 25599)),
    command: arg('command', '/bal'),
    reply: arg('reply', 'Mock balance: $1,234.50'),
    sidebar: ['Mock Server', 'Money: $1,234.50'],
    traffic: { entityMovesPerSec: Number(arg('moves', 0)), sidebarUpdatesPerSec: Number(arg('sidebar-updates', 0)), chatPerSec: Number(arg('chat', 0)) }
  })
  process.stdout.write(`mock server ${mock.version} listening on 127.0.0.1:${mock.port}\n`)
  process.on('SIGTERM', () => mock.close().then(() => process.exit(0)))
  process.on('SIGINT', () => mock.close().then(() => process.exit(0)))
}
