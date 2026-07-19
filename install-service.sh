#!/usr/bin/env bash
# Install the Claude Code Telegram gateway as a macOS launchd service (auto-start + auto-restart).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.claude.telegram-gateway"
PLIST_SRC="$DIR/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then echo "❌ node not found on PATH. Install Node or fix PATH, then retry." >&2; exit 1; fi
NODE_DIR="$(dirname "$NODE_BIN")"

mkdir -p "$HOME/Library/LaunchAgents"

# Fill placeholders. Use | as sed delimiter since paths contain /.
sed -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__DIR__|$DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__PATH__|$NODE_DIR:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin|g" \
    "$PLIST_SRC" > "$PLIST_DST"

# (Re)load the service.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true

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
echo "   Logs:   tail -f \"$DIR/gateway.log\""
echo "   Status: launchctl print gui/$(id -u)/$LABEL | grep -i state"
echo "   Stop:   ./uninstall-service.sh"
echo
echo "⚠️  For auto-topics: make the bot a group Admin with the 'Manage Topics' permission."
