# Pluggable gateway modules + spec-kit workflow module

**Date:** 2026-07-23
**Status:** designed, not yet implemented

Two deliverables in one spec, built together because the second is the first's proving case:

1. **A module system** — the gateway core gains a small, generic extension surface so
   behavior can be added without touching the published npm package.
2. **The spec-kit module** — the first plugin. It watches a session drive a spec-kit
   workflow, compacts the session after each step, and launches a fresh review session when
   implementation completes.

They ship together but are separable: the module system is in-package and generic; the
spec-kit module is an external file that never lands in the OSS package.

---

## Motivation

Running a spec-driven flow (spec-kit's `/specify → /clarify → /plan → /tasks → /implement`,
or any equivalent) from the phone accumulates context across steps, and the final review
is manual. Marc wants two things to happen automatically: **compact between steps** to keep
context lean, and **a fresh, independent review when implementation finishes** — in its own
session so the review doesn't inherit the dev session's bloated context (the same principle
behind the PR-review monitor spec, `2026-07-23-pr-review-monitor-design.md`).

Rather than bolt this onto `gateway.js`, the gateway becomes **pluggable**, so this and
future automations (the PR-review monitor being the obvious next one) are modules against a
stable interface — and job/personal-specific logic stays out of the published package
(`claude-code-telegram-gateway` on npm).

## Decisions locked in brainstorming

- **Detection:** slash-command boundaries — watch the transcript for a spec-kit command
  whose response has settled. (Not artifact-file or sentinel detection; those are out.)
- **Module boundary:** external, config-loaded files against a stable hook API. The OSS
  core stays generic.
- **Module capabilities:** inject a turn into the watched session, spawn a fresh headless
  session, and post to a Telegram topic.
- **No auto-advance:** Marc drives the steps; the module only compacts and reviews.
- **Watch scope:** auto-detect any session the moment a spec-kit command appears. Zero
  config, any repo.
- **Review action:** a fresh headless session running `/code-review`, not an inline
  injection.

---

## Component 1 — The module system

### Where modules live

Modules are **external files**, never in the published package. `config.json` lists them:

```json
"MODULES": ["~/.claude-gateway/modules/spec-kit.js"]
```

Paths resolve against `$CLAUDE_GATEWAY_DIR` (default `~/.claude-gateway/`) or may be
absolute. Absent or empty `MODULES` → the whole system is a no-op and existing installs
behave exactly as before. That no-op property is the OSS-safety guarantee.

### The module contract

A module is a **factory** that receives the curated `api` and returns a hooks object:

```js
module.exports = (api) => ({
  name: 'spec-kit',
  onTranscriptLine(ctx, record) { /* each new transcript record, per session */ },
  onTick(now)                   { /* once per poll tick — settle-window timers */ },
});
```

Every hook is optional. `ctx = { sessionId, cwd, chatId, threadId }`.

v1 ships two hooks (`onTranscriptLine`, `onTick`). A third, `onTelegramUpdate(update)`, is a
natural extension for modules that react to inbound Telegram messages, but nothing in v1 uses
it, so it is deferred — adding it later is an isolated dispatch-point change, not a contract
break.

### The api (the only surface modules touch)

Thin wrappers over existing gateway functions, so modules never reach into internals:

| api method | wraps (gateway.js) | purpose |
|---|---|---|
| `api.injectTurn(sessionId, prompt)` | `queueForSession` (1008) | inject a turn; rides the existing idle gate (pollTick 1363-1371) |
| `api.spawnSession({cwd, prompt, mode})` | **new** detached-spawn helper | fresh `claude -p` session; returns the minted session id |
| `api.postToTopic(sessionId, text)` | `sendPlain` (384) + link lookup | status/audit line into the session's topic |
| `api.getSessionInfo(sessionId)` | `linkBySession` / `readSessionInfo` (291) | cwd, threadId, label |
| `api.state` | namespaced JSON at `statePath('module-<name>')` (47) | per-module persistence |
| `api.log(...)` | `console` | namespaced logging |

`spawnSession` is the one genuinely new primitive: a **detached** `claude -p --session-id
<uuid> --permission-mode <mode> "<prompt>"` with a given cwd. The existing `runClaudeTurn`
(746) is built for live-streamed *driven* turns with a `LiveMessage` and permission plumbing
— the wrong fit for fire-and-forget. `spawnSession` mints a uuid, spawns, returns the id, and
does not wait; the gateway's normal poll loop then discovers the new `.jsonl`, creates a
topic, and mirrors it.

### Core changes to gateway.js (bounded, generic)

1. **Registry (~30 lines):** `loadModules()` reads `config.MODULES`, `require()`s each,
   invokes the factory with `api`, stores `{ name, hooks }`. An `emit(hookName, ...args)`
   helper iterates modules and calls the hook if present.
2. **Isolation:** each `emit` call is wrapped in try/catch **per module** — a throwing hook
   is logged and skipped, never crashing `pollTick` or affecting other modules/installs.
3. **api object:** the wrappers above, plus the new `spawnSession` helper.
4. **Two dispatch points in `pollTick`:**
   - after `readNewLines` (1309), for each parsed record: `emit('transcriptLine', ctx, o)`.
   - once near the end of the tick: `emit('tick', now)`.
   A third, `emit('telegramUpdate', update)` inside `pollUpdates`, is deferred — not built in
   v1 (no module uses it); it slots in as an isolated change when a Telegram-reactive module
   arrives.
5. **Startup:** call `loadModules()` in `main()` after `loadLinks()` (1594).
6. **State cleanup:** when the existing session-drop cleanup runs (1351-1361), signal modules
   (or let them lazily expire `api.state` entries) so per-session state doesn't grow
   unbounded.

