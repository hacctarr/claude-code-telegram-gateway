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

## Quick reference

| Check | Command |
|---|---|
| Unit tests | `npm test` |
| Telegram perms | `node test/check-telegram.js` |
| Injection safety | `./test/inject-probe.sh [session-uuid]` |
| Live logs (service) | `tail -f gateway.log` |
| Service state | `launchctl print gui/$(id -u)/com.claude.telegram-gateway \| grep -i state` |
