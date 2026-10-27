import { CommandSource } from './command.js'
import { SidebarSource } from './sidebar.js'
import { HttpSource } from './http.js'

/**
 * The one interface behind every balance source:
 *   needs: { scoreboard: boolean, chat: boolean }
 *   read(session): Promise<{ amount: number, raw: string, source: string, detail?: object }>
 * A session exposes `username`, `uuid`, `tracker`, `waitForChat(match, timeoutMs, acceptSet)` and `sendCommand(text)`.
 * @param {object} config validated config
 * @param {{env?: NodeJS.ProcessEnv, fetch?: typeof fetch}} [deps]
 */
export function createBalanceSource (config, deps) {
  const b = config.balance
  switch (b.source) {
    case 'command': return new CommandSource(b, config.compiled.commandRe)
    case 'sidebar': return new SidebarSource(b, config.compiled.sidebarRe)
    case 'http': return new HttpSource(b, deps)
    default: throw new Error(`unknown balance source ${b.source}`)
  }
}
