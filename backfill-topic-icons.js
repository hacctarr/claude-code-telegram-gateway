#!/usr/bin/env node
// Backfill custom-emoji icons onto existing forum topics recorded in links.json. Icon-only: the
// current topic name is left untouched (editForumTopic keeps it when `name` is omitted), so
// LLM-generated names are preserved and no titling turns are spent. Idempotent — safe to re-run.
//   node backfill-topic-icons.js          # dry run: print the label → icon plan
//   node backfill-topic-icons.js --apply  # apply the icons
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const g = require('./gateway.js');   // module mode — polling/lock are behind require.main guard

const APPLY = process.argv.includes('--apply');
const dir = process.env.CLAUDE_GATEWAY_DIR || path.join(os.homedir(), '.claude-gateway');
const token = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).BOT_TOKEN;
const raw = JSON.parse(fs.readFileSync(path.join(dir, 'links.json'), 'utf8'));
const map = raw.linkBySession || raw;

function api(method, params) {
  return new Promise((res) => {
    const body = JSON.stringify(params);
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${token}/${method}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); });
    req.on('error', (e) => res({ ok: false, description: e.message }));
    req.write(body); req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const links = Object.values(map).filter((v) => !v.closed);
  console.log(`${links.length} open topics; mode = ${APPLY ? 'APPLY' : 'dry run'}\n`);
  let ok = 0, fail = 0;
  for (const l of links) {
    const icon = g.pickIcon(l.label);
    const label = (l.label || '').slice(0, 50).replace(/\n/g, ' ');
    if (!APPLY) { console.log(`  ${icon.emoji}  [${l.threadId}] ${label}`); continue; }
    let r = await api('editForumTopic', { chat_id: l.chatId, message_thread_id: l.threadId, icon_custom_emoji_id: icon.id });
    if (!r.ok && /retry after (\d+)/i.test(r.description || '')) {
      const wait = (parseInt(RegExp.$1, 10) + 1) * 1000;
      console.log(`  …rate-limited on ${l.threadId}, waiting ${wait / 1000}s`);
      await sleep(wait);
      r = await api('editForumTopic', { chat_id: l.chatId, message_thread_id: l.threadId, icon_custom_emoji_id: icon.id });
    }
    if (r.ok) { ok++; console.log(`  ✓ ${icon.emoji}  [${l.threadId}] ${label}`); }
    else { fail++; console.log(`  ✗ [${l.threadId}] ${label} — ${r.description}`); }
    await sleep(400);
  }
  if (APPLY) console.log(`\ndone: ${ok} set, ${fail} failed`);
})();
