import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const ACTOR = /^[a-z0-9_.-]{1,32}$/

/** Validates an `X-Actor` header value; anything else is recorded as "api". */
export function normaliseActor (value) {
  return typeof value === 'string' && ACTOR.test(value) ? value : 'api'
}

/**
 * Append-only JSON-lines record of everything the program makes a bot say or does to bots.
 * Writes are synchronous and happen BEFORE the action, and a write failure throws, so
 * a command is never sent without a record. Mode 0600. No rotation: use logrotate (copytruncate).
 */
export class AuditLog {
  /** @param {string} file */
  constructor (file) {
    this.file = file
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, '', { mode: 0o600 })
  }

  /** @param {{actor: string, action: string, bot?: string, text?: string, detail?: object}} entry */
  write (entry) {
    appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 })
  }
}
