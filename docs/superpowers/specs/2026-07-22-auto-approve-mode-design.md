# Auto-approve mode: say yes to tool prompts, but only tool prompts

**Date:** 2026-07-22 (revised 2026-07-23 after empirical verification)
**Status:** design confirmed — gateway code needed; the config-only shortcuts don't work on the target machine

## Problem

On a job laptop (the motivating case: the Alkami engagement) the gateway runs under a non-bypass
`PERMISSION_MODE`, so every "ask"-bucket tool call surfaces an Allow/Deny prompt in its Telegram
topic. Driving from the phone means tapping ✅ Allow dozens of times per turn for routine
`Read`/`Edit`/`Bash` calls you were always going to approve. The prompts are noise, not oversight.

The defining constraint, verified this revision: **that machine cannot use bypass, and cannot use
`auto` either.** Both are turned off by the same managed policy. So the fix has to live in the
gateway, not in a config key.

## Why config alone can't do it (verified)

The reason a managed machine "can't enable bypass" is a managed policy that pins `defaultMode`.
Claude Code's own mode logic ties auto-mode availability to the same condition — auto mode is off
when "managed policy sets any `defaultMode` (policy wins over user settings)", and there is an
explicit `permissions.disableAutoMode: "disable"` knob besides. The `setMode` reducer rejects
`bypassPermissions` when `isBypassPermissionsModeAvailable` is false; auto has its own gate.

Empirical check (2026-07-23, CLI 2.1.215): with a settings scope disabling bypass and auto, passing
`--permission-mode auto` was **silently downgraded — the CLI reported `permissionMode: default`.**
So on the target laptop, setting `PERMISSION_MODE` to `bypassPermissions` or `auto` gets you nothing;
policy overrides both. (On an *un*managed machine either works, and `auto` is behaviorally identical
to bypass — but that is not this machine.)

## Design

Keep the CLI in the policy-legal mode it already runs (`manual`, or whatever the policy pins), so it
keeps emitting `can_use_tool` control requests. Change what the gateway *does* with them: instead of
posting Allow/Deny buttons and waiting, auto-resolve `allow` and post a terse audit line.

This is a single branch inside the existing `onPermission` handler (`gateway.js:886`). No new
process, no CLI mode change, nothing for policy to reject — from the CLI's side the permission-prompt
tool is approving a request normally, which is the mechanism the org left open by choosing
manual + prompt-tool in the first place.

### Trigger

A new config flag — `AUTO_APPROVE: true` in `config.json` — gates the branch. `PERMISSION_MODE`
stays whatever the policy permits (do **not** set it to `auto`; that just downgrades). Keeping the
trigger separate from `PERMISSION_MODE` is deliberate: the CLI mode must stay policy-legal, and the
auto-approve decision is the gateway's, not the CLI's.

### Mechanism

`PHONE_APPROVALS` is already true under any non-bypass mode (`gateway.js:115`), so the CLI is
launched with `--permission-prompt-tool stdio --input-format stream-json` and `onPermission` fires
per request. The branch lives entirely inside `onPermission`:

- **Existing (`AUTO_APPROVE` off):** register the approval, post ✅ Allow / ❌ Deny inline buttons,
  wait, resolve on tap or timeout.
- **New (`AUTO_APPROVE` on):** skip the buttons and the timer; immediately resolve
  `{ behavior: 'allow', updatedInput: req.input }` (mirroring the human-approve return exactly) and
  post one audit line.

The `approvals` registry, timeout logic, and callback-query handler are untouched — simply not
exercised when the flag is on, because no buttons are posted.

### Audit line

One line per approval to the session's topic, reusing the `toolName`/`summary` the button prompt
builds today (`gateway.js:436`):

```
✅ auto-allowed: <toolName><: summary if present>
```

