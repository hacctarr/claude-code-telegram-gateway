# PR-Review Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone launchd service that polls GitHub for bot-authored PRs and launches a fresh headless `claude -p "/code-review"` session per new PR, which the existing Telegram gateway auto-mirrors as its own topic.

**Architecture:** A separate Node project at `~/pr-review-monitor/` (does NOT touch `gateway.js`). A poll loop enumerates open PRs per configured target via the GitHub REST API, filters to bot authors, dedupes against a JSON state file, then for each new PR builds a git worktree at the PR head and spawns a detached `claude -p` review session in it. The gateway independently notices the new session transcript and creates + mirrors a topic. A one-line Bot-API notice to a fixed "PR Reviews" topic is the reliable heads-up.

**Tech Stack:** Node v26 (CommonJS), native global `fetch`, `node:test`, `child_process.spawn`, `crypto.randomUUID`, `git worktree`, launchd. No third-party deps. No `gh` CLI.

## Global Constraints

- **Node v26.2.0, CommonJS** (`require`/`module.exports`), no `"type": "module"`. Matches the gateway's ecosystem.
- **Zero runtime dependencies.** Use native `fetch`, `node:test`, `node:crypto`, `node:child_process`, `node:fs`. No npm installs beyond devless testing.
- **Never modify `gateway.js` or anything in `~/telegram_gateway/`.** This project is fully standalone.
- **All I/O boundaries (`fetch`, `spawn`) are dependency-injected** so tests never hit the network or spawn real processes.
- **Test command:** `node --test test/*.test.js` (matches gateway convention).
- **Trigger policy is "D":** every new bot-authored open PR is reviewed; dedup once per `repo#number` (first appearance only).
- **Output is Telegram-only.** No writes to the GitHub PR (no comments, reviews, statuses).
- **GitHub auth per target:** each target carries its own `token` and optional `apiBase` (Enterprise). Default `apiBase` is `https://api.github.com`.
- **State/config live under the project dir**, paths overridable by env: `PR_MONITOR_CONFIG` (default `~/pr-review-monitor/config.json`), `PR_MONITOR_STATE` (default `~/pr-review-monitor/state.json`).

---

### Task 0: Scaffold the standalone project