### Why in-process (rejected alternatives)

- **Raw EventEmitter exposed to modules:** leaks internals; the curated api is the point.
- **Separate launchd processes + shared lib** (the PR-monitor's original shape): strong
  isolation but needs a second file-watcher and IPC to observe the transcript stream and to
  reuse idle-gated injection. In-process modules get both for free.

The trade-off accepted: an in-process module *can* misbehave, so per-call try/catch isolation
is load-bearing, not optional.

---

## Component 2 — The spec-kit module (external file)

### Per-session state (`api.state`, keyed by sessionId)

```
{ armedStep: '/plan'|null, armedAt: <ms>, firedSteps: ['/specify', ...], reviewFired: false }
```

### Detection (`onTranscriptLine`)

Slash commands appear as a `type:'user'` record whose content string contains
`<command-name>/X</command-name>` (verified against real transcripts —
`renderTranscriptLine` already filters these `<...>` records out of the mirror at
gateway.js:657, so the raw content is where the command name lives).

- Extract `/X` via regex from user records.
- If `/X` ∈ `STEP_COMMANDS` (default `/specify /clarify /plan /tasks /analyze /implement`,
  configurable) → set `armedStep = /X`, `armedAt = now`. This auto-arms any session in any
  repo the instant a spec-kit command appears.

### Reaction (settle-driven, in `onTick`)

A step is **complete** when the session has been idle for a settle window since activity
following the armed command — tracked against the session file's mtime (the same idle notion
`isDeskBusy` uses, gateway.js:346). Two thresholds:

- `SETTLE_MS` (default ~30s) for compaction steps.
- `REVIEW_SETTLE_MS` (default ~90s) for the terminal step — longer, because a false
  "complete" there spawns a review.

On completion:

- **Non-terminal step** (`/specify`…`/tasks`, i.e. not the terminal command): call
  `api.injectTurn(sessionId, '/compact')` and `api.postToTopic(sessionId,
  "✅ spec-kit: <step> done → compacting")`. Push the step into `firedSteps` (fire once).
- **Terminal step** (`/implement`, configurable via `TERMINAL_COMMAND`): call
  `api.spawnSession({ cwd, prompt: '/code-review', mode })` in the dev repo's cwd, and
  `api.postToTopic(sessionId, "🔍 implementation complete → launching review")`. Set
  `reviewFired`. The gateway auto-creates and mirrors the review's topic — Marc watches and
  steers the review from his phone (the PR-monitor payoff, reused).

### Loop safety

`firedSteps` dedups per step. The injected `/compact` and the review's `/code-review` are
**not** in `STEP_COMMANDS`, so a reaction can never arm another step. The review runs in a
different session id, so its transcript can't re-arm the dev session.

---

## Reliability & risks

- **False "implement complete" (main risk).** Settle can fire during a long pause in
  `/implement`. Mitigations: (a) longer `REVIEW_SETTLE_MS`; (b) **low blast radius** — the
  review is a separate fresh session, reads only, never posts to GitHub, so a premature
  review is cheap and visible (the same tolerance the PR-monitor spec accepted); (c) Marc
  ignores or kills an early review topic. No confirmation gate in v1.
- **Premature `/compact`.** Same settle mechanism; worst case compaction runs a beat early.
  `/compact` is safe anytime and the audit line makes it visible. Acceptable.
- **Module crash.** Per-call try/catch: a bug in `spec-kit.js` logs and is skipped; the
  mirror loop and every other install are unaffected.
- **State growth.** Prune `api.state` entries when the gateway drops a session link
  (1351-1361), or lazily expire.

## Testing

- **Core (in-package):** register a fake module against a synthetic transcript; assert
  `transcriptLine`/`tick` fire with correct `ctx`; assert a throwing hook does not break
  `pollTick`; assert empty `MODULES` is a pure no-op.
- **spec-kit module (isolated, api mocked):** feed `<command-name>` records + simulated idle
  ticks; assert `/compact` injection on non-terminal steps, review spawn on the terminal
  step, per-step dedup, and that `/compact` / `/code-review` never re-arm. The module only
  touches the injected `api`, so this needs no real gateway, CLI, or Telegram.
- **Manual/integration:** one real spec-kit run driven from the phone — each step compacts,
  `/implement` opens a review topic. As with auto-approve, the live run is the true
  acceptance test; unit tests cover the contract, not the wiring.

## Scope / YAGNI

**In:** the module system (registry + api + dispatch points), and the spec-kit module.

**Out:**
- Auto-advancing steps (Marc drives them).
- Migrating the PR-review monitor into a module — the system is *designed* so it becomes a
  natural second module (needs only `onTick` + `spawnSession` + `postToTopic`), but it is not
  built here.
- Worktree isolation for the review — same-cwd is fine (implementation is done, session
  idle). Noted as possible hardening.
- Artifact-file and sentinel-marker detection (slash-command boundaries only).
- Re-review on new pushes; posting anything back to GitHub; a confirmation gate before
  review.

## Rollout

1. Ship the module system + `spawnSession` (this repo, generic core change), with the fake-
   module core tests.
2. Drop `spec-kit.js` into `~/.claude-gateway/modules/`, add it to `MODULES` in that install's
   `config.json`.
3. Restart the standard way — `touch <install-dir>/restart.flag`. Never `launchctl kickstart
   -k` from inside a gateway-driven session; it self-kills.
4. Drive one real spec-kit flow from the phone and confirm compaction between steps and a
   review topic after `/implement`.
