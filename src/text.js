import nbt from 'prismarine-nbt'

const FORMAT_CODES = /§[0-9a-fk-orx]/gi
const NBT_TAGS = new Set(['byte', 'short', 'int', 'long', 'float', 'double', 'byteArray', 'string', 'list', 'compound', 'intArray', 'longArray'])
const MAX_DEPTH = 16
const MAX_CHARS = 4096

export function stripFormatting (s) {
  return s.replace(FORMAT_CODES, '')
}

/**
 * Flattens a chat component into plain text.
 * Accepts every shape the protocol uses: a plain string, a JSON string (<= 1.20.2),
 * an anonymous-NBT object as parsed by protodef (>= 1.20.3), or an already-simplified object.
 * Translatable components are rendered as their arguments (no language file is loaded),
 * so a `translate` key alone yields an empty string.
 */
export function componentToText (value) {
  const out = []
  let len = 0
  walk(value, 0)
  return stripFormatting(out.join(''))

  function emit (s) {
    if (len >= MAX_CHARS || !s) return
    s = String(s)
    if (len + s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS - len)
    out.push(s)
    len += s.length
  }

  function walk (c, depth) {
    if (c == null || depth > MAX_DEPTH || len >= MAX_CHARS) return
    switch (typeof c) {
      case 'string': {
        const t = c[0]
        if (depth === 0 && (t === '{' || t === '[' || t === '"')) {
          try { return walk(JSON.parse(c), depth + 1) } catch { /* plain text that merely starts with a brace */ }
        }
        return emit(c)
      }
      case 'number':
      case 'boolean':
      case 'bigint':
        return emit(c)
      case 'object':
        break
      default:
        return
    }
    if (Array.isArray(c)) {
      for (const part of c) walk(part, depth + 1)
      return
    }
    if (typeof c.type === 'string' && NBT_TAGS.has(c.type) && 'value' in c) {
      return walk(nbt.simplify(c), depth + 1)
    }
    if (c.text !== undefined) emit(c.text)
    else if (c.translate !== undefined) {
      if (Array.isArray(c.with)) {
        const args = c.with.map(a => componentToText(a))
        emit(c.fallback && c.fallback.includes('%s') ? fillFormat(c.fallback, args) : args.join(' '))
      } else if (c.fallback) emit(c.fallback)
    }
    if (c.extra !== undefined) walk(c.extra, depth + 1)
  }
}

function fillFormat (fmt, args) {
  let i = 0
  return fmt.replace(/%(?:(\d+)\$)?s/g, (_, n) => args[n ? Number(n) - 1 : i++] ?? '')
}

const RAW_LIMIT = 2000

/**
 * The component as JSON text, for building parsers from real samples. JSON-string components are
 * returned as sent; NBT components (1.20.3+) are simplified to the equivalent JSON shape.
 */
export function rawComponentJson (value) {
  let out
  try {
    if (typeof value === 'string') out = value
    else if (value && typeof value.type === 'string' && NBT_TAGS.has(value.type) && 'value' in value) out = JSON.stringify(nbt.simplify(value))
    else out = JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
  } catch { out = String(value) }
  return out === undefined ? '' : out.length > RAW_LIMIT ? out.slice(0, RAW_LIMIT) + '…' : out
}
