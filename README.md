# Claude Code Multi-Session Telegram Gateway (macOS)

A private, local-first gateway that connects your **iPhone** to the **Claude Code sessions running on your Mac** over **Telegram Forum Topics**. It works in both directions:

- **Desk → phone (live mirror):** run Claude normally in the native TUI on your Mac; every *active* session automatically gets its own Telegram topic, and the conversation (your desk input, Claude's replies, tool activity) mirrors into it within ~2s.
- **Phone → desk (inject):** reply inside a topic to steer that session. When the desk session is idle, your message runs headlessly and streams back live. This is ideal when you're **away from the desk**.

It is a transcript **watcher**, not a terminal scraper — it reads Claude's own session logs (`~/.claude/projects/**/<uuid>.jsonl`) and drives turns via headless `claude -p`. No `node-pty`, no ANSI parsing. Zero runtime dependencies.

---

## How it works

```
   ~/.claude/projects/<repo>/<uuid>.jsonl  (written by the native Claude TUI)
                    |
      [poll loop, every ~2s]
        ├─ active + no topic  → createForumTopic + opener      (auto-initiate)
        ├─ new transcript lines → mirror to the topic          (🖥️ desk / assistant / 🔧 tool)
        └─ idle 1 day         → closeForumTopic                 (prune)
                    ▲
  reply in a topic → idle? → claude -p --resume (streams back) │ busy? → queue, run when idle
  /new <msg>       → new topic + independent session
```

- **1 supergroup per repo** (`REPO_MAPPINGS`), **1 topic per session**, isolated end-to-end.
- A session's `cwd` (stored in its transcript) maps it to the right supergroup automatically.
- Session ↔ topic links persist in `links.json`, so topics survive restarts. `sessions.json` from
  older versions is migrated automatically on first run.
- Config and state live in `~/.claude-gateway/` (`CLAUDE_GATEWAY_DIR` to override), outside the
  install dir so `npm update` can't wipe them. Pre-1.0.4 files left in the install directory are
  moved there automatically on first run.

---

## Prerequisites

- **macOS** with Node.js 18+ (tested on v26).
- **Claude Code CLI** installed and logged in (`claude` on your PATH).
- A Telegram bot that is a **group Admin with the "Manage Topics" permission** (required so the
  gateway can create/close topics). Without it, mirroring is skipped and you fall back to manually
  creating topics + `/resume`.

---

## Quick start

```bash
npm install -g claude-code-telegram-gateway
claude-tg setup        # interactive: validates your bot, auto-detects your
                       # user id + group chat id, writes config.json, and can
                       # install the background service for you
```

Or from source: `git clone https://github.com/hacctarr/claude-code-telegram-gateway && cd claude-code-telegram-gateway && npm run setup`

First create the bot + group (Telegram side) as in **[SETUP.md](SETUP.md)** — it takes ~2 minutes —
then `npm run setup` does the rest. Everything below is the manual equivalent.

## Setup (manual)

1. **Create a bot** via `@BotFather` (`/newbot`) and copy the HTTP API token.
2. **Create a Supergroup** per repo, enable **Topics**, add the bot, and promote it to
   **Admin → Manage Topics + Post Messages**.
3. **Get IDs:** your numeric user id (`@userinfobot`) and the group chat id (`-100…`, via the
   `getUpdates` URL in [SETUP.md](SETUP.md)).
4. **Configure:** `cp config.example.json ~/.claude-gateway/config.json` and fill it in:
   ```json
   {
     "BOT_TOKEN": "…",
     "ALLOWED_USER_IDS": ["<your_user_id>"],
     "REPO_MAPPINGS": { "-1001654782309": "/Users/you/Documents" },
     "CLAUDE_PATH": "/Users/you/.nvm/versions/node/vXX/bin/claude"
   }
   ```
   Optional keys (defaults shown): `MIRROR` (true), `AUTO_CREATE_TOPICS` (true),
   `SHOW_TOOL_ACTIVITY` (false), the *default* for 🔧 tool steps, off because one line per tool
   call buries the prose response on a long session; `/tools` overrides it per topic or per chat
   at runtime. Also `PERMISSION_MODE` ("bypassPermissions"), `MODEL`,
   `IDLE_INJECT_SECONDS` (15), `ACTIVE_WINDOW_MIN` (30), `PRUNE_AFTER_HOURS` (2; the older
   `PRUNE_AFTER_DAYS` spelling is still honored),
   `PRUNE_MODE` ("close" | "delete"), `PRUNES_PER_TICK` (5 — cap on prune calls per poll so a
   large idle backlog can't stall a tick or delay a `restart.flag`), `POLL_MS` (2000),
   `TOPIC_OPENER` ("minimal" | "off" | "full" — the first message posted into a new topic),
   `BUTTONS` (true — inline action bar on each mirrored reply + a /sessions picker),
   `AUTO_CONFIGURE_GROUP` (true — apply group/bot appearance from `APPEARANCE` on boot),
   `CHILD_MCP_SERVERS` (unset, see below), `MCP_CONFIG_PATH` (`~/.claude.json`).

> **`CHILD_MCP_SERVERS`, the cost lever.** Every phone turn spawns a fresh Claude child, and by
> default that child loads your entire MCP surface from cold. Tool definitions lead the cached
> prompt prefix, ahead of the system blocks and every message, so servers that finish connecting
> mid-run grow the tools array and invalidate the whole prefix. The conversation is then re-written
> to cache at 1h TTL, billed at twice the base input rate. Measured on a real install: the tools
> array went from 29 definitions to 101 between two requests 15 seconds apart, and a single trivial
> turn cost 74,497 cache-creation tokens.
>
> Set `"CHILD_MCP_SERVERS": []` and children run with built-in tools only: the tools array is then
> byte-identical on every request and the cache is reused across turns. The trade-off is that
> phone-injected turns lose MCP tools; the desk session keeps its full surface. Naming a subset
> (`["gmail"]`) is cheaper than inheriting everything, but only `[]` is fully deterministic, since a
> slow server inside the subset can still shift the array mid-run.

> **Permissions — two ways to run it:**
> - **`bypassPermissions`** (default): phone-injected turns run tools without prompts. Anyone
>   allowed to post in the group gets unattended tool access to that repo — `ALLOWED_USER_IDS` is
>   what protects it.
> - **Any stricter mode** (e.g. `"PERMISSION_MODE": "acceptEdits"` or `"manual"`): tool-permission
>   prompts appear **in the Telegram topic as ✅ Allow / ❌ Deny buttons** — tap to approve from your
>   phone (only `ALLOWED_USER_IDS` presses are honored). Unanswered requests deny after
>   `APPROVAL_TIMEOUT_SECONDS` (default 300) so turns can't hang. Your configured allow/deny rules
>   still apply first; buttons appear only for what would genuinely prompt.

---

## Run

Foreground (for testing):
```bash
npm start
```

As a background service (auto-start on login, auto-restart on crash):
```bash
./install-service.sh      # loads a launchd agent, logs to gateway.log, adds a `cr` alias
tail -f gateway.log       # watch it live
./uninstall-service.sh    # stop + remove
```

`npm test` runs the unit suite (no network, no `claude` spawn).

---

## Updating

```bash
npm i -g claude-code-telegram-gateway@latest
touch ~/.claude-gateway/restart.flag
```

The second line matters: installing new files doesn't touch the gateway already running — it
keeps the old code in memory until it restarts. `restart.flag` is watched in both
`~/.claude-gateway/` and the install dir; the gateway waits for any in-flight turn to finish,
then exits so launchd (or systemd) relaunches it on the new version. Unlike
`launchctl kickstart`, it's safe to run from a phone-driven turn — the gateway won't kill the
session that asked for the restart mid-reply.

"In-flight" means still producing output. A turn that has gone silent for
`RESTART_STALE_TURN_SECONDS` (default 600) stops holding the restart: its reply is already lost,
so waiting longer only keeps you on the old code. Raise it if you run tool calls that stay quiet
for more than ten minutes.

You don't need to re-run setup or reinstall the service: the plist points at a stable path, and
config + state live in `~/.claude-gateway/`, outside the install dir, so an update can't wipe them.

From a source checkout: `git pull && npm test && touch ~/.claude-gateway/restart.flag`.

---

## Using it

- **From the Mac:** just run `claude` in a mapped repo. Within ~30 min of activity a topic appears
  on your phone and mirrors the session live.
- **From the phone:**
  - Reply in a topic to steer that session (runs when the desk session is idle).
  - `/new <message>` — start a brand-new, independent session in its own topic.
  - `/new` (bare) — detach the current topic so your next message starts a fresh session there.
  - `/exit` (or `/close`) — close this topic and stop mirroring its session. The session stays
    resumable on disk, and fresh desk activity re-opens a topic for it automatically.
  - **`/desk`** — open this topic's session in the editor on your Mac (VS Code by default). The
    clean "hand it back to the desk" move: it opens the exact session so you continue there.
  - `/tools off` — stop mirroring 🔧 tool steps in this topic (`/tools off all` for the whole
    chat, `/tools default` to drop the override, bare `/tools` to see the current setting). Tool
    lines are most of a long run's message volume, so this is the noise dial; prose responses,
    desk echoes and stall notices keep posting either way. Same scope as `SHOW_TOOL_ACTIVITY`,
    which it overrides: ⚠️ tool-error lines are tool activity too, so they go quiet with the rest.
    The setting persists across restarts in `~/.claude-gateway/toolprefs.json`.
  - `/sessions` — list recent sessions in the repo.
  - `/resume <uuid | text>` — link this topic to an existing session (searches first message + content).
- **Back at the desk:** two ways, pick per moment —
  - **VS Code / editor:** tap **`/desk`** in the topic; the exact session opens in your editor on the
    Mac via a `vscode://` deep link (configurable for Cursor/Windsurf via `DESK_URL_TEMPLATE`).
  - **Terminal:** just open one — an auto-resume hook (installed into `~/.zshrc`) drops you into that
    branch, multi-repo aware, then clears itself. `cr` remains as a manual resume.

### Phone continuation — works whether or not the desk session is closed
- **Desk session closed:** your phone reply continues the *same* session and is saved — seamless,
  and `cr` at the Mac picks it right up.
- **Desk session left open:** the desk process owns the transcript, so a plain resume wouldn't
  persist. With `AUTO_FORK` (default on) the gateway instead **forks a saved phone branch** and the
  topic follows it — full context kept, one-line notice posted, desk copy untouched. If you later
  keep working the desk copy, it earns its own topic automatically. Three safeguards make this
  race-free (each was a real bug once):
  - held-detection runs **before** the turn (`lsof`, excluding the gateway's own pid) — the prompt
    and its tool side effects execute exactly once, and idle-but-open sessions aren't re-forked;
  - the fork's session id is **pre-minted and reserved**, so the poller can never create a
    duplicate topic for the branch mid-turn;
  - a reply resolves its target session **when it runs**, so back-to-back messages follow the
    first one's fork instead of forking the original twice.
  Set `AUTO_FORK: false` to disable; held-session replies then run with full context but aren't
  persisted (and say so).

### Other notes
- Mirror latency ≈ `POLL_MS` (~2s); it posts completed turns, not token-by-token (phone-injected
  turns *do* stream token-by-token via the live-edited message). Failing desk tool calls are
  surfaced as `⚠️ tool error`; successful tool output is kept quiet.
- **Stall/approval notices:** a desk permission prompt is editor-UI state and never appears in the
  transcript — from the phone the session just looks stuck. If a desk tool call stays unresolved
  past `STALL_NOTICE_SECONDS` (default 60, 0 = off), the topic gets a one-time notice naming the
  tool ("may be running long — or waiting for approval at the desk"), and a follow-up when it
  completes. Approval itself must happen at the desk; `/desk` jumps you there.
- With `bypassPermissions` (default), phone-injected turns never block on a tool-permission prompt.
  A clarifying question in Claude's reply just streams to you; answer in the topic to continue.
- A single-instance lock prevents two gateways from fighting over `getUpdates`. Linux users: a
  `systemd --user` unit is in `systemd/` (macOS uses the bundled launchd installer).

### Appearance (optional)

With `AUTO_CONFIGURE_GROUP` on (default), the gateway configures its own group + bot identity on
boot from the `APPEARANCE` block: group title/description/photo, the bot's global name/about/
description, and the command menu. It is idempotent — a per-scope hash in
`~/.claude-gateway/appearance.json` means it only acts on first run or when a value changes, so
frequent restarts stay silent. `APPEARANCE` carries only what should differ from the live group/bot;
unset fields are left untouched. **A group photo is only set when the group has none** — a
representative icon you set by hand is never overwritten (add `"force_photo": true` to a chat entry
to override). The bot must be a group Admin with **Change Group Info**. Chat wallpaper is not
settable via the Bot API — it stays a manual in-app choice.

---

## Modules (optional)

The gateway can load external modules that extend it against a stable `api`
without modifying the package. List them in `config.json`:

    "MODULES": ["~/.claude-gateway/modules/spec-kit.js"]

Empty or absent = no-op. See `examples/modules/` for the contract and the two
bundled modules: `spec-kit` (compacts a spec-kit session between steps and spawns
a `/code-review` session when `/implement` finishes) and `auto-compact` (compacts
any session that has gone quiet with a large context).

---

## Analytics (optional)

The gateway can ship usage and reliability metrics to Grafana Cloud via OTLP.
Add an `otlp` block to `~/.claude-gateway/config.json`:

    "otlp": { "endpoint": "https://otlp-gateway-<zone>.grafana.net/otlp", "auth": "<base64 instanceID:token>", "enabled": true }

`endpoint` and the instance ID / token come from your Grafana Cloud stack's
OTLP page; `auth` is `base64("<instanceID>:<token>")`. With `enabled: false`
(or no block) the gateway runs unchanged and records nothing over the network,
while `/stats` still works from the local mirror at
`~/.claude-gateway/analytics/stats.json`. Import `grafana/gateway-dashboard.json`
into your Grafana Cloud instance for the dashboard.

Metric names are OTel-normalized by Grafana's OTLP gateway (dots become
underscores, counters gain `_total`), so the dashboard queries
`gateway_claude_turn_total`, `gateway_topic_create_failed_total`, and friends.
A useful alert: `sum(rate(gateway_topic_create_failed_total{reason="rate_limited"}[5m])) > 0`
catches Telegram topic-creation rate-limit storms.

Message sends are counted separately, because a Telegram 429 arrives as a non-ok
*response* rather than an exception and so produces no log line at all:
`gateway_send_failed_total{reason=...}` splits `rate_limited`, `rejected` (any
other non-ok body) and `error` (a thrown transport fault).
`gateway_mirror_batch_stalled_total` counts mirror batches that could not finish
in one pass, with `gateway_mirror_backoff_seconds` recording how long each waited.
A sustained non-zero rate on the stalled counter means a topic is being
rate-limited faster than it can drain, which is the shape a flood takes.

Every series is tagged by machine. `service.instance.id` becomes the Prometheus
`instance` label, defaulting to the host's `hostname`; set `otlp.instance` to a
friendly per-machine label (e.g. `"personal-mac"`, `"alkami-laptop"`) when more
than one gateway reports to the same Grafana stack, so their metrics stay
separate rather than colliding. Filter or group any query by it, for example
`sum by (instance) (rate(gateway_claude_turn_total[15m]))`.
