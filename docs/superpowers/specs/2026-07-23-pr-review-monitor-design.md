# PR-Review Monitor + readout tool/response separation

**Date:** 2026-07-23
**Status:** designed, not yet implemented

Two related workstreams from one session. Component 1 (PR-Review Monitor) is a new
standalone tool. Component 2 (readout separation) is a small change inside `gateway.js`.
They are independent and can be planned/implemented separately; they share this doc
because they were scoped together.

---

## Component 1 — PR-Review Monitor

### Problem

For each job, a coding bot completes development work, opens a PR, and posts its own
review. Marc always wants a *second, independent* code review run on that PR — but in a
**fresh session**, so the review doesn't inherit (and pay for) the dev session's bloated
context. Today this is manual: notice the PR, open a new session, run the review.

### Goal

Detect a bot-authored PR in a watched repo, automatically launch a fresh headless
`claude` session that runs `/code-review` on that PR's diff, and surface it as its own
Telegram topic Marc can watch and steer from his phone — without spending tokens in the
dev session and without any manual kickoff.

### Core insight (keeps this cheap and small)

The gateway already **auto-creates one Telegram forum topic per active session and
mirrors it live**. So the monitor does not build any Telegram topic-creation or
review-rendering. It only has to: *detect the PR → spawn a fresh `claude` review session
→ dedup.* The gateway independently notices the new session's `.jsonl` and creates +
mirrors the topic. The review appears in Telegram as a natural consequence of a new
session existing.

### Load-bearing assumption (validate FIRST, before building anything else)

**The gateway mirrors a headless session it did not itself spawn, and auto-creates a
topic for it.** The mirror loop watches all `~/.claude/projects/**/*.jsonl` and creates
topics per active session — a monitor-spawned `claude -p --session-id X` writes exactly
such a transcript, so in principle it should be picked up. But the gateway's
"active session" gating (recent-mtime / held-open-desk via `lsof`, excluding its own pid)
may exclude a short-lived headless process that runs and exits.

This is the first implementation task — a ~20-minute spike: spawn a throwaway
`claude -p --session-id <uuid> "say hi"` in a watched repo's worktree and confirm a topic
appears and mirrors it. Everything else depends on the answer:

- **If yes:** design stands as written. Monitor stays fully decoupled from the gateway.
- **If no:** fallback — the monitor creates the forum topic itself via the Bot API
  (`createForumTopic`) and either (a) keeps the review session held-open long enough for
  the gateway's desk-session path to bind it, or (b) posts the review result into that
  topic directly. Slightly less "live steer," still delivers the review to a new topic.

### Architecture — standalone poller, NOT a gateway change

A separate launchd agent (`com.claude.pr-review-monitor`) with its own script, its own
`config.json`, and its own state file. It does **not** modify `gateway.js`. Rationale:
`gateway.js` is the published OSS package (`claude-code-telegram-gateway` on npm) — job-
specific PR-review logic does not belong in it. Poller and gateway communicate only
indirectly (poller spawns a session; gateway mirrors it) plus one optional direct Bot-API
notification (below).

Implementation language: Node (matches the gateway, can reuse its config/token
conventions) — final choice deferred to the plan.

### Detection loop

Runs every ~5 minutes (configurable). For each watched repo:

1. Query the GitHub API for open PRs.
2. Filter to PRs authored by the configured bot account(s) for that target.
3. Compare against dedup state; anything not seen before is enqueued.

**Trigger policy (decided): "D" — review every new bot-authored PR.** No wait for a
label, a self-review event, or a draft→ready transition. First appearance of a
bot-authored open PR fires the review. Occasional early fire on an in-progress PR is
acceptable. (The dev bot "completing its own review" is the human's mental model of when
this fires, not a machine precondition.)

**Dedup:** keyed on `repo + PR number`, first appearance only. Re-review on a new head
SHA (new pushes) is a later flag, **off by default**, so a PR is reviewed once.

### Launching the review (the fresh session)

Per enqueued PR:

