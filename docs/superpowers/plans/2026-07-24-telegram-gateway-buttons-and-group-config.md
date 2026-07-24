# Telegram Gateway — Inline Buttons + Group Auto-Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one-tap inline action buttons to mirrored sessions and a `/sessions` picker, and make the gateway configure its own group + bot appearance idempotently on boot.

**Architecture:** Two independent features layered onto the existing `gateway.js`. (C) Inline buttons reuse the existing `callback_query` plumbing in `pollUpdates` (the `ap:` approval prefix) with a new `act:` prefix family, and attach an action-bar `reply_markup` to each mirrored prose message. (D) A boot-time `configureGroup()` reads live identity (`getMe`), then applies bot-global and per-chat appearance via the Bot API, guarded by a per-scope hash in `~/.claude-gateway/appearance.json` so frequent restarts stay silent. Both features are split into a pure, unit-tested helper layer and a thin network-wiring layer verified by the manual runbook.

**Tech Stack:** Node.js (built-ins only — `https`, `crypto`, `fs`, `path`; zero runtime deps), `node:test` + `node:assert` for unit tests, Telegram Bot API.

## Global Constraints

- **Zero runtime dependencies.** Node built-ins only (`https`, `crypto`, `fs`, `path`). Never add an npm package.
- **Node 18+** (tested on v26). Test runner: `node --test test/*.test.js` via `npm test` (needs `export PATH="/Users/marc/.nvm/versions/node/v26.2.0/bin:$PATH"` in a non-interactive shell).
- **`callback_data` ≤ 64 bytes** (Telegram hard limit). A 36-char UUID plus the longest prefix `act:rename:` (11) = 47 bytes — fits.
- **No em-dashes in any user-facing copy** (Marc's voice watchlist). Use a middot `·` or hyphen `-` instead. This applies to button labels, toasts, command descriptions, and appearance text.
- **All feature work stays on the `feat/readout-opener` branch** in the `/Users/marc/telegram_gateway-readout` worktree. `main` (the running install) is untouched until merge + `restart.flag`.
- **Pure helpers are unit-tested; network methods (`setChat*`, `setMy*`, `sendMessage`, `editMessageReplyMarkup`) are exercised only via `test/MANUAL-TESTS.md`.** Never write a unit test that hits `api.telegram.org`.
- **Every exported helper is added to `module.exports`** at the bottom of `gateway.js` or the test `require('../gateway.js')` can't reach it.

---

## Task 1: Pure helpers for inline buttons

**Files:**
- Modify: `gateway.js` — add helpers after `sendPlain` (near line 408); refactor `sendPlain` to use `chunkText`; extend `module.exports` (line 1752-1764).
- Test: `test/gateway.test.js` — append tests.

**Interfaces:**
- Consumes: `relTime(ms)` (existing export, line 334).
- Produces:
  - `chunkText(text, max = 4000) -> string[]` — splits on newline boundaries, same logic `sendPlain` uses today.
  - `parseActionCallback(data) -> { action, sid } | null` — `action` ∈ `desk|rename|exit|resume`.
  - `buildSessionActionBar(sid) -> { inline_keyboard } | null` — null when `sid` falsy.
  - `buildSessionPickerKeyboard(sessions, max = 12) -> { inline_keyboard } | null` — one row per session, `callback_data = act:resume:<id>`; null when empty.

- [ ] **Step 1: Write the failing tests**

Append to `test/gateway.test.js`:

```js
// --- Inline action buttons (Task 1) ----------------------------------------
test('chunkText: short text is a single chunk', () => {
  assert.deepEqual(g.chunkText('hello'), ['hello']);
});

test('chunkText: splits on a newline near the limit', () => {
  const a = 'a'.repeat(3000);
  const b = 'b'.repeat(2000);
  const chunks = g.chunkText(`${a}\n${b}`, 4000);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], a);
  assert.equal(chunks[1], b);
});

test('chunkText: empty string yields no chunks', () => {
  assert.deepEqual(g.chunkText(''), []);
});

test('parseActionCallback: extracts action and session id', () => {
  assert.deepEqual(g.parseActionCallback('act:desk:abc-123'), { action: 'desk', sid: 'abc-123' });
  assert.deepEqual(g.parseActionCallback('act:resume:11111111-2222-3333-4444-555555555555'),
    { action: 'resume', sid: '11111111-2222-3333-4444-555555555555' });
});

test('parseActionCallback: rejects non-act and unknown actions', () => {
  assert.equal(g.parseActionCallback('ap:5:1'), null);
  assert.equal(g.parseActionCallback('act:frobnicate:x'), null);
  assert.equal(g.parseActionCallback('act:desk:'), null);
  assert.equal(g.parseActionCallback(''), null);
  assert.equal(g.parseActionCallback(undefined), null);
});

test('buildSessionActionBar: three buttons with act: callbacks', () => {
  const sid = '11111111-2222-3333-4444-555555555555';
  const bar = g.buildSessionActionBar(sid);
  const row = bar.inline_keyboard[0];
  assert.equal(row.length, 3);
  assert.deepEqual(row.map((b) => b.callback_data),
    [`act:desk:${sid}`, `act:rename:${sid}`, `act:exit:${sid}`]);
  for (const b of row) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
});

test('buildSessionActionBar: null when sid is falsy', () => {
  assert.equal(g.buildSessionActionBar(''), null);
  assert.equal(g.buildSessionActionBar(undefined), null);
});

test('buildSessionPickerKeyboard: one row per session, callbacks within 64 bytes', () => {
  const sessions = [
    { id: '11111111-2222-3333-4444-555555555555', label: 'fix the parser', mtime: Date.now() },
    { id: '99999999-8888-7777-6666-555555555555', label: 'write docs', mtime: Date.now() - 3600_000 },
  ];
  const kb = g.buildSessionPickerKeyboard(sessions);
  assert.equal(kb.inline_keyboard.length, 2);
  assert.equal(kb.inline_keyboard[0][0].callback_data, `act:resume:${sessions[0].id}`);
  for (const row of kb.inline_keyboard) assert.ok(Buffer.byteLength(row[0].callback_data) <= 64);
});

test('buildSessionPickerKeyboard: caps at max rows and returns null when empty', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `id-${i}`, label: `s${i}`, mtime: Date.now() }));
  assert.equal(g.buildSessionPickerKeyboard(many, 12).inline_keyboard.length, 12);
  assert.equal(g.buildSessionPickerKeyboard([]), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="/Users/marc/.nvm/versions/node/v26.2.0/bin:$PATH" && cd /Users/marc/telegram_gateway-readout && node --test test/gateway.test.js`
Expected: FAIL — `g.chunkText is not a function` (and the other new helpers undefined).

- [ ] **Step 3: Add `chunkText` and refactor `sendPlain` to use it**

In `gateway.js`, replace the body of `sendPlain` (lines 389-408) so the chunking lives in a reusable pure helper. New code:

```js
// Split text on newline boundaries so each piece fits Telegram's 4096-char message cap.
function chunkText(text, max = 4000) {
  let rest = text;
  const chunks = [];
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendPlain(chatId, threadId, text) {
  let allSent = true;
  for (const c of chunkText(text)) {
    try {
      const r = await telegramRequest('sendMessage', { chat_id: chatId, message_thread_id: threadId, text: c });
      if (!r || !r.ok) allSent = false;
    } catch (e) { console.error('sendPlain error:', e.code || e.message || String(e)); allSent = false; }
  }
  return allSent;   // callers that mirror content use this to avoid advancing past unsent lines
}
```

- [ ] **Step 4: Add the button helpers**

Immediately after `sendPlain` (before `startTyping`), add:

```js
// --- Inline action buttons: pure builders + parser --------------------------
// Reuses the existing callback_query plumbing (the `ap:` approval prefix) with an `act:` family.
const ACTION_RE = /^act:(desk|rename|exit|resume):(.+)$/;
function parseActionCallback(data) {
  const m = ACTION_RE.exec(data || '');
  return m ? { action: m[1], sid: m[2] } : null;
}

// The per-session action bar that rides each mirrored prose message: one tap to hand back to the
// desk, regenerate the name, or close the topic. Full session id fits callback_data (≤64 bytes).
function buildSessionActionBar(sid) {
  if (!sid) return null;
  return { inline_keyboard: [[
    { text: '🖥️ Desk',   callback_data: `act:desk:${sid}` },
    { text: '✏️ Rename', callback_data: `act:rename:${sid}` },
    { text: '❌ Close',  callback_data: `act:exit:${sid}` },
  ]] };
}

// One tappable row per recent session for the /sessions picker; tapping links this topic to it.
function buildSessionPickerKeyboard(sessions, max = 12) {
  const rows = sessions.slice(0, max).map((s) => [{
    text: `${(s.label || s.id).slice(0, 48)} · ${relTime(s.mtime)}`,
    callback_data: `act:resume:${s.id}`,
  }]);
  return rows.length ? { inline_keyboard: rows } : null;
}
```

- [ ] **Step 5: Export the new helpers**

In `module.exports` (the object starting at line 1752), add to the export list:

```js
  chunkText, parseActionCallback, buildSessionActionBar, buildSessionPickerKeyboard,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `export PATH="/Users/marc/.nvm/versions/node/v26.2.0/bin:$PATH" && cd /Users/marc/telegram_gateway-readout && npm test`
Expected: PASS — all new Task 1 tests green, and the pre-existing suite still green (117+ pass, 0 fail; the 3 known skips remain).

- [ ] **Step 7: Commit**

```bash
cd /Users/marc/telegram_gateway-readout
git add gateway.js test/gateway.test.js
git commit -m "feat: pure helpers for inline session buttons

chunkText (extracted from sendPlain), parseActionCallback,
buildSessionActionBar, buildSessionPickerKeyboard — all unit-tested.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire inline buttons into the mirror + callback paths

**Files:**
- Modify: `gateway.js` — add `BUTTONS` config flag (near line 89); add `lastBar` map + `postWithMarkup` + `clearPrevBar` + `handleActionCallback` + `closeSessionTopic`; edit the mirror prose-send block (lines 1454-1466); edit the `callback_query` branch (after line 1549); edit the `/exit` handler (lines 1629-1644) and `/sessions` handler (lines 1646-1652).
- Test: none new (network wiring; verified by smoke check + `test/MANUAL-TESTS.md`). Task 1 unit tests cover the pure pieces.

**Interfaces:**
- Consumes: `parseActionCallback`, `buildSessionActionBar`, `buildSessionPickerKeyboard`, `chunkText` (Task 1); `openOnDesk` (line 880), `upsertLink` (line 814), `renameTopicFromContent` (line 1333), `sessionFileById` (line 289), `sizeCurrent` (line 874), `linkBySession`, `sessionByThread`, `queues`, `pendingTools`, `supersededAt`, `persistSuperseded`, `persistLinks`, `deleteForumTopic`, `closeForumTopic`, `telegramRequest`, `PRUNE_MODE`, `TITLE_MODE`.
- Produces:
  - `BUTTONS` (bool, default true).
  - `postWithMarkup(chatId, threadId, text, replyMarkup) -> { allSent, lastMessageId }`.
  - `closeSessionTopic(sid, chatId, threadId) -> Promise<void>` (the `/exit` teardown, now shared with the button).

- [ ] **Step 1: Add the `BUTTONS` config flag**

In `gateway.js`, after the `MIRROR_FLUSH_MS` line (line 89), add:

```js
// Inline action buttons: attach a per-session action bar (Desk / Rename / Close) to each mirrored
// prose message, and render /sessions as a tap-to-link picker. false → no reply_markup is attached
// and the act: callback router answers "buttons disabled" (slash commands still work).
const BUTTONS = config.BUTTONS !== false;
```

- [ ] **Step 2: Add `postWithMarkup`, the bar tracker, and `clearPrevBar`**

Immediately after `sendPlain` (after the button helpers from Task 1), add:

```js
// sendPlain's cousin: attaches reply_markup to the LAST chunk and returns that message's id so the
// caller can strip the markup off it later. Returns { allSent, lastMessageId }.
async function postWithMarkup(chatId, threadId, text, replyMarkup) {
  const chunks = chunkText(text);
  let allSent = true, lastMessageId = null;
  for (let i = 0; i < chunks.length; i++) {
    const payload = { chat_id: chatId, message_thread_id: threadId, text: chunks[i] };
    if (replyMarkup && i === chunks.length - 1) payload.reply_markup = replyMarkup;
    try {
      const r = await telegramRequest('sendMessage', payload);
      if (!r || !r.ok) allSent = false;
      else if (r.result) lastMessageId = r.result.message_id;
    } catch (e) { console.error('postWithMarkup error:', e.code || e.message || String(e)); allSent = false; }
  }
  return { allSent, lastMessageId };
}

// Only the newest mirrored message per session should carry the action bar. Track the last one so
// its markup can be cleared when a newer message takes over (editMessageReplyMarkup with []).
const lastBar = new Map();   // sessionId -> { chatId, messageId }
async function clearPrevBar(sid) {
  const b = lastBar.get(sid);
  if (!b) return;
  await telegramRequest('editMessageReplyMarkup',
    { chat_id: b.chatId, message_id: b.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  lastBar.delete(sid);
}
```

- [ ] **Step 3: Extract the `/exit` teardown into `closeSessionTopic`**

Add this function near `pruneTopic` (after line 1379, before the poll-loop section comment):

```js
// The /exit teardown, shared by the /exit command and the ❌ Close button. Closes (or deletes) the
// topic, unbinds the session, and marks it superseded so the mirror won't re-topic it until the
// desk grows the transcript again.
async function closeSessionTopic(sid, chatId, threadId) {
  await sendPlain(chatId, threadId, `👋 Session ${sid.slice(0, 8)} closed. It stays resumable on disk ` +
    `(/sessions in another topic, or \`cr\` at the Mac); fresh desk activity will re-open a topic for it.`);
  sessionByThread.delete(`${chatId}_${threadId}`);
  delete linkBySession[sid];
  queues.delete(sid);
  delete pendingTools[sid];
  lastBar.delete(sid);
  supersededAt[sid] = sizeCurrent(sid); persistSuperseded();
  persistLinks();
  if (PRUNE_MODE === 'delete') await deleteForumTopic(chatId, threadId);
  else await closeForumTopic(chatId, threadId);
  console.log(`[Exit] closed topic ${threadId} for session ${sid.slice(0, 8)}`);
}
```

- [ ] **Step 4: Add `handleActionCallback`**

Add it right after `closeSessionTopic`:

```js
// Dispatch an act: button press. cb is the raw callback_query (for chat/thread + answering).
async function handleActionCallback(act, cb) {
  const { action, sid } = act;
  const answer = (text) => telegramRequest('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {});
  if (action === 'desk') {
    return void answer(openOnDesk(sid) ? '🖥️ Opening on your Mac' : '⚠️ Could not open it on the Mac');
  }
  if (action === 'resume') {
    const chatId = String(cb.message.chat.id);
    const threadId = cb.message.message_thread_id;
    await upsertLink(sid, chatId, threadId); persistLinks();
    await answer('🔗 Linked · send a message to continue it');
    return void sendPlain(chatId, threadId, `🔗 Topic linked to session ${sid.slice(0, 8)}. Send a message to continue it.`);
  }
  const link = linkBySession[sid];
  if (!link) return void answer('That session is no longer linked.');
  if (action === 'rename') {
    if (TITLE_MODE !== 'generated') return void answer('Set TITLE_MODE=generated, or use /rename <name>.');
    await answer('✏️ Regenerating name…');
    const name = await renameTopicFromContent(sid, link, sessionFileById(sid));
    if (name) await sendPlain(link.chatId, link.threadId, `✏️ Renamed to ${name}`);
    return;
  }
  if (action === 'exit') {
    await answer('❌ Closing…');
    await closeSessionTopic(sid, link.chatId, link.threadId);
  }
}
```

- [ ] **Step 5: Route `act:` presses in the `callback_query` branch**

In `pollUpdates`, inside the `if (cb) {` block, after the `ap:` handling (after line 1549's closing `}` for the `if (m)` and before the branch's `continue;` at line 1550), insert:

```js
          const act = parseActionCallback(cb.data);
          if (act) {
            if (!BUTTONS) {
              telegramRequest('answerCallbackQuery', { callback_query_id: cb.id, text: 'Buttons are disabled.' }).catch(() => {});
            } else {
              await handleActionCallback(act, cb);
            }
          }
```

(The existing `continue;` immediately below still runs.)

- [ ] **Step 6: Attach the action bar in the mirror prose path**

In `pollTick`, replace the send block (lines 1458-1465, from `const { activity, prose } = splitReadout(posts);` through `lastMirrorAt.set(id, now);`) with:

```js
          const { activity, prose } = splitReadout(posts);
          let allSent = true;
          if (activity.length) {
            if (!(await sendPlain(link.chatId, link.threadId, activity.join('\n\n')))) allSent = false;
          }
          if (allSent && prose.length) {
            const bar = BUTTONS ? buildSessionActionBar(id) : null;
            const res = await postWithMarkup(link.chatId, link.threadId, prose.join('\n\n'), bar);
            if (!res.allSent) allSent = false;
            else if (bar && res.lastMessageId) {
              await clearPrevBar(id);
              lastBar.set(id, { chatId: link.chatId, messageId: res.lastMessageId });
            }
          }
          if (!allSent) continue;   // keep the offset so these lines retry next tick
          lastMirrorAt.set(id, now);
```

- [ ] **Step 7: Collapse the `/exit` handler onto `closeSessionTopic`**

Replace the `/exit` body (lines 1629-1644) with:

```js
        if (text === '/exit' || text === '/close') {
          const sid = sessionByThread.get(key);
          if (!sid) { sendPlain(chatId, threadId, "This topic isn't bound to a session — nothing to close."); continue; }
          await closeSessionTopic(sid, chatId, threadId);
          continue;
        }
```

- [ ] **Step 8: Render `/sessions` as a picker**

Replace the `/sessions || /resume` handler (lines 1646-1652) with:

```js
        if (text === '/sessions' || text === '/resume') {
          const sessions = await listSessions(REPO_MAPPINGS[chatId]);
          if (!sessions.length) { sendPlain(chatId, threadId, "No past Claude sessions found for this repo yet."); continue; }
          const kb = BUTTONS ? buildSessionPickerKeyboard(sessions) : null;
          if (kb) {
            await telegramRequest('sendMessage', { chat_id: chatId, message_thread_id: threadId,
              text: '🗂 Recent sessions · tap to link this topic:', reply_markup: kb }).catch(() => {});
          } else {
            sendPlain(chatId, threadId, `🗂 Recent sessions:\n\n${formatSessionList(sessions)}\n\nReply /resume <id> to link this topic to one.`);
          }
          continue;
        }
```

- [ ] **Step 9: Export `closeSessionTopic` and `postWithMarkup` (optional but keeps parity), then smoke-check**

Add to `module.exports`:

```js
  postWithMarkup, closeSessionTopic,
```

Run a syntax + load smoke check (no config needed — module guards network at require time):

Run: `export PATH="/Users/marc/.nvm/versions/node/v26.2.0/bin:$PATH" && cd /Users/marc/telegram_gateway-readout && node --check gateway.js && node -e "require('./gateway.js'); console.log('loaded ok')"`
Expected: `loaded ok` and no syntax error.

- [ ] **Step 10: Run the full unit suite**

Run: `export PATH="/Users/marc/.nvm/versions/node/v26.2.0/bin:$PATH" && cd /Users/marc/telegram_gateway-readout && npm test`
Expected: PASS — unchanged green suite (the wiring added no unit tests; Task 1 tests still pass).

- [ ] **Step 11: Commit**

```bash
cd /Users/marc/telegram_gateway-readout
git add gateway.js
git commit -m "feat: wire inline session buttons into mirror + callbacks

Action bar (Desk/Rename/Close) rides each mirrored prose message via
postWithMarkup; previous bar is stripped so only the newest carries it.
act: callback router dispatches to openOnDesk / renameTopicFromContent /
closeSessionTopic / upsertLink. /exit refactored onto shared
closeSessionTopic. /sessions renders a tap-to-link picker. BUTTONS flag.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Pure helpers for group auto-config

**Files:**
- Modify: `gateway.js` — ensure `const crypto = require('crypto');` is present near the other requires (top of file); add appearance helpers near `configureGroup`'s eventual home (before the Boot section, ~line 1380); extend `module.exports`.
- Test: `test/gateway.test.js` — append tests.

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `sha256(bufOrString) -> hex string`.
  - `appearanceHash(obj) -> hex string` (stable `sha256(JSON.stringify(obj))`).
  - `buildCommandList() -> [{ command, description }]` (the 6 commands).
  - `resolveBotProfile(appearance) -> { name, about, description }` (each null when not set).
  - `resolveChatAppearance(appearance, chatId, photoSha) -> { title, description, photoSha, commands }`.
  - `chatPhotoPath(appearance, chatId) -> string | null`.

- [ ] **Step 1: Write the failing tests**

Append to `test/gateway.test.js`:

```js
// --- Group auto-config: pure helpers (Task 3) ------------------------------
test('buildCommandList: six commands, lowercase names, non-empty descriptions', () => {
  const cmds = g.buildCommandList();
  assert.equal(cmds.length, 6);
  assert.deepEqual(cmds.map((c) => c.command), ['new', 'sessions', 'desk', 'rename', 'exit', 'resume']);
  for (const c of cmds) {
    assert.match(c.command, /^[a-z]+$/);
    assert.ok(c.description.length > 0 && c.description.length <= 256);
  }
});

test('appearanceHash: stable for same input, changes when any field changes', () => {
  const a = g.appearanceHash({ title: 'x', description: 'y', photoSha: 'z', commands: g.buildCommandList() });
  const b = g.appearanceHash({ title: 'x', description: 'y', photoSha: 'z', commands: g.buildCommandList() });
  const c = g.appearanceHash({ title: 'x', description: 'CHANGED', photoSha: 'z', commands: g.buildCommandList() });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('resolveBotProfile: nulls when unset, values when set', () => {
  assert.deepEqual(g.resolveBotProfile({}), { name: null, about: null, description: null });
  assert.deepEqual(
    g.resolveBotProfile({ bot_name: 'N', bot_about: 'A', bot_description: 'D' }),
    { name: 'N', about: 'A', description: 'D' });
});

test('resolveChatAppearance: pulls the per-chat entry, defaults title/description to null', () => {
  const appearance = { chats: { '-100': { title: 'T', description: 'D' } } };
  const r = g.resolveChatAppearance(appearance, '-100', 'sha123');
  assert.equal(r.title, 'T');
  assert.equal(r.description, 'D');
  assert.equal(r.photoSha, 'sha123');
  assert.equal(r.commands.length, 6);
  const missing = g.resolveChatAppearance(appearance, '-999', '');
  assert.equal(missing.title, null);
  assert.equal(missing.description, null);
});

test('chatPhotoPath: per-chat overrides default, null when neither set', () => {
  assert.equal(g.chatPhotoPath({ default_photo_path: 'd.png', chats: {} }, '-1'), 'd.png');
  assert.equal(g.chatPhotoPath({ default_photo_path: 'd.png', chats: { '-1': { photo_path: 'c.png' } } }, '-1'), 'c.png');
  assert.equal(g.chatPhotoPath({ chats: {} }, '-1'), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="/Users/marc/.nvm/versions/node/v26.2.0/bin:$PATH" && cd /Users/marc/telegram_gateway-readout && node --test test/gateway.test.js`
Expected: FAIL — `g.buildCommandList is not a function` (and the rest undefined).

- [ ] **Step 3: Ensure `crypto` is required**

At the top of `gateway.js`, check the require block. If `crypto` is not already required, add alongside the existing built-in requires:

```js
const crypto = require('crypto');
```

(Verify with `grep -n "require('crypto')" gateway.js` first; add only if absent.)

- [ ] **Step 4: Add the appearance helpers**

Add just before the Boot section (before `const LOCK_FILE = ...` at line 1700), in a new block:

```js
// ---------------------------------------------------------------------------
// Group auto-config: pure helpers (see docs/superpowers/specs/2026-07-24-...)
// ---------------------------------------------------------------------------
function sha256(bufOrString) { return crypto.createHash('sha256').update(bufOrString).digest('hex'); }
function appearanceHash(obj) { return sha256(JSON.stringify(obj)); }

// The bot's command menu — identical for every mapped chat.
function buildCommandList() {
  return [
    { command: 'new',      description: 'Fresh session in its own topic' },
    { command: 'sessions', description: 'List recent sessions in this repo' },
    { command: 'desk',     description: 'Open this session in the editor on the Mac' },
    { command: 'rename',   description: 'Rename this topic (bare = regenerate from content)' },
    { command: 'exit',     description: 'Close this topic and stop mirroring' },
    { command: 'resume',   description: 'Link this topic to an existing session' },
  ];
}

// Bot-global profile. Each field is null unless APPEARANCE overrides it, so an unset field is never
// pushed (setMyName/etc. skipped) and the live bot identity from getMe stays as-is.
function resolveBotProfile(appearance = {}) {
  return {
    name: appearance.bot_name ?? null,
    about: appearance.bot_about ?? null,
    description: appearance.bot_description ?? null,
  };
}

// Per-chat desired appearance (title/description default to null → not pushed). photoSha is passed
// in so this stays pure; the caller hashes the actual photo bytes.
function resolveChatAppearance(appearance = {}, chatId, photoSha = '') {
  const cfg = (appearance.chats || {})[chatId] || {};
  return {
    title: cfg.title ?? null,
    description: cfg.description ?? null,
    photoSha,
    commands: buildCommandList(),
  };
}

// The photo file to use for a chat: its own override, else the shared default, else none.
function chatPhotoPath(appearance = {}, chatId) {
  const cfg = (appearance.chats || {})[chatId] || {};
  return cfg.photo_path || appearance.default_photo_path || null;
}
```

- [ ] **Step 5: Export the helpers**

Add to `module.exports`:

```js
  sha256, appearanceHash, buildCommandList, resolveBotProfile, resolveChatAppearance, chatPhotoPath,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `export PATH="/Users/marc/.nvm/versions/node/v26.2.0/bin:$PATH" && cd /Users/marc/telegram_gateway-readout && npm test`
Expected: PASS — Task 3 tests green, full suite green.

- [ ] **Step 7: Commit**

```bash
cd /Users/marc/telegram_gateway-readout
git add gateway.js test/gateway.test.js
git commit -m "feat: pure helpers for group auto-config

sha256/appearanceHash, buildCommandList, resolveBotProfile,
resolveChatAppearance, chatPhotoPath — all unit-tested.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `configureGroup()` + boot wiring

**Files:**
- Modify: `gateway.js` — add `AUTO_CONFIGURE_GROUP` / `APPEARANCE` config (near line 131); add `resolveAssetPath`, appearance-state load/save, `tgApply`, `setChatPhotoFile`, `configureGroup` (near the Task 3 helpers); call `configureGroup()` in the boot block (before `pollUpdates()`, line 1747).
- Test: none new (network; verified by smoke check + `test/MANUAL-TESTS.md`).

**Interfaces:**
- Consumes: `appearanceHash`, `resolveBotProfile`, `resolveChatAppearance`, `chatPhotoPath`, `buildCommandList`, `sha256` (Task 3); `telegramRequest`, `statePath`, `REPO_MAPPINGS`, `BOT_TOKEN`, `https`, `SOCKET_TIMEOUT_MS`.
- Produces: `AUTO_CONFIGURE_GROUP` (bool), `APPEARANCE` (object|null), `configureGroup() -> Promise<void>`.

- [ ] **Step 1: Add the config flags**

After the `DESK_OPEN_CMD` line (line 131), add:

```js
// Group auto-config: on boot, apply the group's title/description/photo, the bot's global
// name/about/description, and the command menu, idempotently (per-scope hash in appearance.json).
// APPEARANCE carries only what should differ from the live objects; unset fields are left untouched.
const AUTO_CONFIGURE_GROUP = config.AUTO_CONFIGURE_GROUP !== false;
const APPEARANCE = config.APPEARANCE || null;
```

- [ ] **Step 2: Add asset resolution, state persistence, and the API wrappers**

Add after the Task 3 helper block (after `chatPhotoPath`):

```js
// photo_path may be relative to the install dir (e.g. "assets/claude-logo.png").
function resolveAssetPath(p) { return path.isAbsolute(p) ? p : path.join(__dirname, p); }

const APPEARANCE_FILE = statePath('appearance.json');
function loadAppearanceState() {
  try { const s = JSON.parse(fs.readFileSync(APPEARANCE_FILE, 'utf8')); s.chats = s.chats || {}; return s; }
  catch (e) { return { botProfile: null, chats: {} }; }
}
function saveAppearanceState(s) {
  try { fs.writeFileSync(APPEARANCE_FILE, JSON.stringify(s, null, 2)); }
  catch (e) { console.error(`appearance: state write failed (${e.message})`); }
}

// A wrapped JSON Bot API call for appearance: returns true on ok, logs and returns false otherwise.
async function tgApply(method, payload) {
  try {
    const r = await telegramRequest(method, payload);
    if (r && r.ok) return true;
    console.error(`appearance: ${method} failed (${(r && r.description) || 'unknown'})`);
    return false;
  } catch (e) { console.error(`appearance: ${method} failed (${e.message})`); return false; }
}

// setChatPhoto needs multipart/form-data (a file upload), which telegramRequest (JSON) can't do.
function setChatPhotoFile(chatId, filePath) {
  return new Promise((resolve) => {
    let photo;
    try { photo = fs.readFileSync(filePath); }
    catch (e) { console.error(`appearance: setChatPhoto read failed (${e.message})`); return resolve(false); }
    const boundary = `----gwphoto${process.pid}`;
    const pre = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="photo.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`);
    const post = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([pre, photo, post]);
    const req = https.request({
      hostname: 'api.telegram.org', port: 443, path: `/bot${BOT_TOKEN}/setChatPhoto`, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { const j = JSON.parse(b); if (!j.ok) console.error(`appearance: setChatPhoto failed (${j.description})`); resolve(!!j.ok); }
        catch (e) { resolve(false); }
      });
    });
    req.setTimeout(SOCKET_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { console.error(`appearance: setChatPhoto failed (${e.message})`); resolve(false); });
    req.write(body); req.end();
  });
}
```

- [ ] **Step 3: Add `configureGroup`**

Add after `setChatPhotoFile`:

```js
// Boot-time, idempotent group + bot appearance. Reads live identity (getMe), applies bot-global
// profile once per value change, then each mapped chat's title/description/photo/commands/menu.
// A per-scope hash in appearance.json keeps frequent restarts silent; a partial failure leaves the
// old hash so the next boot retries just that scope.
async function configureGroup() {
  if (!AUTO_CONFIGURE_GROUP || !APPEARANCE) return;
  const state = loadAppearanceState();

  let me = null;
  try { const r = await telegramRequest('getMe'); if (r && r.ok) me = r.result; } catch (e) { /* */ }
  if (me) console.log(`[Appearance] configuring as @${me.username || me.first_name}`);

  // Bot-global profile (scoped to this bot; applied once per value change).
  if (APPEARANCE.set_bot_profile !== false) {
    const desired = resolveBotProfile(APPEARANCE);
    const h = appearanceHash(desired);
    if (h !== state.botProfile) {
      let ok = true;
      if (desired.name != null)        ok = (await tgApply('setMyName', { name: desired.name })) && ok;
      if (desired.about != null)       ok = (await tgApply('setMyShortDescription', { short_description: desired.about })) && ok;
      if (desired.description != null) ok = (await tgApply('setMyDescription', { description: desired.description })) && ok;
      if (ok) { state.botProfile = h; console.log('[Appearance] bot profile updated'); }
    }
  }

  // Per mapped chat: title / description / photo / commands / menu, keyed by chat id.
  for (const chatId of Object.keys(REPO_MAPPINGS)) {
    const cfg = (APPEARANCE.chats || {})[chatId] || {};
    const photoPath = chatPhotoPath(APPEARANCE, chatId);
    let photoSha = '';
    if (photoPath) { try { photoSha = sha256(fs.readFileSync(resolveAssetPath(photoPath))); } catch (e) { photoSha = ''; } }
    const h = appearanceHash(resolveChatAppearance(APPEARANCE, chatId, photoSha));
    if (h === state.chats[chatId]) continue;

    // A group photo should be representative of that group; the operator sets those by hand. Check
    // the live chat first and only set a photo when the group has NONE (bootstrap a fresh group),
    // unless the chat entry opts in with force_photo. getChat failure is treated as "has a photo"
    // so an API hiccup never overwrites one.
    let hasPhoto = true;
    try { const c = await telegramRequest('getChat', { chat_id: chatId }); if (c && c.ok) hasPhoto = !!(c.result && c.result.photo); } catch (e) { /* keep hasPhoto=true */ }

    let ok = true;
    if (cfg.title != null)       ok = (await tgApply('setChatTitle', { chat_id: chatId, title: cfg.title })) && ok;
    if (cfg.description != null) ok = (await tgApply('setChatDescription', { chat_id: chatId, description: cfg.description })) && ok;
    if (photoPath && photoSha && (!hasPhoto || cfg.force_photo === true)) {
      ok = (await setChatPhotoFile(chatId, resolveAssetPath(photoPath))) && ok;
    } else if (photoPath && hasPhoto) {
      console.log(`[Appearance] chat ${chatId} already has a photo · leaving it`);
    }
    ok = (await tgApply('setMyCommands', { commands: buildCommandList(), scope: { type: 'chat', chat_id: Number(chatId) } })) && ok;
    ok = (await tgApply('setChatMenuButton', { chat_id: chatId, menu_button: { type: 'commands' } })) && ok;
    if (ok) { state.chats[chatId] = h; console.log(`[Appearance] chat ${chatId} updated`); }
  }

  saveAppearanceState(state);
}
```

- [ ] **Step 4: Call `configureGroup()` at boot**

In the `require.main === module` block, immediately before `pollUpdates();` (line 1747), add:

```js
  configureGroup().catch((e) => console.error('appearance:', e.message));
