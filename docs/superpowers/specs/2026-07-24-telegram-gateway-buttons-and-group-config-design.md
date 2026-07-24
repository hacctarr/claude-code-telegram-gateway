# Telegram Gateway — Inline Buttons + Group Auto-Config

**Date:** 2026-07-24
**Branch/worktree:** `telegram_gateway-readout`
**Status:** design approved (values + logo), pending spec review

## Problem

Two friction points on the phone side of the gateway, plus a cleanup of two defaults:

1. Every new topic leads with a multi-line opener that renders at the top of the topic like an
   auto-pinned banner. (Not a Telegram pin — verified `pinned_message` never changes on topic
   creation. It's the gateway's own first message.)
2. Steering a session requires typing slash commands (`/desk`, `/rename`, `/exit`, `/resume`).
   Telegram supports inline-keyboard buttons; the gateway already uses them for permission
   approvals but nowhere else.
3. The group's appearance (title, description, photo, bot profile, command menu) is configured by
   hand. It should configure itself.

## Goals

- New topics don't lead with a banner-like block.
- Common per-session actions are one tap from the phone.
- The group configures its own appearance on boot, idempotently.

## Non-Goals

- **Chat wallpaper** (the green doodle): the Bot API exposes no wallpaper method
  (`setChatWallpaper`/`setChatBackground` → `404 Not Found`). Stays a manual in-app setting.
- **Pin management:** nothing in the stack pins; the only live pin is user-authored. No auto-unpin
  (a boot-loop sweep would wipe intentional pins).
- Per-topic pinned messages.

## Scope

| Piece | Status |
|---|---|
| A. Minimal opener (`TOPIC_OPENER` flag) | **Done** in worktree |
| B. Prune default 7→1 day | **Done** in worktree |
| C. Inline action buttons | This spec |
| D. Group auto-config on boot | This spec |

---

## A. Minimal opener (implemented)

`TOPIC_OPENER` config: `off | minimal | full`, default **minimal**.
- `off` — post nothing; topic just starts mirroring.
- `minimal` — one line: `🤖 <name> · "<label>" · mirroring live`.
- `full` — prior behavior: the how-it-works paragraph + a "— where it left off —" seed.

`openerText(info, mode = TOPIC_OPENER)` returns `''` for `off`; `ensureTopicForSession` skips the
send when empty and only posts the "where it left off" seed in `full`. Documented in
`config.example.json` + README. Covered by unit tests (minimal/full/off).

## B. Prune default (implemented)

`PRUNE_AFTER_DAYS` default 7→1 in the code fallback, `config.example.json`, and README. Rolling
hours of inactivity against the transcript mtime (a session touched daily never prunes). The
prune-boundary unit test updated to the 1-day boundary.

---

## C. Inline action buttons

Reuse the existing callback plumbing: the poll loop already handles `update.callback_query` with an
allowlist check + `answerCallbackQuery` + `editMessageText` (permission approvals, `ap:` prefix).
Add an `act:` prefix family routed to existing action functions.

### Surfaces

1. **Session action bar** — `🖥️ Desk · ✏️ Rename · ❌ Close`, attached to each mirrored **prose**
   response message (rides the newest message, so it sits at the bottom near the input — no pin).
   - `act:desk:<sid>` → `openOnDesk(sid)`
   - `act:rename:<sid>` → `renameTopicFromContent(sid, link, file)`
   - `act:exit:<sid>`  → the `/exit` teardown (close topic, unbind, mark superseded)
   - When a newer prose message posts, strip the markup off the previous one
     (`editMessageReplyMarkup` with empty markup) so only the latest carries the bar.
2. **`/sessions` picker** — one inline button per recent session → `act:resume:<sid>` →
   `upsertLink(sid, chatId, threadId)` + confirm. (`callback_data` ≤ 64 bytes; a 36-char UUID fits.)

### Routing

Extend the `callback_query` branch: after the `ap:` match, match `^act:(desk|rename|exit|resume):(.+)$`,
verify the presser is allowlisted (already done at the top of the branch), dispatch, and
`answerCallbackQuery` with a short toast.

### Config

`BUTTONS` (default `true`). When `false`, no `reply_markup` is attached and the `act:` router is a
no-op (slash commands still work).

---

## D. Group auto-config on boot

### Trigger

Once per boot, after `acquireLock()` and before the poll loop starts, `await configureGroup()`.

### Runtime-derived identity

