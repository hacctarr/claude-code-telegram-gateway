#!/usr/bin/env node
'use strict';
// Delete every forum topic the gateway created (listed in links.json) and clear the store.
// This only removes the Telegram MIRROR topics — the underlying Claude sessions on disk are
// untouched. Use to recover from a bad run before reinstalling. Run: node test/reset-topics.js
const https = require('https');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const LINKS = path.join(__dirname, '..', 'links.json');
const links = fs.existsSync(LINKS) ? JSON.parse(fs.readFileSync(LINKS, 'utf8')) : {};

function tg(method, payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.telegram.org', port: 443, path: `/bot${cfg.BOT_TOKEN}/${method}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ ok: false }); } }); });
    req.on('error', () => resolve({ ok: false })); req.write(data); req.end();
  });
}

(async () => {
  const entries = Object.entries(links);
  if (!entries.length) { console.log('links.json is already empty — nothing to reset.'); return; }
  console.log(`Deleting ${entries.length} mirror topic(s)…`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const [sid, l] of entries) {
    let r = await tg('deleteForumTopic', { chat_id: l.chatId, message_thread_id: l.threadId });
    if (!r.ok && /Too Many Requests/i.test(r.description || '')) {   // back off and retry once
      const wait = ((r.parameters && r.parameters.retry_after) || 5) * 1000;
      console.log(`  rate-limited; waiting ${wait / 1000}s…`); await sleep(wait);
      r = await tg('deleteForumTopic', { chat_id: l.chatId, message_thread_id: l.threadId });
    }
    console.log(`  thread ${l.threadId} (${sid.slice(0, 8)}${l.label ? ' — ' + l.label.slice(0, 30) : ''}): ${r.ok ? '🗑 deleted' : '⚠️ ' + (r.description || 'failed')}`);
    await sleep(400);
  }
  fs.writeFileSync(LINKS, '{}');
  console.log('✅ Cleared links.json. The Claude sessions on disk are untouched; reinstall to re-create clean topics.');
})();