**Files:**
- Create: `~/pr-review-monitor/package.json`
- Create: `~/pr-review-monitor/.gitignore`
- Create: `~/pr-review-monitor/config.example.json`
- Create: `~/pr-review-monitor/test/smoke.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: a runnable `node --test test/*.test.js`; a documented config shape.

- [ ] **Step 1: Create the project directory and init git**

```bash
mkdir -p ~/pr-review-monitor/test
cd ~/pr-review-monitor && git init -q
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "pr-review-monitor",
  "version": "0.1.0",
  "private": true,
  "description": "Polls GitHub for bot-authored PRs and launches a fresh headless claude /code-review session per PR.",
  "scripts": {
    "test": "node --test test/*.test.js",
    "start": "node index.js"
  }
}
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
config.json
state.json
*.log
.worktrees/
```

- [ ] **Step 4: Write `config.example.json`** (documents the shape; real `config.json` is git-ignored)

```json
{
  "pollMs": 300000,
  "botToken": "TELEGRAM_BOT_TOKEN_SAME_AS_GATEWAY",
  "chatId": "-1001234567890",
  "reviewsTopicId": 42,
  "claudePath": "/Users/marc/.nvm/versions/node/v26.2.0/bin/claude",
  "permissionMode": "bypassPermissions",
  "worktreeRoot": "/Users/marc/pr-review-monitor/.worktrees",
  "targets": [
    {
      "name": "EM",
      "apiBase": "https://api.github.com",
      "token": "GITHUB_PAT_FOR_EM",
      "repos": ["some-org/some-repo"],
      "botAuthors": ["the-bot-login"],
      "localClone": "/Users/marc/code/em/some-repo"
    }
  ]
}
```

- [ ] **Step 5: Write a smoke test at `test/smoke.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');

test('node test harness runs', () => {
  assert.strictEqual(1 + 1, 2);
});
```

- [ ] **Step 6: Run the test to verify the harness works**

Run: `cd ~/pr-review-monitor && node --test test/*.test.js`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
cd ~/pr-review-monitor && git add -A && git commit -q -m "chore: scaffold pr-review-monitor project"
```

---

### Task 1: Validation spike — does the gateway mirror a headless session it didn't spawn?

This is the load-bearing assumption from the spec. It is a **manual experiment with a decision gate**, not a TDD cycle. Do it before writing any more code — the outcome decides whether Tasks 2–8 stand as written or need the fallback (monitor creates the topic itself).

**Files:** none (throwaway experiment).

- [ ] **Step 1: Pick a throwaway local git repo with a couple of commits**

```bash
mkdir -p /tmp/spike-repo && cd /tmp/spike-repo && git init -q && echo hi > a.txt && git add -A && git commit -q -m init
```

- [ ] **Step 2: Confirm the gateway service is running**

Run: `launchctl list | grep com.claude.telegram-gateway`
Expected: a line with a PID (not `-`).

- [ ] **Step 3: Spawn a short headless claude session in that repo, exactly how the monitor will**

```bash
cd /tmp/spike-repo && CLAUDE=/Users/marc/.nvm/versions/node/v26.2.0/bin/claude; \
SID=$(uuidgen | tr 'A-Z' 'a-z'); echo "session: $SID"; \
"$CLAUDE" -p --session-id "$SID" --permission-mode bypassPermissions "Say the word ping and nothing else."
```

Expected: the command prints a short completion and writes `~/.claude/projects/<sanitized>/$SID.jsonl`.

- [ ] **Step 4: Observe Telegram for ~30–60s (one gateway poll cycle)**

Decision gate:
- **A topic appears and mirrors the "ping" session** → assumption holds. Proceed to Task 2 unchanged.
- **No topic appears** → the gateway only topics held-open desk sessions. STOP and adjust the plan: Task 6/7 must create the forum topic via the Bot API (`createForumTopic`) and post the review into it (the fallback named in the spec). Record which path was taken in the commit message of Task 7.

- [ ] **Step 5: Record the outcome**

Write one line to `~/pr-review-monitor/SPIKE-RESULT.md` stating "gateway mirrors headless sessions: YES/NO (date)", commit it:

```bash
cd ~/pr-review-monitor && git add SPIKE-RESULT.md && git commit -q -m "docs: record gateway-mirror spike result"
```

---

### Task 2: GitHub client — list open PRs and filter to bot authors

**Files:**
- Create: `~/pr-review-monitor/github.js`
- Create: `~/pr-review-monitor/test/github.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `async function listOpenPRs({ apiBase, token, repo }, fetchImpl = fetch)` → `Promise<Array<PR>>` where `PR = { repo: string, number: number, title: string, url: string, author: string, headSha: string, headRef: string, baseRef: string }`.
  - `async function fetchBotPRs(target, fetchImpl = fetch)` → `Promise<Array<PR>>` — calls `listOpenPRs` for each `target.repos[i]`, keeps only PRs whose `author` is in `target.botAuthors`.

- [ ] **Step 1: Write the failing test at `test/github.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { listOpenPRs, fetchBotPRs } = require('../github');

function fakeFetch(payload) {
  return async () => ({ ok: true, status: 200, async json() { return payload; } });
}

test('listOpenPRs maps the GitHub payload to our PR shape', async () => {
  const payload = [{
    number: 7, title: 'Add thing', html_url: 'https://github.com/o/r/pull/7',
    user: { login: 'the-bot' }, head: { sha: 'abc123', ref: 'feature' }, base: { ref: 'main' },
  }];
  const prs = await listOpenPRs({ apiBase: 'https://api.github.com', token: 't', repo: 'o/r' }, fakeFetch(payload));
  assert.deepStrictEqual(prs, [{
    repo: 'o/r', number: 7, title: 'Add thing', url: 'https://github.com/o/r/pull/7',
    author: 'the-bot', headSha: 'abc123', headRef: 'feature', baseRef: 'main',
  }]);
});

test('fetchBotPRs keeps only PRs authored by a configured bot', async () => {
  const payload = [
    { number: 1, title: 'a', html_url: 'u1', user: { login: 'human' }, head: { sha: 's1', ref: 'r1' }, base: { ref: 'main' } },
    { number: 2, title: 'b', html_url: 'u2', user: { login: 'the-bot' }, head: { sha: 's2', ref: 'r2' }, base: { ref: 'main' } },
  ];
  const target = { apiBase: 'https://api.github.com', token: 't', repos: ['o/r'], botAuthors: ['the-bot'] };
  const prs = await fetchBotPRs(target, fakeFetch(payload));
  assert.strictEqual(prs.length, 1);
  assert.strictEqual(prs[0].number, 2);
});

test('listOpenPRs throws on a non-ok response', async () => {
  const badFetch = async () => ({ ok: false, status: 401, async text() { return 'bad creds'; } });
  await assert.rejects(
    () => listOpenPRs({ apiBase: 'https://api.github.com', token: 't', repo: 'o/r' }, badFetch),
    /401/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/pr-review-monitor && node --test test/github.test.js`
Expected: FAIL with "Cannot find module '../github'".

- [ ] **Step 3: Write `github.js`**

```js
'use strict';

// Map one GitHub REST PR object to our internal shape.
function toPR(repo, o) {
  return {
    repo,
    number: o.number,
    title: o.title,
    url: o.html_url,
    author: o.user && o.user.login,
    headSha: o.head && o.head.sha,
    headRef: o.head && o.head.ref,
    baseRef: o.base && o.base.ref,
  };
}

async function listOpenPRs({ apiBase, token, repo }, fetchImpl = fetch) {
  const url = `${apiBase}/repos/${repo}/pulls?state=open&per_page=100`;
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pr-review-monitor',
    },
  });
  if (!res.ok) {
    const body = res.text ? await res.text() : '';
    throw new Error(`GitHub ${res.status} for ${repo}: ${body}`);
  }
  const arr = await res.json();
  return arr.map((o) => toPR(repo, o));
}

async function fetchBotPRs(target, fetchImpl = fetch) {
  const apiBase = target.apiBase || 'https://api.github.com';
  const bots = new Set(target.botAuthors || []);
  const out = [];
  for (const repo of target.repos || []) {
    const prs = await listOpenPRs({ apiBase, token: target.token, repo }, fetchImpl);
    for (const pr of prs) if (bots.has(pr.author)) out.push(pr);
  }
  return out;
}

module.exports = { listOpenPRs, fetchBotPRs };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/pr-review-monitor && node --test test/github.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/pr-review-monitor && git add github.js test/github.test.js && git commit -q -m "feat: github client — list open PRs, filter to bot authors"
```

---

### Task 3: Dedup state store

**Files:**
- Create: `~/pr-review-monitor/state.js`
- Create: `~/pr-review-monitor/test/state.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function prKey(pr)` → `string` (`` `${pr.repo}#${pr.number}` ``).
  - `function loadState(path)` → `{ seen: string[] }` (returns `{ seen: [] }` if the file is missing).
  - `function hasSeen(state, key)` → `boolean`.
  - `function markSeen(state, path, key)` → mutates `state.seen`, writes the file, returns `state`.

- [ ] **Step 1: Write the failing test at `test/state.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prKey, loadState, hasSeen, markSeen } = require('../state');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prm-')), 'state.json');
}

test('prKey combines repo and number', () => {
  assert.strictEqual(prKey({ repo: 'o/r', number: 12 }), 'o/r#12');
});

test('loadState returns empty seen when file is absent', () => {
  const state = loadState(path.join(os.tmpdir(), 'does-not-exist-123.json'));
  assert.deepStrictEqual(state, { seen: [] });
});

test('markSeen persists and hasSeen reads it back', () => {
  const p = tmpFile();
  let state = loadState(p);
  assert.strictEqual(hasSeen(state, 'o/r#1'), false);
  markSeen(state, p, 'o/r#1');
  assert.strictEqual(hasSeen(state, 'o/r#1'), true);
  const reloaded = loadState(p);
  assert.strictEqual(hasSeen(reloaded, 'o/r#1'), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/pr-review-monitor && node --test test/state.test.js`
Expected: FAIL with "Cannot find module '../state'".

- [ ] **Step 3: Write `state.js`**

```js
'use strict';
const fs = require('node:fs');

function prKey(pr) {
  return `${pr.repo}#${pr.number}`;
}

function loadState(path) {
  try {
    const raw = fs.readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    return { seen: Array.isArray(parsed.seen) ? parsed.seen : [] };
  } catch (e) {
    if (e.code === 'ENOENT') return { seen: [] };
    throw e;
  }
}

function hasSeen(state, key) {
  return state.seen.includes(key);
}

function markSeen(state, path, key) {
  if (!state.seen.includes(key)) state.seen.push(key);
  fs.writeFileSync(path, JSON.stringify(state, null, 2));
  return state;
}

module.exports = { prKey, loadState, hasSeen, markSeen };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/pr-review-monitor && node --test test/state.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/pr-review-monitor && git add state.js test/state.test.js && git commit -q -m "feat: dedup state store keyed on repo#number"
```

---

### Task 4: Worktree manager

Builds an isolated worktree checked out at the PR head using `refs/pull/N/head` (works for fork PRs too, needs no extra remote).

**Files:**
- Create: `~/pr-review-monitor/worktree.js`
- Create: `~/pr-review-monitor/test/worktree.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function createWorktree({ localClone, worktreeRoot, number, headSha }, runGit = defaultRunGit)` → `string` (the created worktree path). Fetches `pull/<number>/head` into a local branch `prm/pr-<number>-<shortsha>` and adds a worktree at `<worktreeRoot>/pr-<number>-<shortsha>`.
  - `function removeWorktree({ localClone, worktreePath }, runGit = defaultRunGit)` → `void`.
  - `defaultRunGit(cwd, args)` → runs `git -C <cwd> <args...>` synchronously, throws on non-zero exit.

- [ ] **Step 1: Write the failing test at `test/worktree.test.js`** (injects a fake git runner; asserts on the git commands issued)

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createWorktree, removeWorktree } = require('../worktree');

test('createWorktree fetches the PR head ref and adds a worktree', () => {
  const calls = [];
  const runGit = (cwd, args) => { calls.push({ cwd, args }); };
  const wt = createWorktree(
    { localClone: '/clone', worktreeRoot: '/wt', number: 7, headSha: 'abcdef1234' },
    runGit,
  );
  assert.strictEqual(wt, '/wt/pr-7-abcdef1');
  assert.deepStrictEqual(calls[0], { cwd: '/clone', args: ['fetch', 'origin', 'pull/7/head:prm/pr-7-abcdef1', '--force'] });
  assert.deepStrictEqual(calls[1], { cwd: '/clone', args: ['worktree', 'add', '--force', '/wt/pr-7-abcdef1', 'prm/pr-7-abcdef1'] });
});

test('removeWorktree removes the worktree and prunes', () => {
  const calls = [];
  const runGit = (cwd, args) => { calls.push({ cwd, args }); };
  removeWorktree({ localClone: '/clone', worktreePath: '/wt/pr-7-abcdef1' }, runGit);
  assert.deepStrictEqual(calls[0], { cwd: '/clone', args: ['worktree', 'remove', '--force', '/wt/pr-7-abcdef1'] });
  assert.deepStrictEqual(calls[1], { cwd: '/clone', args: ['worktree', 'prune'] });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/pr-review-monitor && node --test test/worktree.test.js`
Expected: FAIL with "Cannot find module '../worktree'".

- [ ] **Step 3: Write `worktree.js`**

```js
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

function defaultRunGit(cwd, args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

function branchName(number, headSha) {
  return `prm/pr-${number}-${String(headSha).slice(0, 7)}`;
}

function createWorktree({ localClone, worktreeRoot, number, headSha }, runGit = defaultRunGit) {
  const branch = branchName(number, headSha);
  const wtPath = path.join(worktreeRoot, `pr-${number}-${String(headSha).slice(0, 7)}`);
  runGit(localClone, ['fetch', 'origin', `pull/${number}/head:${branch}`, '--force']);
  runGit(localClone, ['worktree', 'add', '--force', wtPath, branch]);
  return wtPath;
}

function removeWorktree({ localClone, worktreePath }, runGit = defaultRunGit) {
  runGit(localClone, ['worktree', 'remove', '--force', worktreePath]);
  runGit(localClone, ['worktree', 'prune']);
}

module.exports = { createWorktree, removeWorktree, defaultRunGit, branchName };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/pr-review-monitor && node --test test/worktree.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/pr-review-monitor && git add worktree.js test/worktree.test.js && git commit -q -m "feat: worktree manager using refs/pull/N/head"
```

---

### Task 5: Review launcher

Spawns the detached headless review session. The prompt is the literal slash command `/code-review`.

**Files:**
- Create: `~/pr-review-monitor/launcher.js`
- Create: `~/pr-review-monitor/test/launcher.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function launchReview({ claudePath, permissionMode, worktreePath, sessionId }, spawnImpl = defaultSpawn)` → `string` (the `sessionId`). Spawns `claudePath -p --session-id <sessionId> --permission-mode <permissionMode> /code-review` with `cwd: worktreePath`, detached, stdio ignored, and unrefs it.
  - `function newSessionId()` → `string` (`crypto.randomUUID()`).

- [ ] **Step 1: Write the failing test at `test/launcher.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { launchReview, newSessionId } = require('../launcher');

test('newSessionId returns a uuid', () => {
  assert.match(newSessionId(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('launchReview spawns claude with the right args and cwd, and unrefs', () => {
  const calls = [];
  let unrefed = false;
  const spawnImpl = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() { unrefed = true; } }; };
  const sid = launchReview(
    { claudePath: '/bin/claude', permissionMode: 'bypassPermissions', worktreePath: '/wt/pr-7', sessionId: 'sid-1' },
    spawnImpl,
  );
  assert.strictEqual(sid, 'sid-1');
  assert.strictEqual(calls[0].cmd, '/bin/claude');
  assert.deepStrictEqual(calls[0].args, ['-p', '--session-id', 'sid-1', '--permission-mode', 'bypassPermissions', '/code-review']);
  assert.strictEqual(calls[0].opts.cwd, '/wt/pr-7');
  assert.strictEqual(calls[0].opts.detached, true);
  assert.strictEqual(unrefed, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/pr-review-monitor && node --test test/launcher.test.js`
Expected: FAIL with "Cannot find module '../launcher'".

- [ ] **Step 3: Write `launcher.js`**

```js
'use strict';
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

function defaultSpawn(cmd, args, opts) {
  return spawn(cmd, args, opts);
}

function newSessionId() {
  return crypto.randomUUID();
}

function launchReview({ claudePath, permissionMode, worktreePath, sessionId }, spawnImpl = defaultSpawn) {
  const args = ['-p', '--session-id', sessionId, '--permission-mode', permissionMode, '/code-review'];
  const child = spawnImpl(claudePath, args, { cwd: worktreePath, detached: true, stdio: 'ignore' });
  child.unref();
  return sessionId;
}

module.exports = { launchReview, newSessionId, defaultSpawn };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/pr-review-monitor && node --test test/launcher.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/pr-review-monitor && git add launcher.js test/launcher.test.js && git commit -q -m "feat: detached headless /code-review launcher"
```

---

### Task 6: Telegram notifier

Posts one heads-up line to the fixed "PR Reviews" topic via the Bot API.

**Files:**
- Create: `~/pr-review-monitor/notify.js`
- Create: `~/pr-review-monitor/test/notify.test.js`

**Interfaces:**
- Consumes: `PR` shape from Task 2.
- Produces:
  - `async function notifyReviewStarted({ botToken, chatId, reviewsTopicId, targetName, pr }, fetchImpl = fetch)` → `Promise<void>`. POSTs to `https://api.telegram.org/bot<botToken>/sendMessage` with `chat_id`, `message_thread_id: reviewsTopicId`, and text `🔍 Launching review: <targetName>/<repo>#<number> — <title>\n<url>`.

- [ ] **Step 1: Write the failing test at `test/notify.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { notifyReviewStarted } = require('../notify');

test('notifyReviewStarted posts the expected message to the reviews topic', async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200, async json() { return { ok: true }; } }; };
  await notifyReviewStarted({
    botToken: 'BOT:TOKEN', chatId: '-100999', reviewsTopicId: 42, targetName: 'EM',
    pr: { repo: 'o/r', number: 7, title: 'Add thing', url: 'https://gh/o/r/pull/7' },
  }, fetchImpl);
  assert.strictEqual(seen.url, 'https://api.telegram.org/botBOT:TOKEN/sendMessage');
  const body = JSON.parse(seen.opts.body);
  assert.strictEqual(body.chat_id, '-100999');
  assert.strictEqual(body.message_thread_id, 42);
  assert.match(body.text, /EM\/o\/r#7 — Add thing/);
  assert.match(body.text, /https:\/\/gh\/o\/r\/pull\/7/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/pr-review-monitor && node --test test/notify.test.js`
Expected: FAIL with "Cannot find module '../notify'".

- [ ] **Step 3: Write `notify.js`**

```js
'use strict';

async function notifyReviewStarted({ botToken, chatId, reviewsTopicId, targetName, pr }, fetchImpl = fetch) {
  const text = `🔍 Launching review: ${targetName}/${pr.repo}#${pr.number} — ${pr.title}\n${pr.url}`;
  const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_thread_id: reviewsTopicId, text }),
  });
  if (!res.ok) {
    const body = res.text ? await res.text() : '';
    throw new Error(`Telegram sendMessage ${res.status}: ${body}`);
  }
}

module.exports = { notifyReviewStarted };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/pr-review-monitor && node --test test/notify.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
cd ~/pr-review-monitor && git add notify.js test/notify.test.js && git commit -q -m "feat: telegram heads-up notifier for review launches"
```

---

### Task 7: Config loader + orchestrator `runOnce`

Wires detect → dedup → worktree → launch → notify → record. Every side-effecting collaborator is injected so `runOnce` is fully unit-testable.

**Files:**
- Create: `~/pr-review-monitor/config.js`
- Create: `~/pr-review-monitor/monitor.js`
- Create: `~/pr-review-monitor/test/monitor.test.js`

**Interfaces:**
- Consumes: `fetchBotPRs` (Task 2); `prKey`, `loadState`, `hasSeen`, `markSeen` (Task 3); `createWorktree` (Task 4); `launchReview`, `newSessionId` (Task 5); `notifyReviewStarted` (Task 6).
- Produces:
  - `function loadConfig(path)` → the parsed config object; throws a clear error if `botToken` or `targets` are missing.
  - `async function runOnce(config, statePath, deps)` → `Promise<Array<string>>` (the `prKey`s newly reviewed this cycle). `deps` = `{ fetchBotPRs, createWorktree, launchReview, newSessionId, notifyReviewStarted, loadState, markSeen, log }`. For each target, for each bot PR not in state: create worktree, launch review, notify, `markSeen`. A failure on one PR is logged and does not abort the cycle.

- [ ] **Step 1: Write the failing test at `test/monitor.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runOnce, loadConfig } = require('../monitor');

function baseConfig() {
  return {
    botToken: 'B:T', chatId: '-100', reviewsTopicId: 1,
    claudePath: '/bin/claude', permissionMode: 'bypassPermissions', worktreeRoot: '/wt',
    targets: [{ name: 'EM', apiBase: 'https://api.github.com', token: 't', repos: ['o/r'], botAuthors: ['bot'], localClone: '/clone' }],
  };
}

function fakeDeps(prs) {
  const events = { worktrees: [], launches: [], notifies: [], seen: [] };
  const state = { seen: [] };
  return {
    events,
    deps: {
      loadState: () => state,
      markSeen: (s, p, key) => { s.seen.push(key); events.seen.push(key); },
      fetchBotPRs: async () => prs,
      createWorktree: (opts) => { events.worktrees.push(opts); return `/wt/pr-${opts.number}`; },
      newSessionId: () => 'sid-x',
      launchReview: (opts) => { events.launches.push(opts); return opts.sessionId; },
      notifyReviewStarted: async (opts) => { events.notifies.push(opts); },
      log: () => {},
    },
  };
}

test('runOnce reviews a new bot PR end to end and records it', async () => {
  const pr = { repo: 'o/r', number: 7, title: 'x', url: 'u', author: 'bot', headSha: 'abc1234', headRef: 'f', baseRef: 'main' };
  const { events, deps } = fakeDeps([pr]);
  const reviewed = await runOnce(baseConfig(), '/tmp/state.json', deps);
  assert.deepStrictEqual(reviewed, ['o/r#7']);
  assert.strictEqual(events.worktrees.length, 1);
  assert.strictEqual(events.launches[0].worktreePath, '/wt/pr-7');
  assert.strictEqual(events.notifies[0].pr.number, 7);
  assert.deepStrictEqual(events.seen, ['o/r#7']);
});

test('runOnce skips a PR already in state', async () => {
  const pr = { repo: 'o/r', number: 7, title: 'x', url: 'u', author: 'bot', headSha: 'abc1234', headRef: 'f', baseRef: 'main' };
  const { events, deps } = fakeDeps([pr]);
  deps.loadState = () => ({ seen: ['o/r#7'] });
  const reviewed = await runOnce(baseConfig(), '/tmp/state.json', deps);
  assert.deepStrictEqual(reviewed, []);
  assert.strictEqual(events.launches.length, 0);
});

test('runOnce continues after one PR throws', async () => {
  const prs = [
    { repo: 'o/r', number: 7, title: 'a', url: 'u', author: 'bot', headSha: 's7', headRef: 'f', baseRef: 'main' },
    { repo: 'o/r', number: 8, title: 'b', url: 'u', author: 'bot', headSha: 's8', headRef: 'f', baseRef: 'main' },
  ];
  const { events, deps } = fakeDeps(prs);
  deps.createWorktree = (opts) => { if (opts.number === 7) throw new Error('boom'); events.worktrees.push(opts); return `/wt/pr-${opts.number}`; };
  const reviewed = await runOnce(baseConfig(), '/tmp/state.json', deps);
  assert.deepStrictEqual(reviewed, ['o/r#8']);
});

test('loadConfig rejects a config missing targets', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prm-')), 'c.json');
  fs.writeFileSync(p, JSON.stringify({ botToken: 'x' }));
  assert.throws(() => loadConfig(p), /targets/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/pr-review-monitor && node --test test/monitor.test.js`
Expected: FAIL with "Cannot find module '../monitor'".

- [ ] **Step 3: Write `config.js`**

```js
'use strict';
const fs = require('node:fs');

function loadConfig(path) {
  const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!cfg.botToken) throw new Error('config: botToken is required');
  if (!Array.isArray(cfg.targets) || cfg.targets.length === 0) throw new Error('config: targets[] is required');
  return cfg;
}

module.exports = { loadConfig };
```

- [ ] **Step 4: Write `monitor.js`**

```js
'use strict';
const { loadConfig } = require('./config');
const { fetchBotPRs } = require('./github');
const { prKey, loadState, markSeen, hasSeen } = require('./state');
const { createWorktree } = require('./worktree');
const { launchReview, newSessionId } = require('./launcher');
const { notifyReviewStarted } = require('./notify');

const DEFAULT_DEPS = {
  fetchBotPRs, createWorktree, launchReview, newSessionId, notifyReviewStarted,
  loadState, markSeen, log: (...a) => console.log(new Date().toISOString(), ...a),
};

async function runOnce(config, statePath, deps = DEFAULT_DEPS) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const state = d.loadState(statePath);
  const reviewed = [];
  for (const target of config.targets) {
    let prs;
    try {
      prs = await d.fetchBotPRs(target);
    } catch (e) {
      d.log(`fetch failed for target ${target.name}: ${e.message}`);
      continue;
    }
    for (const pr of prs) {
      const key = prKey(pr);
      if (hasSeen(state, key)) continue;
      try {
        const worktreePath = d.createWorktree({
          localClone: target.localClone, worktreeRoot: config.worktreeRoot,
          number: pr.number, headSha: pr.headSha,
        });
        const sessionId = d.newSessionId();
        d.launchReview({
          claudePath: config.claudePath, permissionMode: config.permissionMode,
          worktreePath, sessionId,
        });
        await d.notifyReviewStarted({
          botToken: config.botToken, chatId: config.chatId,
          reviewsTopicId: config.reviewsTopicId, targetName: target.name, pr,
        });
        d.markSeen(state, statePath, key);
        reviewed.push(key);
        d.log(`launched review for ${key} (session ${sessionId})`);
      } catch (e) {
        d.log(`review failed for ${key}: ${e.message}`);
      }
    }
  }
  return reviewed;
}

module.exports = { runOnce, loadConfig };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd ~/pr-review-monitor && node --test test/monitor.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the full suite**

Run: `cd ~/pr-review-monitor && node --test test/*.test.js`
Expected: PASS (all tasks' tests green).

- [ ] **Step 7: Commit**

```bash
cd ~/pr-review-monitor && git add config.js monitor.js test/monitor.test.js && git commit -q -m "feat: config loader + runOnce orchestrator"
```

---

### Task 8: Entry point + poll loop

**Files:**
- Create: `~/pr-review-monitor/index.js`
- Create: `~/pr-review-monitor/test/index.test.js`

**Interfaces:**
- Consumes: `loadConfig`, `runOnce` (Task 7).
- Produces:
  - `function resolvePaths(env)` → `{ configPath, statePath }` using `PR_MONITOR_CONFIG` / `PR_MONITOR_STATE` with the documented defaults.
  - `async function main(env, { loadConfig, runOnce, sleep })` → runs `runOnce` on a loop every `config.pollMs`, logging each cycle. (Loop exit is not tested; the tested surface is `resolvePaths` and a single injected cycle.)

- [ ] **Step 1: Write the failing test at `test/index.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { resolvePaths } = require('../index');

test('resolvePaths honors env overrides', () => {
  const { configPath, statePath } = resolvePaths({ PR_MONITOR_CONFIG: '/c.json', PR_MONITOR_STATE: '/s.json' });
  assert.strictEqual(configPath, '/c.json');
  assert.strictEqual(statePath, '/s.json');
});

test('resolvePaths falls back to defaults under the home dir', () => {
  const { configPath, statePath } = resolvePaths({ HOME: '/Users/marc' });
  assert.strictEqual(configPath, '/Users/marc/pr-review-monitor/config.json');
  assert.strictEqual(statePath, '/Users/marc/pr-review-monitor/state.json');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/pr-review-monitor && node --test test/index.test.js`
Expected: FAIL with "Cannot find module '../index'".

- [ ] **Step 3: Write `index.js`**

```js
'use strict';
const path = require('node:path');
const { loadConfig, runOnce } = require('./monitor');

function resolvePaths(env = process.env) {
  const home = env.HOME || require('node:os').homedir();
  const base = path.join(home, 'pr-review-monitor');
  return {
    configPath: env.PR_MONITOR_CONFIG || path.join(base, 'config.json'),
    statePath: env.PR_MONITOR_STATE || path.join(base, 'state.json'),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(env = process.env, injected = {}) {
  const _loadConfig = injected.loadConfig || loadConfig;
  const _runOnce = injected.runOnce || runOnce;
  const _sleep = injected.sleep || sleep;
  const { configPath, statePath } = resolvePaths(env);
  const config = _loadConfig(configPath);
  const log = (...a) => console.log(new Date().toISOString(), ...a);
  log(`pr-review-monitor up; ${config.targets.length} target(s); poll ${config.pollMs}ms`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const reviewed = await _runOnce(config, statePath);
      if (reviewed.length) log(`cycle reviewed: ${reviewed.join(', ')}`);
    } catch (e) {
      log(`cycle error: ${e.message}`);
    }
    await _sleep(config.pollMs || 300000);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { resolvePaths, main };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/pr-review-monitor && node --test test/index.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/pr-review-monitor && git add index.js test/index.test.js && git commit -q -m "feat: entry point + poll loop"
```

---

### Task 9: launchd service + install script

**Files:**
- Create: `~/pr-review-monitor/com.claude.pr-review-monitor.plist`
- Create: `~/pr-review-monitor/install-service.sh`

**Interfaces:**
- Consumes: `index.js` as the program entry.
- Produces: an installable launchd agent that runs `node ~/pr-review-monitor/index.js` and restarts on exit, logging to `~/pr-review-monitor/monitor.log`.

- [ ] **Step 1: Write the plist** (`~/pr-review-monitor/com.claude.pr-review-monitor.plist`) — replace `NODE_BIN` at install time

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.claude.pr-review-monitor</string>
  <key>ProgramArguments</key>
  <array>
    <string>NODE_BIN</string>
    <string>PROJECT_DIR/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>PROJECT_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>PROJECT_DIR/monitor.log</string>
  <key>StandardErrorPath</key><string>PROJECT_DIR/monitor.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Write `install-service.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$HOME/pr-review-monitor"
NODE_BIN="$(command -v node)"
PLIST_SRC="$PROJECT_DIR/com.claude.pr-review-monitor.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.claude.pr-review-monitor.plist"

sed -e "s#NODE_BIN#$NODE_BIN#g" -e "s#PROJECT_DIR#$PROJECT_DIR#g" "$PLIST_SRC" > "$PLIST_DST"
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
echo "loaded com.claude.pr-review-monitor; logs at $PROJECT_DIR/monitor.log"
```

- [ ] **Step 3: Make it executable and verify plist syntax**

Run: `cd ~/pr-review-monitor && chmod +x install-service.sh && plutil -lint com.claude.pr-review-monitor.plist`
Expected: `com.claude.pr-review-monitor.plist: OK` (the `NODE_BIN`/`PROJECT_DIR` tokens are valid plist strings; `plutil` checks XML structure).

- [ ] **Step 4: Commit**

```bash
cd ~/pr-review-monitor && git add com.claude.pr-review-monitor.plist install-service.sh && git commit -q -m "feat: launchd service + install script"
```

---

### Task 10: EM end-to-end proof (manual gate before Cobalt/Alkami)

**Files:**
- Create: `~/pr-review-monitor/config.json` (git-ignored, real secrets)

**Prerequisite (Marc supplies):** a github.com PAT scoped `repo` + `read:org` for the EM org, the EM repo slug(s), the bot's GitHub login, a local clone path, the gateway's `botToken`, the target `chatId`, and a `reviewsTopicId` for a "🔍 PR Reviews" forum topic (create it in the group first).

- [ ] **Step 1: Write `config.json` from `config.example.json`** with the real EM values (one target only for now).

- [ ] **Step 2: Dry-run one cycle in the foreground**

Run: `cd ~/pr-review-monitor && node -e "const {loadConfig,runOnce}=require('./monitor'); const {resolvePaths}=require('./index'); const {configPath,statePath}=resolvePaths(process.env); runOnce(loadConfig(configPath), statePath).then(r=>console.log('reviewed',r))"`
Expected: either `reviewed []` (no open bot PRs right now) or, if an open EM bot PR exists, a worktree is created, a review session spawns, and the `🔍 PR Reviews` topic gets a line. Watch Telegram for the mirrored review topic (per the Task 1 spike outcome).

- [ ] **Step 3: If no bot PR exists to prove the flow, open a throwaway PR** on the EM test repo from the bot login (or temporarily add your own login to `botAuthors`) and re-run Step 2.

- [ ] **Step 4: Confirm dedup** — run Step 2 again; expect `reviewed []` for the already-seen PR.

- [ ] **Step 5: Install the service and confirm it's alive**

Run: `~/pr-review-monitor/install-service.sh && sleep 3 && launchctl list | grep pr-review-monitor && tail -5 ~/pr-review-monitor/monitor.log`
Expected: a PID line and a startup log line.

- [ ] **Step 6: Commit the go-live note** (not `config.json` — it's git-ignored)

```bash
cd ~/pr-review-monitor && printf '# EM live %s\n' "$(date +%F)" >> SPIKE-RESULT.md && git add SPIKE-RESULT.md && git commit -q -m "docs: EM end-to-end proof complete"
```

---

## Deferred (separate plan, after this lands)

- **Cobalt / Alkami targets** — add their `token` + `apiBase` (likely Enterprise/SSO) to `config.json`. No code change; just config + auth. Do after EM is proven.
- **Component 2 — readout tool/response separation in `gateway.js`** — its own plan, sequenced after the Task 1 spike per the spec, and kept off the in-flight `feat/auto-approve-mode` branch.
- **Re-review on new head SHA** — currently dedup is once per `repo#number`; a push-triggered re-review is an explicit future flag.
