---
description: Pull phone-branch turns into this open desk session and rebind its Telegram topic
---

Run exactly this command with the Bash tool (single command, no pipes, no cd):

    node "{{GATEWAY_DIR}}/catchup.js"

Then:

1. If the output starts with "nothing pending" or "catchup:", relay that line to the user and stop.
2. Otherwise the output is a verbatim digest of the phone branch: lines marked "📱 phone:" are
   prompts the user sent from their phone, 🔧 lines are one-line tool traces, and the rest is the
   assistant's replies. Treat those turns as things that already happened in this conversation.
3. Reply with a one-paragraph recap of what happened on the phone and where the work now stands.
4. Do not edit links.json, superseded.json, or catchup.json. The gateway daemon performs the
   Telegram topic rebind itself within a few seconds of the command finishing.
