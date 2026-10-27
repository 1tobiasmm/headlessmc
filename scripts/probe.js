#!/usr/bin/env node
/**
 * Asks a server which Minecraft version it runs (status ping only, no login) and checks
 * that the installed protocol library can speak it.
 *   npm run probe -- play.example.com[:25565] [--json]
 */
import mc from 'minecraft-protocol'
import { pickVersion } from '../src/version.js'
import { componentToText } from '../src/text.js'

const args = process.argv.slice(2)
const json = args.includes('--json')
const target = args.find(a => !a.startsWith('--'))
if (!target) {
  process.stderr.write('usage: npm run probe -- host[:port] [--json]\n')
  process.exit(2)
}
const [host, portText] = target.split(':')
const port = portText ? Number(portText) : 25565

try {
  const started = Date.now()
  const status = await mc.ping({ host, port, closeTimeout: 10_000, noPongTimeout: 3_000 })
  const picked = pickVersion(status)
  const out = {
    host,
    port,
    reportedVersionName: status.version?.name,
    reportedProtocol: status.version?.protocol,
    matchedMinecraftVersions: picked?.candidates ?? [],
    recommendedServerVersion: picked?.minecraftVersion ?? null,
    libraryCanSpeakIt: Boolean(picked && mc.supportedVersions.includes(picked.minecraftVersion)),
    players: status.players ? { online: status.players.online, max: status.players.max } : null,
    motd: componentToText(status.description).slice(0, 200),
    enforcesSecureChat: status.enforcesSecureChat ?? null,
    latencyMs: status.latency ?? Date.now() - started,
    libraryRange: `${mc.supportedVersions[0]} .. ${mc.supportedVersions.at(-1)}`
  }
  if (json) process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  else {
    process.stdout.write(`server            ${host}:${port}\n`)
    process.stdout.write(`reports           ${out.reportedVersionName} (protocol ${out.reportedProtocol})\n`)
    process.stdout.write(`matched versions  ${out.matchedMinecraftVersions.join(', ') || 'none'}\n`)
    process.stdout.write(`library range     ${out.libraryRange}; can speak it: ${out.libraryCanSpeakIt}\n`)
    process.stdout.write(`players           ${out.players ? `${out.players.online}/${out.players.max}` : 'n/a'}\n`)
    process.stdout.write(`motd              ${out.motd}\n`)
    process.stdout.write(`secure chat       ${out.enforcesSecureChat ?? 'not reported'}\n`)
    process.stdout.write(`latency           ${out.latencyMs} ms\n\n`)
    process.stdout.write(`config:  server.version: "${out.recommendedServerVersion ?? 'auto'}"\n`)
    process.stdout.write('note: a proxy (Velocity/BungeeCord, ViaVersion) may report its own version string rather than the backend\'s.\n')
  }
  process.exit(out.libraryCanSpeakIt ? 0 : 3)
} catch (e) {
  process.stderr.write(`ping failed: ${e.message}\n`)
  process.exit(1)
}
