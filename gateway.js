const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
if (!fs.existsSync('./config.json')) {
  console.error("Error: config.json file not found. Copy config.example.json to config.json and populate it.");
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const {
  BOT_TOKEN,
  ALLOWED_USER_IDS,
  REPO_MAPPINGS,
  CLAUDE_PATH,
  PERMISSION_MODE,   // bypassPermissions (default) | acceptEdits | manual | plan | dontAsk | auto
  MODEL,             // e.g. "opus"
  EXTRA_ARGS,        // array of extra CLI args, e.g. ["--effort","high"]
  SHOW_TOOL_ACTIVITY // bool, default true — show 🔧 tool steps
} = config;

const BOT_ID = (BOT_TOKEN || '').split(':')[0];   // bot's own user id (token prefix)
const CLAUDE_BINARY = CLAUDE_PATH || 'claude';
const PERM_MODE = PERMISSION_MODE || 'bypassPermissions';
const EXTRA = Array.isArray(EXTRA_ARGS) ? EXTRA_ARGS : [];
const SHOW_TOOLS = SHOW_TOOL_ACTIVITY !== false;

// Mirroring / auto-topic behavior (all optional, sensible defaults).
const MIRROR = config.MIRROR !== false;
const AUTO_CREATE_TOPICS = config.AUTO_CREATE_TOPICS !== false;
const IDLE_INJECT_MS = (config.IDLE_INJECT_SECONDS || 15) * 1000;
const ACTIVE_WINDOW_MS = (config.ACTIVE_WINDOW_MIN || 30) * 60_000;
const PRUNE_AFTER_MS = (config.PRUNE_AFTER_DAYS || 7) * 86_400_000;
const PRUNE_MODE = config.PRUNE_MODE || 'close';   // "close" | "delete"
const POLL_MS = config.POLL_MS || 2000;
const MIRROR_FLUSH_MS = config.MIRROR_FLUSH_MS || 4000;  // min gap between mirror posts per topic

// repoDir (resolved) -> chatId, so a session's cwd tells us which supergroup owns it.
function invertRepoMappings(mappings) {
  const out = {};
  for (const [chatId, dir] of Object.entries(mappings || {})) out[resolveHome(dir)] = chatId;
  return out;
}

// ---------------------------------------------------------------------------
// Link store: sessionId <-> Telegram topic. Replaces the old sessions.json map.
//   links.json = { "<sessionId>": { chatId, threadId, label, offset, closed } }
// ---------------------------------------------------------------------------
const LINKS_FILE = path.join(__dirname, 'links.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json'); // legacy, migrated once

const IGNORED_FILE = path.join(__dirname, 'ignored.json');
let linkBySession = {};                 // sessionId -> link
const sessionByThread = new Map();      // "chatId_threadId" -> sessionId
const ignoredSessions = new Set();      // sessions deliberately detached via /new — don't re-topic

function loadIgnored(file = IGNORED_FILE, set = ignoredSessions) {
  try { if (fs.existsSync(file)) for (const s of JSON.parse(fs.readFileSync(file, 'utf8'))) set.add(s); }
  catch (e) { /* */ }
  return set;
}
function persistIgnored(file = IGNORED_FILE, set = ignoredSessions) {
  try { fs.writeFileSync(file, JSON.stringify([...set])); } catch (e) { /* */ }
}

// Only real interactive sessions (with an actual user message) get a topic. This filters out
// sub-agent/sidechain and empty/command-only session files that would otherwise spawn junk topics.
function shouldAutoCreate(info) { return !!(info && info.label && info.label.trim()); }

function splitThreadKey(key) { const i = key.lastIndexOf('_'); return [key.slice(0, i), key.slice(i + 1)]; }

function buildThreadIndex(links) {
  const m = new Map();
  for (const [sid, l] of Object.entries(links)) m.set(`${l.chatId}_${l.threadId}`, sid);
  return m;
}

function migrateLegacy(links, legacy) {
  for (const [threadKey, sid] of Object.entries(legacy || {})) {
    if (links[sid]) continue;
    const [chatId, threadId] = splitThreadKey(threadKey);
    if (chatId && threadId) links[sid] = { chatId, threadId: Number(threadId), label: '', offset: 0, closed: false };
  }
  return links;
}

function loadLinks() {
  try { if (fs.existsSync(LINKS_FILE)) linkBySession = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8')); }
  catch (e) { console.warn('Could not read links.json, starting fresh:', e.message); linkBySession = {}; }
  if (fs.existsSync(SESSIONS_FILE)) {
    try { migrateLegacy(linkBySession, JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))); } catch (e) { /* */ }
  }
  // Any link with no committed offset (freshly migrated) must start from the CURRENT end of the
  // transcript — otherwise the first mirror poll would replay the entire history into the topic.
  for (const [sid, l] of Object.entries(linkBySession)) {
    if (!l.offset) {
      const f = sessionFileById(sid);
      try { l.offset = f ? fs.statSync(f).size : 0; } catch (e) { l.offset = 0; }
    }
  }
  const idx = buildThreadIndex(linkBySession);
  sessionByThread.clear();
  for (const [k, v] of idx) sessionByThread.set(k, v);
  persistLinks();
}

