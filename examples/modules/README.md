# Gateway modules

External files that extend the gateway against a stable `api`. They are **not**
part of the published npm package — copy one into your state dir and list it in
`config.json`.

## Install a module

1. Copy the module next to your gateway state:
   `cp spec-kit.js ~/.claude-gateway/modules/spec-kit.js`
2. Add it to `config.json`:
   ```json
   "MODULES": ["~/.claude-gateway/modules/spec-kit.js"]
   ```
3. Restart: `touch ~/.claude-gateway/restart.flag`
   (never `launchctl kickstart -k` from a phone-driven turn — it self-kills).

Paths resolve against `$CLAUDE_GATEWAY_DIR` (default `~/.claude-gateway`) or may
be absolute. Empty or absent `MODULES` is a pure no-op.

## The module contract

A module is a factory that receives the `api` and returns hooks:

    module.exports = (api) => ({
      name: 'spec-kit',
      onTranscriptLine(ctx, record) { /* each new transcript record */ },
      onInjectedTurn(ctx, prompt)   { /* a turn the gateway drove on the user's behalf */ },
      onTick(now)                   { /* once per poll tick */ },
    });

`ctx = { sessionId, cwd, chatId, threadId }`. Every hook is optional. A throwing
hook is logged and skipped — it can't crash the gateway or other modules.

`onInjectedTurn` fires when the gateway drives a turn for the user (e.g. a command
texted in from Telegram); such turns are suppressed from the transcript mirror, so
`onTranscriptLine` never sees them — react to `onInjectedTurn` for the texted-in
path and `onTranscriptLine` for desk-typed activity. Hooks are called synchronously;
a hook that returns a rejected promise is outside the per-module try/catch, so keep
hook bodies synchronous.

### api

| method | purpose |
|---|---|
| `api.injectTurn(sessionId, prompt)` | queue a turn into the session (rides the idle gate) |
| `api.spawnSession({cwd, prompt, mode})` | fresh detached `claude -p`; returns the new session id |
| `api.postToTopic(sessionId, text)` | status line into the session's topic |
| `api.getSessionInfo(sessionId)` | `{ cwd, chatId, threadId, label, mtime }` or null |
| `api.state(name)` | `{ data, save() }` persisted JSON, namespaced per module |
| `api.config` | the gateway config (read-only) |
| `api.log(...)` | namespaced logging |

## spec-kit

Auto-detects any session running a spec-kit flow
(`/specify → /clarify → /plan → /tasks → /analyze → /implement`). After each
non-terminal step settles it injects `/compact`; when `/implement` settles it
spawns a fresh `/code-review` session in the same repo (its own topic appears in
Telegram). Config keys (all optional): `STEP_COMMANDS`, `TERMINAL_COMMAND`,
`SPEC_KIT_SETTLE_SECONDS` (30), `SPEC_KIT_REVIEW_SETTLE_SECONDS` (90).
