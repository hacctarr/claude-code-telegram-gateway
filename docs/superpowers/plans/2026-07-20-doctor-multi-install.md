# Doctor Multi-Install Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `claude-tg doctor` report every gateway install on a machine, with each one's version, log stats, and whether it is the copy currently running.

**Architecture:** `test/doctor.sh` stays a dependency-free bash script (it must run on a machine where the package is broken). It gains an install *list* instead of a first-match variable, and a case-insensitive matcher tying each running pid to the install it was launched from. Testing is via `node:test` spawning the script against a fixture `$HOME` and a stub `npm` on `PATH` — the same `spawnSync` pattern already used by the config-free-require test.

**Tech Stack:** bash 3.2 (macOS `/bin/bash`), `node:test`, python3 for JSON reads (already a script dependency).

## Global Constraints

- Script must run under bash 3.2 — no associative arrays, no `mapfile`.
- No new runtime dependencies. python3 and `npm` are already assumed.
- Must not error under zsh when a glob matches nothing — use `find`, never bare `ls *.glob`.
- `grep -c` prints `0` and exits 1 on no match; never add `|| echo 0` after it.
- `$HOME` and `npm root -g` can disagree on case on macOS (`/Users/marc` vs `/users/Marc`) — all path comparison is case-insensitive.
- Existing output keys (`state dir:`, `config:`, `running:`, `TITLE_MODE:`, `orphaned titlers:`) keep their current names; only the install reporting changes shape.

## File Structure

- `test/doctor.sh` — modified. The whole diagnostic. One responsibility: report machine state.
- `test/gateway.test.js` — modified. Gains a `runDoctor()` fixture helper and the new assertions.

---

### Task 1: Report every install, not just the first

**Files:**
- Modify: `test/doctor.sh:7-11` (install detection), `test/doctor.sh:22-45` (output)
- Test: `test/gateway.test.js` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `runDoctor({home, npmRoot})` test helper returning the script's stdout as a string. Task 2 reuses it.

- [ ] **Step 1: Write the failing test**

Append to `test/gateway.test.js`:

```js
// ---------------------------------------------------------------------------
// doctor.sh — machine diagnostic
// ---------------------------------------------------------------------------

// Runs test/doctor.sh against a fixture $HOME with a stub `npm` on PATH, so the
// "global npm install" branch is exercised without touching the real machine.
function runDoctor({ home, npmRoot }) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-bin-'));
  fs.writeFileSync(path.join(bin, 'npm'),
    `#!/bin/sh\n[ "$1" = root ] && echo '${npmRoot || ''}'\nexit 0\n`, { mode: 0o755 });
  const r = require('child_process').spawnSync(
    '/bin/bash', [path.join(__dirname, 'doctor.sh')],
    { encoding: 'utf8', env: { ...process.env, HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      CLAUDE_GATEWAY_DIR: path.join(home, '.claude-gateway') } });
  return r.stdout;
}

// Builds a fake install dir containing the two files doctor.sh probes for.
function fakeInstall(dir, version, log) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'gateway.js'), '// stub');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
  if (log !== undefined) fs.writeFileSync(path.join(dir, 'gateway.log'), log);
  return dir;
}

test('doctor: reports BOTH a git checkout and an npm install', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  const npmRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-nr-'));
  fakeInstall(path.join(home, 'telegram_gateway'), '1.0.5', '');
  fakeInstall(path.join(npmRoot, 'claude-code-telegram-gateway'), '1.0.0', '');
  const out = runDoctor({ home, npmRoot });
  assert.match(out, /telegram_gateway {2}v1\.0\.5/, 'checkout listed with its version');
  assert.match(out, /claude-code-telegram-gateway {2}v1\.0\.0/, 'npm install listed too');
});

test('doctor: reports per-install log counts without double zeros', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  fakeInstall(path.join(home, 'telegram_gateway'), '1.0.5', 'nothing interesting here\n');
  const out = runDoctor({ home, npmRoot: '' });
  assert.match(out, /retry storms 0 {2}poll timeouts 0/, 'counts render on one line');
  assert.ok(!/^\s*0\s*$/m.test(out), 'no stray bare-zero line from `grep -c || echo 0`');
});

test('doctor: says so plainly when nothing is installed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  const out = runDoctor({ home, npmRoot: '' });
  assert.match(out, /installs:\s*\n\s*NONE FOUND/);
});

