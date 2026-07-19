#!/usr/bin/env bash
# Probe: what happens when we inject a headless turn (claude -p --resume) into a session that
# may be OPEN in the native TUI? This is the core "phone -> desk" assumption behind idle-gated
# injection. Run the accompanying runbook (test/MANUAL-TESTS.md, Test A) alongside this.
#
# Usage:
#   test/inject-probe.sh                 # auto-picks the most recently modified session in the repo
#   test/inject-probe.sh <session-uuid>  # probe a specific session
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE="$(node -e 'const c=require("./config.json");process.stdout.write(c.CLAUDE_PATH||"claude")' 2>/dev/null || echo claude)"
REPO="$(node -e 'const c=require("./config.json");const v=Object.values(c.REPO_MAPPINGS||{});process.stdout.write(v[0]||process.env.HOME)' 2>/dev/null)"
PROJ="$HOME/.claude/projects/$(echo "$REPO" | sed 's|/|-|g')"

SID="${1:-}"
if [[ -z "$SID" ]]; then
  SID="$(basename "$(ls -t "$PROJ"/*.jsonl 2>/dev/null | head -1)" .jsonl)"
fi
FILE="$PROJ/$SID.jsonl"
if [[ ! -f "$FILE" ]]; then echo "❌ No session file at $FILE" >&2; exit 1; fi

echo "Repo:    $REPO"
echo "Session: $SID"
echo "File:    $FILE"
PRE_SIZE=$(stat -f%z "$FILE"); PRE_MTIME=$(stat -f%m "$FILE")
echo "Pre:  size=$PRE_SIZE mtime=$PRE_MTIME"
echo
echo "→ Injecting headless turn (this is what the gateway does when it thinks the desk is idle)…"
# IMPORTANT: claude resolves --resume against the CURRENT directory's project folder, so we must
# run from the repo (exactly as the gateway does via spawn cwd:repoDir). Running elsewhere yields
# a misleading "No conversation found".
set +e
OUT=$(cd "$REPO" && printf '%s' "Reply with exactly the word: INJECTED_OK" | "$CLAUDE" -p --resume "$SID" \
  --output-format json --permission-mode bypassPermissions 2>&1)
RC=$?
set -e

echo "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log("  exit_ok:",!j.is_error,"\n  same_session_id:",j.session_id);console.log("  result:",JSON.stringify(j.result));}catch(e){console.log("  ⚠️ non-JSON output (possible lock/conflict):\n"+s.slice(0,400))}})'
echo "  raw_exit_code: $RC"

POST_SIZE=$(stat -f%z "$FILE");
echo
echo "Post: size=$POST_SIZE (grew by $((POST_SIZE-PRE_SIZE)) bytes) — appended to the SAME file: $([ "$POST_SIZE" -gt "$PRE_SIZE" ] && echo yes || echo NO)"
NEW_FILES=$(find "$PROJ" -name '*.jsonl' -newermt "@$PRE_MTIME" ! -name "$SID.jsonl" 2>/dev/null | wc -l | tr -d ' ')
echo "New sibling session files created by the injection: $NEW_FILES (expect 0 — >0 means it forked)"
echo
echo "NEXT: switch to the TUI terminal, send another message, and confirm the TUI still works and"
echo "shows a coherent history. See test/MANUAL-TESTS.md (Test A) for how to read the result."
