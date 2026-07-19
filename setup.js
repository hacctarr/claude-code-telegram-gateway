#!/usr/bin/env node
'use strict';
// Interactive setup: validates the bot, auto-detects your claude path, auto-grabs your user id and
// group chat id from Telegram, and writes config.json. No dependencies. Run: npm run setup
const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');
const { execSync } = require('child_process');

const CONFIG = path.join(__dirname, 'config.json');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));
const yes = (s) => /^y/i.test(s);

function tg(token, method, payload = {}) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${token}/${method}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ ok: false }); } }); });
    req.on('error', () => resolve({ ok: false })); req.write(data); req.end();
  });
}
const expand = (p) => p.replace(/^~(?=\/|$)/, process.env.HOME);

(async () => {
  console.log('\n🤖  Claude Code Telegram Gateway — setup\n');

  let cfg = {};
  if (fs.existsSync(CONFIG)) {
    if (!yes(await ask('config.json already exists. Update it? [y/N] '))) { console.log('Aborted.'); return rl.close(); }
    try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { /* */ }
  }

  // 1) Bot token (validated via getMe)
  let token = cfg.BOT_TOKEN, me = null;
  for (;;) {
    const entered = await ask(`Bot token from @BotFather${token ? ` [keep ${token.slice(0, 8)}…]` : ''}: `);
    token = entered || token;
    if (!token) { console.log('  A token is required.'); continue; }
    process.stdout.write('  validating… ');
    me = await tg(token, 'getMe');
    if (me.ok) { console.log(`✅ @${me.result.username}`); break; }
    console.log('❌ invalid token — try again.');
  }
  cfg.BOT_TOKEN = token;
  const botId = String(me.result.id);

  // 2) Claude binary (auto-detected)
  let claudePath = cfg.CLAUDE_PATH;
  if (!claudePath) { try { claudePath = execSync('command -v claude', { shell: '/bin/bash' }).toString().trim(); } catch (e) { /* */ } }
  const cp = await ask(`Path to the claude binary${claudePath ? ` [${claudePath}]` : ''}: `);
  cfg.CLAUDE_PATH = cp || claudePath || 'claude';

  // 3) Your user id (auto-detected via getUpdates)
  console.log('\n👤 Your Telegram user id — the ONLY account allowed to control the bot.');
  console.log('   Open a DM with your bot (or post in your group) and send it any message.');
  await ask('   Press Enter once you have sent a message… ');
  let userId = null;
  const up1 = await tg(token, 'getUpdates', { timeout: 0 });
  if (up1.error_code === 409) console.log('   ⚠️ The gateway service seems to be running — stop it (./uninstall-service.sh) and re-run setup for auto-detect.');
  const senders = [...new Set((up1.result || []).map((u) => u.message && u.message.from && u.message.from.id).filter(Boolean))].filter((id) => String(id) !== botId);
  if (senders.length === 1) { userId = String(senders[0]); console.log(`   ✅ detected user id ${userId}`); }
  else if (senders.length > 1) { console.log('   Multiple senders:', senders.join(', ')); userId = await ask('   Which is yours? '); }
  if (!userId) userId = await ask('   Enter your numeric user id (get it from @userinfobot): ');
  cfg.ALLOWED_USER_IDS = userId ? [String(userId)] : (cfg.ALLOWED_USER_IDS || []);

  // 4) Group → repo mappings (chat id auto-detected)
  console.log('\n📁 Map each Telegram supergroup to a local repo directory.');
  cfg.REPO_MAPPINGS = cfg.REPO_MAPPINGS || {};
  for (;;) {
    if (!yes(await ask('   Add a group → repo mapping? [Y/n] ') || 'y')) break;
    console.log('   In that group\'s General topic, post any message.');
    await ask('   Press Enter once posted… ');
    const up = await tg(token, 'getUpdates', { timeout: 0 });
    const chats = [...new Map((up.result || [])
      .map((u) => u.message && u.message.chat)
      .filter((c) => c && (c.type === 'supergroup' || c.type === 'group'))
      .map((c) => [String(c.id), c])).values()];
    let chatId;
    if (chats.length) {
      chats.forEach((c, i) => console.log(`     [${i + 1}] ${c.id}  ${c.title || ''}`));
      const pick = await ask(`   Pick [1-${chats.length}] or type a chat id: `);
      chatId = (/^-?\d+$/.test(pick) && pick.length > 3) ? pick : String((chats[(parseInt(pick, 10) || 1) - 1] || chats[0]).id);
    } else {
      chatId = await ask('   Couldn\'t detect a group — enter its chat id (-100…): ');
    }
    let dir = expand(await ask('   Local repo directory (absolute path): '));
    if (dir && !fs.existsSync(dir) && !yes(await ask(`   ${dir} doesn't exist — use anyway? [y/N] `))) continue;
    if (chatId && dir) { cfg.REPO_MAPPINGS[chatId] = dir; console.log(`   ✅ ${chatId} → ${dir}`); }
  }

  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`\n✅ Wrote ${CONFIG}`);
  console.log('   (config.json is gitignored — your token stays local.)\n');

  if (yes(await ask('Run the Telegram permission check now? [Y/n] ') || 'y')) {
    try { execSync(`node ${path.join(__dirname, 'test', 'check-telegram.js')}`, { stdio: 'inherit' }); } catch (e) { /* */ }
  }
  if (yes(await ask('\nInstall as a background service (launchd, auto-start + restart)? [y/N] '))) {
    try { execSync(path.join(__dirname, 'install-service.sh'), { stdio: 'inherit' }); } catch (e) { /* */ }
  } else {
    console.log('\nStart it anytime:  npm start   (foreground)   ·   ./install-service.sh   (service)');
  }
  rl.close();
})().catch((e) => { console.error('setup error:', e.message); rl.close(); process.exit(1); });