`configureGroup()` first reads live identity so it adapts to whatever bot/group it's running against,
with no hardcoding:
- `getMe` → the bot's actual `first_name`/`username`. `bot_name` **defaults to the live
  `first_name`** and is only changed when `APPEARANCE.bot_name` is set. (Honors "base the bot name on
  the actual bot name" — a stock install never renames the bot unless told to.)
- `getChat` (per mapped chat) → the group's current `title`. Per-chat `title` **defaults to the
  existing title**; only an explicit `APPEARANCE.chats[chatId].title` changes it.

So `APPEARANCE` only needs to carry what should *differ* from the live objects (about, description,
photo, or an explicit title). Fields left runtime-derived are never pushed, so the corresponding
`setMyName`/`setChatTitle` call is skipped entirely.

### Scoping: per bot and per chat

Each engagement runs its own gateway install (own `config.json`, `BOT_TOKEN`, `APPEARANCE`), so
appearance differs per bot automatically. Within one install:
- **Bot-global** fields (`setMyName`/`setMyShortDescription`/`setMyDescription`) are scoped to that
  bot and set **once** per boot. They affect every group that specific bot is in (different
  engagements use different bots, so no cross-talk).
- **Per-chat** fields (title/description/photo/commands/menu) are keyed by `chat_id` so an install
  that maps multiple repos→chats gives each its own identity.

### Config shape

```json
"APPEARANCE": {
  "set_bot_profile": true,
  "bot_name": "Hacctarr",
  "bot_about": "...",
  "bot_description": "...",
  "default_photo_path": "assets/claude-logo.png",
  "chats": {
    "-1003953985506": {
      "title": "Claude Code · Personal",
      "description": "...",
      "photo_path": "assets/claude-logo.png"
    }
  }
}
```

A chat with no entry (or missing keys) is skipped for those keys, not blanked. `photo_path` falls
back to `default_photo_path`. Commands + menu button are the same for every mapped chat.

### Idempotency (per scope)

State file `~/.claude-gateway/appearance.json`: `{ botProfile: <hash>, chats: { <chatId>: <hash> } }`.
- Bot-global: `hash = sha256(bot_name + bot_about + bot_description)`. Applied only if it differs
  from `stored.botProfile`; changing a chat never re-pushes the bot profile.
- Per chat: `hash = sha256(title + description + photoSha + commandsJson)`. Applied only if it
  differs from `stored.chats[chatId]`.
- On a scope's successful apply, write that scope's new hash. Partial failure leaves the old hash so
  the next boot retries just that scope.

This keeps frequent `restart.flag` restarts silent; each scope acts only on first run or its own
value change.

### What it applies

Bot-global (guarded by `set_bot_profile`, default `true`): `setMyName`, `setMyShortDescription`,
`setMyDescription`.

Per mapped chat (`REPO_MAPPINGS`), using that chat's `APPEARANCE.chats[chatId]`:
- `setChatTitle` — `.title`
- `setChatDescription` — `.description`
- `setChatPhoto` — `.photo_path` (or `default_photo_path`), **only when the group has no photo**.
  A group photo should be representative of that group and the operator sets those by hand, so
  `configureGroup()` calls `getChat` first and skips the photo when `chat.photo` is present. A
  `getChat` failure is treated as "has a photo" so an API hiccup never overwrites one. Set
  `force_photo: true` on a chat entry to replace an existing photo deliberately.
- `setMyCommands` (scope `{type:'chat', chat_id}`) — the command list below
- `setChatMenuButton` (`{type:'commands'}`)

### Command list

```
new      Fresh session in its own topic
sessions List recent sessions in this repo
desk     Open this session in the editor on the Mac
rename   Rename this topic (bare = regenerate from content)
exit     Close this topic and stop mirroring
resume   Link this topic to an existing session
```

### Approved values (land in the user's config `APPEARANCE`; repo ships generic placeholders)

- **bot_name:** `Hacctarr`
- **bot_about:** `Bridges the Claude Code sessions running on my computer, over Telegram topics.`
- **bot_description:** `Private, local-first gateway for the Claude Code sessions running on my computer. Every active session gets its own topic and mirrors live; reply in a topic to steer it, or /new to start a fresh one. Allowlisted users only.`
- **title:** `Claude Code · Personal`
- **description:** `Live mirror of Claude Code sessions on my computer. Reply in a topic to steer a session; /new for a fresh one. Private, allowlisted.`
- **photo:** `assets/claude-logo.png` (Claude sunburst, terracotta bg)

### Config

`AUTO_CONFIGURE_GROUP` (default `true`) master switch. `APPEARANCE` object holds the values;
missing keys are skipped (not blanked). Requires the bot's **Change Group Info** admin right
(verified present); a missing right logs a warning and skips that call.

### Error handling

Every API call wrapped; a failure logs `appearance: <method> failed (<desc>)` and continues. A
partial failure does **not** write the success hash, so the next boot retries.

---

## Testing

Repo tests are no-network, no-`claude`-spawn. Unit-test the pure pieces:
- `openerText` modes (done).
- `shouldPrune` 1-day boundary (done).
- `act:` callback parser — prefix/id extraction, rejects malformed.
- `buildCommandList()` shape.
- `appearanceHash(desired, photoSha)` — stable for same input, changes when any value or the photo
  changes; `shouldReapply(stored, desired)` returns false only on an exact hash match.
- `buildSessionPickerKeyboard(sessions)` — one button per session, `callback_data` within 64 bytes.

Network methods (`setChat*`, `setMy*`) are exercised via the existing manual-test doc, not unit
tests.

## Rollout

All on the `telegram_gateway-readout` worktree / feature branch. `main` (the running install) is
untouched until merged + `restart.flag`. On first boot after merge, `configureGroup()` applies the
appearance once; the opener/prune changes take effect immediately.
