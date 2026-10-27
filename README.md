# headless-balance-bot

A standalone, fully headless Minecraft (Java Edition) bot manager. It joins a server **you own**,
reads each account's money balance, and reports it, with no window, no prompts and no human step
once it is running. Everything is controlled over a local HTTP API or a config file.

It does **not** depend on, import or modify any other client project.

- Many accounts from one process: bounded concurrency, staggered joins, exponential reconnect backoff.
- Three balance sources behind one interface: **HTTP endpoint**, **the server's own command** (reply parsed),
  **sidebar / tab-list row**. You choose per server in the config.
- An interactive terminal **CLI** (`node src/cli.js`) works over plain SSH: list bots, send chat/commands as a bot and see the delayed replies, `tail` all messages, read the sidebar, run the balance read.
- Reports go to a JSON-lines file, an in-memory ring (`GET /reports`) and optionally a webhook.
- On a kick or ban the bot **stops and backs off**. It is not retried. There are no anti-bot, rate-limit
  or protection bypasses in this project, and none will be added.

---

## 1. Target version and the protocol library

**Status: not confirmed against your server.** The build environment for this project could resolve
DNS but could not open Minecraft TCP ports (outbound is HTTPS-only), and your server address was not
part of the request, so no status ping was possible. What is recorded here is the decision and how to confirm it.

**Confirm it in one command, from a machine that can reach your server:**

```bash
npm run probe -- mc.example.com          # or host:port; add --json for scripts
```

It sends only a status ping (no login) and prints the version string and protocol number the server
reports, the matching Minecraft version(s), whether the installed library can speak it, player count,
secure-chat flag and latency, plus the line to paste into the config (`server.version`). Exit code 3
means the library cannot speak that protocol.

