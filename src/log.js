const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }

/**
 * Line logger on stderr. Deliberately has no per-packet call sites: lifecycle events only.
 * @param {keyof typeof LEVELS} [level]
 */
export function createLogger (level = 'info') {
  const min = LEVELS[level] ?? LEVELS.info
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] < min) return
    const extra = fields ? ' ' + JSON.stringify(fields) : ''
    process.stderr.write(`${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}${extra}\n`)
  }
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f)
  }
}

export const nullLogger = { debug () {}, info () {}, warn () {}, error () {} }
