# Auto-approve mode: say yes to tool prompts, but only tool prompts

**Date:** 2026-07-22
**Status:** designed, not yet implemented

## Problem

On a job laptop (the motivating case: the Alkami engagement) the gateway runs under a non-bypass
`PERMISSION_MODE`, so every "ask"-bucket tool call surfaces an Allow/Deny prompt in its Telegram
topic. When you're driving a session from your phone, that means tapping ✅ Allow dozens of times
per turn for routine `Read`/`Edit`/`Bash` calls you were always going to approve. The prompts are
noise, not oversight.

The want: a mode where the gateway auto-answers **tool-permission prompts** with "allow" — and
*only* those. Everything else the topic emits (Claude's questions, plan-approval, steering) still
reaches you untouched.

## Goal

Blanket auto-allow of tool-permission prompts on a specific install, on/off by a single env var,
with a terse audit line per approval so a runaway session is still visible.

## Non-goals (YAGNI)

- Per-topic arming (`/autoyes` toggle), allowlist/denylist parsing inside the bot, a separate
  watcher process, runtime toggling. Blanket env-var on/off only.
- Rewriting tool input on approval — the input is passed through unchanged.

## Why blanket-allow is safe

Load-bearing assumption: **settings.json `deny` rules are resolved before the permission-prompt
tool is invoked.** In Claude Code, permission resolution is `deny` → `allow` → `ask`; the CLI only
emits a `can_use_tool` control request for tools that land in the `ask` bucket. A tool matching a
`deny` rule is rejected upstream and never reaches the gateway's approval handler.

So the gateway's denylist (force push, `git reset --hard`, `rm -rf`, `truncate`, DB drops, `~/.aws/`,
etc., configured in settings) stays the real guardrail. The auto-approver only ever sees `ask`-bucket
tools, so "always allow" cannot rubber-stamp a denylisted command — there is nothing dangerous in
the set of prompts it sees.

**This assumption must be verified empirically, not trusted from a reading of the flow** — see
Verification below. If it turned out that `deny` rules did *not* short-circuit ahead of the
prompt tool, blanket-allow would be unsafe and the design would need an in-bot denylist check.

## Design

Single mode branch inside the existing approval path — no new process, no Telegram callback plumbing.

### Trigger

Activate via `PERMISSION_MODE=auto` (the value is already reserved in the enum comment at
`gateway.js:69` and currently unimplemented). Anything else — including the default
`bypassPermissions` — is unaffected. This keeps auto-approve blanket-on for the one install that
sets it and inert everywhere else.

### Mechanism

`PHONE_APPROVALS = PERM_MODE !== 'bypassPermissions'` (gateway.js:115). Under `auto`, `PHONE_APPROVALS`
is `true`, so the CLI is still launched with `--permission-prompt-tool stdio` and still emits
`can_use_tool` control requests — the `onPermission` handler (gateway.js:886) still fires. The branch
lives entirely inside `onPermission`:

- **Existing behavior (`manual`/`acceptEdits`/…):** register the approval, post ✅ Allow / ❌ Deny
  inline buttons to the topic, wait, resolve on tap or timeout.
- **New behavior (`auto`):** skip the buttons and the timer. Immediately resolve
  `{ behavior: 'allow', updatedInput: req.input }` (mirroring the human-approve return exactly), and
  post one terse audit line to the topic instead.

The `approvals` registry, timeout logic, and callback-query handler (gateway.js:1349–1361) are
untouched — they simply aren't exercised in `auto` mode because no buttons are posted.

### Audit line

One line per approval, posted to the session's topic:

```
✅ auto-allowed: <toolName><: summary if present>
```

Reusing the same `toolName`/`summary` the button prompt builds today (gateway.js:436). No inline
keyboard. Terse, to respect the install's token budget. Denylisted tools auto-denied upstream still
surface however they do today (they never reach `onPermission`, so this mode doesn't change them).

## Verification

1. **Deny-precedence check (gates the whole safety argument).** With `PERMISSION_MODE=auto`, add a
   throwaway `deny` rule for a harmless, observable command (e.g. `Bash(echo tripwire:*)`). Drive a
   turn that calls it. Confirm it is **denied** and that `onPermission` is **never entered** for it
   (log a marker at the top of `onPermission`). If it reaches `onPermission`, stop — the safety model
   is wrong and needs an in-bot denylist.
2. **Happy path.** An `ask`-bucket tool (`Read`, `Edit`, benign `Bash`) auto-resolves allow with no
   buttons, and the `✅ auto-allowed:` line appears in the topic.
3. **Isolation.** With `PERMISSION_MODE` unset/`bypassPermissions`, behavior is identical to today
   (no prompts at all); with `manual`, buttons still appear and still work. `auto` changes nothing
   for other installs.
4. **Input passthrough.** Confirm `updatedInput` equals `req.input` (no mutation).

## Rollout

- Design doc committed locally only. No push, no version bump, no `git tag` publish — those are
  separate explicit steps.
- Ship path when approved: implement on this branch, `npm test`, deploy the standard way
  (`touch ~/telegram_gateway/restart.flag` — never `launchctl kickstart -k` from inside a
  gateway-driven session), then set `PERMISSION_MODE=auto` in the Alkami install's env.
