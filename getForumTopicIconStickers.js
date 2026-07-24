#!/usr/bin/env node
// Reprint Telegram's fixed forum-topic icon set (emoji + custom_emoji_id) so the ICON_RULES table
// in gateway.js can be refreshed if Telegram ever changes it. Only ids from this set are accepted
// as a topic's icon_custom_emoji_id. Reads BOT_TOKEN from ~/.claude-gateway/config.json.
//   node getForumTopicIconStickers.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const dir = process.env.CLAUDE_GATEWAY_DIR || path.join(os.homedir(), '.claude-gateway');
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const token = cfg.BOT_TOKEN;
if (!token) { console.error('No BOT_TOKEN in config.json'); process.exit(1); }

https.get(`https://api.telegram.org/bot${token}/getForumTopicIconStickers`, (r) => {
  let d = '';
  r.on('data', (c) => (d += c));
  r.on('end', () => {
    const j = JSON.parse(d);
    if (!j.ok) { console.error('API error:', d); process.exit(1); }
    console.log(`# ${j.result.length} topic-icon stickers`);
    for (const s of j.result) console.log(`${s.emoji}\t${s.custom_emoji_id}`);
  });
}).on('error', (e) => { console.error(e.message); process.exit(1); });
