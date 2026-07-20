# Topic naming: cost containment and staying current

**Date:** 2026-07-20
**Status:** implemented in v1.0.2–v1.0.5

> **Process note.** This spec was written *after* implementation. The design was explored and
> approved conversationally, but the brainstorming flow's write-spec → review → plan steps were
> skipped and the work went straight to code. Recording it here so the reasoning is durable rather
> than living only in a session transcript. The sequencing was wrong; the content below is what was
> actually agreed and built.

## Problem

Telegram topics are named once, at creation, from the session's first user message. Two failures
came out of that.

**1. Cost.** `TITLE_MODE` defaulted to `generated`, which spawns a real Claude turn per topic
*creation attempt*. That spawn inherited the user's entire MCP surface, skills index, settings and
CLAUDE.md — 63,720 tokens measured on a live install, to produce a three-word slug. Worse, the
titling call was evaluated as an argument to `createForumTopic`, so it ran *before* the API result
was known; a rate-limited creation retried on the next 2s poll tick with no backoff. Worst case
~1.9M tokens/minute, driven entirely by desk activity with no phone involvement.

**2. Quality.** Even working correctly, naming from the opening message produces topics called
`ping`, `re-you-sure-it`, `oh-but-wait-i`. The name describes how the session started, not what it
became.

## Constraints

- **Cost is the binding constraint.** Any per-session model call must be bounded and predictable.
- **Telegram rate-limits topic operations.** 429s carry `retry after N`; ignoring it caused the
  original storm.
- **Transcripts are large.** Sessions reach 26MB. Anything on the 2s poll tick must not be O(file).
- **Names are identifiers.** They appear in a topic list the user scans. Churn destroys
  recognisability, so stability has value independent of accuracy.
- **Byte counts are not a substance signal.** Measured on real sessions, KB-per-user-message ranges
  69→226. A "+150KB" threshold fires after one message in some sessions and three in others,
  because it measures tool output volume, not conversation.

## Approaches considered

For *when* to refresh a name:

| | approach | verdict |
|---|---|---|
| A | Regenerate on substantial new work (repeating, threshold-triggered) | Rejected as default: unbounded on long sessions (one had 35 user turns), and churns names. |
| B | Regenerate once, after the session settles | **Chosen.** Bounded at one extra call per session; fixes the observed defect. |
| C | Manual only (`/rename`) | Adopted *alongside* B as the escape hatch, not instead of it. |
| D | Periodic while active | Rejected: pays for idle drift; ~1.8M tokens/day at 12 active sessions. |

B and C compose: B handles the common case automatically and cheaply, C covers the genuine mid-
session pivot where the user is the better judge.

For *how* to detect "settled":

- **Total user messages ever** — faithful to the intent, but requires re-reading each transcript to
  count, O(file) every tick.
- **User messages observed after the topic appeared** — counted on lines the mirror loop already
  parses, so O(new bytes). **Chosen.**

These differ only for sessions that already existed when their topic was created; there, the cheap
rule names by current subject, which is arguably the better answer anyway. For the new sessions
that motivated the work, they are identical.

## Design

**Cost containment (v1.0.2)**

- `titleArgs()` builds the titling argv with full isolation: `--strict-mcp-config`, empty
  `--mcp-config`, `--allowedTools ""`, `--max-turns 1`,
  `--exclude-dynamic-system-prompt-sections`, `--disable-slash-commands`, `--setting-sources ""`.
  Measured 63,720 → 25,269 tokens. The remainder is Claude Code's own base prompt and is not
  strippable from the CLI.
- `TITLE_MODE` defaults to `first-message` (free, local `slugify`). `generated` is opt-in, because
  25K for three words should be a deliberate choice.
- `createTopicCooldown()` gives per-session exponential backoff (30s base, 15min ceiling), never
  shorter than Telegram's `retry_after`, parsed by `parseRetryAfter()`. `createForumTopic` returns
  `{threadId, retryAfterMs}` instead of swallowing the reason.
- Generated slugs are cached per session so a retry never pays twice.

**Settle-then-rename (v1.0.5)**

- `countUserTurns(lines)` counts real desk prompts in an already-parsed batch — skipping `isMeta`,
  command envelopes (`<...>`), tool results and whitespace-only content.
- The mirror loop accumulates into `link.userTurns`.
- `dueForRename(link, threshold)` is true exactly once: at or past `RENAME_AFTER_TURNS` (default 3)
  and not yet `renamed`.
- `renameTopicFromContent()` clears the title cache, regenerates, and applies via `editForumTopic`.

**`/rename [name]`** — with an argument, used verbatim; bare, regenerates from current content.
Works regardless of `TITLE_MODE` in its explicit form.

## Data flow

```
poll tick (2s)
  └─ mirror: readNewLines(file, link.offset)
       ├─ render + post
       ├─ link.userTurns += countUserTurns(lines)
       └─ dueForRename(link)?
            ├─ link.renamed = true; persistLinks()      ← set BEFORE the API call
            └─ renameTopicFromContent() → editForumTopic
```

## Error handling

- `link.renamed` is persisted *before* the rename API call. A failed rename is not retried, by
  design — the original bug was precisely a failure path that retried every tick with a model call
  attached. A missed rename is cosmetic; a retry loop is expensive.
- Topic-creation failures back off per session and are logged with the remaining cooldown.
- `renameTopicFromContent` returns `null` on any failure and never throws into the poll loop.
- Links written by older versions have no `userTurns` / `renamed`; `dueForRename` treats absent as
  zero/false.

## Configuration

| key | default | meaning |
|---|---|---|
| `TITLE_MODE` | `first-message` | `first-message` \| `session-name` \| `generated` |
| `RENAME_AFTER_TURNS` | `3` | desk prompts before the one-time rename; `0` disables |
| `TOPIC_RETRY_BASE_MS` | `30000` | backoff base after a failed topic creation |
| `TOPIC_RETRY_MAX_MS` | `900000` | backoff ceiling |

## Testing

Unit tests cover `titleArgs` isolation flags, cooldown backoff/ceiling/`retry_after`/clear,
`parseRetryAfter`, `countUserTurns` (meta, command, tool-result and whitespace exclusion), and
`dueForRename` (threshold, once-only, disabled, legacy links). 74 tests total.

`countUserTurns` was additionally validated against real transcripts, matching an independent scan
exactly on three stable sessions (35, 5, 1 user turns).

## Known limitations

- A session that pivots after its automatic rename keeps a stale name until `/rename`. Accepted:
  that is what `/rename` is for.
- The rename fires 3 prompts after the *topic* appears, not the 3rd message of the session. See
  the tradeoff above.
- `generated` still costs ~25K per call. Two calls per session (creation + settle) is the bounded
  worst case, ~50K per new session.
