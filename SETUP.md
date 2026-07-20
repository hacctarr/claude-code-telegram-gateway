# Telegram Setup Guide

Complete steps to configure Telegram for the Claude Code gateway. The gateway connects your phone
to the Claude Code sessions running on your Mac: active desk sessions **auto-appear as Telegram
topics and mirror live**, and you can **reply from your phone** to steer a session when it's idle.

> One bot + one supergroup per repository, per Mac. Each Forum Topic is one Claude session.

---

## Step 1 — Create a bot

1. In Telegram, open **@BotFather** → send `/newbot`.
2. Give it a **name** (e.g. `My Mac Claude`) and a **username ending in `bot`** (e.g. `mymac_claude_bot`).
3. Copy the **HTTP API token** (looks like `123456789:AAH...`). You'll put it in `config.json`.

> **Privacy mode:** you do **not** need to disable it. The bot must be a group **admin** (Step 2),
> and admins receive all messages regardless of privacy mode.

## Step 2 — Create the supergroup with Topics

1. **New Group** → add your bot → name it after the repo (e.g. `Mac1: auth-service`).
2. **Enable Topics:** Group Info → Edit → turn on **Topics** (this converts the group to a supergroup).
3. **Promote the bot to Admin** (Group Info → Edit → Administrators) with **Manage Topics** and
   **Post Messages** enabled. *This is required* — the gateway creates/closes topics via the bot.

## Step 3 — Get your IDs

- **Your user ID** (the security allowlist): message **@userinfobot**, copy the number → goes in
  `ALLOWED_USER_IDS`.
- **Group chat ID:** post any message in the group's **General** topic, then open in a browser:
  `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
  Find the `"chat": { "id": -100... }` value (a negative number starting `-100`) → the key in
  `REPO_MAPPINGS`.

## Step 4 — Configure

```bash
mkdir -p ~/.claude-gateway
cp config.example.json ~/.claude-gateway/config.json
```
```json
{
  "BOT_TOKEN": "123456789:AAH...",
  "ALLOWED_USER_IDS": ["<your_user_id>"],
  "REPO_MAPPINGS": { "-1001234567890": "/Users/you/projects/auth-service" },
  "CLAUDE_PATH": "/Users/you/.nvm/versions/node/vXX/bin/claude"
}
```
Config and all runtime state live in `~/.claude-gateway/` (override with `CLAUDE_GATEWAY_DIR`),
deliberately outside the install directory: for an npm install that directory sits in
`node_modules` and is replaced on every `npm update`. A config left in the install dir still
works and is moved to `~/.claude-gateway/` automatically on first run.

Optional tuning keys (mirror/prune/idle timings) are listed in `config.example.json`.

Run `node test/check-telegram.js` to verify the bot's identity and that it can create/delete a
topic (self-cleaning). Expect `✅ All checks passed`.

## Step 5 — Run

```bash
npm start                 # foreground (testing)
# or run it as a background service:
./install-service.sh      # launchd: auto-start on login, restart on crash, logs to gateway.log
```

## Using it

- **From the Mac:** run `claude` in a mapped repo. Within ~30 min of activity a topic appears on your
  phone and mirrors the session (🖥️ desk / assistant / 🔧 tool) within ~2s.
- **From the phone:**
  - Reply in a topic to steer that session (runs when the desk session is idle).
  - `/new <message>` — start a fresh, independent session in its own topic.
  - `/sessions` — list recent sessions; `/resume <id | text>` — link a topic to an existing session.
- **Back at the desk:** `cr` (installed alias for `claude -c`) resumes the most recent session,
  including turns you sent from the phone.

See the main [README](README.md) for the architecture and the known limitations of the
"native TUI primary" model.
