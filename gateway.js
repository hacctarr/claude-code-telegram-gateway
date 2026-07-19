const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error("Error: config.json not found. Run `npm run setup`, or copy config.example.json to config.json and fill it in.");
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
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
// How to name topics: "generated" = a short AI slug (VS Code-tab style, e.g. telegram-topic-fix);
// "session-name" = Claude's derived name (documents-14); "first-message" = the opening prompt.
const TITLE_MODE = config.TITLE_MODE || 'generated';
const TITLE_MODEL = config.TITLE_MODEL || 'haiku';
// Auto-fork a held-open desk session into a persistent phone branch (on by default). The fork id is
// pre-minted and reserved before the turn spawns, the topic is atomically rebound to the branch, and
// held-detection ignores the gateway's own pid — the three fixes that make this safe. Set
// AUTO_FORK:false to disable; replies into a held session then run with full context but don't persist.
const AUTO_FORK = config.AUTO_FORK !== false;
// After this many seconds with a desk tool call still unresolved, post a one-time notice to the
// topic (it may be a long-running tool OR a permission prompt sitting unanswered at the desk — the
// transcript can't distinguish them, so the notice says both). 0 disables.
const STALL_NOTICE_MS = config.STALL_NOTICE_SECONDS === 0 ? 0 : (config.STALL_NOTICE_SECONDS || 60) * 1000;
// Phone approvals: when PERMISSION_MODE is anything other than bypassPermissions, injected turns
// route tool-permission prompts to the Telegram topic as Allow/Deny buttons instead of silently
// auto-denying. Unanswered requests deny after this timeout so turns can't hang forever.
const PHONE_APPROVALS = PERM_MODE !== 'bypassPermissions';
const APPROVAL_TIMEOUT_MS = (config.APPROVAL_TIMEOUT_SECONDS || 300) * 1000;
// /desk opens a topic's session in the desktop editor. Template's {session} is the session id.
// Default targets the Claude Code VS Code extension; Cursor/Windsurf users can swap the scheme.
const DESK_URL_TEMPLATE = config.DESK_URL_TEMPLATE || 'vscode://anthropic.claude-code/open?session={session}';
const DESK_OPEN_CMD = config.DESK_OPEN_CMD || 'open';   // macOS `open`; Linux users: "xdg-open"

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

// Branch management: when a phone reply forks a held-open desk session, the ORIGINAL desk session is
// "superseded" — we record the transcript size at the fork point and skip re-topicing it, UNLESS the
// desk keeps working on it (file grows past that point), in which case it automatically gets its own
// topic again. So divergence is handled without any manual /branches command.
const SUPERSEDED_FILE = path.join(__dirname, 'superseded.json');
let supersededAt = {};   // sessionId -> transcript size when it was forked away from
function loadSuperseded() { try { if (fs.existsSync(SUPERSEDED_FILE)) supersededAt = JSON.parse(fs.readFileSync(SUPERSEDED_FILE, 'utf8')); } catch (e) { supersededAt = {}; } }
function persistSuperseded() { try { fs.writeFileSync(SUPERSEDED_FILE, JSON.stringify(supersededAt)); } catch (e) { /* */ } }

