#!/usr/bin/env node
'use strict';
// Live check that the bot can do what the gateway needs: identify itself, create a forum topic,
// post into it, and delete it. Verifies the "admin + Manage Topics" requirement without guessing.
// Run:  node test/check-telegram.js
const https = require('https');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const { BOT_TOKEN, REPO_MAPPINGS } = cfg;

function tg(method, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = https.request({
      hostname: 'api.telegram.org', port: 443, path: `/bot${BOT_TOKEN}/${method}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}

(async () => {
  const me = await tg('getMe');
  if (!me.ok) { console.error('❌ getMe failed — check BOT_TOKEN.', me); process.exit(1); }
  console.log(`✅ Bot: @${me.result.username} (id ${me.result.id})`);

  let allGood = true;
  for (const chatId of Object.keys(REPO_MAPPINGS)) {
    process.stdout.write(`\n— chat ${chatId} (${REPO_MAPPINGS[chatId]})\n`);

    const chat = await tg('getChat', { chat_id: chatId });
    if (!chat.ok) { console.error(`  ❌ getChat failed: ${chat.description}`); allGood = false; continue; }
    console.log(`  chat type: ${chat.result.type}, forum: ${chat.result.is_forum === true}`);
    if (!chat.result.is_forum) { console.error('  ❌ Topics/Forum not enabled on this group.'); allGood = false; }

    const admin = await tg('getChatMember', { chat_id: chatId, user_id: me.result.id });
    const status = admin.ok ? admin.result.status : 'unknown';
    const canManage = admin.ok && (admin.result.can_manage_topics === true || status === 'creator');
    console.log(`  bot status: ${status}, can_manage_topics: ${admin.ok ? admin.result.can_manage_topics : '?'}`);
    if (status !== 'administrator' && status !== 'creator') { console.error('  ❌ Bot is not an admin.'); allGood = false; continue; }

    const created = await tg('createForumTopic', { chat_id: chatId, name: '🔧 gateway self-test' });
    if (!created.ok) { console.error(`  ❌ createForumTopic failed: ${created.description}`); allGood = false; continue; }
    const threadId = created.result.message_thread_id;
    console.log(`  ✅ created topic ${threadId}`);
    await tg('sendMessage', { chat_id: chatId, message_thread_id: threadId, text: 'Self-test OK — deleting this topic.' });
    const del = await tg('deleteForumTopic', { chat_id: chatId, message_thread_id: threadId });
    console.log(del.ok ? '  ✅ posted + deleted self-test topic (cleanup done)' : `  ⚠️ could not delete self-test topic: ${del.description}`);
  }

  console.log(`\n${allGood ? '✅ All checks passed — auto-topics + mirroring will work.' : '❌ Some checks failed — fix the above before relying on auto-topics.'}`);
  process.exit(allGood ? 0 : 1);
})().catch((e) => { console.error('check-telegram error:', e); process.exit(1); });