function persistLinks() {
  try { fs.writeFileSync(LINKS_FILE, JSON.stringify(linkBySession, null, 2)); }
  catch (e) { console.error('Failed to persist links.json:', e.message); }
}

// Per-thread serialization: one Claude turn at a time per topic.
const threadChains = new Map();
const injecting = new Set();             // sessionIds the gateway is currently driving (suppress mirror)
const queues = new Map();                // sessionId -> [prompt] awaiting an idle desk session
const lastMirrorAt = new Map();          // sessionId -> ts of last mirror post (rate-limit coalescing)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resolveHome(filepath) {
  if (filepath.startsWith('~/') || filepath === '~') return path.join(process.env.HOME, filepath.slice(1));
  return filepath;
}

const repoToChat = invertRepoMappings(REPO_MAPPINGS);

// --- Session discovery -----------------------------------------------------
const CONTENT_SEARCH_MAX_BYTES = 3_000_000;

function allSessionFiles() {
  const projectsDir = path.join(process.env.HOME, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return [];
  const gather = (dir) => {
    let out = [];
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      let st; try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) out = out.concat(gather(p));
      else if (f.endsWith('.jsonl')) out.push(p);
    }
    return out;
  };
  return gather(projectsDir);
}

const cwdCache = new Map();  // filePath -> cwd (immutable per session)
function getCwd(file) {
  if (cwdCache.has(file)) return Promise.resolve(cwdCache.get(file));
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: fs.createReadStream(file) });
    let found = false;
    rl.on('line', (line) => {
      if (found) return;
      let o; try { o = JSON.parse(line); } catch (e) { return; }
      if (o.cwd) { found = true; cwdCache.set(file, o.cwd); rl.close(); resolve(o.cwd); }
    });
    rl.on('close', () => { if (!found) resolve(null); });
    rl.on('error', () => resolve(null));
  });
}

function sessionFileById(sessionId) {
  for (const file of cwdCache.keys()) if (path.basename(file, '.jsonl') === sessionId) return file;
  for (const f of allSessionFiles()) if (path.basename(f, '.jsonl') === sessionId) return f;
  return null;
}

// Stream a session file just far enough to read its cwd + first real user message.
function readSessionInfo(file) {
  return new Promise((resolve) => {
    let cwd = null, label = null, size = 0, mtime = 0;
    try { const st = fs.statSync(file); size = st.size; mtime = st.mtimeMs; } catch (e) { /* */ }
    const rl = require('readline').createInterface({ input: fs.createReadStream(file) });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let o; try { o = JSON.parse(line); } catch (e) { return; }
      if (!cwd && o.cwd) cwd = o.cwd;
      if (!label && o.type === 'user' && o.message) {
        const c = o.message.content;
        let t = typeof c === 'string' ? c : (Array.isArray(c) ? (c.find((b) => b.type === 'text') || {}).text : null);
        if (t && !t.startsWith('<') && !o.isMeta) label = t.replace(/\s+/g, ' ').trim().slice(0, 80);
      }
      if (cwd && label) rl.close();
    });
    rl.on('close', () => resolve({ id: path.basename(file, '.jsonl'), path: file, cwd, label, size, mtime }));
    rl.on('error', () => resolve({ id: path.basename(file, '.jsonl'), path: file, cwd, label, size, mtime }));
  });
}

async function listSessions(repoDir) {
  const target = resolveHome(repoDir);
  const infos = await Promise.all(allSessionFiles().map(readSessionInfo));
  return infos.filter((s) => s.cwd === target).sort((a, b) => b.mtime - a.mtime);
}

async function matchSessions(repoDir, term) {
  const t = term.toLowerCase();
  const sessions = await listSessions(repoDir);
  const byLabel = sessions.filter((s) => (s.label || '').toLowerCase().includes(t) || s.id.toLowerCase().startsWith(t));
  if (byLabel.length) return byLabel;
  return sessions.filter((s) => {
    if (s.size > CONTENT_SEARCH_MAX_BYTES) return false;
    try { return fs.readFileSync(s.path, 'utf8').toLowerCase().includes(t); } catch (e) { return false; }
  });
}

