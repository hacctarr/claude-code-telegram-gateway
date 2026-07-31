# Desk catch-up: pull phone-branch turns back into an open desk session

**Date:** 2026-07-30
**Status:** approved, not yet implemented

## Problem

When a desk session is held open and the user replies from the phone, the gateway forks: the phone
turn runs under a pre-minted fork id, the Telegram topic rebinds to the fork, and the original desk
session is marked superseded (`driveTurn`, gateway.js). The open desk session (a Claude Code CLI
terminal or a Claude Desktop Code window) never sees those turns. Returning to the desk means
working from stale context, and the existing recovery (`resume.json` marker + zshrc `cr` hook) only
helps a *new* shell; an already-open session has no way to catch up.

## Requirements

- A user-invoked command, working identically in Claude Code CLI and Claude Desktop Code, that
  pulls the phone-branch turns into the open desk session.
- Semantics: **catch up + rebind.** After the command, the desk session has the phone turns in
  context, the Telegram topic follows the desk session again, and the fork is superseded. One live
  branch. (Decided over "catch up only" and "adopt the fork".)
- Digest form: **full turns, verbatim.** Every phone user prompt and final assistant reply verbatim;
  tool calls collapsed to one-line traces. (Decided over model-summary and capped-verbatim.)
- Phase 2: a lightweight warning in the desk session when a phone branch is ahead, so the user
  knows to run the command.

## Facts the design rests on (verified 2026-07-30)

- Both harnesses expose `CLAUDE_CODE_SESSION_ID` in the Bash tool environment and write transcripts
  to `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl` (verified from a live Claude Desktop
  session, `CLAUDE_CODE_ENTRYPOINT=claude-desktop`).
- Forks run `claude -p --resume <deskSid> --fork-session --session-id <forkId>` (gateway.js
  `runClaudeTurn`), so a fork's jsonl carries the full copied history: the new phone turns are
  exactly the entries whose uuids are absent from the desk transcript.
- The daemon holds `links.json` / `superseded.json` in memory and persists over external edits, so
  the rebind must be executed by the daemon. Precedent for file-signal control: `restart.flag`.
- `pollTick` re-topics a superseded desk session as soon as its transcript grows
  (`st.size > supersededAt[id]`). Ingesting the digest grows the desk transcript, so without
  ordering guarantees the daemon would give the desk a *new* topic instead of rebinding the
  existing one.
- UserPromptSubmit and SessionStart hooks run in both harnesses and receive `session_id` on stdin;
  plain stdout becomes injected context.

## Approaches considered

| | approach | verdict |
|---|---|---|
| A | Gateway script emits digest + file-signal rebind consumed by the daemon | **Chosen.** Only the daemon can mutate its state safely; script works in both harnesses. |
| B | Pure command edits `links.json` directly | Rejected: daemon persists over the edit; rebind silently reverts; no topic-side note. |
| C | Automatic digest injection via hook, no command | Rejected as mechanism: fires mid-thought, injects unbounded content unasked. Kept as a phase-2 *warning* only. |

## Design

Three pieces: `catchup.js` (read-only digest + request marker), a daemon consumption path (the
rebind), and a thin `/catchup` slash command. Phase 2 adds `catchup-warn.js` as a hook.

### catchup.js (new, repo root, sibling of resume-hook.js)

1. `sid = process.env.CLAUDE_CODE_SESSION_ID`; exit with a clear message if absent.
2. Locate the desk transcript by glob `~/.claude/projects/*/<sid>.jsonl`.
3. Find the **linked descendant leaf**: among sessions in `links.json` whose transcript lives in
   the same project dir, a candidate is a descendant iff its uuid set intersects the desk file's
   uuids and contains uuids the desk file lacks. Fork-of-fork chains resolve automatically because
   the gateway moves the link to each new fork, so there is exactly one *linked* descendant. Going
   forward the gateway also records `forkedFrom: <parentSid>` on the link at fork time; the
   uuid-overlap test remains as the fallback for pre-existing state.
4. No linked descendant, or `sid` not in `superseded.json`: print "nothing pending" and exit 0
   without writing a marker.
