# Manual verification runbook

Unit tests (`npm test`) cover the pure logic. These steps cover what they can't: the real Telegram
API and the interaction between headless injection and the live desk TUI. Do them once before
trusting the gateway in daily use.

---

## Test A — Injection vs. an open TUI (the critical one, gap #1)

**Why:** phone→desk injection runs `claude -p --resume <id>` when the transcript looks idle. If the
native TUI is holding that session, we need to know whether that injection is safe (clean append),
locks/errors, or forks the transcript.

1. **Terminal 1 (the "desk"):**
   ```bash
   cd <your mapped repo, e.g. ~/Documents>
   claude
   ```
   Send one message, e.g. `Remember the codeword: BANANA.` Wait for the reply, then **leave the TUI
   open and idle** (don't quit).

2. **Terminal 2 (the "phone", simulated):**
   ```bash
   cd ~/telegram_gateway
   ./test/inject-probe.sh
   ```
   It auto-picks the most recent session (your Terminal-1 one) and injects a headless turn.

3. **Read the probe output:**
   - `exit_ok: true` and `result: "INJECTED_OK"` → headless resume succeeded even with the TUI open.
   - `same_session_id` equals the session id → no new session was minted.
   - `appended to the SAME file: yes` and `New sibling session files: 0` → **clean append, no fork.** ✅
   - Any `non-JSON output (possible lock/conflict)`, a new sibling file, or a changed session id →
     **injection conflicts with the open TUI.** ❗ In that case we should tighten the idle-gate to
     also refuse injection whenever the session is the *most recently active* one (assume TUI owns it),
     or require the desk session be closed. Tell me the result and I'll adjust.

4. **Back in Terminal 1:** send another message (e.g. `What was the codeword?`). Confirm the TUI still
   responds coherently and didn't break. Note whether it "sees" the injected turn (it generally
   won't until you `cr`/reload — that's expected).

5. **Cleanup:** quit the TUI. Run `cr` (or `claude -c`) in the repo and confirm the session loads with
   both the desk turns and the injected `INJECTED_OK` turn present.

---

## Test B — Telegram permissions & topic lifecycle (gap #2)

**Why:** auto-topics need the bot to be an admin with **Manage Topics**. This verifies it for real and
leaves no junk behind (it deletes its own self-test topic).

```bash
cd ~/telegram_gateway
node test/check-telegram.js
```
Expect `✅ All checks passed`. If it reports "not an admin" or "can_manage_topics: false", fix the
bot's rights in the group (Admin → Manage Topics) and re-run.

---

## Test C — End-to-end mirror + auto-initiate

1. Start the gateway (`npm start`, or `./install-service.sh` then `tail -f gateway.log`).
2. In the desk TUI, open/continue a session in the mapped repo and send a message.
3. Within ~30 min of activity (default `ACTIVE_WINDOW_MIN`) a **new topic** should appear in the
   supergroup with an opener, and within ~2s (`POLL_MS`) your exchange should mirror in as
   `🖥️ desk:` / assistant text / `🔧 tool` lines.
4. From the phone, reply in that topic while the desk session is **idle** → the turn runs and streams
   back once (no duplicate from the mirror).
5. From the phone, `/new draft a haiku` → a brand-new topic + independent session appears.
6. **Prune:** temporarily set `PRUNE_AFTER_DAYS` very low (e.g. via a quick config edit + restart) and
   confirm an idle session's topic gets closed; revive the session and confirm it reopens.

---

## Test F — Inline action buttons

**Why:** buttons ride the live callback plumbing; only a real Telegram round-trip exercises them.

1. From the Mac, run a session in a mapped repo so a topic appears and a prose reply mirrors in.
2. Confirm the reply carries a **🖥️ Desk · ✏️ Rename · ❌ Close** bar. Send another desk turn;
   confirm the bar moves to the newest reply and the previous one loses its buttons.
3. Tap **🖥️ Desk** → the session opens in your editor on the Mac; the toast says "Opening on your Mac".
4. Tap **❌ Close** → the topic closes and the session unbinds (same as `/exit`).
5. In another topic, send `/sessions` → a tappable list appears; tap one → "Linked", then send a
   message and confirm it continues that session.
6. Set `"BUTTONS": false`, restart, and confirm replies have no bar and `/sessions` falls back to text.

---

## Test G — Group auto-config

**Why:** appearance calls hit setChat*/setMy* once; verify they apply and then stay silent.

1. With `APPEARANCE` set and the bot an Admin with **Change Group Info**, start the gateway.
2. Confirm the log shows `[Appearance] configuring as @<bot>` and one or more `updated` lines, and
   that the group title/description and the bot's about/description changed in Telegram. A group that
   **already has a photo** keeps it (log: `already has a photo · leaving it`); a group with no photo
   gets `default_photo_path`. To force-replace one, add `"force_photo": true` to that chat entry.
3. `touch ~/.claude-gateway/restart.flag`. On relaunch, confirm **no** `updated` lines appear
   (hash match → silent). Change `APPEARANCE.chats.<id>.title`, restart, and confirm only that chat
   re-applies.
4. Confirm `~/.claude-gateway/appearance.json` holds a `botProfile` hash and a per-chat hash.

---

## Quick reference

| Check | Command |
|---|---|
| Unit tests | `npm test` |
| Telegram perms | `node test/check-telegram.js` |
| Injection safety | `./test/inject-probe.sh [session-uuid]` |
| Live logs (service) | `tail -f gateway.log` |
| Service state | `launchctl print gui/$(id -u)/com.claude.telegram-gateway \| grep -i state` |
