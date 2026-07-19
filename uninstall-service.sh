#!/usr/bin/env bash
# Stop and remove the Claude Code Telegram gateway launchd service.
set -euo pipefail
LABEL="com.claude.telegram-gateway"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST_DST"
echo "✅ Stopped and removed $LABEL."
echo "   (The 'cr' alias in ~/.zshrc, if added, was left in place — remove it manually if you like.)"