```

- [ ] **Step 5: Export `configureGroup` (for parity) and smoke-check**

Add to `module.exports`:

```js
  configureGroup,
```

Run: `export PATH="/Users/marc/.nvm/versions/node/v26.2.0/bin:$PATH" && cd /Users/marc/telegram_gateway-readout && node --check gateway.js && node -e "require('./gateway.js'); console.log('loaded ok')" && npm test`
Expected: `loaded ok`, then the full suite PASS (no new unit tests; Tasks 1+3 tests still green).

- [ ] **Step 6: Commit**

```bash
cd /Users/marc/telegram_gateway-readout
git add gateway.js
git commit -m "feat: boot-time group + bot auto-config (configureGroup)

Reads live identity (getMe), applies bot-global profile and per-chat
title/description/photo/commands/menu idempotently via per-scope hash in
appearance.json. Multipart setChatPhotoFile for the logo upload.
AUTO_CONFIGURE_GROUP + APPEARANCE config.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Docs + example config + manual runbook

**Files:**
- Modify: `config.example.json` — add `BUTTONS`, `AUTO_CONFIGURE_GROUP`, and a generic `APPEARANCE` block.
- Modify: `README.md` — document the buttons and auto-config under the optional keys + a short "Appearance" note.
- Modify: `test/MANUAL-TESTS.md` — add a Test for buttons and one for appearance.

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add the new keys to `config.example.json`**

