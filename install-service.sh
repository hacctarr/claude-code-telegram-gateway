#!/usr/bin/env bash
# Install the Claude Code Telegram gateway as a macOS launchd service (auto-start + auto-restart).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.claude.telegram-gateway"
PLIST_SRC="$DIR/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

# GATEWAY_NODE pins the interpreter. The plist takes an absolute path, so whatever
# resolves here is what the daemon runs until it is reinstalled, and the installing
# shell is a poor thing to decide that: a PATH temporarily prepended for some other
# tool silently changes which node a long-lived service gets.
NODE_BIN="${GATEWAY_NODE:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then echo "❌ node not found on PATH. Install Node, fix PATH, or set GATEWAY_NODE, then retry." >&2; exit 1; fi
NODE_DIR="$(dirname "$NODE_BIN")"
echo "   node:   $NODE_BIN"

mkdir -p "$HOME/Library/LaunchAgents"
# launchd will not start a service whose StandardOutPath directory is missing, and the
# failure surfaces as a bare I/O error with nothing naming the cause.
mkdir -p "$HOME/.claude-gateway"

# A launchd job inherits almost nothing, so this string is the daemon's whole PATH.
# /opt/homebrew/bin belongs in it: that is where a Mac keeps its tools, and without
# it a spawn fails with "command not found" inside a process nobody is watching.
# Deduplicated because $NODE_DIR is frequently one of the standard entries already;
# a laptop was found with /usr/local/bin listed twice for exactly that reason.
GATEWAY_PATH=""
for d in "$NODE_DIR" /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
  case ":$GATEWAY_PATH:" in
    *":$d:"*) continue ;;                       # already present, skip
  esac
  GATEWAY_PATH="${GATEWAY_PATH:+$GATEWAY_PATH:}$d"
done

# Fill placeholders. Use | as sed delimiter since paths contain /.
sed -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__DIR__|$DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__PATH__|$GATEWAY_PATH|g" \
    "$PLIST_SRC" > "$PLIST_DST"

# (Re)load the service. bootout is async, so retry bootstrap a few times to dodge the
# "Input/output error (5)" race when the old instance hasn't fully torn down yet.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
booted=0
for _ in 1 2 3 4 5; do
  sleep 1
  if launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" 2>/dev/null; then booted=1; break; fi
done
if [ "$booted" != 1 ]; then
  echo "⚠️  launchctl bootstrap failed. Try: launchctl bootout gui/$(id -u)/$LABEL ; ./install-service.sh" >&2
fi
launchctl enable "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl kickstart "gui/$(id -u)/$LABEL" 2>/dev/null || true

# Shell integration: auto-resume the branch you were working on from your phone, so opening a
# terminal drops you straight back in — no `cr` needed (multi-repo aware). `cr` stays as a manual
# fallback. The block is idempotent and marked so uninstall can strip it.
RC="$HOME/.zshrc"
if ! grep -qF 'claude-gateway auto-resume' "$RC" 2>/dev/null; then
  cat >> "$RC" <<HOOK

# >>> claude-gateway auto-resume >>>
# On an interactive shell, resume any branch you just drove from your phone, then clear the marker.
_claude_gateway_resume() {
  local out; out="\$(node "$DIR/resume-hook.js" 2>/dev/null)" || return
  [ -z "\$out" ] && return
  local repo="\${out%%\$'\t'*}" sid="\${out##*\$'\t'}"
  [ -d "\$repo" ] && cd "\$repo" && command claude --resume "\$sid"
}
alias cr='node "$DIR/resume-hook.js" >/dev/null 2>&1; claude -c'   # manual: resume most recent here
[[ -o interactive ]] && _claude_gateway_resume
# <<< claude-gateway auto-resume <<<
HOOK
  echo "🔗 Added auto-resume hook to $RC (open a new terminal to use it)."
fi

echo "✅ Installed and started $LABEL."
echo "   Logs:   tail -f \"$HOME/.claude-gateway/gateway.log\""
echo "   Status: launchctl print gui/$(id -u)/$LABEL | grep -i state"
echo "   Stop:   ./uninstall-service.sh"
echo
echo "⚠️  For auto-topics: make the bot a group Admin with the 'Manage Topics' permission."