test('doctor: no zsh unmatched-glob error when the projects dir is empty', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects', `-${home.replace(/^\//, '').replace(/[/.]/g, '-')}`), { recursive: true });
  const out = runDoctor({ home, npmRoot: '' });
  assert.match(out, /orphaned titlers: 0/);
  assert.ok(!/no matches found/.test(out));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E "doctor:"`
Expected: all four `doctor:` tests FAIL — current output has a single `install:` line, not an `installs:` block.

- [ ] **Step 3: Rewrite `test/doctor.sh`**

Replace the whole file with:

```bash
#!/usr/bin/env bash
# Telegram gateway health check — works for git-clone and npm installs.
# Usage: bash test/doctor.sh   (or `claude-tg doctor`)

STATE="${CLAUDE_GATEWAY_DIR:-$HOME/.claude-gateway}"

# Every place the gateway may live. A machine can have BOTH a git checkout and the npm
# package; reporting only the first hides a stale copy — possibly the one actually running.
INSTALLS=()
for d in "$HOME/telegram_gateway" "$(npm root -g 2>/dev/null)/claude-code-telegram-gateway"; do
  [ -f "$d/gateway.js" ] && INSTALLS+=("$d")
done

lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }

# config.json may still sit in an install dir (pre-1.0.4) or already be migrated to STATE.
CONFIG=""
for c in "$STATE/config.json" "${INSTALLS[0]}/config.json"; do
  [ -n "$c" ] && [ -f "$c" ] && { CONFIG="$c"; break; }
done

