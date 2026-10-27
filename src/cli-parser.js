/**
 * Parses one line typed into the interactive CLI. Pure function, no I/O.
 *
 * Anything that is not a known command word or a "/command" is an ERROR, never chat: a typo must not
 * become a message in the game. Only `say <text>` and a leading "/" send text.
 *
 * @returns {{type: string, [k: string]: any}}
 *   types: empty | bots | use{id} | say{text} | bal | tail{count} | sidebar | raw{on} | dump{file,count} |
 *          window{ms} | join | leave | quit | help | error{message}
 */
export const MAX_TEXT = 256
const BOT_ID = /^[A-Za-z0-9_.-]{1,64}$/
const CONTROL = /[\u0000-\u001f\u007f]/

export function parseLine (line) {
  const text = line.trim()
  if (!text) return { type: 'empty' }

  if (text[0] === '/') return sayOrError(text)

  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text)
  const word = m[1].toLowerCase()
  const rest = (m[2] ?? '').trim()
  const args = rest ? rest.split(/\s+/) : []
  const usage = u => ({ type: 'error', message: `usage: ${u}` })

  switch (word) {
    case 'bots': return args.length ? usage('bots') : { type: 'bots' }
    case 'use':
      if (args.length !== 1) return usage('use <botId>')
      return BOT_ID.test(args[0]) ? { type: 'use', id: args[0] } : { type: 'error', message: `invalid bot id "${args[0]}"` }
    case 'say':
      return rest ? sayOrError(rest) : usage('say <text>   (text starting with / is sent as a command)')
    case 'bal': case 'balance': return args.length ? usage('bal') : { type: 'bal' }
    case 'tail': {
      if (args.length > 1) return usage('tail [lastN]')
      const n = args.length ? Number(args[0]) : 0
      return Number.isInteger(n) && n >= 0 && n <= 200 ? { type: 'tail', count: n } : { type: 'error', message: 'tail: lastN must be an integer 0-200' }
    }
    case 'sidebar': return args.length ? usage('sidebar') : { type: 'sidebar' }
    case 'raw':
      return args.length === 1 && (args[0] === 'on' || args[0] === 'off') ? { type: 'raw', on: args[0] === 'on' } : usage('raw on|off')
    case 'dump': {
      if (args.length < 1 || args.length > 2) return usage('dump <file> [lastN]')
      const n = args.length === 2 ? Number(args[1]) : 100
      return Number.isInteger(n) && n >= 1 && n <= 2000 ? { type: 'dump', file: args[0], count: n } : { type: 'error', message: 'dump: lastN must be an integer 1-2000' }
    }
    case 'window': {
      const n = Number(args[0])
      return args.length === 1 && Number.isInteger(n) && n >= 0 && n <= 60000 ? { type: 'window', ms: n } : usage('window <ms>   (0-60000)')
    }
    case 'join': return args.length ? usage('join') : { type: 'join' }
    case 'leave': return args.length ? usage('leave') : { type: 'leave' }
    case 'quit': case 'exit': return { type: 'quit' }
    case 'help': case '?': return { type: 'help' }
    default:
      return { type: 'error', message: `unknown command "${m[1]}" (nothing was sent). Type help; use "say <text>" or "/command" to send` }
  }
}

function sayOrError (text) {
  if (text === '/') return { type: 'error', message: 'empty command' }
  if (text.length > MAX_TEXT) return { type: 'error', message: `text is ${text.length} characters; the limit is ${MAX_TEXT}` }
  if (CONTROL.test(text)) return { type: 'error', message: 'text contains control characters' }
  return { type: 'say', text }
}

export const HELP = `commands:
  bots                 list bots and their state
  use <botId>          select a bot (the prompt shows it)
  /anything            send as a command from the selected bot
  say <text>           send as chat (a leading / makes it a command)
  bal                  run the configured balance read; shows the parsed value and the raw text
  tail [lastN]         stream every chat/system/action-bar message until Ctrl+C
  sidebar              print the scoreboard sidebar and the tab header/footer
  raw on|off           also show raw JSON chat components
  dump <file> [lastN]  save the last N received messages and the sidebar to a file (default 100)
  window <ms>          how long to collect replies after a command (default 3000)
  join | leave         start / stop the selected bot
  quit                 leave the CLI (bots keep running)
Every command sent is recorded in the audit log with actor "cli".`
