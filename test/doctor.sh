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

# config.json may still sit in an install dir (pre-1.0.4) or already be migrated to STATE.
CONFIG=""
for c in "$STATE/config.json" "${INSTALLS[0]}/config.json"; do
  [ -n "$c" ] && [ -f "$c" ] && { CONFIG="$c"; break; }
done

lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }

# pid of a gateway launched from $1, if any. $HOME and `npm root -g` can disagree on case
# on macOS (/Users/marc vs /users/Marc), so compare case-insensitively.
running_pid_for() {
  local want pid cmd
  want="$(lower "$1")/gateway.js"
  for pid in $(pgrep -f 'gateway\.js' 2>/dev/null); do
    cmd="$(lower "$(ps -o command= -p "$pid" 2>/dev/null)")"
    # $want must appear as a whole argv token, not just any substring — otherwise
    # `tail -f <install>/gateway.js.log` (or `vim`/`git diff` on that log) matches
    # too, since it literally contains "<install>/gateway.js" as a prefix of a
    # longer token. Anchor both ends: start-of-string or space before, end-of-string
    # or space after. "$want" stays quoted inside each pattern so glob metacharacters
    # in the path (e.g. brackets) are matched literally, not as glob syntax.
    case "$cmd" in
      "$want") printf '%s' "$pid"; return 0;;
      "$want "*) printf '%s' "$pid"; return 0;;
      *" $want") printf '%s' "$pid"; return 0;;
      *" $want "*) printf '%s' "$pid"; return 0;;
    esac
  done
  return 1
}

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
  if pid=$(running_pid_for "$d"); then mark="  <- running (pid $pid)"; else mark=""; fi
  echo "  $d  v$ver$mark"
  # Version drift: the live process loaded gateway.js at boot and holds it in memory, so the file
  # on disk may have moved on since. running.json records what that process actually loaded, and is
  # trusted only when both its pid and its install dir match the process we just found: a marker
  # left by a dead process, or by the other install on a two-install machine, proves nothing.
  if [ -n "$pid" ] && [ -f "$STATE/running.json" ]; then
    drift=$(python3 - "$STATE/running.json" "$pid" "$d" "$ver" <<'PY' 2>/dev/null
import hashlib, json, os, sys
marker, pid, install, disk_ver = sys.argv[1:5]
try:
    m = json.load(open(marker))
except Exception:
    sys.exit(0)
if str(m.get('pid')) != pid:
    sys.exit(0)
if os.path.normcase(str(m.get('dir', ''))) != os.path.normcase(install):
    sys.exit(0)

loaded = m.get('version', '')
if loaded and loaded != disk_ver:
    print(f"process loaded v{loaded}, disk has v{disk_ver}. restart to load it")
    sys.exit(0)

# Same version on both sides still leaves the development case: a pull that edited gateway.js
# without touching package.json. A marker written before the hash existed cannot speak to it.
sha = m.get('sha')
if sha:
    try:
        disk = hashlib.sha256(open(os.path.join(install, 'gateway.js'), 'rb').read()).hexdigest()
    except OSError:
        sys.exit(0)
    if disk != sha:
        print(f"gateway.js on disk differs from the loaded copy (both v{disk_ver}). restart to load it")
PY
)
    if [ -n "$drift" ]; then echo "      DRIFT: $drift"; fi
  fi
  if [ -f "$d/gateway.log" ]; then
    # grep -c prints 0 AND exits 1 on no match, so `|| echo 0` would print it twice.
    echo "      retry storms $(grep -c 'createForumTopic failed' "$d/gateway.log" 2>/dev/null)  poll timeouts $(grep -c 'request timeout' "$d/gateway.log" 2>/dev/null)"
  else
    echo "      (no gateway.log)"
  fi
done

# find, not `ls *.jsonl`: zsh errors on an unmatched glob where bash passes it through.
# This dir holds a .jsonl for EVERY Claude Code session run from $HOME, not just titler
# spawns — counting all of them reported 300 "orphaned titlers" on a machine whose real
# count was 0. Titler turns are identified by the prompt generateTitle() sends; keep this
# string in sync with gateway.js.
SESSIONS=$(find "$PROJ" -maxdepth 1 -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')
TITLERS=$(find "$PROJ" -maxdepth 1 -name '*.jsonl' -exec grep -l 'kebab-case slug titling this work session' {} + 2>/dev/null | wc -l | tr -d ' ')
echo "orphaned titlers: $TITLERS  of $SESSIONS sessions in $PROJ"

# Fork liveness. This is the check whose absence let forking die silently for weeks: the old
# probe assumed a live session keeps its .jsonl open, Claude Code 2.1.220 stopped doing that,
# lsof went quiet, and every phone reply resumed a live desk session in place instead of
# forking, with no error anywhere. A capability that fails by doing nothing needs a check
# that asserts it can still see something, so state the signal's health rather than its
# absence. Detection lives in gateway.js (liveSessionHolders); this only reports on it.
REG="$HOME/.claude/sessions"
if [ ! -d "$REG" ]; then
  echo "fork liveness:    NO REGISTRY at $REG (this Claude Code predates it; falling back to lsof)"
else
  live=0; stale=0
  for f in "$REG"/*.json; do
    [ -e "$f" ] || continue
    pid=$(basename "$f" .json)
    case "$pid" in (*[!0-9]*) continue ;; esac
    if kill -0 "$pid" 2>/dev/null; then live=$((live+1)); else stale=$((stale+1)); fi
  done
  echo "fork liveness:    $live live session(s) in registry, $stale stale entr(ies)"
  if [ "$live" = 0 ]; then
    echo "      NOTE: no live sessions right now, so this says nothing about the signal's health."
  fi
  # The assumption that broke. If a live session DOES hold its transcript, the lsof fallback is
  # still meaningful; if none does, the registry is the only thing keeping forking alive.
  holds=0
  for f in "$REG"/*.json; do
    [ -e "$f" ] || continue
    sid=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('sessionId',''))" "$f" 2>/dev/null)
    [ -n "$sid" ] && [ -f "$PROJ/$sid.jsonl" ] || continue
    [ -n "$(lsof -t "$PROJ/$sid.jsonl" 2>/dev/null)" ] && holds=$((holds+1))
  done
  echo "      transcripts held open by any process: $holds  (0 = lsof fallback is dead here, only the registry keeps forking alive)"
fi