function relTime(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function formatSessionList(sessions, max = 12) {
  return sessions.slice(0, max).map((s) =>
    `• ${s.label || '(no first message)'}\n  ${relTime(s.mtime)} — id: ${s.id}`
  ).join('\n\n');
}

// --- Activity windows (pure) ----------------------------------------------
function isActive(mtime, now = Date.now()) { return (now - mtime) <= ACTIVE_WINDOW_MS; }
function shouldPrune(mtime, now = Date.now()) { return (now - mtime) > PRUNE_AFTER_MS; }
function isDeskBusy(mtime, now = Date.now()) { return (now - mtime) <= IDLE_INJECT_MS; }

// ---------------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------------
function telegramRequest(method, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'api.telegram.org', port: 443,
      path: `/bot${BOT_TOKEN}/${method}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendPlain(chatId, threadId, text) {
  const MAX = 4000;
  let rest = text;
  const chunks = [];
  while (rest.length > MAX) {
    let cut = rest.lastIndexOf('\n', MAX);
    if (cut < MAX * 0.5) cut = MAX;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) chunks.push(rest);
  for (const c of chunks) {
    try { await telegramRequest('sendMessage', { chat_id: chatId, message_thread_id: threadId, text: c }); }
    catch (e) { console.error('sendPlain error:', e.code || e.message || String(e)); }
  }
}

function startTyping(chatId, threadId) {
  const ping = () => telegramRequest('sendChatAction', { chat_id: chatId, message_thread_id: threadId, action: 'typing' }).catch(() => {});
  ping();
  return setInterval(ping, 4000);
}

async function createForumTopic(chatId, name) {
  const r = await telegramRequest('createForumTopic', { chat_id: chatId, name: name.slice(0, 128) })
    .catch((e) => ({ ok: false, description: e.message }));
  if (!r.ok) { console.error(`[Topic] createForumTopic failed (${r.description || 'unknown'}). Bot needs admin + Manage Topics.`); return null; }
  return r.result.message_thread_id;
}
const closeForumTopic = (chatId, threadId) => telegramRequest('closeForumTopic', { chat_id: chatId, message_thread_id: threadId }).catch(() => {});
const reopenForumTopic = (chatId, threadId) => telegramRequest('reopenForumTopic', { chat_id: chatId, message_thread_id: threadId }).catch(() => {});
const deleteForumTopic = (chatId, threadId) => telegramRequest('deleteForumTopic', { chat_id: chatId, message_thread_id: threadId }).catch(() => {});

// ---------------------------------------------------------------------------
// LiveMessage (unchanged): in-place, throttled editing with page rollover.
// ---------------------------------------------------------------------------
const PAGE_MAX = 3800;
const EDIT_INTERVAL_MS = 1500;

class LiveMessage {
  constructor(chatId, threadId) {
    this.chatId = chatId;
    this.threadId = threadId;
    this.frozenLen = 0;
    this.curId = null;
    this.sentForCur = '';
    this.lastEditAt = 0;
    this.flushTimer = null;
    this.running = null;
    this.pending = null;
    this.forceNext = false;
  }

  async _sendNew(text) {
    const r = await telegramRequest('sendMessage', {
      chat_id: this.chatId, message_thread_id: this.threadId, text: text || '…'
    }).catch((e) => { console.error('live send error:', e.message); return null; });
    return r && r.ok ? r.result.message_id : null;
  }

  async _editCur(text) {
    if (this.curId == null || text === this.sentForCur) return;
    this.sentForCur = text;
    this.lastEditAt = Date.now();
    await telegramRequest('editMessageText', {
      chat_id: this.chatId, message_id: this.curId, text: text || '…'
    }).catch(() => { /* "message not modified" etc. */ });
  }

  _splitPoint(text) {
    if (text.length <= PAGE_MAX) return text.length;
    let cut = text.lastIndexOf('\n', PAGE_MAX);
    if (cut < PAGE_MAX * 0.5) cut = text.lastIndexOf(' ', PAGE_MAX);
    if (cut < PAGE_MAX * 0.5) cut = PAGE_MAX;
    return cut;
  }

  set(full, force = false) {
    this.pending = full;
    if (force) this.forceNext = true;
    if (this.running) return this.running;
    this.running = (async () => {
      while (this.pending != null) {
        const f = this.pending; this.pending = null;
        const force2 = this.forceNext; this.forceNext = false;
        await this._apply(f, force2);
      }
      this.running = null;
    })();
    return this.running;
  }

  async _apply(full, force) {
    let tail = full.slice(this.frozenLen);
    while (tail.length > PAGE_MAX) {
      const cut = this._splitPoint(tail);
      const chunk = tail.slice(0, cut);
      if (this.curId == null) this.curId = await this._sendNew(chunk);
      else await this._editCur(chunk);
      this.frozenLen += chunk.length;
      this.curId = null;
      this.sentForCur = '';
      tail = full.slice(this.frozenLen);
    }
    if (this.curId == null) {
      if (tail.trim()) { this.curId = await this._sendNew(tail); this.sentForCur = tail; }
      return;
    }
    const since = Date.now() - this.lastEditAt;
    if (!force && since < EDIT_INTERVAL_MS) {
      if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = null; this.set(full); }, EDIT_INTERVAL_MS - since);
      return;
    }
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    await this._editCur(tail);
  }

  async finalize(full) {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    await this.set(full, true);
  }
}

// ---------------------------------------------------------------------------
// Rendering: streamed events (createFeed) and stored transcript lines.
// ---------------------------------------------------------------------------
function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (name === 'Bash' && input.command) return input.command.replace(/\s+/g, ' ').slice(0, 120);
  const key = input.file_path || input.path || input.pattern || input.query || input.url;
  if (key) return String(key).slice(0, 120);
  const s = JSON.stringify(input);
  return s.length > 100 ? s.slice(0, 100) + '…' : s;
}

function createFeed(showTools = true) {
  let body = '';
  const feed = {
    sawContent: false, sessionId: null, isError: false, resultText: null,
    render() { return body.trim() || '⚙️ Working…'; },
    handle(o) {
      if (!o || typeof o !== 'object') return false;
      if (o.type === 'stream_event' && o.event && o.event.type === 'content_block_delta'
          && o.event.delta && o.event.delta.type === 'text_delta') {
        body += o.event.delta.text; feed.sawContent = true; return true;
      }
      if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
        let changed = false;
        for (const block of o.message.content) {
          if (block.type === 'tool_use' && showTools) {
            const summary = summarizeToolInput(block.name, block.input);
            if (body && !body.endsWith('\n')) body += '\n';
            body += `🔧 ${block.name}${summary ? ': ' + summary : ''}\n`;
            feed.sawContent = true; changed = true;
          }
        }
        return changed;
      }
      if (o.type === 'result') {
        feed.sessionId = o.session_id || null;
        feed.isError = !!o.is_error || o.subtype !== 'success';
        feed.resultText = typeof o.result === 'string' ? o.result : null;
      }
      return false;
    },
    finish() { if (feed.resultText && !feed.sawContent) body = feed.resultText; return feed.render(); }
  };
  return feed;
}

// A stored transcript record -> zero or more Telegram post strings.
function renderTranscriptLine(o, showTools = true) {
  if (!o || typeof o !== 'object') return [];
  if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
    const out = [];
    for (const b of o.message.content) {
      if (b.type === 'text' && b.text && b.text.trim()) out.push(b.text.trim());
      else if (b.type === 'tool_use' && showTools) {
        const s = summarizeToolInput(b.name, b.input);
        out.push(`🔧 ${b.name}${s ? ': ' + s : ''}`);
      }
    }
    return out;
  }
  if (o.type === 'user' && !o.isMeta && o.message) {
    const c = o.message.content;
    const t = typeof c === 'string' ? c : (Array.isArray(c) ? (c.find((x) => x.type === 'text') || {}).text : null);
    if (t && !t.startsWith('<') && t.trim()) return [`🖥️ desk: ${t.replace(/\s+/g, ' ').trim()}`];
    return [];
  }
  return [];
}

// Read complete JSONL records appended since `offset`. Returns parsed lines + advanced offset.
function readNewLines(filePath, offset) {
  let size;
  try { size = fs.statSync(filePath).size; } catch (e) { return { lines: [], newOffset: offset }; }
  if (size <= offset) return { lines: [], newOffset: offset };
  const len = size - offset;
  const buf = Buffer.alloc(len);
  let fd;
  try { fd = fs.openSync(filePath, 'r'); fs.readSync(fd, buf, 0, len, offset); }
  catch (e) { return { lines: [], newOffset: offset }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return { lines: [], newOffset: offset };   // no complete line yet
  const complete = text.slice(0, lastNl);
  const newOffset = offset + Buffer.byteLength(complete, 'utf8') + 1;
  const lines = [];
  for (const line of complete.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    lines.push(o);
  }
  return { lines, newOffset };
}

// ---------------------------------------------------------------------------
// Running a Claude turn (streaming headless) — used for phone injections.
// ---------------------------------------------------------------------------
function runClaudeTurn(prompt, cwd, sessionId, live, createId) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
                  '--permission-mode', PERM_MODE];
    if (MODEL) args.push('--model', MODEL);
    if (sessionId) args.push('--resume', sessionId);
    else if (createId) args.push('--session-id', createId);  // deterministic id for a fresh session
    args.push(...EXTRA);

    console.log(`[Claude] ${sessionId ? 'resume ' + sessionId : 'new session'} in ${cwd}`);
    const child = spawn(CLAUDE_BINARY, args, { cwd, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const feed = createFeed(SHOW_TOOLS);
    let stderr = '', rem = '';

    child.stdout.on('data', (d) => {
      rem += d.toString();
      const lines = rem.split('\n');
      rem = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let o; try { o = JSON.parse(line); } catch (e) { continue; }
        try { if (feed.handle(o)) live.set(feed.render()); } catch (e) { console.error('event handler error:', e.message); }
      }
    });
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => resolve({ ok: false, error: `Failed to launch Claude: ${err.message}`, sawContent: feed.sawContent }));
    child.on('close', () => {
      const body = feed.finish();
      if (feed.isError) {
        const msg = feed.resultText || stderr.trim().slice(0, 400) || 'Claude returned an error.';
        return resolve({ ok: false, error: msg, sessionId: feed.sessionId, sawContent: feed.sawContent, body });
      }
      resolve({ ok: true, sessionId: feed.sessionId, sawContent: feed.sawContent, body });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Bind (or rebind) a session to a Telegram thread; reconcile a duplicate auto-topic if any.
async function upsertLink(sessionId, chatId, threadId, labelHint) {
  const existing = linkBySession[sessionId];
  if (existing && (existing.chatId !== chatId || existing.threadId !== threadId)) {
    // A different topic (likely auto-created by the poller) already owns this session — close it.
    sessionByThread.delete(`${existing.chatId}_${existing.threadId}`);
    closeForumTopic(existing.chatId, existing.threadId);
  }
  const link = existing && existing.chatId === chatId && existing.threadId === threadId
    ? existing
    : { chatId, threadId, label: '', offset: 0, closed: false };
  link.chatId = chatId; link.threadId = threadId; link.closed = false;
  if (!link.label && labelHint) link.label = labelHint.replace(/\s+/g, ' ').trim().slice(0, 80);
  linkBySession[sessionId] = link;
  sessionByThread.set(`${chatId}_${threadId}`, sessionId);
  ignoredSessions.delete(sessionId);
  return link;
}

// A resumed turn "sticks" only if the transcript grew. If it didn't, the desk TUI is holding the
// session open and the injected turn ran in memory only (verified behavior) — nothing was saved.
function persisted(sizeBefore, sizeAfter) { return sizeAfter > sizeBefore; }

// Drive one turn in `threadId` on behalf of `knownSessionId` (or a fresh session if null).
async function driveTurn(chatId, threadId, prompt, knownSessionId) {
  const repoDir = resolveHome(REPO_MAPPINGS[chatId]);
  const typing = startTyping(chatId, threadId);
  const live = new LiveMessage(chatId, threadId);
  const sessionId = knownSessionId || null;
  // For a fresh session, mint the id up front and reserve it so the poller can't race us into a
  // duplicate topic before we bind it.
  const createId = sessionId ? null : crypto.randomUUID();
  let activeSid = sessionId || createId;   // which session to un-suppress in finally
  let sizeBefore = 0;
  if (activeSid) injecting.add(activeSid);
  if (sessionId) { try { sizeBefore = fs.statSync(sessionFileById(sessionId)).size; } catch (e) { /* */ } }
  try {
    const result = await runClaudeTurn(prompt, repoDir, sessionId, live, createId);
    clearInterval(typing);

    // Injection into an existing session that failed to resume: do NOT fork a divergent session.
    if (!result.ok && sessionId && !result.sawContent) {
      await live.finalize(`⚠️ Couldn't reach session ${sessionId.slice(0, 8)} — it may have been cleared. ` +
        `Send /sessions to pick another, or /new to start fresh here.`);
      return;
    }

    let finalText = result.ok ? result.body
      : `${result.body && result.body !== '⚙️ Working…' ? result.body + '\n\n' : ''}⚠️ ${result.error}`;

    // Held-open detection: injected into an existing session but nothing persisted → desk owns it.
    let heldOpen = false;
    if (sessionId && result.ok) {
      let sizeAfter = sizeBefore;
      try { sizeAfter = fs.statSync(sessionFileById(sessionId)).size; } catch (e) { /* */ }
      if (!persisted(sizeBefore, sizeAfter)) {
        heldOpen = true;
        finalText += `\n\n⚠️ The desk session is open right now, so this ran but was NOT saved to it ` +
          `(the desk won't see it). Close the desk session — or use /new here — so phone replies stick.`;
      }
    }
    await live.finalize(finalText);

    const finalSid = result.sessionId || sessionId || createId;
    if (finalSid) {
      injecting.add(finalSid);
      if (createId && finalSid !== createId) injecting.delete(createId);  // release unused reservation
      activeSid = finalSid;
      await upsertLink(finalSid, chatId, threadId, prompt);
      if (!heldOpen) { try { linkBySession[finalSid].offset = fs.statSync(sessionFileById(finalSid)).size; } catch (e) { /* */ } }
      persistLinks();
    }
    console.log(`[Drive → thread ${threadId}] ok=${result.ok} session=${finalSid || '—'}${heldOpen ? ' (held/ephemeral)' : ''}`);
  } catch (err) {
    clearInterval(typing);
    console.error('driveTurn error:', err);
    await sendPlain(chatId, threadId, `⚠️ Gateway error: ${err.message}`);
  } finally {
    if (activeSid) injecting.delete(activeSid);
  }
}