5. Build the digest from fork entries whose uuid is absent from the desk file: user text turns and
   assistant text verbatim; `tool_use`/`tool_result` as one-line traces (name + summarized input);
   meta lines and command envelopes excluded (reuse the mirror's classification logic).
6. **Order: compute digest, print (stdout flushed), write marker, exit.** The desk jsonl only
   grows after the Bash tool returns, so even a marker written last reaches disk before the
   transcript grows, which keeps the daemon's re-topic path from firing first. Marker last is
   terminal-state discipline: the rebind trigger only exists once the digest has fully left the
   process, so there is no state where the daemon rebinds a desk session that never ingested.
7. Marker: `~/.claude-gateway/catchup.json` holding
   `{ "<deskSid>": { forkId, forkSize, repoDir, ts, shownUuids, declined? } }`,
   merge-written like `resume.json` so concurrent catchups in different repos don't clobber.
   `forkSize` is the byte length of the content actually digested, taken from the single read
   rather than a separate `stat`: a phone turn landing between a stat and the read would record a
   size smaller than the digest covered, and the daemon would then decline a rebind that was in
   fact complete. `shownUuids` is what a declined entry carries into the retry (see below).

A phone session started fresh (`/new`) is not a descendant and is out of scope: catch-up targets
branches forked from the invoking session.

### Daemon consumption (gateway.js)

At the top of `pollTick`, before the file loop, consume `catchup.json` entries:

- Guard: `sizeCurrent(forkId) > forkSize` means the phone landed another turn after the digest was
  cut. Decline: post to the topic "📱 a phone turn landed after catch-up, run /catchup again", and
  mark the entry `declined` rather than dropping it. The already-ingested digest remains valid, and
  the retained `shownUuids` are what makes "the re-run picks up the remainder" true: the desk
  transcript records the first digest only as prose under a fresh uuid, so a re-run diffing on the
  desk file alone would re-print every turn the user just read. A declined entry is not a pending
  request: it neither re-triggers a rebind nor blocks the re-topic guard.
- Rebind (mirror of the fork block in `driveTurn`, inverted):
  - `delete supersededAt[deskSid]`; `supersededAt[forkId] = sizeCurrent(forkId)`; persist.
  - `delete linkBySession[forkId]`; `upsertLink(deskSid, chatId, threadId, label)` reusing the
    fork's link fields so the topic keeps its identity; `link.offset = sizeCurrent(deskSid)` so
    the ingested digest is not re-mirrored to Telegram; persist.
  - Queued replies follow back: `queues.get(forkId)` moves to `deskSid`.
  - `writeResumeMarker(repoDir, deskSid)`, so `cr` in a later shell resumes the desk branch, not
    the stale fork.
  - Topic note: "🖥️ desk caught up. This topic follows the desk session again."
- Belt-and-suspenders: the file-loop supersede check skips re-topic for any sid with a pending
  catchup entry, covering a tick that lands between marker write and consumption.

The fork file stays on disk, superseded at its final size. If anything ever writes to it again it
re-topics on its own: existing behavior, correct here too.

### /catchup command (new: commands/catchup.md, installed to ~/.claude/commands/)

Markdown command, no `!` preamble (CLI-only feature): it instructs Claude to run
`node <gatewayDir>/catchup.js` via Bash, ingest the printed digest, and reply with a one-paragraph
recap of what happened on the phone. On "nothing pending" it says so and stops. `setup.js` installs
it alongside the shell hook it already manages; the install resolves `<gatewayDir>` at write time
(global npm install vs. checkout).

### Phase 2: catchup-warn.js (hook)

- Registered for UserPromptSubmit and SessionStart in `~/.claude/settings.json` (installed
  opt-in by `setup.js`).
- Reads hook JSON on stdin for `session_id`. Fast path: `session_id` not a key in
  `superseded.json` means exit silently. Two small JSON reads + a stat; well under the latency a
  per-prompt hook can afford.
- When behind: parse only the fork region past `supersededAt[sid]` to count phone user turns, and
  print one line: "📱 Phone branch is N turns ahead. Run /catchup to pull them in." Fires on
  every prompt while behind, by design; it self-clears because the rebind removes `sid` from
  `superseded.json`.

## Error handling

- `catchup.js` crash at any point before the marker write leaves gateway state unchanged: the
  digest may have partially printed (partial output still reaches the desk context), and a re-run
  of `/catchup` starts over cleanly. Because the marker is written only after the digest has fully
  flushed, there is no state where the daemon rebinds a desk session that never ingested.
- Daemon consumption never throws into `pollTick` (same discipline as `renameTopicFromContent`).
- Legacy links without `forkedFrom` resolve via uuid overlap.
- Marker entries older than 10 minutes are dropped on read (stale request from a killed session).

## Configuration

No new config keys. The warn hook is opt-in at install time (`setup.js` prompt), not a runtime
flag.

## Testing

node:test, alongside the existing suite:

- uuid-diff extraction: new-turn selection, meta/command exclusion, tool one-liner rendering.
- Descendant resolution: direct fork, fork-of-fork chain, `forkedFrom` fast path, uuid fallback,
  no-descendant and not-superseded cases.
- Marker semantics: merge-write, stale-entry drop, write ordering (digest before marker),
  `forkSize` derived from the digested bytes under a fork that grows mid-read.
- Decline recovery: a re-run after a decline shows only the remainder, and prints "nothing
  pending" when the retained `shownUuids` already cover the fork.
- Daemon consumption: atomic rebind state (superseded both directions, link fields carried,
  offset jump, queue handoff, resume marker), decline-on-growth, decline retains the entry,
  a declined entry reads as not-pending, skip-re-topic-with-pending-entry.
- Warn hook: silent fast path, turn count over the fork region, self-clear after rebind.

Fixtures mirror real transcript shape: multiple project dirs, a desk file plus a fork carrying
copied history, uuids overlapping exactly as `--fork-session` produces them.

## Known limitations

- If the desk session's context has been compacted, the ingested digest lands in the live context
  but the desk transcript diverges textually from the fork history; acceptable, since the desk
  file is the canonical branch going forward.
- A phone `/new` session is invisible to catch-up by design.
- The digest is unbounded (verbatim by decision). A pathological phone marathon lands whole; the
  capped variant was considered and declined.
