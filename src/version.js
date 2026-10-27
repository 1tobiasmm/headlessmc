import mc from 'minecraft-protocol'
import minecraftData from 'minecraft-data'

/**
 * Maps a status-ping response to a minecraft-data version, the same way the library's
 * autoVersion does. Returns null when the protocol is unknown to this library build.
 */
export function pickVersion (status) {
  const name = status?.version?.name ?? ''
  const protocol = status?.version?.protocol
  const byName = [name, ...(name.match(/((\d+\.)+\d+)/g) ?? [])]
    .map(v => minecraftData.versionsByMinecraftVersion.pc[v])
    .filter(Boolean)
    .sort((a, b) => b.version - a.version)
  const byProtocol = minecraftData.postNettyVersionsByProtocolVersion.pc[protocol] ?? []
  const candidates = [...byProtocol, ...byName]
  if (candidates.length === 0) return null
  return { minecraftVersion: candidates[0].minecraftVersion, protocol, serverName: name, candidates: [...new Set(candidates.map(c => c.minecraftVersion))] }
}

/** Resolves and caches the protocol version for a server, one ping at a time. */
export class VersionResolver {
  /** @param {{ttlMs?: number, ping?: Function}} [opts] */
  constructor ({ ttlMs = 10 * 60_000, ping = mc.ping } = {}) {
    this.ttlMs = ttlMs
    this.ping = ping
    this.cache = new Map() // "host:port" -> { value, expires, pending }
  }

  /** @param {{host: string, port: number, version: string}} server */
  async resolve (server) {
    if (server.version !== 'auto') return server.version
    const key = `${server.host}:${server.port}`
    const hit = this.cache.get(key)
    if (hit?.pending) return hit.pending
    if (hit?.value && hit.expires > Date.now()) return hit.value
    const pending = this._ping(server).then(v => {
      this.cache.set(key, { value: v, expires: Date.now() + this.ttlMs })
      return v
    }, e => { this.cache.delete(key); throw e })
    this.cache.set(key, { pending, value: hit?.value, expires: 0 })
    return pending
  }

  async _ping (server) {
    const status = await this.ping({ host: server.host, port: server.port, closeTimeout: 10_000, noPongTimeout: 3_000 })
    const picked = pickVersion(status)
    if (!picked) {
      const e = new Error(`unsupported protocol ${status?.version?.protocol} (${status?.version?.name}); update minecraft-protocol`)
      e.code = 'UNSUPPORTED_VERSION'
      throw e
    }
    return picked.minecraftVersion
  }

  invalidate () { this.cache.clear() }
}