// Auto-resume marker: the newest phone-driven branch per repo. A shell hook reads it so opening a
// terminal drops you straight back into what you were doing on your phone (no `cr` needed).
const RESUME_MARKER = path.join(process.env.HOME, '.claude-gateway', 'resume.json');
function writeResumeMarker(repoDir, sessionId) {
  try {
    fs.mkdirSync(path.dirname(RESUME_MARKER), { recursive: true });
    let m = {}; try { m = JSON.parse(fs.readFileSync(RESUME_MARKER, 'utf8')); } catch (e) { /* */ }
    m[repoDir] = { sessionId, ts: Date.now() };
    fs.writeFileSync(RESUME_MARKER, JSON.stringify(m, null, 2));
  } catch (e) { /* */ }
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

// Growth baseline: a session only earns a topic once its transcript grows PAST its size when the
// gateway started. This stops a restart (or a `resume`/read that merely bumps mtime) from
// mass-creating topics for pre-existing sessions — only genuinely-progressing work gets a topic.
const sessionBaseline = {};              // sessionId -> transcript size at startup (new files default 0)
function snapshotBaseline() {
  for (const f of allSessionFiles()) {
    try { sessionBaseline[path.basename(f, '.jsonl')] = fs.statSync(f).size; } catch (e) { /* */ }
  }
}

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

// --- Phone approvals: registry + Telegram buttons ---------------------------
// When PERMISSION_MODE isn't bypassPermissions, injected turns pause on tool permissions
// (can_use_tool control requests) and route them here as Allow/Deny inline buttons.
function createApprovalRegistry() {
  let seq = 0;
  const pending = new Map();   // id -> { resolve, timer, meta }
  return {
    create(meta, timeoutMs) {
      const id = String(++seq);
      let resolveFn;
      const promise = new Promise((res) => { resolveFn = res; });
      const entry = { meta, timer: null, resolve: (r) => { if (entry.timer) clearTimeout(entry.timer); pending.delete(id); resolveFn(r); } };
      if (timeoutMs) entry.timer = setTimeout(() => entry.resolve({ allowed: false, timedOut: true }), timeoutMs);
      pending.set(id, entry);
      return { id, promise };
    },
    resolve(id, allowed, by) {
      const e = pending.get(id);
      if (!e) return null;                    // already handled / timed out
      const meta = e.meta;
      e.resolve({ allowed, by });
      return meta;
    },
    size() { return pending.size; },
  };
}
const approvals = createApprovalRegistry();

async function sendApprovalRequest(chatId, threadId, toolName, summary, approvalId) {
  const r = await telegramRequest('sendMessage', {
    chat_id: chatId, message_thread_id: threadId,
    text: `🔐 Permission request:\n${toolName}${summary ? ': ' + summary : ''}`,
    reply_markup: { inline_keyboard: [[
      { text: '✅ Allow', callback_data: `ap:${approvalId}:1` },
      { text: '❌ Deny', callback_data: `ap:${approvalId}:0` },
    ]] },
  }).catch(() => null);
  return r && r.ok ? r.result.message_id : null;
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
    // Surface tool errors (but not the noisy success output) so a failing desk run is visible.
    if (Array.isArray(c) && showTools) {
      const errs = [];
      for (const b of c) {
        if (b.type === 'tool_result' && b.is_error) {
          const et = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? (b.content.find((x) => x.type === 'text') || {}).text : '');
          errs.push(`⚠️ tool error: ${(et || '').replace(/\s+/g, ' ').trim().slice(0, 150)}`);
        }
      }
      return errs;
    }
    return [];
  }
  return [];
}

