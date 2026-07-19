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

# Convenience alias: `cr` resumes the most recent session in the primary repo.
PRIMARY_REPO="$(node -e 'const c=require("./config.json");const v=Object.values(c.REPO_MAPPINGS||{});process.stdout.write(v[0]||process.env.HOME)' 2>/dev/null || echo "$HOME")"
ALIAS_LINE="alias cr='cd \"$PRIMARY_REPO\" && claude -c'"
RC="$HOME/.zshrc"
if ! grep -qF "alias cr=" "$RC" 2>/dev/null; then
  printf '\n# Claude gateway: resume most recent session\n%s\n' "$ALIAS_LINE" >> "$RC"
  echo "🔗 Added 'cr' alias to $RC (open a new shell or 'source $RC')."
fi

echo "✅ Installed and started $LABEL."
echo "   Logs:   tail -f \"$DIR/gateway.log\""
echo "   Status: launchctl print gui/$(id -u)/$LABEL | grep -i state"
echo "   Stop:   ./uninstall-service.sh"
echo
echo "⚠️  For auto-topics: make the bot a group Admin with the 'Manage Topics' permission."