function scheduleDrive(chatId, threadId, prompt, sessionId) {
  const key = `${chatId}_${threadId}`;
  const prev = threadChains.get(key) || Promise.resolve();
  const next = prev.then(() => driveTurn(chatId, threadId, prompt, sessionId)).catch((e) => console.error(e));
  threadChains.set(key, next);
  return next;
}

function queueForSession(sessionId, prompt) {
  if (!queues.has(sessionId)) queues.set(sessionId, []);
  queues.get(sessionId).push(prompt);
}

// ---------------------------------------------------------------------------
// Topic lifecycle
// ---------------------------------------------------------------------------
function topicName(info) {
  return info.label ? `🤖 ${info.label.slice(0, 60)}` : `🤖 Claude ${info.id.slice(0, 8)}`;
}
function openerText(info) {
  return `🤖 Claude session ${info.id.slice(0, 8)}` +
    (info.label ? `\n“${info.label}”` : '') +
    `\nLast active ${relTime(info.mtime)}.\n\n` +
    `This topic mirrors the desk session live. Reply here to steer it — your message runs when the ` +
    `desk session is idle. Back at the Mac, run \`cr\` (claude -c) to resume with your phone turns included.`;
}

async function ensureTopicForSession(info) {
  if (linkBySession[info.id] || ignoredSessions.has(info.id)) return linkBySession[info.id] || null;
  if (!shouldAutoCreate(info)) return null;   // skip sub-agent/empty/command-only sessions
  const chatId = repoToChat[info.cwd];
  if (!chatId || !AUTO_CREATE_TOPICS) return null;
  const threadId = await createForumTopic(chatId, topicName(info));
  if (!threadId) return null;
  linkBySession[info.id] = { chatId, threadId, label: info.label || '', offset: info.size || 0, closed: false };
  sessionByThread.set(`${chatId}_${threadId}`, info.id);
  persistLinks();
  await sendPlain(chatId, threadId, openerText(info));
  console.log(`[Topic] created for ${info.id.slice(0, 8)} → chat ${chatId} thread ${threadId}`);
  return linkBySession[info.id];
}