// The last user prompt + assistant response in a transcript, so a freshly-created topic shows where
// the session left off. Reads only the tail of the file to stay cheap on large transcripts.
function lastExchange(file) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - 131072);   // last 128 KB is plenty for the final turn
    const len = size - start;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
    let lastText = null, lastUser = null;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch (e) { continue; }
      if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
        const t = o.message.content.filter((b) => b.type === 'text' && b.text && b.text.trim()).map((b) => b.text.trim()).join('\n');
        if (t) lastText = t;
      } else if (o.type === 'user' && !o.isMeta && o.message) {
        const c = o.message.content;
        const t = typeof c === 'string' ? c : (Array.isArray(c) ? (c.find((x) => x.type === 'text') || {}).text : null);
        if (t && !t.startsWith('<') && t.trim()) lastUser = t.replace(/\s+/g, ' ').trim();
      }
    }
    return { lastText, lastUser };
  } catch (e) { return { lastText: null, lastUser: null }; }
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
function runClaudeTurn(prompt, cwd, sessionId, live, createId, forkId, onPermission) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
                  '--permission-mode', PERM_MODE];
    // Non-bypass modes: route tool-permission prompts to us over stdio (verified: the CLI emits
    // control_request/can_use_tool and pauses the tool until our control_response arrives).
    if (PHONE_APPROVALS) args.push('--permission-prompt-tool', 'stdio', '--input-format', 'stream-json');
    if (MODEL) args.push('--model', MODEL);
    if (sessionId) {
      args.push('--resume', sessionId);
      // Fork with a PRE-MINTED id (verified supported) so the fork is reserved in `injecting`
      // before it ever appears on disk — the poller can never race it into a duplicate topic.
      if (forkId) args.push('--fork-session', '--session-id', forkId);
    } else if (createId) args.push('--session-id', createId);  // deterministic id for a fresh session
    args.push(...EXTRA);

    console.log(`[Claude] ${sessionId ? 'resume ' + sessionId : 'new session'} in ${cwd}`);
    const child = spawn(CLAUDE_BINARY, args, { cwd, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const feed = createFeed(SHOW_TOOLS);
    let stderr = '', rem = '';

    const answerPermission = async (o) => {
      let resp = { behavior: 'deny', message: 'No approval handler available' };
      try { if (onPermission) resp = await onPermission(o.request); }
      catch (e) { resp = { behavior: 'deny', message: `Approval handler error: ${e.message}` }; }
      try { child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: resp } }) + '\n'); }
      catch (e) { /* child gone */ }
    };

    child.stdout.on('data', (d) => {
      rem += d.toString();
      const lines = rem.split('\n');
      rem = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let o; try { o = JSON.parse(line); } catch (e) { continue; }
        if (o.type === 'control_request' && o.request && o.request.subtype === 'can_use_tool') { answerPermission(o); continue; }
        try { if (feed.handle(o)) live.set(feed.render()); } catch (e) { console.error('event handler error:', e.message); }
        // In stream-json input mode the CLI waits for more input after the result — close stdin to let it exit.
        if (o.type === 'result' && PHONE_APPROVALS) { try { child.stdin.end(); } catch (e) { /* */ } }
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
    if (PHONE_APPROVALS) {
      // stdin must STAY OPEN for control responses; closed after the result arrives (above).
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n');
    } else {
      child.stdin.write(prompt);
      child.stdin.end();
    }
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

// --- Desk stall / approval notices -----------------------------------------
// A desk permission prompt is UI state and never appears in the transcript — the session just goes
// quiet after an assistant tool_use with no tool_result. We track unresolved tool calls per session
// and, past a threshold, post one honest notice (could be a slow tool OR an unanswered prompt),
// plus a resolution line when it completes so the phone knows the session is moving again.
const pendingTools = {};   // sessionId -> { toolUseId: { name, summary, ts, notified } }

// Pure: fold mirrored transcript records into one session's pending-tool state.
// Returns entries that had been notified and just resolved (worth announcing).
function updatePendingTools(state, records, now) {
  const resolved = [];
  for (const o of records) {
    if (!o || typeof o !== 'object') continue;
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const b of o.message.content) {
        if (b.type === 'tool_use' && b.id) state[b.id] = { name: b.name, summary: summarizeToolInput(b.name, b.input), ts: now, notified: false };
      }
    } else if (o.type === 'user' && o.message && Array.isArray(o.message.content)) {
      for (const b of o.message.content) {
        if (b.type === 'tool_result' && b.tool_use_id && state[b.tool_use_id]) {
          if (state[b.tool_use_id].notified) resolved.push(state[b.tool_use_id]);
          delete state[b.tool_use_id];
        }
      }
    }
  }
  return resolved;
}

// Pure: entries past the threshold not yet announced (marks them announced).
function dueStallNotices(state, now, thresholdMs) {
  const due = [];
  if (!thresholdMs || !state) return due;
  for (const e of Object.values(state)) {
    if (!e.notified && now - e.ts >= thresholdMs) { e.notified = true; due.push(e); }
  }
  return due;
}

// A resumed turn "sticks" only if the transcript grew. If it didn't, the desk TUI is holding the
// session open and the injected turn ran in memory only (verified behavior) — nothing was saved.
function persisted(sizeBefore, sizeAfter) { return sizeAfter > sizeBefore; }
function sizeCurrent(sessionId) { try { return fs.statSync(sessionFileById(sessionId)).size; } catch (e) { return 0; } }