Insert after the `TOPIC_OPENER` line (line 24), and add an `APPEARANCE` block before the closing `}`. The example ships **generic placeholders** (never Marc's live values):

```json
  "BUTTONS": true,
  "AUTO_CONFIGURE_GROUP": true,
  "_APPEARANCE": "boot-time group + bot appearance; carries only what should differ from the live objects. Unset fields are left untouched. Photo is only set when the group has NONE (representative per-group icons you set by hand are never overwritten; add force_photo:true on a chat to override). Photo paths are relative to the install dir.",
  "APPEARANCE": {
    "set_bot_profile": true,
    "bot_about": "Bridges the Claude Code sessions running on my computer, over Telegram topics.",
    "bot_description": "Private, local-first gateway for the Claude Code sessions running on my computer. Every active session gets its own topic and mirrors live; reply in a topic to steer it, or /new to start a fresh one. Allowlisted users only.",
    "default_photo_path": "assets/claude-logo.png",
    "chats": {
      "-1001654782309": {
        "title": "Claude Code",
        "description": "Live mirror of Claude Code sessions on my computer. Reply in a topic to steer a session; /new for a fresh one. Private, allowlisted."
      }
    }
  },
```

- [ ] **Step 2: Document in `README.md`**

In the optional-keys list (around line 76-80), append to the defaults line:

```
`BUTTONS` (true — inline action bar on each mirrored reply + a /sessions picker),
`AUTO_CONFIGURE_GROUP` (true — apply group/bot appearance from `APPEARANCE` on boot).
```

Then add a short subsection after the "Using it" section:

```markdown
### Appearance (optional)

With `AUTO_CONFIGURE_GROUP` on (default), the gateway configures its own group + bot identity on
boot from the `APPEARANCE` block: group title/description/photo, the bot's global name/about/
description, and the command menu. It is idempotent — a per-scope hash in
`~/.claude-gateway/appearance.json` means it only acts on first run or when a value changes, so
frequent restarts stay silent. `APPEARANCE` carries only what should differ from the live group/bot;
unset fields are left untouched. **A group photo is only set when the group has none** — a
representative icon you set by hand is never overwritten (add `"force_photo": true` to a chat entry
to override). The bot must be a group Admin with **Change Group Info**. Chat wallpaper is not
settable via the Bot API — it stays a manual in-app choice.
```

- [ ] **Step 3: Add manual verification steps**

Append to `test/MANUAL-TESTS.md`:

```markdown
## Test F — Inline action buttons

**Why:** buttons ride the live callback plumbing; only a real Telegram round-trip exercises them.

1. From the Mac, run a session in a mapped repo so a topic appears and a prose reply mirrors in.
2. Confirm the reply carries a **🖥️ Desk · ✏️ Rename · ❌ Close** bar. Send another desk turn;
   confirm the bar moves to the newest reply and the previous one loses its buttons.
3. Tap **🖥️ Desk** → the session opens in your editor on the Mac; the toast says "Opening on your Mac".
4. Tap **❌ Close** → the topic closes and the session unbinds (same as `/exit`).
5. In another topic, send `/sessions` → a tappable list appears; tap one → "Linked", then send a
   message and confirm it continues that session.
6. Set `"BUTTONS": false`, restart, and confirm replies have no bar and `/sessions` falls back to text.

## Test G — Group auto-config

**Why:** appearance calls hit setChat*/setMy* once; verify they apply and then stay silent.

1. With `APPEARANCE` set and the bot an Admin with **Change Group Info**, start the gateway.
2. Confirm the log shows `[Appearance] configuring as @<bot>` and one or more `updated` lines, and
   that the group title/description and the bot's about/description changed in Telegram. A group that
   **already has a photo** keeps it (log: `already has a photo · leaving it`); a group with no photo
   gets `default_photo_path`. To force-replace one, add `"force_photo": true` to that chat entry.
3. `touch ~/.claude-gateway/restart.flag`. On relaunch, confirm **no** `updated` lines appear
   (hash match → silent). Change `APPEARANCE.chats.<id>.title`, restart, and confirm only that chat
   re-applies.
4. Confirm `~/.claude-gateway/appearance.json` holds a `botProfile` hash and a per-chat hash.
```

- [ ] **Step 4: Verify example config parses**

Run: `cd /Users/marc/telegram_gateway-readout && node -e "JSON.parse(require('fs').readFileSync('config.example.json','utf8')); console.log('config.example.json parses')"`
Expected: `config.example.json parses`.

- [ ] **Step 5: Commit**

```bash
cd /Users/marc/telegram_gateway-readout
git add config.example.json README.md test/MANUAL-TESTS.md
git commit -m "docs: document inline buttons + group auto-config

config.example.json gains BUTTONS / AUTO_CONFIGURE_GROUP / a generic
APPEARANCE block; README + MANUAL-TESTS cover both features.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- A (minimal opener) / B (prune 7→1): already done + committed on this branch — out of scope for these tasks. ✓
- C.1 session action bar (Desk/Rename/Close, rides newest prose, strips prior): Task 2 Steps 2, 4, 6. ✓
- C.2 `/sessions` picker → `act:resume:`: Task 1 (builder) + Task 2 Step 8. ✓
- C routing (`act:` after `ap:`, allowlist already checked at branch top): Task 2 Step 5. ✓
- C `BUTTONS` flag: Task 2 Step 1 + gating in Steps 5, 6, 8. ✓
- D trigger (once per boot before poll loop): Task 4 Step 4. ✓
- D runtime-derived identity (getMe; unset fields never pushed): Task 4 Step 3 + `resolveBotProfile`/`resolveChatAppearance` returning null for unset (Task 3). ✓ Title default is realized as "skip setChatTitle unless overridden" (behaviorally identical to defaulting to the existing title). `getChat` is called per chat to check for an existing photo before overwriting it.
- D photo never overwrites a hand-set representative icon (getChat → skip unless no photo or `force_photo`): Task 4 Step 3. ✓
- D scoping per bot + per chat: bot-global set once; per-chat keyed by chat id: Task 4 Step 3. ✓
- D config shape (`set_bot_profile`, `bot_*`, `default_photo_path`, `chats`): Task 4 Step 3 + Task 5 Step 1. ✓
- D idempotency (per-scope hash in appearance.json; partial failure retries): Task 4 Step 3 (`ok` gate on hash write). ✓
- D applies setChatTitle/Description/Photo/setMyCommands(chat scope)/setChatMenuButton + setMyName/ShortDescription/Description: Task 4 Step 3. ✓
- D command list (6 commands): Task 3 `buildCommandList`. ✓
- D error handling (wrap, log `appearance: <method> failed`, retry next boot): `tgApply` + `setChatPhotoFile` (Task 4 Step 2). ✓
- Non-goals honored: no wallpaper method, no pin management. ✓
- Testing section (openerText/shouldPrune done; act: parser; buildCommandList; appearanceHash; picker keyboard): Tasks 1 + 3. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code and exact commands. ✓

**Type consistency:** `parseActionCallback` returns `{ action, sid }` — consumed with those names in `handleActionCallback` (Task 2). `postWithMarkup` returns `{ allSent, lastMessageId }` — consumed with those names in the mirror path. `resolveChatAppearance(appearance, chatId, photoSha)` signature matches its call in `configureGroup` and its test. `buildSessionActionBar(id)` uses the full session id (passed as `id` in `pollTick`, `sid` elsewhere — same value). ✓
