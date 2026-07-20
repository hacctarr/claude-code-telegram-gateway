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
    case "$cmd" in *"$want"*) printf '%s' "$pid"; return 0;; esac
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
  if [ -f "$d/gateway.log" ]; then
    # grep -c prints 0 AND exits 1 on no match, so `|| echo 0` would print it twice.
    echo "      retry storms $(grep -c 'createForumTopic failed' "$d/gateway.log" 2>/dev/null)  poll timeouts $(grep -c 'request timeout' "$d/gateway.log" 2>/dev/null)"
  else
    echo "      (no gateway.log)"
  fi
done

# find, not `ls *.jsonl`: zsh errors on an unmatched glob where bash passes it through.
echo "orphaned titlers: $(find "$PROJ" -maxdepth 1 -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')  in $PROJ"