**Choice: [`minecraft-protocol`](https://github.com/PrismarineJS/node-minecraft-protocol) 1.68 (Node.js 22+)**,
without the heavier `mineflayer` layer on top.

| Reason | Detail |
|---|---|
| Version coverage | 1.16.5 through 26.1 were exercised here (see Testing); the library supports 1.7 to 26.1, so the exact version your server runs does not change this choice. `server.version: auto` pings once and selects the protocol. |
| Cost per bot | No world/physics/entity model is built. Chunk and entity packets are discarded before deserialisation (`client.lean`). A Netty/JVM client would need a JVM per process; Node shares one runtime for all bots. |
| Auth built in | Microsoft device-code flow with a disk cache, encryption, compression, config-state handshake (1.20.2+), signed-chat bookkeeping and `client.chat()` for commands on all 1.19+ variants. |
| Maintenance | Tracks new Minecraft releases through `minecraft-data`; updating is `npm update`. |

**"Java version":** this client is a Node program, so the *server's* Java runtime is irrelevant to it. What matters
is the Minecraft *Java Edition* protocol version, which is what the probe reports. If you would like a JVM client
instead (for example MCProtocolLib), the manager, API, config, reports and balance-source layers are separable; the
protocol-facing code is only `src/bot.js`, `src/lean.js`, `src/scoreboard.js` and `src/version.js`.

---

## 2. Setup

Requirements: Node.js 22+, npm.

```bash
npm ci
cp config/config.example.yaml config.yaml     # edit: server.host, accounts, balance
export HMC_API_TOKEN="$(openssl rand -hex 24)"
node src/main.js --config config.yaml          # or: npm start
```

Add `--autostart` (or `HMC_AUTOSTART=1`) to start every configured account at launch; otherwise bots start
through the API. The process refuses to start without the API token variable.

```bash
curl -s localhost:8787/health
curl -s -H "Authorization: Bearer $HMC_API_TOKEN" -X POST localhost:8787/bots/start -d '{"ids":["offline-1"]}'
curl -s -H "Authorization: Bearer $HMC_API_TOKEN" localhost:8787/bots
curl -s -H "Authorization: Bearer $HMC_API_TOKEN" localhost:8787/bots/offline-1/balance
```

### First run: find your server's balance format (required step)

No balance wording or scoreboard layout is built in. The parser handles only what **you** configure, and
you write that from what your server really sends:

1. Set `balance.source` (`command` or `sidebar`) with a placeholder pattern, and keep `debug.dump.enabled: true`.
2. Start one bot. For the first 30 s after it joins, `data/debug/first-connect.jsonl` records, as JSON lines:
   `sidebar` (plain rows **and** raw team prefix/suffix/display-name components), `tab` (header/footer),
   `chat` (every system/chat/action-bar message, plain text **and** raw component, with its kind), and
   `command_sent`. The first read fires at `readyDelayMs`, so the command's reply is in the file.
3. Read the file, write `replyPattern` / `labelPattern` from the real text, then `POST /config/reload`
   (or `SIGHUP`) and `POST /bots/{id}/balance/refresh` to try it.
4. Set `debug.dump.enabled: false`. The dump can contain other players' chat; it is created with mode 0600.

Until a pattern matches, reads fail with a `balance_error` report that includes the unmatched raw text, so
a wrong pattern is visible rather than silently producing a wrong number.

### Authentication modes

| `auth` | When to use | How credentials are supplied |
|---|---|---|
| `offline` | Server has `online-mode=false` | none |
| `microsoft` | Online-mode server | One-time `npm run auth -- --config config.yaml --id <id>` (see below). Refresh token cached in `auth.profilesFolder`, renewed automatically. |
| `token` | You already hold a Minecraft access token | Two env vars named in the config (`accessTokenEnv`, `profileIdEnv`). Tokens expire (about a day). |

**The one human step.** Microsoft requires an interactive device-code sign-in the first time an account is
used. That is a limit of Microsoft's login, not of this program. It happens outside the bot process, once per
account, via `npm run auth`. The running bot never prompts: with a cold cache it stops that bot with reason
`auth_required` and does not retry against Microsoft. After that, unattended operation needs nothing further.
If you have a server on `online-mode=false` or a token pipeline of your own, you can avoid even that.

---

## 3. Balance sources

All three implement the same interface (`src/balance/index.js`): `read(session) -> {amount, raw, source}`.
Choose with `balance.source`. Every pattern is a case-insensitive regex and **must** contain a named group `(?<amount>...)`.
The captured text is parsed strictly: optional `$`, digits with optional comma grouping, optional decimals, and an
optional suffix that must be listed in `balance.suffixes`. Anything else is rejected with the raw text kept.

| Source | Preference | What it does | Needs |
|---|---|---|---|
| `http` | (a) first choice | `GET`/`POST` your balance endpoint, read `jsonPath` from the JSON. `{username}` / `{uuid}` are substituted in the URL. Credential read from an env var. | An endpoint **you** supply or the server documents |
| `command` | (b) | Sends `command.text` as the bot, takes the first message of an accepted kind (default: system) matching `replyPattern` within `readTimeoutMs`. | The server's balance command and its reply text |
| `sidebar` | (c) | Matches `labelPattern` against each plain-text row of the sidebar scoreboard (`surfaces: [sidebar, tabHeader, tabFooter]`). Row text is team prefix + entry + suffix, or the 1.20.3+ score display name. | The row's label as the server renders it |

**Which one to use here, and why.** None is pre-selected for DonutSMP, because none could be confirmed from this
environment: the only HTTP endpoint evidenced for that network is the auction listing, which does not return balances;
third-party mods mention a player-stats endpoint that includes money (`api.donutsmp.net/v1/stats/{username}`), but its
schema and field name were not verified and it is not wired in. If you supply such an endpoint, `http` is the preferred
source (no join needed for the data, no chat traffic). Otherwise use `command` (works on any server with a balance
command) and fall back to `sidebar` if the server shows the money row. `http` still joins the bot, so state and
reporting behave identically across sources.

Notes:
- `command` only accepts the kinds listed in `command.accept`. Player chat (`player`) is excluded by default so another
  player cannot spoof a reply by typing text that matches. A server whose plugin routes player chat through system messages
  can still be spoofed within the 15 s wait window; set a tight, anchored pattern.
- Do not put an auction/API key in chat or logs. Keys are read from environment variables only.
- Changing the source on reload applies to the next read for `http`/`command`. Switching **to** `sidebar` needs the bot to
  reconnect (the scoreboard is only tracked when needed, and rows sent earlier cannot be replayed).

---

## 4. HTTP API

Bound to `api.bind` (default `127.0.0.1:8787`). Everything except `GET /health` needs
`Authorization: Bearer <token>`, where the token is the value of the env var named by `api.tokenEnv`
(default `HMC_API_TOKEN`). Bodies are JSON, at most 64 KB. An optional `X-Actor: <name>` header (`[a-z0-9_.-]{1,32}`, otherwise recorded as `api`) names who is calling in the audit log; the CLI sends `cli`. Errors look like `{"error": "<code>", "message": "..."}`.

| Method & path | Body / query | Success | Notes |
|---|---|---|---|
| `GET /health` | none | `200 {status, version, uptimeSec, bots:{total, byState, joinQueue}, joinsPausedUntil, resources:{rssMB, heapUsedMB, baselineRssMB, memoryPerOnlineBotMB, cpuPercent, cpuPercentPerOnlineBot, exceeded}, reports:{...}}` | No auth, no secrets. Used by Docker `HEALTHCHECK`. |
| `POST /bots/start` | `{"ids":["a","b"]}` and/or `{"all":true}` and/or `{"accounts":[{"username":"X_1","auth":"offline"}]}` | `202 {accepted:[{id,state}], rejected:[{id,error,...}]}`; `409` if nothing was accepted | Reject codes: `already_running`, `unknown_account`, `invalid_account`, `cooling_down` (with `retryAfterSec`), `max_bots`, `queue_full` |
| `POST /bots/stop` | `{"ids":[...]}` or `{"all":true}` | `200 {stopped:[...], notFound:[...]}`; `404` if none found | A stopped *kicked* bot keeps its cooldown. |
| `GET /bots` | none | `200 {bots:[status...]}` | |
| `GET /bots/{id}` | none | `200 status` / `404` | |
| `GET /bots/{id}/balance` | none | `200 {id, state, balance:{amount, raw, source, at} \| null, lastError}` / `404` | Last successful read; `lastError` is the last failed one. |
| `POST /bots/{id}/balance/refresh` | none | `200 report` (balance) · `502 report` (read failed) · `429 {retryAfterSec}` · `409 not_online/busy` | Subject to `balance.minReadIntervalSec`. |
| `POST /bots/{id}/say` | `{"text":"/bal","windowMs":3000}` | `200 {id, sent, kind:"command"\|"chat", windowMs, messages:[{ts, kind, text, raw}]}` · `409 not_online` · `400` | Sends `text` (1-256 chars, no control characters; a leading `/` makes it a command), records it in the audit log **first**, then returns every chat/system/action-bar message received during the window (default 3 s, capped by `observe.maxReplyWindowMs`). |
| `GET /bots/{id}/messages` | `?since=<seq>&limit=100&wait=<ms≤25000>` | `200 {id, state, capacity, latest, messages:[{seq, ts, bot, kind, text, raw}]}` | Last N messages (ring buffer, `observe.messageBuffer`). `wait` long-polls for new ones; `kind`: `player`, `system`, `actionbar`, `event` (online / connection lost / kicked). |
| `GET /bots/{id}/sidebar` | `?raw=1` | `200 {id, state, tracking, sidebar:{title, lines[, raw]}\|null, tab:{header, footer}}` | `tracking:false` when `observe.trackScoreboard` is off or the bot is offline. |
| `GET /reports` | `?limit=100&id=&type=` | `200 {reports:[...]}` newest first | `type`: `balance`, `balance_error`, `kick` |
| `POST /config/reload` | none | `200 {reloaded, changed:[paths], restartRequired:[paths]}` · `400 invalid_config` | Re-reads the file. `SIGHUP` does the same. |

**Bot status** (`/bots`, `/bots/{id}`):

```json
{ "id": "offline-1", "username": "BalanceBot1",
  "state": "online",            // connecting | online | reconnecting | kicked | stopped
  "reason": null,                // why: kicked | banned | user | auth_required | auth_failed | auth_env_missing |
                                 //      unsupported_version | max_attempts | reconnect_disabled | shutdown
  "detail": null,                // e.g. "queued" while waiting for a join slot, last error while reconnecting
  "since": "…", "onlineSince": "…", "nextAttemptAt": null,
  "attempts": 1, "failures": 0, "lastError": null,
  "kick": null,                  // {text, ban, at, until} after a kick
  "balance": {"amount": 1234.5, "raw": "…", "source": "command", "at": "…"},
  "lastReadError": null, "reads": 1, "readErrors": 0 }
```

**Report lines** (file, webhook body, `/reports`):

```json
{"ts":"2026-01-01T12:00:00.000Z","type":"balance","id":"offline-1","username":"BalanceBot1","amount":1234.5,"raw":"<exact text matched>","source":"command","at":"…","detail":{"kind":"system","matched":"…"}}
{"ts":"…","type":"balance_error","id":"offline-1","username":"…","source":"command","error":"timeout|unparseable|http|config","message":"…","raw":"<text if any>"}
{"ts":"…","type":"kick","id":"offline-1","username":"…","ban":false,"text":"<server's kick text>","until":"…"}
```

The webhook receives each report as an `application/json` POST (optional `Authorization: Bearer` from `reports.webhook.tokenEnv`),
with up to `maxAttempts` tries (1 s, 2 s backoff), `4xx` other than 408/429 not retried, and a bounded queue that drops the
oldest report when full.

---

## 4b. Interactive CLI (terminal only, works over SSH)

```bash
export HMC_API_TOKEN=...            # same token the daemon uses; the CLI refuses to start without it
node src/cli.js                      # or: npm run cli -- --bot offline-1 --window 5000
```

It talks to the daemon's local HTTP API (`http://127.0.0.1:8787` by default; `--url` / `HMC_API_URL`). It only accepts **loopback**
URLs, so the token never crosses a network; from another machine, SSH to the bot host and run it there (or `ssh -L 8787:127.0.0.1:8787`).
No GUI, no curses: plain lines in, plain lines out, so it also works piped (`echo '/bal' | node src/cli.js --bot b1`).

| Command | What it does |
|---|---|
| `bots` | List bots with state, reason/detail and last balance (`*` marks the selected one) |
| `use <botId>` | Select a bot; the prompt becomes `hmc[<botId>]> ` |
| `/anything` | Send as a **command** from the selected bot |
| `say <text>` | Send as **chat** (`say /home` is the same as `/home`) |
| `bal` | Run the configured balance read; prints the parsed value and the exact raw text it came from. Subject to `balance.minReadIntervalSec` |
| `tail [lastN]` | Stream every chat, system and action-bar message (plus online/offline/kick events) with ISO timestamp and bot id, until **Ctrl+C**, which returns to the prompt |
| `sidebar` | Print the sidebar lines and the tab header/footer |
| `raw on\|off` | Also print each message's raw JSON component (and raw sidebar rows), for building parsers from real samples |
| `dump <file> [lastN]` | Save the last N messages (with raw) and the sidebar to a JSON file (mode 0600, never overwrites) |
| `window <ms>` | How long to collect replies after a command (default 3000, `--window` / `HMC_CLI_WINDOW_MS`) |
| `join` / `leave` | Start / stop the selected bot |
| `quit` | Leave the CLI; bots keep running |

Rules the CLI enforces:

- **Replies stay with their command.** After `/anything` or `say`, the CLI prints what it sent and then every message received during the
  window, including ones that arrive late. The window is opened *before* the text is sent, so an instant reply is not missed; a reply
  that arrives after the window is not shown under the command (it is still in `tail` and `dump`).
- **Nothing is sent silently or by accident.** Each send is echoed (`-> bot: text`), written to the audit log with actor `cli` before it goes out,
  and only `/…` and `say …` send anything. An unknown word such as a typo is an error ("nothing was sent"), never chat.
- **Bounded memory.** The daemon keeps only the last `observe.messageBuffer` messages per bot (a ring buffer).
- **Token from the environment only**, API on `127.0.0.1` only.

Example session. Captured from a real pseudo-terminal run of this build against the mock server (the balance wording is the mock's own, not a real server's); the `^C` is where Ctrl+C was pressed and the `dump` line is illustrative (it was exercised by the automated CLI tests, not in this capture):

```text
$ node src/cli.js --window 1500
headless-balance-bot CLI. Type help. Commands you send are audited as actor "cli".
hmc> bots
ID                   STATE         REASON/DETAIL          BALANCE
 bot1                online                               1234.5 (command, 2026-10-27T12:45:28.022Z)
hmc> use bot1
using bot1 (online)
hmc[bot1]> /bal
-> bot1: /bal   (audited as cli; collecting replies for 1500 ms)
   2026-10-27T12:45:31.892Z [bot1] system    Mock balance: $1,234.50
hmc[bot1]> sidebar
sidebar: Mock
   1  Mock Server
   2  Money: $1,234.50
tab header: ""
tab footer: ""
hmc[bot1]> raw on
raw on
hmc[bot1]> tail 2
2026-10-27T12:45:28.021Z [bot1] system    Mock balance: $1,234.50
    raw: {"text":"Mock balance: $1,234.50"}
2026-10-27T12:45:31.891Z [bot1] system    Mock balance: $1,234.50
    raw: {"text":"Mock balance: $1,234.50"}
-- tailing bot1 (capacity 100); Ctrl+C to stop --
^C
-- tail stopped --
hmc[bot1]> dump /tmp/sample.json 50
saved 3 messages and the sidebar to /tmp/sample.json
hmc[bot1]> quit
```

and the audit log it produced (the first line is the daemon's own scheduled read):

```json
{"ts":"2026-10-27T12:45:28.014Z","actor":"poll","action":"send","bot":"bot1","text":"/bal"}
{"ts":"2026-10-27T12:45:31.887Z","actor":"cli","action":"send","bot":"bot1","text":"/bal"}
```

Typical use for finding a server's real format: `use <bot>` → `raw on` → `/bal` → read the raw component under the reply → write
`replyPattern` → `POST /config/reload` → `bal`. `tail` shows what else the server prints while you do things in-game.

---

## 5. Config reference

One YAML file (`--config` or `HMC_CONFIG`; default `./config.yaml`). Unknown keys are errors. Fully commented example:
[`config/config.example.yaml`](config/config.example.yaml). Reload with `POST /config/reload` or `SIGHUP`;
`api.*` changes need a restart and are reported under `restartRequired`. Running bots keep their sockets;
limits, backoff, balance source/patterns, report sinks and kick settings apply from the next use.

| Key | Default | Meaning |
|---|---|---|
| `server.host` | **required** | Server you own |
| `server.port` / `version` / `connectTimeoutMs` | 25565 / `auto` / 20000 | `auto` = ping once, cache 10 min |
| `accounts[]` | `[]` | `id` (default username), `username`, `auth` (`offline`\|`microsoft`\|`token`), `accessTokenEnv`, `profileIdEnv` |
| `accountGroups[]` | `[]` | `idPrefix`, `usernamePrefix`, `count` (≤5000), `start`, `pad`: generated **offline** accounts |
| `auth.profilesFolder` | `./data/auth` | Microsoft token cache |
| `limits.maxBots` | 1000 | Running bots allowed |
| `limits.maxConcurrentBots` | 50 | Bots holding a connection; extra bots wait queued |
| `limits.maxConcurrentConnecting` | 3 | Handshakes in flight |
| `limits.maxQueue` | 1000 | Join-queue bound |
| `limits.joinDelayMs` / `joinJitterMs` | 3000 / 500 | Minimum gap between any two connection attempts, reconnects included |
| `reconnect.*` | 5 s, ×2, cap 300 s, ±20 %, unlimited, reset after 60 s online | Exponential backoff |
| `kick.cooldownSeconds` / `banCooldownSeconds` | 900 / 86400 | Restart is refused until then |
| `kick.banPattern` | `\bban(ned)?\b\|blacklist` | Marks a kick as a ban |
| `kick.globalPauseSeconds` | 60 | All joins pause after any kick (≥ `cooldownSeconds` after a ban) |
| `kick.transientPattern` | whole-message "Server closed / is restarting…" | Plain shutdown notices reconnect instead of counting as a kick; `''` disables |
| `budget.*` | on, 60 MB/bot, 3 %/bot, no RSS cap | Admission control, see §7 |
| `client.viewDistance` | 2 | Smallest allowed; reduces what the server sends |
| `client.lean` | true | Skip deserialising unused packets |
| `balance.source` | **required** | `http` \| `command` \| `sidebar` (plus the matching sub-section) |
| `balance.pollIntervalSec` | 300 | `0` = read once; otherwise ≥ `minReadIntervalSec` |
| `balance.minReadIntervalSec` | 30 | Floor between two reads of one bot |
| `balance.readyDelayMs` / `readTimeoutMs` | 3000 / 15000 | |
| `balance.currencySymbols` / `suffixes` | `$` / `{}` | Parser vocabulary; empty `suffixes` rejects "1.5M" |
| `debug.dump.*` | enabled, 2 bots, 30 s, 500 lines | First-connect discovery dump |
| `observe.messageBuffer` | 100 | Last N messages kept per bot for the CLI (`0` = none, no permanent chat listener) |
| `observe.trackScoreboard` | true | Track sidebar/tab for every bot so CLI `sidebar` works (`false` saves a little CPU/RAM; see §8) |
| `observe.maxReplyWindowMs` | 30000 | Upper bound for a reply-collection window |
| `audit.file` / `audit.polls` | `./data/audit.jsonl` / true | Audit log; `polls: false` leaves out the automatic balance command (CLI/API sends are always recorded) |
| `reports.file` / `keepRecent` / `webhook` | `./data/reports.jsonl` / 500 / none | |
| `api.bind` / `port` / `tokenEnv` | `127.0.0.1` / 8787 / `HMC_API_TOKEN` | **Loopback only**: any other `bind` is refused at startup unless `HMC_ALLOW_NON_LOOPBACK=1` (containers, §9) |

---

## 6. Behaviour you should know about

- **Kick or ban text ⇒ stop and back off.** A `kick_disconnect`/`disconnect` packet moves the bot to `kicked`
  (reason `banned` if the text matches `kick.banPattern`) with no automatic retry. The id cannot be restarted until
  its cooldown ends, stopping it does not clear the cooldown, and new joins for *all* bots pause meanwhile. There is
  no override flag.
  - Includes login-time disconnects such as whitelist, throttling and "server full": all final.
  - **One deliberate exception:** a message that is *entirely* a plain shutdown notice (`Server closed`,
    `Server is restarting`, …) is treated as a dropped connection and retried with backoff, because otherwise every
    server restart would permanently stop every bot until someone calls the API. It is anchored to the whole message,
    so "Server closed for cheating" is a kick. Set `kick.transientPattern: ''` to disable the exception.
- **Reconnect** (dropped sockets, refused connections, timeouts): exponential backoff with jitter; reconnects go through the
  same staggered queue as first joins, so a server restart cannot cause a thundering herd.
- **Resource packs are always declined.** A server that requires one will kick the bot, which is then final.
- **Audit log**: every message a bot is made to send is appended to `audit.file` (JSON lines, mode 0600) **before** it is sent, with
  `actor`: `cli` (typed in the CLI), `api` (HTTP caller without an actor), or `poll` (the scheduled balance command). If the audit
  write fails, the send is aborted. API start/stop calls are recorded too. There is no rotation; use logrotate with `copytruncate`.
  Plain chat sent as a bot that has no chat-signing keys (offline / `token` accounts) can be refused or kicked by servers that enforce
  secure chat; a kick is final like any other.
- **Secrets**: accounts and webhooks reference env var *names*; values are never written to the config, status, reports or logs.
- **Logging**: lifecycle lines only (state changes, kicks), on stderr. There is no per-packet logging; `HMC_LOG_LEVEL=debug|info|warn|error`.

---

## 7. Efficiency design and the resource budget

What keeps a bot cheap:

- No world model. With `client.lean` the play-state deserializer drops chunk, light, entity, sound, particle, inventory
  and recipe packets by id *before* parsing them (`src/lean.js`); chat, scoreboard, teams, tab list, player info, commands,
  keep-alive and disconnect are still parsed.
- View distance 2, so the server sends fewer chunks to begin with.
- Listeners exist only while needed: chat taps only during a command wait or the dump window; the scoreboard tracker only for
  `sidebar` (and the dump window).
- Every collection is capped: report ring, webhook queue, join queue, scoreboard (8 objectives × 64 scores, 1024 teams), parsed
  text (4096 chars). Scoreboard text is stored raw and flattened only when read.
- One timer per bot at a time (connect timeout, reconnect delay, or next read).

**Resource budget.** One Node process cannot meter individual bots. The budget is therefore *admission control against
process averages*: every `checkIntervalMs` it samples RSS and CPU; while measured memory per online bot exceeds
`memoryMBPerBot`, or total CPU exceeds `cpuPercentPerBot × online + 10 %`, or RSS exceeds `maxRssMB`, **new joins wait**
(`/health` → `resources.exceeded` names the reason). Running bots are never killed. For hard per-process limits use the
cgroup caps in `deploy/` (`MemoryMax`, `CPUQuota`, `mem_limit`, `cpus`) and `--max-old-space-size`; for hard isolation
between groups of bots run several processes.

---

## 8. Benchmark

Measured with `npm run bench` (`scripts/benchmark.js`): the real `src/main.js` process holds N offline bots against a local mock
server running in a **separate process**; memory and CPU come from `/proc` for the bot process only. Raw results are in
[`bench/`](bench/). One run per size, 20 s steady state after a 3 s settle, no warm-up repeats.

**Machine:** Intel Xeon @ 2.8 GHz, 4 cores, 16 GB, Linux, Node 22.22. **Server:** loopback mock, Minecraft 1.21.4.
**Per-bot load:** *idle* = keep-alives + one sidebar score update per second + one balance read every 30 s;
*busy* = idle + 50 entity-move packets/s + 1 chat line/s per bot (about 25,000 packets/s at 500 bots).
Defaults otherwise (`client.lean: true`, `observe.messageBuffer: 100`, `observe.trackScoreboard: true`).

| Bots | Idle: RSS | Idle: CPU (of one core) | Busy: RSS | Busy: CPU (of one core) |
|---:|---:|---:|---:|---:|
| 0 (just started) | 92 MB | ~0 % | | |
| 25 | 158 MB | 1.0 % | 156 MB | 3.2 % |
| 100 | 181 MB | 2.3 % | 183 MB | 10.1 % |
| 250 | 206 MB | 4.9 % | 222 MB | 25.3 % |
| 500 | 267 MB | 7.0 % | 312 MB | 46.1 % |

All bots were online at the end of every run (500/500).

What these numbers do and do not say:

- **Memory.** About **0.2-0.3 MB per additional bot** (least-squares slope over the four sizes: 0.22 MB idle, 0.32 MB busy), on top of a
  fixed ~155 MB that appears once the first bot connects (92 MB at start-up, plus compiled protocol tables, minecraft-data and JIT). So
  **500 bots fit in roughly 270-310 MB** here. The RSS series is noisy: two runs that differ only in a feature flag landed 20-30 MB apart
  (busy, 500 bots: 312 MB with `lean` on vs 282 MB off; idle, 250 bots: 206 MB vs 221 MB), so treat the slope as ±0.1 MB/bot. A **"bots per GB" figure is not claimed**: it would be an extrapolation past the
  500 bots measured, and file-descriptor limits, ephemeral ports and a real server's traffic will bind first.
- **CPU.** Idle steady state is about **0.014-0.04 % of a core per bot** (7 % of one core for 500 bots); under the busy profile about
  **0.09-0.14 % per bot**. A real server sends chunks and many more entities than this mock, so expect higher CPU than the busy row; that is
  not measured here.
- **Joining.** Each join costs about **85 ms of CPU** (client setup and login), so 500 bots saturate one core for ~45 s, i.e. a ramp of about
  10 bots/s is the ceiling of this process regardless of `joinDelayMs`. The default of one join per 3 s is far below it.
- **`client.lean` (skipping unused packets): no measurable benefit in this benchmark.** With 50 tiny entity-move packets/s per bot, lean on vs
  off differed by under 5 % CPU (46.1 % vs 48.0 % at 500 bots), inside run-to-run noise, and RSS was not lower. The feature targets large
  chunk/entity packets, which the mock does not send, so its value on a real server is **unmeasured**. It is correctness-tested (it
  drops exactly the listed packets and chat still works), not performance-proven.
- **Cost of the CLI support** (message ring + scoreboard tracking): idle, 500 bots, `observe` on vs off: 267 MB / 7.0 % vs 264 MB / 8.0 %.
  No difference is measurable at this load. It is not measured under chat-heavy loads beyond the busy profile's 1 line/s/bot.
- The mock server used 5 % (idle) and 45 % (busy at 500 bots) of a core, so it was not the bottleneck.

Reproduce: `npm run bench -- --bots 25,100,250,500 --duration 20 --traffic idle --lean both` (also `--traffic busy`, `--observe off`).


---

## 9. Run it for real

### Docker

```bash
cp config/config.example.yaml config.yaml          # set api.bind: 0.0.0.0 (inside the container only), server, accounts, balance
printf 'HMC_API_TOKEN=%s\n' "$(openssl rand -hex 24)" > .env && chmod 600 .env
docker compose -f deploy/docker-compose.yml up -d --build
curl -s localhost:8787/health
```

The compose file publishes the API on the **host's loopback only** (`127.0.0.1:8787`), runs read-only with all capabilities
dropped, sets hard `mem_limit`/`cpus`, and keeps reports, the dump and the Microsoft token cache in the `bot-data` volume.
Inside a container the process must listen on the container's interface, so the compose file sets `HMC_ALLOW_NON_LOOPBACK=1` (the only way to get a non-loopback bind) and publishes the port on the **host's** `127.0.0.1`. Never publish it on `0.0.0.0`.
Without Compose: `docker build -t headless-balance-bot .` then
`docker run -d --env-file .env -e HMC_AUTOSTART=1 -e HMC_ALLOW_NON_LOOPBACK=1 -p 127.0.0.1:8787:8787 -v $PWD/config.yaml:/config/config.yaml:ro -v bot-data:/app/data headless-balance-bot`.
For `auth: microsoft`, run the one-time sign-in in the container: `docker compose run --rm bot node scripts/auth-login.js --config /config/config.yaml --id main`
(the same volume holds the cache).

### systemd

[`deploy/headless-balance-bot.service`](deploy/headless-balance-bot.service) is a hardened unit (dedicated user, `ProtectSystem=strict`,
`MemoryMax`, `CPUQuota`, `--autostart`, `systemctl reload` ⇒ config reload). Setup commands are in its header comment.

---

## 10. Testing

```bash
npm test            # unit + end-to-end suite (node:test), about 1-2 minutes
node scripts/matrix.mjs   # one bot per (version × source) against the mock server
```

Covered by automated tests: config loader (defaults, strictness, cross-field rules, secrets-by-env, groups, reload diff);
text flattening (JSON, NBT, translate, bounds); amount parser and pattern rules; scoreboard tracker (legacy and 1.20.3+ score
packets, numeric and named team modes, caps, waiting); all three balance sources; API handlers (auth, every route, error
codes) and a real HTTP server; scheduler/manager (concurrency, staggering, queue bounds, cooldown, global pause, stop);
bot lifecycle (backoff growth and reset, kick/ban/login-disconnect finality, auth_required, token env, protocol upkeep,
timer cleanup); report sinks; and end-to-end runs through real sockets and real packet serialisation against the mock
server for 1.16.5, 1.19.4, 1.20.1, 1.20.4, 1.21.4 and 1.21.8. The CLI has its own tests: the command parser (every command,
limits, typo-is-never-chat), the message ring and the reply-collection window (late reply inside the window shown, after it not; subscribe
before send; bounded; abort), audit-before-send and fail-closed, the new API routes, and full scripted CLI sessions (including `tail`
with interrupt, `raw`, `dump`, rate-limit and error paths, piped input) against the mock server through the real HTTP API.

**What the tests cannot prove** is in the final section below and in the hand-off notes: the mock server is
not your server.

## 11. Known uncertainties

- **Server version is unconfirmed** (see §1). Run the probe.
- **Balance wording/layout is unconfirmed**; it is read from your dump, never assumed. Parser tests use synthetic fixtures.
- **Versions below 1.16 and above those listed were not validated end-to-end** (the mock's sidebar packets are 1.16+; 1.21.11 and
  26.1 passed the matrix run but are not in the automated suite).
- **Real-server packet details not reproducible with the mock**: servers behind proxies (Velocity/Bungee/ViaVersion) may report
  the proxy's version in the ping; servers that require resource packs, plugin-message handshakes or cookies/transfer packets
  may kick a minimal client; 1.21.5+ chat-signing and `chunk_batch` flow control were only exercised with the mock's simple replies.
- **Command replies** may arrive as several lines, in a different channel (action bar / title) or after a longer delay than
  `readTimeoutMs`; the dump shows which.
- **Unattended Microsoft auth** depends on the cached refresh token staying valid; Microsoft can invalidate it (password change,
  long inactivity). The bot then stops with `auth_required`.