No inline keyboard. This visibility is the reason to do it gateway-side rather than wish for bypass:
the gateway *is* the approver here, so it can account for every approval. (Under native bypass/auto
the CLI approves internally and the gateway never learns an approval happened — no audit line is
possible there. On the locked machine that path isn't available anyway.)

## Why this is safe

`deny` rules resolve before the permission-prompt tool is invoked. Resolution is
`deny` → `allow` → `ask`; the CLI only emits `can_use_tool` for tools in the `ask` bucket. A denied
tool is rejected upstream and never reaches `onPermission`, so blanket-allow cannot rubber-stamp it.

Verified — including under the locked policy (below). The settings `deny` list on that machine
(force push, `git reset --hard`, `rm -rf`, `truncate`, DB drops, `~/.aws/`, etc.) stays the real
guardrail. **It lives in that machine's own `~/.claude/settings.json` — a different file from this
Mac's.** Confirm it is populated before enabling auto-approve; it is the entire guardrail.

## Verification

Run 2026-07-23 against Claude Code **2.1.215**, in an isolated sandbox, driving the CLI with the
gateway's flags (`gateway.js:714-768`) and an approver that auto-allows every `can_use_tool`. Denied
command `touch <tripwire>`, control command `mkdir -p <control>`; both ask-bucket Bash calls, each
leaving a disk artifact so "was it blocked" is a filesystem fact.

**Gate 1 — deny short-circuits ahead of the prompt tool** (unmanaged sandbox):

| mode | denied `touch` | control `mkdir` |
|---|---|---|
| `manual` | blocked upstream, no `can_use_tool` | **prompted**, allowed, ran |
| `auto` | blocked upstream, no `can_use_tool` | no prompt, ran |
| `bypassPermissions` | blocked upstream, no `can_use_tool` | no prompt, ran |

**Gate 2 — config can't escape policy** (settings scope disables bypass + auto): requesting
`--permission-mode auto` → CLI reports `permissionMode: default`. Downgraded. Config-only is out.

**Gate 3 — the actual design, under the locked policy** (bypass + auto disabled, CLI in `manual`,
gateway auto-allows):

- denied `touch` → blocked upstream, **no `can_use_tool`**, never ran
- control `mkdir` → **`can_use_tool` fired**, gateway auto-allowed, ran

**PASS.** The gateway-side auto-allow works where config cannot, and `deny` is still enforced. This
is the load-bearing result: it is the only approach that survives the target machine's policy.

A regression test for gates 1 and 3 lives at `test/permission-mode-auto.integration.test.js`,
opt-in via `RUN_CLI_CONTRACT=1` (spawns real CLI turns). Re-run after a Claude Code upgrade — the
whole design rests on CLI behavior no gateway unit test covers.

### Two traps worth remembering

1. **Colons break Bash deny patterns.** `Bash(echo tripwire:*)` never matched `echo tripwire:BLOCKED`
   — the colon breaks the prefix parse, which reads as "deny didn't fire" when the rule just wasn't
   matching. Use a tripwire with a filesystem side effect, not an `echo`.
2. **A harness driving `--input-format stream-json` must write the opening user message to stdin**
   (`gateway.js:766-768`), or the child hangs forever with no output and no error.

### Not verified

The live gateway end-to-end over Telegram, and the target laptop against its own managed policy and
settings. All runs were an isolated sandbox on the personal Mac (which has no such policy); the locked
policy was *simulated* via a `--settings` scope, not the machine's real managed-settings file.

## Rollout

1. On the target laptop, confirm the deny list in its `~/.claude/settings.json` is populated — it is
   the only guardrail once auto-approve is on.
2. Ship the `AUTO_APPROVE` branch (this repo), then set `AUTO_APPROVE: true` in that install's
   `config.json` (at `$CLAUDE_GATEWAY_DIR`, default `~/.claude-gateway/`). Leave `PERMISSION_MODE`
   at whatever the policy permits — do not set it to `auto`.
3. Restart the standard way for that install — `touch <install-dir>/restart.flag`. Never
   `launchctl kickstart -k` from inside a gateway-driven session; it self-kills.
4. Drive one turn from the phone: a routine `Read` should run with an `✅ auto-allowed:` line and no
   button, and a denylisted command should still be refused.

Step 4 is the real acceptance test; the sandbox runs prove the CLI contract, not that install's
policy, settings, and launchd wiring.