# ~/.claude/projects dir for HOME, using Claude Code's own path encoding.
PROJ="$HOME/.claude/projects/-$(printf '%s' "${HOME#/}" | tr '/.' '--')"

echo "state dir:     $STATE $([ -d "$STATE" ] && echo '(exists)' || echo '(absent — pre-1.0.4)')"
echo "config:        ${CONFIG:-NOT FOUND}"
if [ -n "$CONFIG" ]; then
  echo "TITLE_MODE:    $(python3 -c "import json;print(json.load(open('$CONFIG')).get('TITLE_MODE','(absent -> default)'))" 2>/dev/null || echo '(unreadable)')"
fi
ALLPIDS=$(pgrep -f 'gateway\.js' 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')
echo "running:       ${ALLPIDS:-no}"

echo "installs:"
[ ${#INSTALLS[@]} -eq 0 ] && echo "  NONE FOUND"
for d in "${INSTALLS[@]}"; do
  ver="(unknown)"
  [ -f "$d/package.json" ] && ver=$(python3 -c "import json;print(json.load(open('$d/package.json'))['version'])" 2>/dev/null)
  echo "  $d  v$ver"
  if [ -f "$d/gateway.log" ]; then
    # grep -c prints 0 AND exits 1 on no match, so `|| echo 0` would print it twice.
    echo "      retry storms $(grep -c 'createForumTopic failed' "$d/gateway.log" 2>/dev/null)  poll timeouts $(grep -c 'request timeout' "$d/gateway.log" 2>/dev/null)"
  else
    echo "      (no gateway.log)"
  fi
done

# find, not `ls *.jsonl`: zsh errors on an unmatched glob where bash passes it through.
echo "orphaned titlers: $(find "$PROJ" -maxdepth 1 -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')  in $PROJ"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`, and `tests` up by 4 from the previous total.

- [ ] **Step 5: Verify against the real machine**

Run: `node bin/claude-tg.js doctor`
Expected: an `installs:` block listing `/Users/marc/telegram_gateway  v1.0.5` with its log counts. No stray blank-zero lines.

- [ ] **Step 6: Commit**

```bash
git add test/doctor.sh test/gateway.test.js
git commit -m "doctor: report every install, not just the first

A machine can have both a git checkout and the npm package. Reporting only
the first hid a stale copy — which may be the one actually running.
Each install now shows its version and its own log counts."
```

---

### Task 2: Mark which install is actually running

**Files:**
- Modify: `test/doctor.sh` (add `running_pid_for`, use it in the install loop)
- Test: `test/gateway.test.js` (append)

**Interfaces:**
- Consumes: `runDoctor({home, npmRoot})` and `fakeInstall(dir, version, log)` from Task 1.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the failing test**

Append to `test/gateway.test.js`:

```js
test('doctor: marks the install a running gateway was launched from', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  const dir = fakeInstall(path.join(home, 'telegram_gateway'), '1.0.5', '');
  // A real, long-lived process whose argv contains <dir>/gateway.js, so pgrep finds it.
  fs.writeFileSync(path.join(dir, 'gateway.js'), 'setTimeout(()=>{},60000)');
  const child = require('child_process').spawn(process.execPath, [path.join(dir, 'gateway.js')], { stdio: 'ignore' });
  try {
    const out = runDoctor({ home, npmRoot: '' });
    assert.match(out, new RegExp(`v1\\.0\\.5\\s+<- running \\(pid ${child.pid}\\)`),
      'the running install is marked with its pid');
  } finally { child.kill('SIGKILL'); }
});

test('doctor: leaves installs unmarked when nothing is running from them', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  fakeInstall(path.join(home, 'telegram_gateway'), '1.0.5', '');
  const out = runDoctor({ home, npmRoot: '' });
  assert.ok(!/<- running/.test(out), 'no false positive from an unrelated gateway elsewhere');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E "doctor: (marks|leaves)"`
Expected: the `marks` test FAILS (no `<- running` marker exists yet). The `leaves` test may pass vacuously — that is fine, it is a regression guard.

- [ ] **Step 3: Add the matcher to `test/doctor.sh`**

Insert immediately after the `lower()` definition:

```bash
# pid of a gateway launched from $1, if any. $HOME and `npm root -g` can disagree on case
# on macOS (/Users/marc vs /users/Marc), so compare case-insensitively.
running_pid_for() {
  local want pid cmd
  want="$(lower "$1")/gateway.js"
  for pid in $(pgrep -f 'gateway\.js' 2>/dev/null); do
    cmd="$(lower "$(ps -o command= -p "$pid" 2>/dev/null)")"
    case "$cmd" in *"$want"*) printf '%s' "$pid"; return 0;; esac
  done
  return 1
}
```

- [ ] **Step 4: Use it in the install loop**

In `test/doctor.sh`, replace this line:

```bash
  echo "  $d  v$ver"
```

with:

```bash
  if pid=$(running_pid_for "$d"); then mark="  <- running (pid $pid)"; else mark=""; fi
  echo "  $d  v$ver$mark"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`, `tests` up by 2 from Task 1's total.

- [ ] **Step 6: Verify against the real machine**

Run: `node bin/claude-tg.js doctor`
Expected: `/Users/marc/telegram_gateway  v1.0.5  <- running (pid NNNNN)`, where NNNNN matches the pid on the `running:` line.

- [ ] **Step 7: Commit and release**

```bash
git add test/doctor.sh test/gateway.test.js
git commit -m "doctor: mark which install the running gateway came from

Answers the question the report existed to answer: when a machine has two
copies, which one is the service actually executing. Case-insensitive match
because \$HOME and \`npm root -g\` disagree on case on macOS."
npm version 1.0.6 --no-git-tag-version
git commit -am "v1.0.6"
git tag v1.0.6 && git push origin main && git push origin v1.0.6
```

Expected: the GitHub Action publishes 1.0.6 to npm automatically (Trusted Publishing is configured as of v1.0.5). Confirm with `npm view claude-code-telegram-gateway version`.

---

## Appendix: rollout runbook (not a TDD task)

Rolling 1.0.5+ onto the other machines is operational, not code, so it has no tests and no task
structure. Per machine:

**Diagnose first** — `claude-tg doctor`, or if the install predates the command, paste the snippet
from `test/doctor.sh`. High `retry storms` plus orphaned titler files means that machine was burning
tokens.

**Git checkout:**
```bash
git -C ~/telegram_gateway pull
touch ~/telegram_gateway/restart.flag
```

**npm install** — the 1.0.0 → 1.0.5 hop destroys state, because npm replaces the package directory
before the new code's migration can run. This is unavoidable for this one hop; every later update is
safe.
```bash
PKG=$(npm root -g)/claude-code-telegram-gateway
mkdir -p ~/claude-tg-backup && cp "$PKG"/*.json ~/claude-tg-backup/ 2>/dev/null
npm update -g claude-code-telegram-gateway
cp ~/claude-tg-backup/config.json "$PKG"/     # migrates itself to ~/.claude-gateway on next start
claude-tg doctor
```

**Then confirm** the machine shows `v1.0.5`+ and, after a restart, `config: ~/.claude-gateway/config.json`.

**Decide `TITLE_MODE` per machine.** It defaults to `first-message` (free). Only set `generated` where
the AI-slug names are wanted — it costs ~25k tokens at topic creation plus ~25k once at the settle
rename, so ~50k per new session.
