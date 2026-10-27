#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { createApi } from './api.js'
import { ConfigError, loadConfig } from './config.js'
import { createLogger } from './log.js'
import { BotManager } from './manager.js'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const log = createLogger(process.env.HMC_LOG_LEVEL ?? 'info')

function parseArgs (argv) {
  const out = { config: process.env.HMC_CONFIG ?? './config.yaml', autostart: process.env.HMC_AUTOSTART === '1' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' || argv[i] === '-c') out.config = argv[++i]
    else if (argv[i] === '--autostart') out.autostart = true
    else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write('usage: headless-balance-bot [--config config.yaml] [--autostart]\n  --autostart  start every configured account at launch (also HMC_AUTOSTART=1)\n')
      process.exit(0)
    } else { process.stderr.write(`unknown argument ${argv[i]}\n`); process.exit(2) }
  }
  return out
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  let config
  try { config = loadConfig(args.config) } catch (e) {
    if (e instanceof ConfigError) { log.error(e.message); process.exit(2) }
    throw e
  }

  const token = process.env[config.api.tokenEnv]
  if (!token) {
    log.error(`environment variable ${config.api.tokenEnv} is empty; set it to the API token (the API is never exposed without one)`)
    process.exit(2)
  }
  if (!['127.0.0.1', '::1', 'localhost'].includes(config.api.bind)) {
    // The API can make bots speak, so it is loopback-only. The one legitimate exception is a container, where the
    // process must listen on the container's interface and the runtime publishes the port on the HOST's loopback.
    if (process.env.HMC_ALLOW_NON_LOOPBACK !== '1') {
      log.error(`api.bind is ${config.api.bind}: the API is loopback-only (127.0.0.1). Inside a container set HMC_ALLOW_NON_LOOPBACK=1 and publish the port on the host's 127.0.0.1 only.`)
      process.exit(2)
    }
    log.warn('API bound to a non-loopback address by HMC_ALLOW_NON_LOOPBACK=1; it must be published on the host loopback only', { bind: config.api.bind })
  }

  const manager = new BotManager(config, { log })
  const reload = () => {
    const next = loadConfig(args.config)
    const result = manager.applyConfig(next)
    log.info('config reloaded', result)
    return result
  }
  const api = createApi({ manager, token, reload, version })
  const server = await api.listen(config.api)
  log.info('api listening', { bind: config.api.bind, port: server.address().port, accounts: config.accounts.length })

  if (args.autostart) {
    const res = manager.startConfigured(config.accounts.map(a => a.id))
    log.info('autostart', { accepted: res.accepted.length, rejected: res.rejected.length })
  }

  let closing = false
  const shutdown = async signal => {
    if (closing) return
    closing = true
    log.info('shutting down', { signal })
    server.close()
    await manager.shutdown()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGHUP', () => { try { reload() } catch (e) { log.error('reload failed', { error: e.message }) } })
  process.on('unhandledRejection', e => log.error('unhandled rejection', { error: String(e?.stack ?? e).slice(0, 500) }))
}

main().catch(e => { log.error('fatal', { error: String(e?.stack ?? e) }); process.exit(1) })
