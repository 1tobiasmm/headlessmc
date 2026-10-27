// Runs one bot against the mock server for each (version, source) pair and prints the result.
import { startMockServer } from './mock-server.js'
import { validateConfig } from '../src/config.js'
import { BotManager } from '../src/manager.js'
import mc from 'minecraft-protocol'

const versions = process.argv.slice(2).length ? process.argv.slice(2) : ['1.16.5', '1.18.2', '1.19.2', '1.19.4', '1.20.1', '1.20.2', '1.20.4', '1.20.6', '1.21.1', '1.21.4', '1.21.8']
const rows = []
for (const version of versions) {
  if (!mc.supportedVersions.includes(version)) { rows.push([version, 'unsupported']); continue }
  for (const [source, style] of [['command'], ['sidebar', 'team'], ['sidebar', 'display_name']]) {
    const mock = await startMockServer({ version, command: '/bal', reply: 'Mock balance: $1,234.50', sidebar: ['Title', 'Money: $2,000'], sidebarStyle: style })
    const cfg = validateConfig({
      server: { host: '127.0.0.1', port: mock.port, version, connectTimeoutMs: 8000 },
      accounts: [{ username: 'Alpha1' }],
      limits: { joinDelayMs: 0, joinJitterMs: 0 },
      balance: { source, pollIntervalSec: 0, readyDelayMs: 200, readTimeoutMs: 3000,
        command: { text: '/bal', replyPattern: 'Mock balance: (?<amount>\\$[\\d,.]+)' },
        sidebar: { labelPattern: '^Money: (?<amount>\\$[\\d,]+)' } },
      reports: { file: null }, debug: { dump: { enabled: false } }
    })
    const m = new BotManager(cfg)
    m.start(cfg.accounts)
    const t0 = Date.now()
    let bot
    while (Date.now() - t0 < 9000) {
      bot = m.get('Alpha1')?.status()
      if (bot?.balance || bot?.lastReadError || bot?.state === 'stopped' || bot?.state === 'kicked') break
      await new Promise(r => setTimeout(r, 50))
    }
    const r = bot?.balance ? `OK ${bot.balance.amount}` : `FAIL state=${bot?.state} ${JSON.stringify(bot?.lastReadError ?? bot?.lastError ?? '')}`
    rows.push([version, `${source}${style ? '/' + style : ''}`, r])
    await m.shutdown(); await mock.close()
  }
}
for (const r of rows) console.log(r.join('  '))
process.exit(0)