async function pruneTopic(sessionId) {
  const l = linkBySession[sessionId];
  if (!l) return;
  if (PRUNE_MODE === 'delete') {
    await deleteForumTopic(l.chatId, l.threadId);
    sessionByThread.delete(`${l.chatId}_${l.threadId}`);
    delete linkBySession[sessionId];
  } else {
    await closeForumTopic(l.chatId, l.threadId);
    l.closed = true;
  }
  persistLinks();
  console.log(`[Topic] pruned (${PRUNE_MODE}) session ${sessionId.slice(0, 8)}`);
}

async function reviveTopic(sessionId) {
  const l = linkBySession[sessionId];
  if (!l || !l.closed) return;
  await reopenForumTopic(l.chatId, l.threadId);
  l.closed = false;
  persistLinks();
  console.log(`[Topic] reopened session ${sessionId.slice(0, 8)}`);
}

// ---------------------------------------------------------------------------
// Poll loop: discover new sessions, mirror activity, prune, flush queues.
// ---------------------------------------------------------------------------
let polling = false;
async function pollTick() {
  if (polling) return;
  polling = true;
  try {
    const now = Date.now();
    const files = allSessionFiles();
    const existingIds = new Set(files.map((f) => path.basename(f, '.jsonl')));

    for (const file of files) {
      const id = path.basename(file, '.jsonl');
      let st; try { st = fs.statSync(file); } catch (e) { continue; }
      const cwd = await getCwd(file);
      if (!cwd || !repoToChat[cwd]) continue;

      const link = linkBySession[id];
      if (!link) {
        // Discover: only real, active, un-ignored sessions we aren't already driving get a topic.
        if (MIRROR && AUTO_CREATE_TOPICS && !ignoredSessions.has(id) && !injecting.has(id) && isActive(st.mtimeMs, now)) {
          await ensureTopicForSession(await readSessionInfo(file));
        }
        continue;
      }
      if (!link.closed && shouldPrune(st.mtimeMs, now)) { await pruneTopic(id); continue; }
      if (link.closed) { if (isActive(st.mtimeMs, now)) await reviveTopic(id); else continue; }

      // Mirror new lines, throttled per topic so a busy desk session can't exceed Telegram limits.
      if (MIRROR && !injecting.has(id) && st.size > link.offset) {
        if (now - (lastMirrorAt.get(id) || 0) < MIRROR_FLUSH_MS) continue;  // retry next poll; offset unchanged
        const { lines, newOffset } = readNewLines(file, link.offset);
        const posts = [];
        for (const o of lines) posts.push(...renderTranscriptLine(o, SHOW_TOOLS));
        if (posts.length) { await sendPlain(link.chatId, link.threadId, posts.join('\n\n')); lastMirrorAt.set(id, now); }
        link.offset = newOffset;
        persistLinks();
      }
    }

    // Cleanup: drop links whose transcript file no longer exists (session deleted on disk).
    for (const id of Object.keys(linkBySession)) {
      if (existingIds.has(id)) continue;
      const l = linkBySession[id];
      if (l && !l.closed) await closeForumTopic(l.chatId, l.threadId);
      if (l) sessionByThread.delete(`${l.chatId}_${l.threadId}`);
      delete linkBySession[id];
      lastMirrorAt.delete(id);
      persistLinks();
      console.log(`[Cleanup] dropped link for missing session ${id.slice(0, 8)}`);
    }
    // Flush queued phone messages for now-idle sessions.
    for (const [sessionId, prompts] of queues) {
      if (!prompts.length) { queues.delete(sessionId); continue; }
      const l = linkBySession[sessionId];
      if (!l) { queues.delete(sessionId); continue; }
      if (injecting.has(sessionId)) continue;
      let mtime = 0; try { mtime = fs.statSync(sessionFileById(sessionId)).mtimeMs; } catch (e) { /* */ }
      if (isDeskBusy(mtime, now)) continue;
      scheduleDrive(l.chatId, l.threadId, prompts.shift(), sessionId);
    }
  } catch (err) {
    console.error('pollTick error:', err.message);
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------------------
// Telegram update polling (inbound messages)
// ---------------------------------------------------------------------------
let lastUpdateId = 0;
async function pollUpdates() {
  try {
    const res = await telegramRequest('getUpdates', { offset: lastUpdateId + 1, timeout: 30 });
    if (res.ok && res.result.length > 0) {
      for (const update of res.result) {
        lastUpdateId = update.update_id;
        const message = update.message;
        if (!message) continue;

        const senderId = message.from ? message.from.id.toString() : null;
        const chatId = message.chat.id.toString();
        const threadId = message.message_thread_id;
        const text = message.text;

        if (senderId === BOT_ID) continue;   // ignore our own posts / forum service messages
        if (!ALLOWED_USER_IDS.includes(senderId)) { console.warn(`[Blocked] user ${senderId}`); continue; }
        if (!REPO_MAPPINGS[chatId]) { console.warn(`[Config] chat ${chatId} not mapped`); continue; }
        if (!threadId) {
          telegramRequest('sendMessage', { chat_id: chatId, text: "⚠️ Please send commands inside a topic thread." }).catch(() => {});
          continue;
        }
        if (!text) continue;

        const key = `${chatId}_${threadId}`;

        if (text === '/start') {
          sendPlain(chatId, threadId, "👋 Claude Code gateway ready. Active desk sessions auto-appear as topics and mirror live. Reply in a topic to steer that session; /new <msg> starts a fresh one.");
          continue;
        }

        // /new <message> — brand-new session in its own new topic.
        if (text.startsWith('/new ')) {
          const firstMsg = text.substring(5).trim();
          const newThread = await createForumTopic(chatId, `🤖 ${firstMsg.slice(0, 50)}`);
          if (!newThread) { sendPlain(chatId, threadId, "⚠️ Couldn't create a topic — grant the bot admin + Manage Topics."); continue; }
          scheduleDrive(chatId, newThread, firstMsg, null);
          sendPlain(chatId, threadId, "🆕 New session started in its own topic.");
          continue;
        }
        // /new (bare) — detach this topic so the next message starts a fresh session here.
        if (text === '/new' || text === '/reset') {
          const sid = sessionByThread.get(key);
          if (sid) { ignoredSessions.add(sid); persistIgnored(); sessionByThread.delete(key); delete linkBySession[sid]; persistLinks(); }
          sendPlain(chatId, threadId, "🆕 This topic will start a fresh session on your next message.");
          continue;
        }
        // /sessions or bare /resume — list recent sessions.
        if (text === '/sessions' || text === '/resume') {
          const sessions = await listSessions(REPO_MAPPINGS[chatId]);
          sendPlain(chatId, threadId, sessions.length
            ? `🗂 Recent sessions:\n\n${formatSessionList(sessions)}\n\nReply /resume <id> to link this topic to one.`
            : "No past Claude sessions found for this repo yet.");
          continue;
        }
        // /resume <uuid | search text>
        if (text.startsWith('/resume ')) {
          const term = text.substring(8).trim();
          const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(term);
          if (isUuid) {
            await upsertLink(term, chatId, threadId); persistLinks();
            sendPlain(chatId, threadId, `🔗 Topic linked to session ${term}. Send a message to continue it.`);
            continue;
          }
          const matches = await matchSessions(REPO_MAPPINGS[chatId], term);
          if (matches.length === 0) sendPlain(chatId, threadId, `⚠️ No session matching "${term}". Send /sessions to list recent ones.`);
          else if (matches.length === 1) {
            await upsertLink(matches[0].id, chatId, threadId, matches[0].label); persistLinks();
            sendPlain(chatId, threadId, `🔗 Linked to "${matches[0].label || matches[0].id}"\n   (${matches[0].id})\nSend a message to continue it.`);
          } else {
            sendPlain(chatId, threadId, `Multiple sessions match "${term}":\n\n${formatSessionList(matches)}\n\nReply /resume <id> to pick one.`);
          }
          continue;
        }

        // Normal message: route to the session this topic is bound to.
        const sessionId = sessionByThread.get(key);
        if (sessionId) {
          let mtime = 0; try { mtime = fs.statSync(sessionFileById(sessionId)).mtimeMs; } catch (e) { /* */ }
          if (isDeskBusy(mtime)) {
            queueForSession(sessionId, text);
            sendPlain(chatId, threadId, "⏳ Desk session looks busy — I'll send this when it goes idle.");
          } else {
            scheduleDrive(chatId, threadId, text, sessionId);
          }
        } else {
          scheduleDrive(chatId, threadId, text, null); // fresh session bound to this topic
        }
      }
    }
  } catch (err) {
    console.error('Error polling Telegram updates:', err.code || err.message || String(err));
    await new Promise((r) => setTimeout(r, 5000));
  }
  pollUpdates();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function shutdown() {
  console.log("\n🛑 [Gateway Shutdown] Exiting. Headless turns are short-lived; no orphaned sessions to kill.");
  persistLinks();
  process.exit(0);
}

if (require.main === module) {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  loadLinks();
  loadIgnored();
  console.log("=============================================");
  console.log("🚀 CLAUDE CODE MULTI-SESSION TELEGRAM GATEWAY");
  console.log("=============================================");
  console.log(`Allowed admins: ${ALLOWED_USER_IDS.length} · repos: ${Object.keys(REPO_MAPPINGS).length}`);
  console.log(`Permission mode: ${PERM_MODE}${MODEL ? ` · model: ${MODEL}` : ''} · tools: ${SHOW_TOOLS ? 'on' : 'off'}`);
  console.log(`Mirror: ${MIRROR ? 'on' : 'off'} · auto-topics: ${AUTO_CREATE_TOPICS ? 'on' : 'off'} · prune: ${PRUNE_MODE} after ${PRUNE_AFTER_MS / 86400000}d`);
  console.log(`Restored ${Object.keys(linkBySession).length} linked session(s). Poll ${POLL_MS}ms.`);
  console.log("Listening for Topic messages + mirroring desk sessions...");
  pollUpdates();
  setInterval(pollTick, POLL_MS);
  pollTick();
}

module.exports = {
  LiveMessage, summarizeToolInput, createFeed, renderTranscriptLine, readNewLines,
  listSessions, matchSessions, readSessionInfo, relTime, formatSessionList,
  isActive, shouldPrune, isDeskBusy, invertRepoMappings, splitThreadKey, buildThreadIndex,
  migrateLegacy, topicName, openerText, shouldAutoCreate, loadIgnored, persistIgnored, persisted,
};
