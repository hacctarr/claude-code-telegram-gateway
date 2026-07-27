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
| `api.getContextTokens(sessionId)` | how full that session's context is, in tokens (0 if unknown) |
| `api.state(name)` | `{ data, save() }` persisted JSON, namespaced per module |
| `api.config` | the gateway config (read-only) |
| `api.telemetry` | `count/gauge/record/registerObservable` onto the gateway's OTLP stream |
| `api.log(...)` | namespaced logging |

`api.telemetry` records metrics; it cannot start, stop, or flush the exporter, since the
endpoint and credentials are the gateway's to own. Metrics are exported only when the `otlp`
block in the config is enabled, so recording from a module is safe either way. Prefix your
metric names to keep them distinguishable from the gateway's own `gateway.*` series. Use
`registerObservable(name, fn)` for a value you would rather sample at export time than push;
a throwing `fn` is isolated and reports null for that cycle.

## spec-kit

Auto-detects any session running a spec-kit flow
(`/specify → /clarify → /plan → /tasks → /analyze → /implement`). After each
non-terminal step settles it injects `/compact`; when `/implement` settles it
spawns a fresh `/code-review` session in the same repo (its own topic appears in
Telegram). Config keys (all optional): `STEP_COMMANDS`, `TERMINAL_COMMAND`,
`SPEC_KIT_SETTLE_SECONDS` (30), `SPEC_KIT_REVIEW_SETTLE_SECONDS` (90).

## auto-compact

Compacts a topic once you have stopped working it. Every session the gateway sees
is watched; when one has been idle past `AUTO_COMPACT_IDLE_MINUTES` **and** its
context is at least `AUTO_COMPACT_MIN_TOKENS`, the module injects `/compact` with
your summarization instructions and posts the size to the topic.

The gateway is the only component that can do this. No hook can initiate a
compaction (`PreCompact` only fires around one already underway), but `/compact`
is dispatchable non-interactively, and to Claude Code the gateway is the user.

| key | default | meaning |
|---|---|---|
| `AUTO_COMPACT_IDLE_MINUTES` | 45 | how long a topic must be quiet before it counts as closed |
| `AUTO_COMPACT_MIN_TOKENS` | 120000 | floor below which a compaction isn't worth the call |
| `AUTO_COMPACT_INSTRUCTIONS` | decisions, rationale, open questions, identifiers | passed to `/compact` |
| `AUTO_COMPACT_PRELUDE` | none | a turn injected first, e.g. `/remember` to persist before the discard |

Set `AUTO_COMPACT_PRELUDE` if you run a memory plugin whose capture must land
before context is dropped. The prelude rides its own turn, and the queue drains one
prompt per tick, so it always completes ahead of the compaction.

The idle window is the setting to get right: a quiet desk session is not
necessarily an abandoned one, and a compaction is a real summarization call.
