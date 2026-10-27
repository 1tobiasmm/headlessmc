import mc from 'minecraft-protocol'
import minecraftData from 'minecraft-data'

/**
 * Packets this program never reads. Dropping them before deserialisation avoids parsing
 * chunk, entity and inventory payloads, which dominate inbound CPU on a real server.
 * Chat, scoreboard, teams, tab list, player_info (needed by the library's chat plugin),
 * declare_commands, keep_alive, ping, position and disconnect are NOT skipped.
 */
export const SKIPPED_PACKETS = new Set([
  'map_chunk', 'unload_chunk', 'update_light', 'chunks_biomes', 'tile_entity_data',
  'block_change', 'multi_block_change', 'block_action', 'block_break_animation', 'world_event',
  'world_particles', 'level_particles', 'sound_effect', 'named_sound_effect', 'entity_sound_effect',
  'spawn_entity', 'spawn_entity_living', 'spawn_entity_experience_orb', 'spawn_entity_painting',
  'named_entity_spawn', 'entity_destroy', 'entity_velocity', 'entity_move_look', 'rel_entity_move',
  'entity_look', 'entity_head_rotation', 'entity_teleport', 'entity_metadata', 'entity_equipment',
  'entity_update_attributes', 'entity_effect', 'remove_entity_effect', 'entity_status', 'entity_event',
  'animation', 'collect', 'update_time', 'set_slot', 'window_items', 'map', 'damage_event',
  'hurt_animation', 'set_passengers', 'attach_entity', 'sync_entity_position', 'move_minecart',
  'declare_recipes', 'recipe_book_add', 'unlock_recipes', 'advancements', 'statistics', 'tags'
])

const idCache = new Map()

/** Numeric ids of the skippable play-state clientbound packets for a version. */
export function skippedIds (minecraftVersion, names = SKIPPED_PACKETS) {
  const key = minecraftVersion + (names === SKIPPED_PACKETS ? '' : ':custom')
  let ids = idCache.get(key)
  if (!ids) {
    ids = new Set()
    const mappings = minecraftData(minecraftVersion)?.protocol?.play?.toClient?.types?.packet?.[1]?.[0]?.type?.[1]?.mappings ?? {}
    for (const [hex, name] of Object.entries(mappings)) if (names.has(name)) ids.add(Number(hex))
    idCache.set(key, ids)
  }
  return ids
}

const EMPTY = Buffer.alloc(0)

/** Reads the leading varint packet id from a decompressed packet buffer. */
export function readPacketId (buf) {
  let id = 0
  let shift = 0
  for (let i = 0; i < 5 && i < buf.length; i++) {
    const b = buf[i]
    id |= (b & 0x7f) << shift
    if (!(b & 0x80)) return id
    shift += 7
  }
  return -1
}

/** Client whose play-state deserializer discards SKIPPED_PACKETS without parsing them. */
export class LeanClient extends mc.Client {
  setSerializer (state) {
    super.setSerializer(state)
    if (state !== mc.states.PLAY) return
    const ids = skippedIds(this.version)
    if (ids.size === 0) return
    const des = this.deserializer
    const parse = des.parsePacketBuffer.bind(des)
    des.parsePacketBuffer = buf => {
      if (ids.has(readPacketId(buf))) {
        return { data: { name: 'lean_skipped', params: null }, metadata: { size: buf.length }, buffer: EMPTY, fullBuffer: EMPTY }
      }
      return parse(buf)
    }
  }
}
