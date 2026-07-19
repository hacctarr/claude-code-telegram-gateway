#!/usr/bin/env bash
# Stop and remove the Claude Code Telegram gateway launchd service.
set -euo pipefail
LABEL="com.claude.telegram-gateway"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST_DST"

# Strip the auto-resume block from ~/.zshrc (between the marker lines).
RC="$HOME/.zshrc"
if [ -f "$RC" ] && grep -qF 'claude-gateway auto-resume' "$RC"; then
  sed -i '' '/# >>> claude-gateway auto-resume >>>/,/# <<< claude-gateway auto-resume <<</d' "$RC" 2>/dev/null \
    || sed -i '/# >>> claude-gateway auto-resume >>>/,/# <<< claude-gateway auto-resume <<</d' "$RC"
  echo "🔗 Removed the auto-resume hook from $RC."
fi
echo "✅ Stopped and removed $LABEL."