// Drive one turn in `threadId` on behalf of `knownSessionId` (or a fresh session if null).
// Build the desktop deep-link that opens a session in the editor (pure — tested).
function deskUrl(sessionId) { return DESK_URL_TEMPLATE.replace('{session}', encodeURIComponent(sessionId)); }
// Open a session in the desktop editor on the Mac (the gateway runs there).
function openOnDesk(sessionId) {
  try { execFileSync(DESK_OPEN_CMD, [deskUrl(sessionId)], { stdio: 'ignore' }); return true; }
  catch (e) { console.error('openOnDesk failed:', e.message); return false; }
}

// Is the transcript currently held open by ANOTHER process (the desk TUI / VS Code extension)?
// Verified: a live TUI keeps its .jsonl open even when idle, so lsof detects it — letting us decide
// fork-vs-resume BEFORE running, so the prompt (and its side effects) never runs twice.
// CRITICAL: exclude our own pid — the gateway's own transient read streams (mirror/label scans)
// otherwise register as "held" and caused spurious chained forks.
function heldByOtherPids(lsofOutput, selfPid) {
  return lsofOutput.split('\n').map((s) => parseInt(s.trim(), 10)).filter(Boolean).filter((pid) => pid !== selfPid);
}
function isSessionHeld(file) {
  if (!file) return false;
  try {
    const out = execFileSync('lsof', ['-t', file], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return heldByOtherPids(out, process.pid).length > 0;
  } catch (e) { return false; }   // lsof exits non-zero when nothing holds the file
}

// `resolveSession` is a FUNCTION evaluated when the turn actually runs — not when the message was
// enqueued. Two rapid replies previously both captured the pre-fork session id and forked it twice;
// resolving at run time means the second reply sees the first reply's fork and continues it.
async function driveTurn(chatId, threadId, prompt, resolveSession) {
  const repoDir = resolveHome(REPO_MAPPINGS[chatId]);
  const typing = startTyping(chatId, threadId);
  const live = new LiveMessage(chatId, threadId);
  const sessionId = (typeof resolveSession === 'function' ? resolveSession() : resolveSession) || null;

  // Decide the mode ONCE, before spawning (single run — side effects never execute twice):
  //   held by another process + AUTO_FORK → fork with a PRE-MINTED id (reserved below)
  //   held, no AUTO_FORK                  → resume; reply has full context but won't persist
  //   free existing session               → resume in place
  //   no session                          → fresh session with a pre-minted id
  const held = !!(sessionId && isSessionHeld(sessionFileById(sessionId)));
  const forkId = (AUTO_FORK && held) ? crypto.randomUUID() : null;
  const createId = sessionId ? null : crypto.randomUUID();
  const sizeBefore = sessionId ? sizeCurrent(sessionId) : 0;
  // Reserve every id this turn may touch BEFORE spawning, so the poller can't topic any of them.
  const reserved = [sessionId, createId, forkId].filter(Boolean);
  reserved.forEach((id) => injecting.add(id));
  // Non-bypass modes: tool-permission prompts become Allow/Deny buttons in this topic.
  const onPermission = PHONE_APPROVALS ? (async (req) => {
    const summary = summarizeToolInput(req.tool_name, req.input);
    const { id, promise } = approvals.create({ chatId, threadId }, APPROVAL_TIMEOUT_MS);
    const msgId = await sendApprovalRequest(chatId, threadId, req.tool_name, summary, id);
    const res = await promise;
    if (res.timedOut && msgId) {
      telegramRequest('editMessageText', { chat_id: chatId, message_id: msgId,
        text: `🔐 ${req.tool_name}${summary ? ': ' + summary : ''}\n\n⏱ Timed out — denied.` }).catch(() => {});
    }
    return res.allowed
      ? { behavior: 'allow', updatedInput: req.input }
      : { behavior: 'deny', message: res.timedOut ? 'Approval timed out on Telegram' : 'Denied from Telegram' };
  }) : null;
  try {
    const result = await runClaudeTurn(prompt, repoDir, sessionId, live, createId, forkId, onPermission);
    clearInterval(typing);

    if (!result.ok && sessionId && !result.sawContent && !forkId) {
      await live.finalize(`⚠️ Couldn't reach session ${sessionId.slice(0, 8)} — it may have been cleared. ` +
        `Send /sessions to pick another, or /new to start fresh here.`);
      return;
    }

    const body = result.ok ? result.body
      : `${result.body && result.body !== '⚙️ Working…' ? result.body + '\n\n' : ''}⚠️ ${result.error}`;

    if (forkId) {
      const forked = result.ok && result.sessionId === forkId && fs.existsSync(sessionFileById(forkId) || '');
      if (forked) {
        // Atomic rebind: topic keeps its identity, now follows the phone branch. The desk copy is
        // marked superseded at its current size — if the desk keeps working it re-topics on its own.
        supersededAt[sessionId] = sizeCurrent(sessionId); persistSuperseded();
        delete linkBySession[sessionId];
        await upsertLink(forkId, chatId, threadId, prompt);          // overwrites thread→session mapping
        try { linkBySession[forkId].offset = sizeCurrent(forkId); } catch (e) { /* */ }
        persistLinks();
        if (queues.has(sessionId)) { queues.set(forkId, queues.get(sessionId)); queues.delete(sessionId); }  // queued replies follow the fork
        writeResumeMarker(repoDir, forkId);
        await live.finalize(`${body}\n\n↪️ Desk session was open, so this continued in a saved phone branch. ` +
          `This topic now follows the branch; your desk copy is untouched (it gets its own topic if you keep working it there).`);
        console.log(`[Drive → thread ${threadId}] forked ${sessionId.slice(0, 8)} → ${forkId.slice(0, 8)} (desk held open)`);
      } else {
        // Fork didn't take — DON'T touch the binding; the reply above still had full context.
        await live.finalize(`${body}\n\n⚠️ The desk session is open and the branch didn't persist — ` +
          `this reply used full context but wasn't saved. Close the desk session and resend to persist.`);
        console.log(`[Drive → thread ${threadId}] fork failed for ${sessionId.slice(0, 8)}; binding unchanged`);
      }
      return;
    }

    // Held-open without AUTO_FORK: full context, but nothing was saved to the desk copy.
    const ephemeral = held && result.ok && !persisted(sizeBefore, sizeCurrent(sessionId));
    await live.finalize(ephemeral
      ? `${body}\n\n⚠️ The desk session is open, so this reply isn't saved to it (close the desk ` +
        `session to persist). The reply above still used the full session context.`
      : body);

    const finalSid = result.sessionId || sessionId || createId;
    if (finalSid) {
      injecting.add(finalSid);
      await upsertLink(finalSid, chatId, threadId, prompt);
      if (!ephemeral) { try { linkBySession[finalSid].offset = sizeCurrent(finalSid); } catch (e) { /* */ } }
      persistLinks();
      if (result.ok && !ephemeral) writeResumeMarker(repoDir, finalSid);
      if (!reserved.includes(finalSid)) reserved.push(finalSid);
    }
    console.log(`[Drive → thread ${threadId}] ok=${result.ok} session=${finalSid || '—'}${ephemeral ? ' (held/ephemeral)' : ''}`);
  } catch (err) {
    clearInterval(typing);
    console.error('driveTurn error:', err);
    await sendPlain(chatId, threadId, `⚠️ Gateway error: ${err.message}`);
  } finally {
    reserved.forEach((id) => injecting.delete(id));
  }
}

function scheduleDrive(chatId, threadId, prompt, resolveSession) {
  const key = `${chatId}_${threadId}`;
  const prev = threadChains.get(key) || Promise.resolve();
  const next = prev.then(() => driveTurn(chatId, threadId, prompt, resolveSession)).catch((e) => console.error(e));
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
// Claude Code's own session name (e.g. "documents-f7"), from ~/.claude/sessions/*.json, so a topic
// is named the same as the session you see in the editor / picker. Falls back to the first message.
function sessionNameById(sessionId) {
  const dir = path.join(process.env.HOME, '.claude', 'sessions');
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try { const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (o.sessionId === sessionId && o.name) return o.name; } catch (e) { /* */ }
    }
  } catch (e) { /* */ }
  return null;
}
function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').filter(Boolean).slice(0, 4).join('-').slice(0, 32);
}

