#!/usr/bin/env bash
# Telegram gateway health check — works for git-clone and npm installs.
# Usage: bash tg-doctor.sh

STATE="${CLAUDE_GATEWAY_DIR:-$HOME/.claude-gateway}"

# Locate the install: git checkout first, then the global npm package.
INSTALL=""
for d in "$HOME/telegram_gateway" "$(npm root -g 2>/dev/null)/claude-code-telegram-gateway"; do
  [ -f "$d/gateway.js" ] && { INSTALL="$d"; break; }
done

# config.json may still be in the install dir (pre-1.0.4) or already migrated to STATE.
CONFIG=""
for c in "$STATE/config.json" "$INSTALL/config.json"; do
  [ -f "$c" ] && { CONFIG="$c"; break; }
done

# ~/.claude/projects dir for HOME, using Claude Code's own path encoding.
PROJ="$HOME/.claude/projects/$(echo "$HOME" | sed 's|^/||; s|[/.]|-|g; s|^|-|')"

echo "install:       ${INSTALL:-NOT FOUND}"
echo "state dir:     $STATE $([ -d "$STATE" ] && echo '(exists)' || echo '(absent — pre-1.0.4)')"
echo "config:        ${CONFIG:-NOT FOUND}"
PIDS=$(pgrep -f 'gateway\.js' | tr '\n' ' ' | sed 's/ *$//')
echo "running:       ${PIDS:-no}"

if [ -n "$CONFIG" ]; then
  echo "TITLE_MODE:    $(python3 -c "import json;print(json.load(open('$CONFIG')).get('TITLE_MODE','(absent -> default)'))" 2>/dev/null || echo '(unreadable)')"
fi

LOG="$INSTALL/gateway.log"
if [ -f "$LOG" ]; then
  echo "retry storms:  $(grep -c 'createForumTopic failed' "$LOG" 2>/dev/null || echo 0)"
  echo "poll timeouts: $(grep -c 'request timeout' "$LOG" 2>/dev/null || echo 0)"
else
  echo "retry storms:  (no gateway.log at $LOG)"
fi

echo "orphaned titlers: $(ls "$PROJ"/*.jsonl 2>/dev/null | wc -l | tr -d ' ')  in $PROJ"

VER="(unknown)"
[ -f "$INSTALL/package.json" ] && VER=$(python3 -c "import json;print(json.load(open('$INSTALL/package.json'))['version'])" 2>/dev/null)
echo "version:       $VER"