1. In the target's local clone, create a **git worktree** checked out to the PR head
   (isolated from the dev session's working tree — never disturb it).
2. Mint a session id and launch headless:
   `claude -p --session-id <uuid> --permission-mode <mode> "/code-review"` with
   **cwd = the worktree**. `/code-review` reviews the working-tree diff against the PR's
   base, i.e. the PR's changes.
3. The gateway sees the new session `.jsonl`, creates a topic, mirrors the review live.
   Marc watches and steers from his phone (gateway's existing reply-to-steer path).
4. Record `repo#PR` in state to prevent re-review.

Worktree lifecycle: created per review, removed after the review session completes
(cleanup on a later poll if the process is gone). Naming keeps concurrent reviews from
colliding.

### Belt-and-suspenders notification

When the monitor launches a review it also posts **one line** to a fixed
"🔍 PR Reviews" topic via the Bot API directly:
`Launching review: EM/<repo>#123 — <PR title>` with the PR URL. This is a reliable
heads-up independent of whether gateway mirroring succeeds, and gives Marc a stable place
to see "a review just started" even if the mirrored topic is delayed.

### Output policy

**Telegram-only. No writes to the GitHub PR.** The review does not post comments,
reviews, or status back to GitHub. Marc remains the sole decider of whether anything gets
pushed to the PR. (Auto-posting to GitHub is explicitly out of scope for v1.)

### Configuration (per target)

Targets: **Cobalt, Alkami, EM.** Each target entry carries:

- `repos` — explicit repo list, or an org to enumerate.
- `botAuthors` — GitHub login(s) whose PRs are reviewable.
- `localClone` — path to the local clone used to build worktrees.
- `token` — its **own** GitHub token, and optional `host` for GitHub Enterprise.

### Prerequisites / operational risk

- **`gh` is not installed on this Mac.** The poller uses the GitHub REST API with a token
  directly (preferred — no `gh` dependency), or `gh` must be installed. Decide in the plan.
- **Auth is the real risk.** Cobalt and Alkami are likely SSO-gated (work orgs, possibly
  Enterprise). Tokens for them may be non-trivial to obtain and scope.

### Rollout

Prove the entire loop end-to-end on **EM first** (plain github.com + a PAT Marc can grab).
Only after EM works — spike validated, one real bot PR reviewed in its own topic — add
Cobalt and Alkami by supplying their tokens/hosts. No code change to add a target, just
config.

### Out of scope (YAGNI, v1)

- Re-review on new pushes (flag exists, default off).
- Posting review results back to the GitHub PR.
- Label / draft-transition triggers (using "D").
- Per-target review-command variation, `/code-review ultra` automation (ultra is
  user-launched and billed; the monitor cannot fire it — at most it could prep the command
  for Marc, deferred).

---

## Component 2 — Readout: separate tool-use from responses

### Problem

In a mirrored topic, tool activity and the assistant's prose response are interleaved in
the same Telegram message, so the reply Marc steers from is a mixed tool-log + text blob.
He wants tool-use and responses visually separated.

### Decision: option "A" — separate messages

Tool-use lines post as their own Telegram message(s); the assistant's prose reply posts as
a distinct message. Two bubbles, clearly divided. The prose response becomes the clean,
last thing in the topic — the natural target for reply-to-steer.

### Where the change lives (two render paths in `gateway.js`)

1. **`renderTranscriptLine` (gateway.js:626)** — the mirror path for stored transcript
   records. It **already returns text blocks and `tool_use` blocks as separate array
   entries.** The separation work here is in the *caller/flush*: post `tool_use` entries
   and text entries as distinct Telegram messages rather than joining them into one blob.
   This is the easy path.

2. **`createFeed` (gateway.js:590)** — the live streamed feed for gateway-driven
   (phone-injected) turns. Here text deltas and `tool_use` share one `body` that streams
   via in-place `editMessageText`. Separating these means maintaining two messages (a tool
   message and a response message) or a clear in-body delimiter. This is the harder path
   and the real work of the component.

`SHOW_TOOL_ACTIVITY` / `SHOW_TOOLS` (gateway.js:72,79) still governs whether tool activity
appears at all; this change is about *layout when it does*, not visibility.

### Constraint

This edits the published OSS package. Keep the change clean and behind existing config
sensibilities; it should degrade gracefully (a single combined message is still valid if
separation can't be produced for a given record). Build it **after** the monitor's
validation spike so the two workstreams don't tangle in the same branch.

### Out of scope (v1)

- Routing tool activity to a separate topic/thread.
- Collapsible/foldable tool sections (that was option B — not chosen).
- Changing what counts as tool activity vs. what's suppressed.