// Ask a small/fast model for a short kebab-case slug (VS Code-tab style) from the session's content.
// Runs in HOME (never a mapped repo) with a throwaway session id that we delete afterward, so title
// generation never leaves a stray session file that could itself spawn a topic.
function generateTitle(firstMsg, recentMsg) {
  return new Promise((resolve) => {
    if (!firstMsg && !recentMsg) return resolve(null);
    const prompt = `Give a 1-3 word kebab-case slug titling this work session. Reply ONLY the slug, no quotes or extra text.\n` +
      `First message: "${(firstMsg || '').slice(0, 300)}"` + (recentMsg ? `\nRecent: "${recentMsg.slice(0, 200)}"` : '');
    const home = process.env.HOME;
    const tmpId = crypto.randomUUID();
    const cleanup = () => { try { const enc = '-' + home.replace(/^\//, '').replace(/[/.]/g, '-'); fs.unlinkSync(path.join(home, '.claude', 'projects', enc, tmpId + '.jsonl')); } catch (e) { /* */ } };
    let out = '', done = false;
    const finish = (v) => { if (done) return; done = true; cleanup(); resolve(v); };
    let child; try { child = spawn(CLAUDE_BINARY, ['-p', '--session-id', tmpId, '--model', TITLE_MODEL, '--permission-mode', 'bypassPermissions'], { cwd: home, env: process.env }); }
    catch (e) { return resolve(null); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* */ } finish(null); }, 20000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => { clearTimeout(timer); finish(slugify(out) || null); });
    child.stdin.write(prompt); child.stdin.end();
  });
}

// Sync fallback namer (also used in tests).
function topicName(info) {
  const name = TITLE_MODE === 'first-message' ? slugify(info.label) : sessionNameById(info.id);
  if (name) return `🤖 ${name}`;
  return info.label ? `🤖 ${slugify(info.label)}` : `🤖 claude-${info.id.slice(0, 6)}`;
}

// Async resolver used at topic creation — generates a slug when TITLE_MODE=generated.
async function resolveTopicName(info) {
  if (TITLE_MODE === 'generated') {
    const { lastUser } = lastExchange(info.path);
    const slug = await generateTitle(info.label, lastUser);
    if (slug) return `🤖 ${slug}`;
  }
  return topicName(info);
}
function openerText(info) {
  const name = sessionNameById(info.id);
  return `🤖 Session ${name || info.id.slice(0, 8)}` +
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
  const threadId = await createForumTopic(chatId, await resolveTopicName(info));
  if (!threadId) return null;
  const tkey = `${chatId}_${threadId}`;
  if (sessionByThread.has(tkey) && sessionByThread.get(tkey) !== info.id) {   // never bind two sessions to one thread
    console.warn(`[Topic] thread ${threadId} already bound to ${sessionByThread.get(tkey).slice(0, 8)}; skipping duplicate for ${info.id.slice(0, 8)}`);
    return null;
  }
  linkBySession[info.id] = { chatId, threadId, label: info.label || '', offset: info.size || 0, closed: false };
  sessionByThread.set(tkey, info.id);
  persistLinks();
  await sendPlain(chatId, threadId, openerText(info));
  // Seed the topic with where the session left off (last prompt + last response).
  const { lastText, lastUser } = lastExchange(info.path);
  if (lastText) {
    await sendPlain(chatId, threadId,
      `— where it left off —${lastUser ? `\n🖥️ desk: ${lastUser.slice(0, 400)}` : ''}\n\n${lastText}`);
  }
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
  delete pendingTools[sessionId];
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
// Graceful self-restart: `touch restart.flag` (from anywhere — including a phone-driven turn) and
// the gateway exits once no injected turns are in flight; launchd relaunches it with fresh code.
// Never `launchctl kickstart -k` from inside a gateway-driven turn — that kills the process group,
// including the turn that issued it, mid-command.
const RESTART_FLAG = path.join(__dirname, 'restart.flag');

let polling = false;
async function pollTick() {
  if (polling) return;
  polling = true;
  try {
    if (fs.existsSync(RESTART_FLAG) && injecting.size === 0) {
      try { fs.unlinkSync(RESTART_FLAG); } catch (e) { /* */ }
      console.log('[Restart] restart.flag seen and no turns in flight — exiting for launchd relaunch.');
      persistLinks();
      process.exit(1);   // non-zero → KeepAlive relaunches
    }
    const now = Date.now();
    let topicsThisTick = 0;
    const files = allSessionFiles();
    const existingIds = new Set(files.map((f) => path.basename(f, '.jsonl')));

    for (const file of files) {
      const id = path.basename(file, '.jsonl');
      let st; try { st = fs.statSync(file); } catch (e) { continue; }
      const cwd = await getCwd(file);
      if (!cwd || !repoToChat[cwd]) continue;

      if (id.startsWith('agent-')) continue;                         // sub-agent sessions never get a topic
      const link = linkBySession[id];
      if (!link) {
        if (ignoredSessions.has(id)) continue;                       // /new-detached — permanent
        if (supersededAt[id] !== undefined) {                        // desk branch we forked away from
          if (st.size > supersededAt[id]) { delete supersededAt[id]; persistSuperseded(); }  // desk kept working → re-topic
          else continue;                                             // still at the fork point → stay hidden
        }
        const grew = st.size > (sessionBaseline[id] || 0);           // grew past startup size (new files: baseline 0 → eligible)
        // Discover: real, active, progressing sessions. At most ONE creation per tick so a burst of
        // active sessions can never hammer Telegram's rate limit again.
        if (MIRROR && AUTO_CREATE_TOPICS && !injecting.has(id) && grew && isActive(st.mtimeMs, now) && topicsThisTick < 1) {
          if (await ensureTopicForSession(await readSessionInfo(file))) topicsThisTick++;
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
        // Track unresolved tool calls; announce completion of any we'd flagged as stalled.
        const pstate = (pendingTools[id] = pendingTools[id] || {});
        for (const r of updatePendingTools(pstate, lines, now)) {
          posts.push(`▶️ ${r.name} finished — session continuing.`);
        }
        if (posts.length) { await sendPlain(link.chatId, link.threadId, posts.join('\n\n')); lastMirrorAt.set(id, now); }
        link.offset = newOffset;
        persistLinks();
      }
      // Stall notice: a tool call unresolved past the threshold — slow tool, or a permission
      // prompt sitting unanswered at the desk (the transcript can't tell which; say both).
      for (const e of dueStallNotices(pendingTools[id], now, STALL_NOTICE_MS)) {
        await sendPlain(link.chatId, link.threadId,
          `⏳ Desk session has been on this for ${Math.round((now - e.ts) / 1000)}s:\n🔧 ${e.name}${e.summary ? ': ' + e.summary : ''}\n` +
          `It may just be running long — or waiting for tool approval at the desk (/desk opens it).`);
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
      delete pendingTools[id];
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

        // Inline-button presses (phone approvals).
        const cb = update.callback_query;
        if (cb) {
          const fromId = cb.from ? String(cb.from.id) : '';
          if (!ALLOWED_USER_IDS.includes(fromId)) {
            telegramRequest('answerCallbackQuery', { callback_query_id: cb.id, text: 'Not authorized' }).catch(() => {});
            continue;
          }
          const m = /^ap:(\d+):([01])$/.exec(cb.data || '');
          if (m) {
            const allowed = m[2] === '1';
            const meta = approvals.resolve(m[1], allowed, fromId);
            telegramRequest('answerCallbackQuery', { callback_query_id: cb.id, text: meta ? (allowed ? 'Allowed ✅' : 'Denied ❌') : 'Already handled' }).catch(() => {});
            if (meta && cb.message) {
              telegramRequest('editMessageText', {
                chat_id: cb.message.chat.id, message_id: cb.message.message_id,
                text: `${cb.message.text}\n\n${allowed ? '✅ Allowed' : '❌ Denied'}`,
              }).catch(() => {});
            }
          }
          continue;
        }

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
          sendPlain(chatId, threadId, "👋 Claude Code gateway ready. Active desk sessions auto-appear as topics and mirror live.\n\n" +
            "• reply in a topic to steer that session\n• /new <msg> — fresh session in its own topic\n• /desk — open this session in the editor on your Mac\n• /sessions, /resume <id|text>");
          continue;
        }

        // /desk (or /open) — open this topic's session in the desktop editor on the Mac.
        if (text === '/desk' || text === '/open') {
          const sid = sessionByThread.get(key);
          if (!sid) { sendPlain(chatId, threadId, "No session is linked to this topic yet — send a message first."); continue; }
          sendPlain(chatId, threadId, openOnDesk(sid)
            ? "🖥️ Opening this session in the editor on your Mac."
            : "⚠️ Couldn't open it on the Mac (is the editor installed and the URL scheme registered?).");
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
        // /exit — close this session's topic and stop mirroring it. The session file stays on disk
        // (resume any time via /sessions or `cr`); if the desk keeps working it, it re-topics itself.
        if (text === '/exit' || text === '/close') {
          const sid = sessionByThread.get(key);
          if (!sid) { sendPlain(chatId, threadId, "This topic isn't bound to a session — nothing to close."); continue; }
          await sendPlain(chatId, threadId, `👋 Session ${sid.slice(0, 8)} closed. It stays resumable on disk ` +
            `(/sessions in another topic, or \`cr\` at the Mac); fresh desk activity will re-open a topic for it.`);
          sessionByThread.delete(key);
          delete linkBySession[sid];
          queues.delete(sid);
          delete pendingTools[sid];
          supersededAt[sid] = sizeCurrent(sid); persistSuperseded();   // hidden unless the desk grows it again
          persistLinks();
          if (PRUNE_MODE === 'delete') await deleteForumTopic(chatId, threadId);
          else await closeForumTopic(chatId, threadId);
          console.log(`[Exit] closed topic ${threadId} for session ${sid.slice(0, 8)}`);
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

        // Normal message: route to the session this topic is bound to. The session is re-resolved
        // when the turn RUNS (not now) so back-to-back replies follow a fork instead of re-forking.
        const sessionId = sessionByThread.get(key);
        if (sessionId) {
          let mtime = 0; try { mtime = fs.statSync(sessionFileById(sessionId)).mtimeMs; } catch (e) { /* */ }
          if (isDeskBusy(mtime)) {
            // Desk is actively writing this transcript right now — a fork would branch mid-turn.
            queueForSession(sessionId, text);
            sendPlain(chatId, threadId, "⏳ Desk session is mid-turn — I'll send this when it settles.");
          } else {
            scheduleDrive(chatId, threadId, text, () => sessionByThread.get(key) || null);
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
const LOCK_FILE = path.join(__dirname, '.gateway.lock');
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
      if (pid && pid !== process.pid && pidAlive(pid)) {
        console.error(`Another gateway is already running (pid ${pid}). Exiting to avoid a getUpdates conflict.`);
        process.exit(1);
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch (e) { /* */ }
}
function releaseLock() { try { if (fs.existsSync(LOCK_FILE) && parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10) === process.pid) fs.unlinkSync(LOCK_FILE); } catch (e) { /* */ } }

function shutdown() {
  console.log("\n🛑 [Gateway Shutdown] Exiting. Headless turns are short-lived; no orphaned sessions to kill.");
  persistLinks();
  releaseLock();
  process.exit(0);
}

if (require.main === module) {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  acquireLock();
  loadLinks();
  loadIgnored();
  loadSuperseded();
  snapshotBaseline();   // record current sizes so a restart doesn't mass-create topics
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
  migrateLegacy, topicName, openerText, shouldAutoCreate, loadIgnored, persistIgnored, persisted, deskUrl,
  lastExchange, sessionNameById, heldByOtherPids, updatePendingTools, dueStallNotices, createApprovalRegistry,
};
