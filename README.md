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
        └─ idle 7 days        → closeForumTopic                 (prune)
                    ▲
  reply in a topic → idle? → claude -p --resume (streams back) │ busy? → queue, run when idle
  /new <msg>       → new topic + independent session
```

- **1 supergroup per repo** (`REPO_MAPPINGS`), **1 topic per session**, isolated end-to-end.
- A session's `cwd` (stored in its transcript) maps it to the right supergroup automatically.
- Session ↔ topic links persist in `links.json`, so topics survive restarts. `sessions.json` from
  older versions is migrated automatically on first run.

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
git clone https://github.com/hacctarr/claude-code-telegram-gateway
cd claude-code-telegram-gateway
npm run setup          # interactive: validates your bot, auto-detects your
                       # user id + group chat id, writes config.json, and can
                       # install the background service for you
```

First create the bot + group (Telegram side) as in **[SETUP.md](SETUP.md)** — it takes ~2 minutes —
then `npm run setup` does the rest. Everything below is the manual equivalent.

## Setup (manual)

1. **Create a bot** via `@BotFather` (`/newbot`) and copy the HTTP API token.
2. **Create a Supergroup** per repo, enable **Topics**, add the bot, and promote it to
   **Admin → Manage Topics + Post Messages**.
3. **Get IDs:** your numeric user id (`@userinfobot`) and the group chat id (`-100…`, via the
   `getUpdates` URL in [SETUP.md](SETUP.md)).
4. **Configure:** `cp config.example.json config.json` and fill it in:
   ```json
   {
     "BOT_TOKEN": "…",
     "ALLOWED_USER_IDS": ["<your_user_id>"],
     "REPO_MAPPINGS": { "-1001654782309": "/Users/you/Documents" },
     "CLAUDE_PATH": "/Users/you/.nvm/versions/node/vXX/bin/claude"
   }
   ```
   Optional keys (defaults shown): `MIRROR` (true), `AUTO_CREATE_TOPICS` (true),
   `SHOW_TOOL_ACTIVITY` (true), `PERMISSION_MODE` ("bypassPermissions"), `MODEL`,
   `IDLE_INJECT_SECONDS` (15), `ACTIVE_WINDOW_MIN` (30), `PRUNE_AFTER_DAYS` (7),
   `PRUNE_MODE` ("close" | "delete"), `POLL_MS` (2000).

> **Permissions note:** the default `bypassPermissions` lets phone-injected turns run tools without
> an approval prompt (there's no way to tap "approve" from Telegram). Anyone allowed to post in the
> group gets unattended tool access to that repo — `ALLOWED_USER_IDS` is what protects it.

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

## Using it

- **From the Mac:** just run `claude` in a mapped repo. Within ~30 min of activity a topic appears
  on your phone and mirrors the session live.
- **From the phone:**
  - Reply in a topic to steer that session (runs when the desk session is idle).
  - `/new <message>` — start a brand-new, independent session in its own topic.
  - `/new` (bare) — detach the current topic so your next message starts a fresh session there.
  - **`/desk`** — open this topic's session in the editor on your Mac (VS Code by default). The
    clean "hand it back to the desk" move: it opens the exact session so you continue there.
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
- **Desk session left open:** a plain resume into a held session runs but wouldn't persist (the desk
  owns the file). The gateway detects this (the transcript didn't grow) and **automatically forks a
  phone-owned branch** that *does* persist, continuing there — you get a one-line "continued in a
  phone branch" notice. Your desk copy is untouched; from that point the phone and desk branches
  diverge — but you never have to remember to close the TUI, and opening a terminal auto-resumes the
  phone branch. If you *do* keep working the desk branch afterward, it automatically gets its own
  topic again (no manual `/branches` command needed). Held-open is detected with `lsof` **before**
  the turn runs, so the prompt (and any tool side effects) never executes twice.

### Other notes
- Mirror latency ≈ `POLL_MS` (~2s); it posts completed turns, not token-by-token (phone-injected
  turns *do* stream token-by-token via the live-edited message). Failing desk tool calls are
  surfaced as `⚠️ tool error`; successful tool output is kept quiet.
- With `bypassPermissions` (default), phone-injected turns never block on a tool-permission prompt.
  A clarifying question in Claude's reply just streams to you; answer in the topic to continue.
- A single-instance lock prevents two gateways from fighting over `getUpdates`. Linux users: a
  `systemd --user` unit is in `systemd/` (macOS uses the bundled launchd installer).
