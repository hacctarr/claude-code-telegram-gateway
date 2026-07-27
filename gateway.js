const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// Persistent state lives OUTSIDE the install directory. For an npm install __dirname sits in
// node_modules and is replaced wholesale on `npm update`, which silently destroys config.json
// (your bot token) and links.json (every topic binding). ~/.claude-gateway survives updates —
// it is already where the resume marker lives. Override with CLAUDE_GATEWAY_DIR.
const STATE_DIR = process.env.CLAUDE_GATEWAY_DIR || path.join(os.homedir(), '.claude-gateway');
const STATE_FILES = ['config.json', 'links.json', 'sessions.json', 'ignored.json', 'superseded.json'];

// One-time move of legacy in-package state into STATE_DIR. Copy+unlink rather than rename so it
// works when the npm prefix and $HOME are on different filesystems (rename gives EXDEV). Never
// overwrites a file already in the destination. Returns the names actually moved.
function migrateStateFiles(fromDir, toDir, names = STATE_FILES) {
  const moved = [];
  if (fromDir === toDir) return moved;
  for (const name of names) {
    const src = path.join(fromDir, name);
    const dst = path.join(toDir, name);
    try {
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
      fs.mkdirSync(toDir, { recursive: true });
      try { fs.renameSync(src, dst); }
      catch (e) { fs.copyFileSync(src, dst); fs.unlinkSync(src); }   // EXDEV across filesystems
      moved.push(name);
    } catch (e) { /* leave the legacy copy in place rather than lose it */ }
  }
  return moved;
}

const IS_GATEWAY = require.main === module;
if (IS_GATEWAY) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (e) { /* */ }
  const moved = migrateStateFiles(__dirname, STATE_DIR);
  if (moved.length) console.log(`[State] migrated ${moved.join(', ')} → ${STATE_DIR} (survives npm update)`);
}

// The gateway loads gateway.js once at boot and holds it in memory, so `git pull` or `npm update`
// changes the file on disk without touching the live process. package.json then describes a version
// nobody is running. This records what this process actually loaded, so doctor can name the gap
// instead of reporting the on-disk version as though it were live.
//
// The hash is the part that earns its keep during development: a pull that edits gateway.js and
// leaves the version alone is the common case, and the version fields agree straight through it.
function writeRunningMarker(stateDir = STATE_DIR) {
  const self = path.join(__dirname, 'gateway.js');
  let sha = null;
  try { sha = crypto.createHash('sha256').update(fs.readFileSync(self)).digest('hex'); }
  catch (e) { /* unreadable own source: fall back to version-only drift detection */ }
  const marker = {
    version: require('./package.json').version,
    pid: process.pid,
    dir: __dirname,
    startedAt: new Date().toISOString(),
    ...(sha ? { sha } : {}),
  };
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'running.json'), JSON.stringify(marker));
  } catch (e) { console.warn('Could not write running.json:', e.message); }
  return marker;
}

// Reads prefer STATE_DIR but fall back to a legacy in-package file when migration hasn't run
// (e.g. this module imported by tests). New writes always land in STATE_DIR.
function statePath(name) {
  const current = path.join(STATE_DIR, name);
  if (fs.existsSync(current)) return current;
  const legacy = path.join(__dirname, name);
  return fs.existsSync(legacy) ? legacy : current;
}

// config.json is gitignored, so it is absent in CI and for anyone importing this file as a
// module. Only refuse to start when we are actually being run as the gateway — bailing at
// require-time broke `npm test` in CI, which silently failed every tagged npm release.
const CONFIG_PATH = statePath('config.json');
const HAS_CONFIG = fs.existsSync(CONFIG_PATH);
if (!HAS_CONFIG && IS_GATEWAY) {
  console.error(`Error: config.json not found in ${STATE_DIR}. Run \`npm run setup\`, or copy config.example.json there and fill it in.`);
  process.exit(1);
}
const config = HAS_CONFIG ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};

const { createTelemetry } = require('./telemetry');
const ANALYTICS_DIR = path.join(STATE_DIR, 'analytics');
// Late-bound on purpose: main() replaces console with a timestamping wrapper before
// telemetry.start() runs, and an arrow picks that up where a direct reference to
// console.error would capture the unwrapped original.
const telemetry = createTelemetry({
  dir: ANALYTICS_DIR, otlp: config.otlp || {}, log: (m) => console.error(m),
});

// Low-cardinality repo label from a cwd (or a repo dir), matched against REPO_MAPPINGS values.
function repoOf(cwd, mappings) {
  if (!cwd) return 'unknown';
  for (const dir of Object.values(mappings || {})) {
    if (cwd === dir || cwd.startsWith(dir + path.sep)) return path.basename(dir);
  }
  return path.basename(cwd);
}

// Token and cost figures a turn's terminal stream-json `result` event already
// carries (same shape as `claude -p --output-format json`). Returns undefined
// when the event has no usage, so a turn that reported none records nothing.
// `model` collapses modelUsage to one bounded label: the single id, 'multi', or
// 'unknown'.
function parseTurnUsage(ev) {
  const u = ev && ev.usage;
  if (!u || typeof u !== 'object') return undefined;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const models = ev.modelUsage && typeof ev.modelUsage === 'object' ? Object.keys(ev.modelUsage) : [];
  return {
    input_tokens: n(u.input_tokens),
    output_tokens: n(u.output_tokens),
    cache_creation_input_tokens: n(u.cache_creation_input_tokens),
    cache_read_input_tokens: n(u.cache_read_input_tokens),
    cost_usd: n(ev.total_cost_usd),
    model: models.length === 1 ? models[0] : (models.length ? 'multi' : 'unknown'),
  };
}

// Fan usage out to bounded-cardinality counters, one token counter per type plus
// a cost counter, labelled by repo and model. No message content, so nothing a
// body could leak. Injected telemetry keeps it unit-testable.
function recordTurnUsage(tel, repo, usage) {
  if (!usage) return;
  const model = usage.model || 'unknown';
  tel.count('gateway.tokens', { repo, type: 'input', model }, usage.input_tokens || 0);
  tel.count('gateway.tokens', { repo, type: 'output', model }, usage.output_tokens || 0);
  tel.count('gateway.tokens', { repo, type: 'cache_creation', model }, usage.cache_creation_input_tokens || 0);
  tel.count('gateway.tokens', { repo, type: 'cache_read', model }, usage.cache_read_input_tokens || 0);
  tel.count('gateway.cost_usd', { repo, model }, usage.cost_usd || 0);
}

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
// Default only: /tools in a topic overrides it per topic or per chat at runtime (see toolPrefs).
// Off unless asked for. One line per tool call is what turns a long desk session into hundreds of
// mirrored posts, and the prose response is what a phone reader is actually there for.
function resolveShowTools(cfg = {}) { return cfg.SHOW_TOOL_ACTIVITY === true; }
const SHOW_TOOLS = resolveShowTools(config);

// MCP surface handed to spawned children. The tools array leads the cached prompt prefix, ahead of
// the system blocks and every message, so a child that lets its MCP servers connect asynchronously
// grows that array mid-run and invalidates the whole prefix. The conversation is then re-written to
// cache at 1h TTL, which bills at twice the base input rate: on a large resumed session that runs
// to hundreds of thousands of tokens per turn. Pinning the set keeps the prefix byte-stable from one
// turn to the next, which is what lets the cache actually be reused.
//   absent      inherit the user's full surface (the behavior before this option existed)
//   []          no MCP servers at all
//   ["a","b"]   only these, resolved from the user's own MCP config
const CHILD_MCP_SERVERS = Array.isArray(config.CHILD_MCP_SERVERS) ? config.CHILD_MCP_SERVERS : null;
const MCP_POOL_FILE = config.MCP_CONFIG_PATH || path.join(os.homedir(), '.claude.json');

function loadMcpServerPool(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers || {}; }
  catch (e) { return {}; }
}

// Sorted so the serialized config is byte-identical no matter what order the names arrive in;
// an unstable ordering here would defeat the caching this whole option exists to protect.
function resolveChildMcp(selection, pool) {
  if (!Array.isArray(selection)) return { args: [], missing: [] };
  const mcpServers = {};
  const missing = [];
  for (const name of [...selection].sort()) {
    if (pool && pool[name]) mcpServers[name] = pool[name];
    else missing.push(name);
  }
  return { args: ['--mcp-config', JSON.stringify({ mcpServers }), '--strict-mcp-config'], missing };
}

const CHILD_MCP = resolveChildMcp(CHILD_MCP_SERVERS, CHILD_MCP_SERVERS ? loadMcpServerPool(MCP_POOL_FILE) : {});
if (CHILD_MCP.missing.length) {
  console.warn(`[MCP] CHILD_MCP_SERVERS names no server in ${MCP_POOL_FILE}: ${CHILD_MCP.missing.join(', ')}`);
}

// Mirroring / auto-topic behavior (all optional, sensible defaults).
const MIRROR = config.MIRROR !== false;
const AUTO_CREATE_TOPICS = config.AUTO_CREATE_TOPICS !== false;
const IDLE_INJECT_MS = (config.IDLE_INJECT_SECONDS || 15) * 1000;
const ACTIVE_WINDOW_MS = (config.ACTIVE_WINDOW_MIN || 30) * 60_000;
// Idle window before a topic is pruned. Hours is the unit the decision is actually made in: a
// session that went quiet at breakfast should not still be holding a slot at dinner. The pre-hours
// PRUNE_AFTER_DAYS spelling still works so an existing config keeps the window it asked for.
// A non-positive or unparseable value would prune every topic on sight, so it falls back instead.
function resolvePruneMs(cfg = {}) {
  const DEFAULT_MS = 2 * 3_600_000;
  const scaled = (v, unitMs) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n * unitMs : null;
  };
  return scaled(cfg.PRUNE_AFTER_HOURS, 3_600_000) ?? scaled(cfg.PRUNE_AFTER_DAYS, 86_400_000) ?? DEFAULT_MS;
}
const PRUNE_AFTER_MS = resolvePruneMs(config);

// The boot banner should echo the window in a unit that matches how it was configured.
function formatPruneWindow(ms) {
  return ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`;
}
const PRUNE_MODE = config.PRUNE_MODE || 'close';   // "close" | "delete"
// Bound the prune network calls one tick issues so a large idle backlog (e.g. dozens of restored
// sessions on boot) can't monopolize a tick — the remainder catches up on the next ticks, keeping
// each tick short and the restart flag responsive. Mirrors the topics-per-tick=1 create cap.
const PRUNES_PER_TICK = config.PRUNES_PER_TICK || 5;
const POLL_MS = config.POLL_MS || 2000;
const MIRROR_FLUSH_MS = config.MIRROR_FLUSH_MS || 4000;  // min gap between mirror posts per topic
// Inline action buttons: attach a per-session action bar (Desk / Rename / Close) to each mirrored
// prose message, and render /sessions as a tap-to-link picker. false → no reply_markup is attached
// and the act: callback router answers "buttons disabled" (slash commands still work).
const BUTTONS = config.BUTTONS !== false;
// Topic opener — the first message posted into a freshly created topic. In a forum, a topic's
// first message renders at the very top, so a long opener reads like an auto-pinned banner on
// every new topic. "minimal" (default) is one identifying line; "full" adds the how-it-works
// paragraph + a "where it left off" seed; "off" posts nothing and the topic just starts mirroring.
const TOPIC_OPENER = config.TOPIC_OPENER || 'minimal';   // "off" | "minimal" | "full"
// How to name topics: "first-message" = the opening prompt (free, the default);
// "session-name" = Claude's derived name (documents-14); "generated" = a short AI slug.
// "generated" spawns a real Claude turn per topic-creation ATTEMPT. Even fully isolated
// (see titleArgs) that costs ~25k tokens for a three-word slug, so it is opt-in.
const TITLE_MODE = config.TITLE_MODE || 'first-message';
const TITLE_MODEL = config.TITLE_MODEL || 'haiku';
// Topic creation is rate-limited by Telegram. A failure must not be retried on the next
// 2s tick — with TITLE_MODE=generated that would respawn the titling turn every time.
const TOPIC_RETRY_BASE_MS = config.TOPIC_RETRY_BASE_MS || 30_000;
const TOPIC_RETRY_MAX_MS = config.TOPIC_RETRY_MAX_MS || 15 * 60_000;
// Rename a topic once, after this many mirrored desk prompts, so its name reflects the work
// rather than the opening message. 0 disables. Only does anything when TITLE_MODE=generated.
const RENAME_AFTER_TURNS = config.RENAME_AFTER_TURNS === 0 ? 0 : (config.RENAME_AFTER_TURNS || 3);
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
// How long an injected turn may go without producing any output before a queued restart stops
// waiting on it. The window has to clear the longest silent stretch a healthy turn can have, which
// is a single long tool call (the CLI streams nothing while a tool runs), so it is generous.
const RESTART_STALE_TURN_MS = (config.RESTART_STALE_TURN_SECONDS || 600) * 1000;
// Auto-approve: answer every tool-permission request with "allow" instead of posting Allow/Deny
// buttons. For machines that can't run bypassPermissions (managed policy) but still want
// hands-off phone driving. The `deny` list still short-circuits upstream — a denied tool never
// reaches this handler — so this only ever rubber-stamps ask-bucket tools. One audit line per
// approval keeps a runaway session visible.
const AUTO_APPROVE = config.AUTO_APPROVE === true;
// /desk opens a topic's session in the desktop editor. Template's {session} is the session id.
// Default targets the Claude Code VS Code extension; Cursor/Windsurf users can swap the scheme.
const DESK_URL_TEMPLATE = config.DESK_URL_TEMPLATE || 'vscode://anthropic.claude-code/open?session={session}';
const DESK_OPEN_CMD = config.DESK_OPEN_CMD || 'open';   // macOS `open`; Linux users: "xdg-open"
// Group auto-config: on boot, apply the group's title/description/photo, the bot's global
// name/about/description, and the command menu, idempotently (per-scope hash in appearance.json).
// APPEARANCE carries only what should differ from the live objects; unset fields are left untouched.
const AUTO_CONFIGURE_GROUP = config.AUTO_CONFIGURE_GROUP !== false;
const APPEARANCE = config.APPEARANCE || null;

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
const LINKS_FILE = statePath('links.json');
const SESSIONS_FILE = statePath('sessions.json'); // legacy, migrated once

const IGNORED_FILE = statePath('ignored.json');
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

// Tool-activity overrides, keyed by topic ("<chatId>_<threadId>") and by chat. Runtime state rather
// than config so a noisy topic can be silenced from the phone, without a config edit and restart.
const TOOLPREFS_FILE = statePath('toolprefs.json');
let toolPrefs = { chats: {}, threads: {} };
function loadToolPrefs() {
  try {
    const p = JSON.parse(fs.readFileSync(TOOLPREFS_FILE, 'utf8'));
    toolPrefs = { chats: p.chats || {}, threads: p.threads || {} };
  } catch (e) { toolPrefs = { chats: {}, threads: {} }; }
  return toolPrefs;
}
function persistToolPrefs() { try { fs.writeFileSync(TOOLPREFS_FILE, JSON.stringify(toolPrefs)); } catch (e) { /* */ } }

// Branch management: when a phone reply forks a held-open desk session, the ORIGINAL desk session is
// "superseded" — we record the transcript size at the fork point and skip re-topicing it, UNLESS the
// desk keeps working on it (file grows past that point), in which case it automatically gets its own
// topic again. So divergence is handled without any manual /branches command.
const SUPERSEDED_FILE = statePath('superseded.json');
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
// sessionIds the gateway is currently driving. Membership suppresses the mirror for the whole
// life of the turn; the recorded timestamp is the last time the child produced output, which is
// what the restart gate waits on. Clock is injectable so the silence window is unit-testable.
function createInjectionSet(clock = Date.now) {
  const lastActive = new Map();
  return {
    add(id) { lastActive.set(id, clock()); },
    delete(id) { lastActive.delete(id); },
    has(id) { return lastActive.has(id); },
    get size() { return lastActive.size; },
    // Only ids already reserved are bumped: a turn hands over every id it might touch, some of
    // which it never minted, and touch must not conjure a reservation nothing will ever release.
    touch(...ids) {
      const now = clock();
      for (const id of ids) if (id && lastActive.has(id)) lastActive.set(id, now);
    },
    // Reservations that produced child output within `silenceMs`. A turn still streaming must not
    // be cut off mid-reply; one that has gone quiet this long has already lost its reply, so
    // continuing to wait on it only holds the restart hostage.
    liveCount(silenceMs, now = clock()) {
      let n = 0;
      for (const t of lastActive.values()) if (now - t < silenceMs) n++;
      return n;
    },
  };
}
const injecting = createInjectionSet();
const queues = new Map();                // sessionId -> [prompt] awaiting an idle desk session
const lastMirrorAt = new Map();          // sessionId -> ts of last mirror post (rate-limit coalescing)
const mirrorRetryAt = new Map();         // sessionId -> earliest ts to retry a failed batch (429 backoff)

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
// windowMs is injectable so the boundary is testable without depending on the host's own config.
function shouldPrune(mtime, now = Date.now(), windowMs = PRUNE_AFTER_MS) { return (now - mtime) > windowMs; }
function isDeskBusy(mtime, now = Date.now()) { return (now - mtime) <= IDLE_INJECT_MS; }

// ---------------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------------
const SOCKET_TIMEOUT_MS = 15000;   // fail fast; a hung send must not stall the poll loop
// getUpdates is a long-poll: the server deliberately holds the connection open until an
// update arrives or this many seconds pass. The socket timeout must exceed it, or every
// idle poll is killed client-side before the server ever answers and the loop wedges.
const UPDATE_POLL_TIMEOUT_S = config.UPDATE_POLL_TIMEOUT_S || 25;
function updateSocketTimeoutMs() { return UPDATE_POLL_TIMEOUT_S * 1000 + 10_000; }

function telegramRequest(method, payload, timeoutMs = SOCKET_TIMEOUT_MS) {
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error('telegram request timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Telegram reports 429s as "Too Many Requests: retry after 38". Returns ms, 0 if absent.
function parseRetryAfter(description) {
  const m = /retry after (\d+)/i.exec(description || '');
  return m ? Number(m[1]) * 1000 : 0;
}

// Split text on newline boundaries so each piece fits Telegram's 4096-char message cap.
function chunkText(text, max = 4000) {
  let rest = text;
  const chunks = [];
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// Why a send failed, as a low-cardinality metric attribute. The distinction that matters is
// rate_limited vs the rest: a 429 is Telegram asking us to slow down, and a rising rate of them is
// the flood signature. A rejection is a non-ok body with no exception thrown, which is exactly why
// the original flood produced no log output at all.
function classifySendFailure(response, error) {
  if (error) return 'error';
  return parseRetryAfter(response && response.description) ? 'rate_limited' : 'rejected';
}

// Deliver `text` as Telegram-sized chunks. Two properties keep a rate-limited topic from flooding:
// it STOPS at the first failure (pushing the rest of the batch at a chat that just said "slow down"
// is what earns the next 429), and it reports how many chunks are now on Telegram so the caller can
// resume mid-batch instead of re-posting what already landed. `send` is injectable for tests.
async function sendChunked(chatId, threadId, text, { skip = 0, replyMarkup = null, send = telegramRequest } = {}) {
  const chunks = chunkText(text);
  let sent = Math.min(skip, chunks.length), lastMessageId = null, retryAfterMs = 0;
  for (let i = sent; i < chunks.length; i++) {
    const payload = { chat_id: chatId, message_thread_id: threadId, text: chunks[i] };
    if (replyMarkup && i === chunks.length - 1) payload.reply_markup = replyMarkup;
    let r;
    try { r = await send('sendMessage', payload); }
    catch (e) {
      console.error('sendChunked error:', e.code || e.message || String(e));
      telemetry.count('gateway.send.failed', { reason: classifySendFailure(null, e) });
      break;
    }
    if (!r || !r.ok) {
      retryAfterMs = parseRetryAfter(r && r.description);
      // Counted here because nothing else sees it: a non-ok body throws nothing and logs nothing.
      telemetry.count('gateway.send.failed', { reason: classifySendFailure(r) });
      break;
    }
    sent = i + 1;
    if (r.result) lastMessageId = r.result.message_id;
  }
  return { allSent: sent >= chunks.length, sent, total: chunks.length, lastMessageId, retryAfterMs };
}

async function sendPlain(chatId, threadId, text) {
  const r = await sendChunked(chatId, threadId, text);
  return r.allSent;   // callers that mirror content use this to avoid advancing past unsent lines
}

// sendPlain's cousin: attaches reply_markup to the LAST chunk and returns that message's id so the
// caller can strip the markup off it later. Returns { allSent, lastMessageId }.
async function postWithMarkup(chatId, threadId, text, replyMarkup) {
  const { allSent, lastMessageId } = await sendChunked(chatId, threadId, text, { replyMarkup });
  return { allSent, lastMessageId };
}

// Per-session record of how much of the in-flight mirror batch is already on Telegram. A batch is
// identified by the transcript offset it ends at; once the session writes more, the batch changed
// and the counts reset. Pure so the resume rule is unit-tested.
function resumeCursor(cursor, offset) {
  return cursor && cursor.offset === offset ? cursor : { offset, activity: 0, prose: 0 };
}

// The cursor rides the link record so it persists to links.json with the rest of the link. An
// in-memory cursor would be dropped by the one event it most needs to survive: a restart between
// the failed attempt and the retry, which would re-post the chunks that had already landed.
function linkCursor(link, offset) {
  return resumeCursor(link && link.mirrorCursor, offset);
}

// --- Inline action buttons: pure builders + parser --------------------------
// Reuses the existing callback_query plumbing (the `ap:` approval prefix) with an `act:` family.
const ACTION_RE = /^act:(desk|rename|exit|resume):(.+)$/;
function parseActionCallback(data) {
  const m = ACTION_RE.exec(data || '');
  return m ? { action: m[1], sid: m[2] } : null;
}

// The per-session action bar that rides each mirrored prose message: one tap to hand back to the
// desk, regenerate the name, or close the topic. Full session id fits callback_data (<=64 bytes).
function buildSessionActionBar(sid) {
  if (!sid) return null;
  return { inline_keyboard: [[
    { text: '🖥️ Desk',   callback_data: `act:desk:${sid}` },
    { text: '✏️ Rename', callback_data: `act:rename:${sid}` },
    { text: '❌ Close',  callback_data: `act:exit:${sid}` },
  ]] };
}

// One tappable row per recent session for the /sessions picker; tapping links this topic to it.
function buildSessionPickerKeyboard(sessions, max = 12) {
  const rows = sessions.slice(0, max).map((s) => [{
    text: `${(s.label || s.id).slice(0, 48)} · ${relTime(s.mtime)}`,
    callback_data: `act:resume:${s.id}`,
  }]);
  return rows.length ? { inline_keyboard: rows } : null;
}

// Only the newest mirrored message per session should carry the action bar. Track the last one so
// its markup can be cleared when a newer message takes over (editMessageReplyMarkup with []).
const lastBar = new Map();   // sessionId -> { chatId, messageId }
async function clearPrevBar(sid) {
  const b = lastBar.get(sid);
  if (!b) return;
  await telegramRequest('editMessageReplyMarkup',
    { chat_id: b.chatId, message_id: b.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  lastBar.delete(sid);
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

// Returns { threadId, retryAfterMs }. threadId is null on failure; callers that create topics
// on a timer use retryAfterMs to back off instead of retrying on the very next tick.
async function createForumTopic(chatId, name, iconId = null) {
  const params = { chat_id: chatId, name: name.slice(0, 128) };
  if (iconId) params.icon_custom_emoji_id = iconId;
  const r = await telegramRequest('createForumTopic', params)
    .catch((e) => ({ ok: false, description: e.message }));
  if (!r.ok) {
    console.error(`[Topic] createForumTopic failed (${r.description || 'unknown'}). Bot needs admin + Manage Topics.`);
    telemetry.count('gateway.topic.create_failed', { reason: /too many requests|retry after/i.test(r.description || '') ? 'rate_limited' : 'other' });
    return { threadId: null, retryAfterMs: parseRetryAfter(r.description) };
  }
  return { threadId: r.result.message_thread_id, retryAfterMs: 0 };
}

// Per-session backoff for topic creation. Exponential from base, capped at max, never shorter
// than Telegram's own retry_after.
function createTopicCooldown(baseMs = TOPIC_RETRY_BASE_MS, maxMs = TOPIC_RETRY_MAX_MS) {
  const state = new Map();   // sessionId -> { until, fails }
  return {
    blocked(id, now = Date.now()) { const e = state.get(id); return !!e && now < e.until; },
    fail(id, retryAfterMs = 0, now = Date.now()) {
      const e = state.get(id) || { fails: 0, until: 0 };
      e.fails += 1;
      const backoff = Math.min(maxMs, baseMs * 2 ** (e.fails - 1));
      e.until = now + Math.max(backoff, retryAfterMs);
      state.set(id, e);
      return e;
    },
    clear(id) { state.delete(id); },
    size() { return state.size; },
  };
}
const topicCooldown = createTopicCooldown();
const editForumTopic = (chatId, threadId, name, iconId) => {
  const params = { chat_id: chatId, message_thread_id: threadId, name: name.slice(0, 128) };
  if (iconId) params.icon_custom_emoji_id = iconId;
  return telegramRequest('editForumTopic', params)
    .catch((e) => ({ ok: false, description: e.message }));
};
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
  // Readout separation: tool activity accumulates in toolBody, the assistant's prose in proseBody.
  // render() stacks tools above prose with a blank line so the response reads as its own block —
  // the streamed-turn analogue of the mirror path's two-message split.
  let toolBody = '', proseBody = '';
  const render = () => {
    const parts = [];
    if (toolBody.trim()) parts.push(toolBody.trim());
    if (proseBody.trim()) parts.push(proseBody.trim());
    return parts.join('\n\n') || '⚙️ Working…';
  };
  const feed = {
    sawContent: false, sessionId: null, isError: false, resultText: null,
    render,
    handle(o) {
      if (!o || typeof o !== 'object') return false;
      if (o.type === 'stream_event' && o.event && o.event.type === 'content_block_delta'
          && o.event.delta && o.event.delta.type === 'text_delta') {
        proseBody += o.event.delta.text; feed.sawContent = true; return true;
      }
      if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
        let changed = false;
        for (const block of o.message.content) {
          if (block.type === 'tool_use' && showTools) {
            const summary = summarizeToolInput(block.name, block.input);
            if (toolBody && !toolBody.endsWith('\n')) toolBody += '\n';
            toolBody += `🔧 ${block.name}${summary ? ': ' + summary : ''}\n`;
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
    finish() { if (feed.resultText && !feed.sawContent) proseBody = feed.resultText; return render(); }
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

// Activity markers that renderTranscriptLine (and the flush) can emit: tool step, resumed-tool
// notice, tool error, desk-input echo, stall notice. Anything without one of these prefixes is the
// assistant's prose response.
const ACTIVITY_PREFIXES = ['🔧', '▶️', '⚠️', '🖥️', '⏳'];

// Partition a batch of mirror post-strings into activity vs prose, preserving order within each.
// The flush posts activity as one Telegram message and prose as a second, so the prose response is
// the clean, last bubble in the topic — the natural reply-to-steer target.
function splitReadout(posts) {
  const activity = [], prose = [];
  for (const p of posts) {
    if (ACTIVITY_PREFIXES.some((e) => p.startsWith(e))) activity.push(p);
    else prose.push(p);
  }
  return { activity, prose };
}

// --- Tool-activity visibility: pure resolve + command parse -----------------
// Precedence: this topic's override, then its chat's, then the config default. A long agentic run
// posts one 🔧 line per tool call, which is the bulk of a busy topic's traffic — turning it off for
// a topic (or a whole chat) leaves the prose responses, the desk echoes and the stall notices.
function resolveToolActivity(prefs, chatId, threadId, fallback) {
  const { chats = {}, threads = {} } = prefs || {};
  const thread = threads[`${chatId}_${threadId}`];
  if (typeof thread === 'boolean') return thread;
  const chat = chats[String(chatId)];
  if (typeof chat === 'boolean') return chat;
  return fallback;
}

// "/tools" | "/tools on|off|default [all]" -> an intent, or null when this isn't the command.
// An unrecognized argument asks for help rather than falling back to a scope the user didn't name.
const TOOLS_RE = /^\/tools(?:\s+(\S+))?(?:\s+(\S+))?\s*$/i;
function parseToolsCommand(text) {
  const m = TOOLS_RE.exec(String(text || '').trim());
  if (!m) return null;
  const [, rawArg, rawScope] = m;
  if (!rawArg) return { action: 'show' };
  const arg = rawArg.toLowerCase(), scopeWord = (rawScope || '').toLowerCase();
  if (scopeWord && scopeWord !== 'all') return { action: 'help' };
  const scope = scopeWord === 'all' ? 'chat' : 'thread';
  if (arg === 'on' || arg === 'off') return { action: 'set', on: arg === 'on', scope };
  if (arg === 'default') return { action: 'clear', scope };
  return { action: 'help' };
}

// Apply a parsed set/clear to a prefs object, in place. Clearing removes the key entirely so the
// next wider scope decides again — storing "unset" as a value would shadow it.
function setToolPref(prefs, cmd, chatId, threadId) {
  const bucket = cmd.scope === 'chat' ? prefs.chats : prefs.threads;
  const key = cmd.scope === 'chat' ? String(chatId) : `${chatId}_${threadId}`;
  if (cmd.action === 'clear') delete bucket[key];
  else bucket[key] = cmd.on;
  return prefs;
}

// Runtime binding of the resolver to this process's stored prefs and the config default.
function showToolsIn(chatId, threadId) { return resolveToolActivity(toolPrefs, chatId, threadId, SHOW_TOOLS); }

// Where the effective setting comes from, for /tools to report honestly.
function toolActivityStatus(chatId, threadId) {
  const on = showToolsIn(chatId, threadId);
  const source = typeof toolPrefs.threads[`${chatId}_${threadId}`] === 'boolean' ? 'this topic'
    : typeof toolPrefs.chats[String(chatId)] === 'boolean' ? 'this chat'
    : 'the SHOW_TOOL_ACTIVITY default';
  return { on, source };
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

// How full a session's context is, from the last main-thread assistant turn's usage.
// Everything the model was sent counts (fresh input + both cache buckets); output does
// not, since it is already folded into the next turn's input. Sidechain turns are
// subagents running their own context and would wildly overstate the parent's.
// Reads only the tail, like lastExchange, so it stays cheap on large transcripts.
function contextTokens(file) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - 131072);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
    let tokens = 0;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch (e) { continue; }
      if (o.type !== 'assistant' || o.isSidechain) continue;
      const u = o.message && o.message.usage;
      if (!u) continue;
      tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
    return tokens;
  } catch (e) { return 0; }
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
    args.push(...CHILD_MCP.args);
    args.push(...EXTRA);

    console.log(`[Claude] ${sessionId ? 'resume ' + sessionId : 'new session'} in ${cwd}`);
    telemetry.count('gateway.claude.turn', { repo: repoOf(cwd, REPO_MAPPINGS), mode: sessionId ? 'resume' : 'new' });
    const child = spawn(CLAUDE_BINARY, args, { cwd, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    // The live message already knows which topic it posts to, so the turn honors that topic's
    // /tools setting without threading yet another argument through this signature.
    const feed = createFeed(showToolsIn(live.chatId, live.threadId));
    let stderr = '', rem = '';

    const answerPermission = async (o) => {
      let resp = { behavior: 'deny', message: 'No approval handler available' };
      try { if (onPermission) resp = await onPermission(o.request); }
      catch (e) { resp = { behavior: 'deny', message: `Approval handler error: ${e.message}` }; }
      try { child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: resp } }) + '\n'); }
      catch (e) { /* child gone */ }
    };

    child.stdout.on('data', (d) => {
      // Proof of life for the restart gate. Every id this turn reserved is bumped, since a resumed
      // turn that forks streams under the fork's id while both remain reserved.
      injecting.touch(sessionId, createId, forkId);
      rem += d.toString();
      const lines = rem.split('\n');
      rem = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let o; try { o = JSON.parse(line); } catch (e) { continue; }
        if (o.type === 'control_request' && o.request && o.request.subtype === 'can_use_tool') { answerPermission(o); continue; }
        try { if (feed.handle(o)) live.set(feed.render()); } catch (e) { console.error('event handler error:', e.message); }
        // The terminal result event carries the turn's token usage and cost; fan
        // it out to metrics. Best-effort, never breaks the turn.
        if (o.type === 'result') {
          try { recordTurnUsage(telemetry, repoOf(cwd, REPO_MAPPINGS), parseTurnUsage(o)); }
          catch (e) { /* telemetry is best-effort */ }
        }
        // In stream-json input mode the CLI waits for more input after the result, so close stdin to let it exit.
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
    // Auto-approve: say yes without posting buttons. Denied tools never reach here (deny resolves
    // upstream of the prompt tool), so this only allows ask-bucket tools. Audit line, no keyboard.
    if (AUTO_APPROVE) {
      sendPlain(chatId, threadId, `✅ auto-allowed: ${req.tool_name}${summary ? ': ' + summary : ''}`);
      return { behavior: 'allow', updatedInput: req.input };
    }
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
        telemetry.count('gateway.session.forked', { ok: 'true' });
      } else {
        // Fork didn't take — DON'T touch the binding; the reply above still had full context.
        await live.finalize(`${body}\n\n⚠️ The desk session is open and the branch didn't persist — ` +
          `this reply used full context but wasn't saved. Close the desk session and resend to persist.`);
        console.log(`[Drive → thread ${threadId}] fork failed for ${sessionId.slice(0, 8)}; binding unchanged`);
        telemetry.count('gateway.session.forked', { ok: 'false' });
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

      // The gateway drove this turn on the user's behalf, so it already holds the prompt.
      // Injected turns are suppressed from the transcript mirror (the offset jumped past them
      // just above), so the transcriptLine tap never sees them — hand the prompt to modules
      // directly. This is how a module arms on a command texted in from Telegram, without
      // reaching into a stream the gateway deliberately hides.
      moduleRegistry.emit('injectedTurn', { sessionId: finalSid, cwd: repoDir, chatId, threadId }, prompt);
    }
    console.log(`[Drive → thread ${threadId}] ok=${result.ok} session=${finalSid || '—'}${ephemeral ? ' (held/ephemeral)' : ''}`);
    telemetry.count('gateway.drive.injection', { repo: repoOf(REPO_MAPPINGS[chatId], REPO_MAPPINGS), ok: String(result.ok) });
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
// Module system: external files named in config.MODULES extend the gateway
// against a curated api. Empty/absent MODULES → pure no-op (OSS-safety).
// ---------------------------------------------------------------------------
// A registry over already-instantiated modules ({ name, hooks }). emit() maps a
// hook key to on<Hook> and calls it per module inside try/catch, so one module's
// bug can never crash pollTick or affect another module/install.
function createModuleRegistry(instances, log = console.error) {
  const list = Array.isArray(instances) ? instances : [];
  const method = (hook) => 'on' + hook.charAt(0).toUpperCase() + hook.slice(1);
  return {
    emit(hook, ...args) {
      const fn = method(hook);
      for (const m of list) {
        const h = m.hooks && m.hooks[fn];
        if (typeof h !== 'function') continue;
        try { h(...args); }
        catch (e) { log(`[Module ${m.name}] ${fn} threw: ${e.stack || e.message}`); }
      }
    },
    names() { return list.map((m) => m.name); },
  };
}

// Resolve a MODULES entry to an absolute path: ~ expands, absolute passes through,
// anything else is relative to the gateway state dir (default ~/.claude-gateway).
function resolveModulePath(entry, gatewayDir) {
  const p = resolveHome(entry);
  return path.isAbsolute(p) ? p : path.join(gatewayDir, p);
}

// Modules that ship inside the package and load without being named in MODULES.
// Each carries the config key that turns it off, so the opt-out is data rather
// than a branch in the loader. Strict `=== false` means only an explicit false
// disables one: a missing config file, or a config written before the key
// existed, leaves the module on.
const BUILTIN_MODULES = [
  { name: 'auto-compact', file: path.join(__dirname, 'modules', 'auto-compact.js'), off: 'AUTO_COMPACT' },
];

// Require each module file and instantiate its factory with the curated api.
// A module that fails to load is logged and skipped: one bad module never
// stops the gateway or the others, and that isolation covers the builtins too.
// Builtins load first so an external module can observe a session the builtin
// has already registered.
function loadModules(config, api, log = console.error, gatewayDir = STATE_DIR, builtins = BUILTIN_MODULES) {
  const cfg = config || {};
  const loaded = new Set();
  const instances = [];

  const add = (file, label) => {
    if (loaded.has(file)) return;                     // same file named twice loads once
    loaded.add(file);
    try {
      const factory = require(file);
      if (typeof factory !== 'function') throw new Error('module does not export a factory function');
      const hooks = factory(api);
      const name = (hooks && hooks.name) || path.basename(file, '.js');
      instances.push({ name, hooks: hooks || {} });
      log(`[Module] loaded ${name} from ${file}${label ? ` (${label})` : ''}`);
    } catch (e) {
      log(`[Module] failed to load ${file}: ${e.message}`);
    }
  };

  for (const b of builtins || []) {
    if (cfg[b.off] === false) { log(`[Module] ${b.name} disabled by ${b.off}: false`); continue; }
    add(b.file, 'builtin');
  }
  for (const entry of Array.isArray(cfg.MODULES) ? cfg.MODULES : []) {
    add(resolveModulePath(entry, gatewayDir));
  }
  return createModuleRegistry(instances, log);
}

// Args for a detached review/aux session. Pure so it can be unit-tested.
function buildSpawnArgs(sessionId, mode, model, mcp = CHILD_MCP.args) {
  const args = ['-p', '--session-id', sessionId, '--permission-mode', mode];
  if (model) args.push('--model', model);
  args.push(...mcp);
  return args;
}

// Fire-and-forget headless session. Unlike runClaudeTurn (live-streamed, driven,
// permission-plumbed), this mints a uuid, spawns detached, feeds the prompt on
// stdin, and returns the id without waiting. The poll loop then discovers the new
// .jsonl, creates a topic, and mirrors it like any other session.
function spawnSession({ cwd, prompt, mode }) {
  const sessionId = crypto.randomUUID();
  const args = buildSpawnArgs(sessionId, mode || PERM_MODE, MODEL);
  try {
    const child = spawn(CLAUDE_BINARY, args, { cwd, env: { ...process.env }, detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', (e) => console.error('[Module] spawnSession failed:', e.message));
    try { child.stdin.write(prompt); child.stdin.end(); } catch (e) { /* child gone */ }
    child.unref();
    console.log(`[Module] spawned session ${sessionId.slice(0, 8)} in ${cwd}`);
  } catch (e) {
    console.error('[Module] spawnSession error:', e.message);
  }
  return sessionId;
}

// The curated surface modules receive. Everything is a thin wrapper over an existing
// gateway function — modules never reach into internals.
function buildModuleApi() {
  return {
    injectTurn(sessionId, prompt) { return queueForSession(sessionId, prompt); },
    spawnSession(opts) { return spawnSession(opts); },
    postToTopic(sessionId, text) {
      const l = linkBySession[sessionId];
      if (!l) return false;
      return sendPlain(l.chatId, l.threadId, text).catch((e) => { console.error('[Module] postToTopic failed:', e.message); return false; });
    },
    getSessionInfo(sessionId) {
      const l = linkBySession[sessionId];
      const file = sessionFileById(sessionId);
      let cwd = null, mtime = 0;
      if (file) { cwd = cwdCache.get(file) || null; try { mtime = fs.statSync(file).mtimeMs; } catch (e) { /* */ } }
      if (!l && !file) return null;
      return { cwd, chatId: l && l.chatId, threadId: l && l.threadId, label: l && l.label, mtime };
    },
    getContextTokens(sessionId) {
      const file = sessionFileById(sessionId);
      return file ? contextTokens(file) : 0;
    },
    state(name) {
      const file = statePath('module-' + name);
      let data = {};
      try { if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { data = {}; }
      return { data, save() { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.error('[Module] state save failed:', e.message); } } };
    },
    config,
    // Metrics only. The exporter's lifecycle (endpoint, credentials, flush cadence, shutdown)
    // belongs to the gateway, so a module gets the recording surface and nothing that could
    // redirect or silence the stream the gateway is responsible for.
    telemetry: {
      count: (...a) => telemetry.count(...a),
      gauge: (...a) => telemetry.gauge(...a),
      record: (...a) => telemetry.record(...a),
      registerObservable: (...a) => telemetry.registerObservable(...a),
    },
    log(...a) { console.log('[Module]', ...a); },
  };
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

// Pick a topic icon from the work's content. Telegram's real topic-icon slot
// (icon_custom_emoji_id) only accepts emoji from a fixed sticker set — the ids below are from
// getForumTopicIconStickers (getForumTopicIconStickers.js reprints the full set). Each rule pairs
// the display emoji with the matching custom_emoji_id so the real icon and any text fallback agree.
// First match wins, so order most-specific first; 🤖 is the neutral default.
const DEFAULT_ICON = { emoji: '🤖', id: '5309832892262654231' };
const ICON_RULES = [
  [/\b(bug|fix|broken|crash|error|fail|regress|debug)/, '🦠', '5312424913615723286'],
  [/\b(test|spec|assert|coverage|e2e)/,                 '🧪', '5411138633765757782'],
  [/\b(refactor|cleanup|clean-?up|tidy|dedup)/,         '🧼', '5377468357907849200'],
  [/\b(perf|performance|optimi|speed|latency|token-?burn|cost)/, '⚡️', '5312016608254762256'],
  [/\b(deploy|release|ship|publish|launch|rollout)/,    '🏁', '5408906741125490282'],
  [/\b(secur|auth|login|credential|password|oauth|vuln)/, '🪪', '5418115271267197333'],
  [/\b(api|endpoint|http|webhook|route|server|git|commit|branch|merge|\bpr\b)/, '💻', '5350554349074391003'],
  [/\b(ui|ux|css|style|layout|design|frontend|button)/, '🎨', '5310039132297242441'],
  [/\b(mail|email|gmail|inbox)/,                        '💬', '5417915203100613993'],
  [/\b(chart|graph|data|analytic|report|metric|stat|dashboard)/, '📈', '5350305691942788490'],
  [/\b(money|finance|invoice|bill|payment|tax|budget|copilot)/, '💰', '5350452584119279096'],
  [/\b(schedul|cron|timer|calendar|remind)/,            '📆', '5433614043006903194'],
  [/\b(db|database|sql|sqlite|migrat|schema|query)/,    '📚', '5350481781306958339'],
  [/\b(search|find|grep|lookup|explore|research)/,      '🔎', '5309965701241379366'],
  [/\b(doc|docs|readme|write-?up|guide|note|summary)/,  '📝', '5373251851074415873'],
  [/\b(property|home|house|mortgage|hoa|barwick|evolene)/, '🏠', '5312486108309757006'],
  [/\b(travel|flight|hotel|trip|italy|hawaii|vacation)/, '✈️', '5348436127038579546'],
  [/\b(car|vehicle|tesla|bmw|cybertruck|suburban)/,     '🚗', '5312322066328853156'],
  [/\b(school|college|grade|homework|tuition)/,         '🎓', '5357419403325481346'],
  [/\b(medical|doctor|health|prescription|\brx\b|dental)/, '🩺', '5350307998340226571'],
  [/\b(file|upload|download|attach|organi|rename|sort)/, '📁', '5357315181649076022'],
];
function pickIcon(text) {
  const t = (text || '').toLowerCase();
  for (const [re, emoji, id] of ICON_RULES) if (re.test(t)) return { emoji, id };
  return DEFAULT_ICON;
}
function pickEmoji(text) { return pickIcon(text).emoji; }

// argv for the throwaway titling turn. Every flag here exists to keep a three-word slug from
// costing a full agent turn: without them the child inherits the user's entire MCP surface,
// skills index, settings and CLAUDE.md. Measured on a real install: 63,720 tokens with none of
// these, 25,269 with all of them. The remainder is Claude Code's own base prompt.
function titleArgs(tmpId, model = TITLE_MODEL, mode = PERM_MODE) {
  return [
    '-p',
    '--session-id', tmpId,
    '--model', model,
    // Honour the configured mode. The turn carries no tools and no MCP so it cannot
    // act either way, but a machine under managed policy is not allowed to pass
    // bypassPermissions at all, and hardcoding it here left no way to opt out.
    '--permission-mode', mode,
    '--max-turns', '1',
    '--allowedTools', '',
    '--mcp-config', '{"mcpServers":{}}',
    '--strict-mcp-config',
    '--exclude-dynamic-system-prompt-sections',
    '--disable-slash-commands',
    '--setting-sources', '',
  ];
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
    let child; try { child = spawn(CLAUDE_BINARY, titleArgs(tmpId), { cwd: home, env: process.env }); }
    catch (e) { return resolve(null); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* */ } finish(null); }, 20000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => { clearTimeout(timer); finish(slugify(out) || null); });
    child.stdin.write(prompt); child.stdin.end();
  });
}

// Sync fallback namer (also used in tests). The topic's visual now comes from its custom-emoji
// icon (see pickIcon / resolveTopicName), so the name itself is plain text — no emoji prefix.
function topicName(info) {
  const name = TITLE_MODE === 'first-message' ? slugify(info.label) : sessionNameById(info.id);
  if (name) return name;
  return info.label ? slugify(info.label) : `claude-${info.id.slice(0, 6)}`;
}

// A topic is named at creation, when the session is usually one message old — which is how you
// end up with topics called "ping" or "re-you-sure-it". Once RENAME_AFTER_TURNS real desk prompts
// have been mirrored, regenerate the name once from what the session actually became.
// Counting happens on already-parsed mirrored lines, so it costs nothing extra: O(new bytes),
// never a re-read of a transcript that can run to tens of MB.
function countUserTurns(lines) {
  let n = 0;
  for (const o of lines) {
    if (!o || o.type !== 'user' || o.isMeta || !o.message) continue;
    const c = o.message.content;
    const t = typeof c === 'string' ? c : (Array.isArray(c) ? (c.find((x) => x.type === 'text') || {}).text : null);
    if (t && !t.startsWith('<') && t.trim()) n++;
  }
  return n;
}

// True exactly once per topic: enough substance to name it, and not yet renamed.
function dueForRename(link, threshold = RENAME_AFTER_TURNS) {
  if (!threshold || !link || link.renamed) return false;
  return (link.userTurns || 0) >= threshold;
}

// Async resolver used at topic creation — generates a slug when TITLE_MODE=generated.
// Generated slugs are cached per session: a topic creation that fails and is later retried
// must not pay for the titling turn twice.
// Returns { name, iconId } — the plain topic name plus the custom-emoji icon id to render beside it.
const titleCache = new Map();   // sessionId -> { name, iconId }
async function resolveTopicName(info) {
  if (TITLE_MODE === 'generated') {
    if (titleCache.has(info.id)) return titleCache.get(info.id);
    const { lastUser } = lastExchange(info.path);
    const slug = await generateTitle(info.label, lastUser);
    if (slug) {
      const r = { name: slug, iconId: pickIcon(`${info.label || ''} ${slug} ${lastUser || ''}`).id };
      titleCache.set(info.id, r);
      return r;
    }
  }
  return { name: topicName(info), iconId: pickIcon(info.label).id };
}
function openerText(info, mode = TOPIC_OPENER) {
  const name = sessionNameById(info.id) || info.id.slice(0, 8);
  if (mode === 'off') return '';
  if (mode === 'minimal') {
    return `🤖 ${name}${info.label ? ` · “${info.label}”` : ''} · mirroring live`;
  }
  return `🤖 Session ${name}` +
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
  if (topicCooldown.blocked(info.id)) return null;   // backing off from a recent failure
  const { name, iconId } = await resolveTopicName(info);
  const { threadId, retryAfterMs } = await createForumTopic(chatId, name, iconId);
  if (!threadId) {
    const { fails, until } = topicCooldown.fail(info.id, retryAfterMs);
    console.error(`[Topic] backing off ${info.id.slice(0, 8)} for ${Math.round((until - Date.now()) / 1000)}s (failure #${fails})`);
    telemetry.record('gateway.topic.backoff_seconds', Math.round((until - Date.now()) / 1000));
    return null;
  }
  topicCooldown.clear(info.id);
  const tkey = `${chatId}_${threadId}`;
  if (sessionByThread.has(tkey) && sessionByThread.get(tkey) !== info.id) {   // never bind two sessions to one thread
    console.warn(`[Topic] thread ${threadId} already bound to ${sessionByThread.get(tkey).slice(0, 8)}; skipping duplicate for ${info.id.slice(0, 8)}`);
    return null;
  }
  linkBySession[info.id] = { chatId, threadId, label: info.label || '', offset: info.size || 0, closed: false };
  sessionByThread.set(tkey, info.id);
  persistLinks();
  const opener = openerText(info);
  if (opener) await sendPlain(chatId, threadId, opener);
  // Seed the topic with where the session left off (last prompt + last response) — only in the
  // "full" opener mode; "minimal"/"off" keep new topics from leading with a banner-like block.
  if (TOPIC_OPENER === 'full') {
    const { lastText, lastUser } = lastExchange(info.path);
    if (lastText) {
      await sendPlain(chatId, threadId,
        `— where it left off —${lastUser ? `\n🖥️ desk: ${lastUser.slice(0, 400)}` : ''}\n\n${lastText}`);
    }
  }
  console.log(`[Topic] created for ${info.id.slice(0, 8)} → chat ${chatId} thread ${threadId}`);
  telemetry.count('gateway.topic.created', { repo: repoOf(REPO_MAPPINGS[chatId], REPO_MAPPINGS) });
  return linkBySession[info.id];
}

// Regenerate a topic's name from the session's current content and apply it. Only meaningful
// under TITLE_MODE=generated — the other modes are derived from the first message, which by
// definition hasn't changed. Returns the new name, or null if nothing was renamed.
async function renameTopicFromContent(sessionId, link, file) {
  if (TITLE_MODE !== 'generated') return null;
  try {
    const info = await readSessionInfo(file || sessionFileById(sessionId));
    if (!info) return null;
    titleCache.delete(sessionId);       // force a fresh slug rather than reusing the creation-time one
    const { name, iconId } = await resolveTopicName(info);
    if (!name) return null;
    const r = await editForumTopic(link.chatId, link.threadId, name, iconId);
    if (!r || !r.ok) {
      console.error(`[Topic] rename failed for ${sessionId.slice(0, 8)} (${(r && r.description) || 'unknown'})`);
      return null;
    }
    link.label = info.label || link.label;
    persistLinks();
    console.log(`[Topic] renamed ${sessionId.slice(0, 8)} → ${name}`);
    return name;
  } catch (e) {
    console.error(`[Topic] rename error for ${sessionId.slice(0, 8)}: ${e.message}`);
    return null;
  }
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
  telemetry.count('gateway.topic.pruned', { mode: PRUNE_MODE });
}

async function reviveTopic(sessionId) {
  const l = linkBySession[sessionId];
  if (!l || !l.closed) return;
  await reopenForumTopic(l.chatId, l.threadId);
  l.closed = false;
  persistLinks();
  console.log(`[Topic] reopened session ${sessionId.slice(0, 8)}`);
}

// The /exit teardown, shared by the /exit command and the ❌ Close button. Closes (or deletes) the
// topic, unbinds the session, and marks it superseded so the mirror won't re-topic it until the
// desk grows the transcript again.
async function closeSessionTopic(sid, chatId, threadId) {
  await sendPlain(chatId, threadId, `👋 Session ${sid.slice(0, 8)} closed. It stays resumable on disk ` +
    `(/sessions in another topic, or \`cr\` at the Mac); fresh desk activity will re-open a topic for it.`);
  sessionByThread.delete(`${chatId}_${threadId}`);
  delete linkBySession[sid];
  queues.delete(sid);
  delete pendingTools[sid];
  lastBar.delete(sid);
  supersededAt[sid] = sizeCurrent(sid); persistSuperseded();
  persistLinks();
  if (PRUNE_MODE === 'delete') await deleteForumTopic(chatId, threadId);
  else await closeForumTopic(chatId, threadId);
  console.log(`[Exit] closed topic ${threadId} for session ${sid.slice(0, 8)}`);
}

// Dispatch an act: button press. cb is the raw callback_query (for chat/thread + answering).
async function handleActionCallback(act, cb) {
  const { action, sid } = act;
  const answer = (text) => telegramRequest('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {});
  if (action === 'desk') {
    return void answer(openOnDesk(sid) ? '🖥️ Opening on your Mac' : '⚠️ Could not open it on the Mac');
  }
  if (action === 'resume') {
    const chatId = String(cb.message.chat.id);
    const threadId = cb.message.message_thread_id;
    await upsertLink(sid, chatId, threadId); persistLinks();
    await answer('🔗 Linked · send a message to continue it');
    return void sendPlain(chatId, threadId, `🔗 Topic linked to session ${sid.slice(0, 8)}. Send a message to continue it.`);
  }
  const link = linkBySession[sid];
  if (!link) return void answer('That session is no longer linked.');
  if (action === 'rename') {
    if (TITLE_MODE !== 'generated') return void answer('Set TITLE_MODE=generated, or use /rename <name>.');
    await answer('✏️ Regenerating name…');
    const name = await renameTopicFromContent(sid, link, sessionFileById(sid));
    if (name) await sendPlain(link.chatId, link.threadId, `✏️ Renamed to ${name}`);
    return;
  }
  if (action === 'exit') {
    await answer('❌ Closing…');
    await closeSessionTopic(sid, link.chatId, link.threadId);
  }
}

// ---------------------------------------------------------------------------
// Poll loop: discover new sessions, mirror activity, prune, flush queues.
// ---------------------------------------------------------------------------
// Graceful self-restart: `touch restart.flag` (from anywhere — including a phone-driven turn) and
// the gateway exits once no injected turns are in flight; launchd relaunches it with fresh code.
// Never `launchctl kickstart -k` from inside a gateway-driven turn — that kills the process group,
// including the turn that issued it, mid-command.
// Watched in both places: STATE_DIR is the durable home, but `touch restart.flag` inside a git
// checkout is long-standing muscle memory and stays working.
const RESTART_FLAGS = [path.join(STATE_DIR, 'restart.flag'), path.join(__dirname, 'restart.flag')];
function seenRestartFlag() { return RESTART_FLAGS.find((f) => { try { return fs.existsSync(f); } catch (e) { return false; } }); }

// Honor a restart only when the flag is present AND no phone-injected turn is still producing
// output, so `touch restart.flag` never kills a session mid-reply. The count is of *live* turns
// rather than every reservation: a child that hangs never releases its reservation, and gating on
// existence alone let one hold every subsequent restart indefinitely. Pure so the gate is
// unit-tested.
function restartReady(flagPresent, liveInjections) { return Boolean(flagPresent) && liveInjections === 0; }

// Checked at the top of the tick AND inside the per-session loop: one tick can iterate dozens of
// sessions with a network call each (prune/mirror), so a top-of-tick-only check made a
// `touch restart.flag` wait out the whole slow tick. Bailing mid-loop keeps restarts responsive
// even under a large prune backlog. Returns true (after exiting) when it honors the flag.
function honorRestartIfReady() {
  const flag = seenRestartFlag();
  const live = injecting.liveCount(RESTART_STALE_TURN_MS);
  if (!restartReady(flag, live)) return false;
  try { fs.unlinkSync(flag); } catch (e) { /* */ }
  if (injecting.size) {
    console.warn(`[Restart] ${injecting.size} injected turn(s) reserved but silent for ` +
      `>${Math.round(RESTART_STALE_TURN_MS / 1000)}s, restarting anyway; their replies are already lost.`);
  }
  console.log('[Restart] restart.flag seen and no turns in flight, exiting for launchd relaunch.');
  persistLinks();
  process.exit(1);   // non-zero → KeepAlive relaunches
  return true;       // unreachable under a real process.exit; kept for test stubs
}

// Loaded at boot from config.MODULES; a no-op registry until then so the mirror
// loop can call moduleRegistry.emit() unconditionally with zero overhead.
let moduleRegistry = createModuleRegistry([], console.error);

let polling = false;
async function pollTick() {
  if (polling) return;
  polling = true;
  try {
    if (honorRestartIfReady()) return;
    const now = Date.now();
    let topicsThisTick = 0;
    let prunesThisTick = 0;
    const files = allSessionFiles();
    const existingIds = new Set(files.map((f) => path.basename(f, '.jsonl')));

    for (const file of files) {
      if (honorRestartIfReady()) return;   // bail promptly even mid-backlog
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
      if (!link.closed && shouldPrune(st.mtimeMs, now)) {
        if (prunesThisTick >= PRUNES_PER_TICK) continue;   // over the per-tick cap → catch up next tick
        await pruneTopic(id); prunesThisTick++; continue;
      }
      if (link.closed) { if (isActive(st.mtimeMs, now)) await reviveTopic(id); else continue; }

      // Mirror new lines, throttled per topic so a busy desk session can't exceed Telegram limits.
      if (MIRROR && !injecting.has(id) && st.size > link.offset) {
        if (now < (mirrorRetryAt.get(id) || 0)) continue;                   // backing off a rate-limited batch
        if (now - (lastMirrorAt.get(id) || 0) < MIRROR_FLUSH_MS) continue;  // retry next poll; offset unchanged
        const { lines, newOffset } = readNewLines(file, link.offset);
        // Feed each new record to modules (spec-kit arming, etc.). ctx carries the
        // session's identity so a module needs no gateway internals.
        const modCtx = { sessionId: id, cwd, chatId: link.chatId, threadId: link.threadId };
        for (const o of lines) moduleRegistry.emit('transcriptLine', modCtx, o);
        const posts = [];
        const showTools = showToolsIn(link.chatId, link.threadId);
        for (const o of lines) posts.push(...renderTranscriptLine(o, showTools));
        // Track unresolved tool calls; announce completion of any we'd flagged as stalled.
        const pstate = (pendingTools[id] = pendingTools[id] || {});
        for (const r of updatePendingTools(pstate, lines, now)) {
          posts.push(`▶️ ${r.name} finished — session continuing.`);
        }
        if (posts.length) {
          // Readout separation: tool activity and the prose response post as distinct messages,
          // prose last, so the response is the clean reply-to-steer target. Advance the offset only
          // if every message sent — a mid-batch network hiccup retries the whole batch next tick.
          const { activity, prose } = splitReadout(posts);
          // Resume where the last attempt stopped. Without this the whole batch re-posts every tick,
          // and a batch big enough to trip Telegram's flood limit can never finish, which is exactly
          // how one topic collected thousands of duplicates.
          const cursor = linkCursor(link, newOffset);
          let allSent = true, backoffMs = 0;
          if (activity.length) {
            const res = await sendChunked(link.chatId, link.threadId, activity.join('\n\n'), { skip: cursor.activity });
            cursor.activity = res.sent;
            backoffMs = Math.max(backoffMs, res.retryAfterMs);
            if (!res.allSent) allSent = false;
          }
          if (allSent && prose.length) {
            const bar = BUTTONS ? buildSessionActionBar(id) : null;
            const res = await sendChunked(link.chatId, link.threadId, prose.join('\n\n'), { skip: cursor.prose, replyMarkup: bar });
            cursor.prose = res.sent;
            backoffMs = Math.max(backoffMs, res.retryAfterMs);
            if (!res.allSent) allSent = false;
            else if (bar && res.lastMessageId) {
              await clearPrevBar(id);
              lastBar.set(id, { chatId: link.chatId, messageId: res.lastMessageId });
            }
          }
          if (!allSent) {
            // Keep the offset so the rest of the batch retries, but only what has NOT been sent,
            // and not before Telegram's retry_after (falling back to the normal flush gap).
            link.mirrorCursor = cursor;
            persistLinks();       // survive a restart between this attempt and the retry
            const waitMs = Math.max(backoffMs, MIRROR_FLUSH_MS);
            mirrorRetryAt.set(id, now + waitMs);
            // A batch that cannot finish is the flood signature. Silence here is what let the
            // original incident run for hours, so the stall is counted even though it self-heals.
            telemetry.count('gateway.mirror.batch_stalled');
            telemetry.record('gateway.mirror.backoff_seconds', Math.round(waitMs / 1000));
            continue;
          }
          delete link.mirrorCursor;
          mirrorRetryAt.delete(id);
          lastMirrorAt.set(id, now);
        }
        link.userTurns = (link.userTurns || 0) + countUserTurns(lines);
        link.offset = newOffset;
        persistLinks();

        // Settled: name it after what the session became, not its opening line. Once only.
        if (dueForRename(link)) {
          link.renamed = true;          // set first — a failed rename must not retry every tick
          persistLinks();
          await renameTopicFromContent(id, link, file);
        }
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
      mirrorRetryAt.delete(id);
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
    // Per-tick module hook: settle-window timers, deferred reactions.
    moduleRegistry.emit('tick', now);
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
    const res = await telegramRequest('getUpdates',
      { offset: lastUpdateId + 1, timeout: UPDATE_POLL_TIMEOUT_S }, updateSocketTimeoutMs());
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
          const act = parseActionCallback(cb.data);
          if (act) {
            if (!BUTTONS) {
              telegramRequest('answerCallbackQuery', { callback_query_id: cb.id, text: 'Buttons are disabled.' }).catch(() => {});
            } else {
              await handleActionCallback(act, cb);
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
        if (!ALLOWED_USER_IDS.includes(senderId)) { console.warn(`[Blocked] user ${senderId}`); telemetry.count('gateway.access.blocked'); continue; }
        if (!REPO_MAPPINGS[chatId]) { console.warn(`[Config] chat ${chatId} not mapped`); continue; }
        if (!threadId) {
          telegramRequest('sendMessage', { chat_id: chatId, text: "⚠️ Please send commands inside a topic thread." }).catch(() => {});
          continue;
        }
        if (!text) continue;

        const key = `${chatId}_${threadId}`;

        if (text === '/start') {
          sendPlain(chatId, threadId, "👋 Claude Code gateway ready. Active desk sessions auto-appear as topics and mirror live.\n\n" +
            "• reply in a topic to steer that session\n• /new <msg> — fresh session in its own topic\n• /desk — open this session in the editor on your Mac\n• /rename [name] — rename this topic (bare = regenerate from content)\n• /sessions, /resume <id|text>");
          continue;
        }

        // /rename [name] — rename this topic. With an argument, use it verbatim; bare, regenerate
        // from the session's current content. The escape hatch for a session that has pivoted
        // since the automatic settle-rename fired.
        if (text === '/rename' || text.startsWith('/rename ')) {
          const sid = sessionByThread.get(key);
          const link = sid && linkBySession[sid];
          if (!link) { sendPlain(chatId, threadId, "No session is linked to this topic yet — send a message first."); continue; }
          const explicit = text.slice(7).trim();
          if (explicit) {
            const r = await editForumTopic(chatId, threadId, slugify(explicit) || explicit.slice(0, 40), pickIcon(explicit).id);
            sendPlain(chatId, threadId, r && r.ok ? `✏️ Renamed.` : `⚠️ Rename failed (${(r && r.description) || 'unknown'}).`);
            continue;
          }
          if (TITLE_MODE !== 'generated') {
            sendPlain(chatId, threadId, `TITLE_MODE is "${TITLE_MODE}", so there's no name to regenerate. Use \`/rename <name>\`, or set TITLE_MODE to "generated".`);
            continue;
          }
          sendPlain(chatId, threadId, "✏️ Regenerating the topic name…");
          const name = await renameTopicFromContent(sid, link, sessionFileById(sid));
          sendPlain(chatId, threadId, name ? `✏️ Renamed to ${name}` : "⚠️ Couldn't regenerate the name.");
          continue;
        }

        // /tools [on|off|default] [all] — mirror 🔧 tool steps, or don't. Tool lines are most of a
        // long run's message volume, so this is the noise dial: per topic, or `all` for the chat.
        const toolsCmd = parseToolsCommand(text);
        if (toolsCmd) {
          if (toolsCmd.action === 'help') {
            sendPlain(chatId, threadId, "Usage: /tools on|off (this topic) · /tools on|off all (this chat) · " +
              "/tools default [all] (drop the override) · /tools (show current)");
            continue;
          }
          if (toolsCmd.action !== 'show') {
            setToolPref(toolPrefs, toolsCmd, chatId, threadId);
            persistToolPrefs();
          }
          const { on, source } = toolActivityStatus(chatId, threadId);
          const where = toolsCmd.action === 'show' ? '' : (toolsCmd.scope === 'chat' ? ' for this chat' : ' for this topic');
          sendPlain(chatId, threadId, `${on ? '🔧' : '🔇'} Tool activity is ${on ? 'ON' : 'OFF'}${where} (set by ${source}). ` +
            `Responses, desk echoes and stall notices always post.`);
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

        // /stats: gateway usage and reliability summary from the local metric mirror.
        if (text === '/stats') {
          sendPlain(chatId, threadId, formatStats(telemetry.snapshot(), Date.now() - telemetry._startMs));
          continue;
        }

        // /new <message> — brand-new session in its own new topic.
        if (text.startsWith('/new ')) {
          const firstMsg = text.substring(5).trim();
          const { threadId: newThread } = await createForumTopic(chatId, firstMsg.slice(0, 50), pickIcon(firstMsg).id);
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
          await closeSessionTopic(sid, chatId, threadId);
          continue;
        }
        // /sessions or bare /resume — list recent sessions.
        if (text === '/sessions' || text === '/resume') {
          const sessions = await listSessions(REPO_MAPPINGS[chatId]);
          if (!sessions.length) { sendPlain(chatId, threadId, "No past Claude sessions found for this repo yet."); continue; }
          const kb = BUTTONS ? buildSessionPickerKeyboard(sessions) : null;
          if (kb) {
            await telegramRequest('sendMessage', { chat_id: chatId, message_thread_id: threadId,
              text: '🗂 Recent sessions · tap to link this topic:', reply_markup: kb }).catch(() => {});
          } else {
            sendPlain(chatId, threadId, `🗂 Recent sessions:\n\n${formatSessionList(sessions)}\n\nReply /resume <id> to link this topic to one.`);
          }
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
// Group auto-config: pure helpers + boot-time apply
// ---------------------------------------------------------------------------
function sha256(bufOrString) { return crypto.createHash('sha256').update(bufOrString).digest('hex'); }
function appearanceHash(obj) { return sha256(JSON.stringify(obj)); }

function humanizeMs(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function formatStats(snap, uptimeMs) {
  const sum = (name, match = {}) => snap.counters
    .filter((c) => c.name === name && Object.entries(match).every(([k, v]) => c.attrs[k] === v))
    .reduce((a, c) => a + c.value, 0);
  const turns = sum('gateway.claude.turn');
  const inj = sum('gateway.drive.injection');
  const created = sum('gateway.topic.created');
  const pruned = sum('gateway.topic.pruned');
  const failed = sum('gateway.topic.create_failed');
  const rl = sum('gateway.topic.create_failed', { reason: 'rate_limited' });
  const blocked = sum('gateway.access.blocked');
  const active = snap.observables['gateway.sessions.active'] ?? 'n/a';
  const sendFailed = sum('gateway.send.failed');
  const sendRl = sum('gateway.send.failed', { reason: 'rate_limited' });
  const stalled = sum('gateway.mirror.batch_stalled');
  return [
    `📊 Gateway (up ${humanizeMs(uptimeMs)})`,
    `Turns ${turns} · Injections ${inj} · Topics +${created} / pruned ${pruned}`,
    `Topic failures ${failed}${rl ? ` (${rl} rate-limited)` : ''}${failed ? ' ⚠️' : ''}`,
    // Omitted entirely on a healthy gateway: a row of zeros trains you to stop reading it.
    ...(sendFailed || stalled
      ? [`Send failures ${sendFailed}${sendRl ? ` (${sendRl} rate-limited)` : ''} · stalled batches ${stalled} ⚠️`]
      : []),
    `Active sessions ${active} · Blocked ${blocked}`,
  ].join('\n');
}

// The bot's command menu — identical for every mapped chat.
function buildCommandList() {
  return [
    { command: 'new',      description: 'Fresh session in its own topic' },
    { command: 'sessions', description: 'List recent sessions in this repo' },
    { command: 'desk',     description: 'Open this session in the editor on the Mac' },
    { command: 'rename',   description: 'Rename this topic (bare = regenerate from content)' },
    { command: 'exit',     description: 'Close this topic and stop mirroring' },
    { command: 'tools',    description: 'Show or set tool-step mirroring (on|off [all])' },
    { command: 'resume',   description: 'Link this topic to an existing session' },
    { command: 'stats',    description: 'Gateway usage & reliability stats' },
  ];
}

// Bot-global profile. Each field is null unless APPEARANCE overrides it, so an unset field is never
// pushed (setMyName/etc. skipped) and the live bot identity from getMe stays as-is.
function resolveBotProfile(appearance = {}) {
  return {
    name: appearance.bot_name ?? null,
    about: appearance.bot_about ?? null,
    description: appearance.bot_description ?? null,
  };
}

// Per-chat desired appearance (title/description default to null → not pushed). photoSha is passed
// in so this stays pure; the caller hashes the actual photo bytes.
function resolveChatAppearance(appearance = {}, chatId, photoSha = '') {
  const cfg = (appearance.chats || {})[chatId] || {};
  return {
    title: cfg.title ?? null,
    description: cfg.description ?? null,
    photoSha,
    commands: buildCommandList(),
  };
}

// The photo file to use for a chat: its own override, else the shared default, else none.
function chatPhotoPath(appearance = {}, chatId) {
  const cfg = (appearance.chats || {})[chatId] || {};
  return cfg.photo_path || appearance.default_photo_path || null;
}

// photo_path may be relative to the install dir (e.g. "assets/claude-logo.png").
function resolveAssetPath(p) { return path.isAbsolute(p) ? p : path.join(__dirname, p); }

const APPEARANCE_FILE = statePath('appearance.json');
function loadAppearanceState() {
  try { const s = JSON.parse(fs.readFileSync(APPEARANCE_FILE, 'utf8')); s.chats = s.chats || {}; return s; }
  catch (e) { return { botProfile: null, chats: {} }; }
}
function saveAppearanceState(s) {
  try { fs.writeFileSync(APPEARANCE_FILE, JSON.stringify(s, null, 2)); }
  catch (e) { console.error(`appearance: state write failed (${e.message})`); }
}

// A wrapped JSON Bot API call for appearance: returns true on ok, logs and returns false otherwise.
async function tgApply(method, payload) {
  try {
    const r = await telegramRequest(method, payload);
    if (r && r.ok) return true;
    // Telegram returns 400 "...is not modified" when the value already matches the live object.
    // That is the desired state, so treat it as success — otherwise the scope hash never persists
    // and every boot re-attempts the call (and can trip rate limits).
    if (r && /not modified/i.test(r.description || '')) return true;
    console.error(`appearance: ${method} failed (${(r && r.description) || 'unknown'})`);
    return false;
  } catch (e) { console.error(`appearance: ${method} failed (${e.message})`); return false; }
}

// setChatPhoto needs multipart/form-data (a file upload), which telegramRequest (JSON) can't do.
function setChatPhotoFile(chatId, filePath) {
  return new Promise((resolve) => {
    let photo;
    try { photo = fs.readFileSync(filePath); }
    catch (e) { console.error(`appearance: setChatPhoto read failed (${e.message})`); return resolve(false); }
    const boundary = `----gwphoto${process.pid}`;
    const pre = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="photo.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`);
    const post = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([pre, photo, post]);
    const req = https.request({
      hostname: 'api.telegram.org', port: 443, path: `/bot${BOT_TOKEN}/setChatPhoto`, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { const j = JSON.parse(b); if (!j.ok) console.error(`appearance: setChatPhoto failed (${j.description})`); resolve(!!j.ok); }
        catch (e) { resolve(false); }
      });
    });
    req.setTimeout(SOCKET_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { console.error(`appearance: setChatPhoto failed (${e.message})`); resolve(false); });
    req.write(body); req.end();
  });
}

// Boot-time, idempotent group + bot appearance. Reads live identity (getMe), applies bot-global
// profile once per value change, then each mapped chat's title/description/photo/commands/menu.
// A per-scope hash in appearance.json keeps frequent restarts silent; a partial failure leaves the
// old hash so the next boot retries just that scope.
async function configureGroup() {
  if (!AUTO_CONFIGURE_GROUP || !APPEARANCE) return;
  const state = loadAppearanceState();

  let me = null;
  try { const r = await telegramRequest('getMe'); if (r && r.ok) me = r.result; } catch (e) { /* */ }
  if (me) console.log(`[Appearance] configuring as @${me.username || me.first_name}`);

  // Bot-global profile (scoped to this bot; applied once per value change).
  if (APPEARANCE.set_bot_profile !== false) {
    const desired = resolveBotProfile(APPEARANCE);
    const h = appearanceHash(desired);
    if (h !== state.botProfile) {
      let ok = true;
      if (desired.name != null)        ok = (await tgApply('setMyName', { name: desired.name })) && ok;
      if (desired.about != null)       ok = (await tgApply('setMyShortDescription', { short_description: desired.about })) && ok;
      if (desired.description != null) ok = (await tgApply('setMyDescription', { description: desired.description })) && ok;
      if (ok) { state.botProfile = h; console.log('[Appearance] bot profile updated'); }
    }
  }

  // Per mapped chat: title / description / photo / commands / menu, keyed by chat id.
  for (const chatId of Object.keys(REPO_MAPPINGS)) {
    const cfg = (APPEARANCE.chats || {})[chatId] || {};
    const photoPath = chatPhotoPath(APPEARANCE, chatId);
    let photoSha = '';
    if (photoPath) { try { photoSha = sha256(fs.readFileSync(resolveAssetPath(photoPath))); } catch (e) { photoSha = ''; } }
    const h = appearanceHash(resolveChatAppearance(APPEARANCE, chatId, photoSha));
    if (h === state.chats[chatId]) continue;

    // A group photo should be representative of that group; the operator sets those by hand. Check
    // the live chat first and only set a photo when the group has NONE (bootstrap a fresh group),
    // unless the chat entry opts in with force_photo. getChat failure is treated as "has a photo"
    // so an API hiccup never overwrites one.
    let hasPhoto = true;
    try { const c = await telegramRequest('getChat', { chat_id: chatId }); if (c && c.ok) hasPhoto = !!(c.result && c.result.photo); } catch (e) { /* keep hasPhoto=true */ }

    let ok = true;
    if (cfg.title != null)       ok = (await tgApply('setChatTitle', { chat_id: chatId, title: cfg.title })) && ok;
    if (cfg.description != null) ok = (await tgApply('setChatDescription', { chat_id: chatId, description: cfg.description })) && ok;
    if (photoPath && photoSha && (!hasPhoto || cfg.force_photo === true)) {
      ok = (await setChatPhotoFile(chatId, resolveAssetPath(photoPath))) && ok;
    } else if (photoPath && hasPhoto) {
      console.log(`[Appearance] chat ${chatId} already has a photo · leaving it`);
    }
    ok = (await tgApply('setMyCommands', { commands: buildCommandList(), scope: { type: 'chat', chat_id: Number(chatId) } })) && ok;
    // Note: setChatMenuButton is a private-chat-only setting (per-user); calling it with a supergroup
    // chat_id returns "invalid chat_id specified". The command list in a group surfaces via
    // setMyCommands (above), so there is nothing more to do here.
    if (ok) { state.chats[chatId] = h; console.log(`[Appearance] chat ${chatId} updated`); }
  }

  saveAppearanceState(state);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const LOCK_FILE = path.join(STATE_DIR, '.gateway.lock');
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

async function shutdown() {
  console.log("\n🛑 [Gateway Shutdown] Exiting. Headless turns are short-lived; no orphaned sessions to kill.");
  try { await telemetry.stop(); } catch (e) { /* best effort */ }
  persistLinks();
  releaseLock();
  process.exit(0);
}

if (require.main === module) {
  // Timestamp every log line (launchd's log file has no timestamps of its own).
  for (const m of ['log', 'warn', 'error']) {
    const orig = console[m].bind(console);
    console[m] = (...a) => orig(new Date().toISOString(), ...a);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  acquireLock();
  writeRunningMarker();   // stamp the version this process loaded, before anything can fail
  loadLinks();
  telemetry.start();   // load persisted counters BEFORE incrementing, so restart isn't overwritten
  telemetry.count('gateway.restart');
  telemetry.registerObservable('gateway.sessions.active', () => Object.keys(linkBySession).length);
  telemetry.registerObservable('gateway.up', () => 1);
  loadIgnored();
  loadSuperseded();
  loadToolPrefs();
  moduleRegistry = loadModules(config, buildModuleApi(), console.error);
  if (moduleRegistry.names().length) console.log(`Modules: ${moduleRegistry.names().join(', ')}`);
  snapshotBaseline();   // record current sizes so a restart doesn't mass-create topics
  console.log("=============================================");
  console.log("🚀 CLAUDE CODE MULTI-SESSION TELEGRAM GATEWAY");
  console.log("=============================================");
  console.log(`Allowed admins: ${ALLOWED_USER_IDS.length} · repos: ${Object.keys(REPO_MAPPINGS).length}`);
  console.log(`Permission mode: ${PERM_MODE}${AUTO_APPROVE ? ' · auto-approve: ON' : ''}${MODEL ? ` · model: ${MODEL}` : ''} · tools: ${SHOW_TOOLS ? 'on' : 'off'} (${Object.keys(toolPrefs.chats).length + Object.keys(toolPrefs.threads).length} /tools override(s))`);
  console.log(`Mirror: ${MIRROR ? 'on' : 'off'} · auto-topics: ${AUTO_CREATE_TOPICS ? 'on' : 'off'} · prune: ${PRUNE_MODE} after ${formatPruneWindow(PRUNE_AFTER_MS)}`);
  console.log(`Restored ${Object.keys(linkBySession).length} linked session(s). Poll ${POLL_MS}ms.`);
  console.log("Listening for Topic messages + mirroring desk sessions...");
  configureGroup().catch((e) => console.error('appearance:', e.message));
  pollUpdates();
  setInterval(pollTick, POLL_MS);
  pollTick();
}

module.exports = {
  LiveMessage, summarizeToolInput, createFeed, renderTranscriptLine, splitReadout, readNewLines,
  listSessions, matchSessions, readSessionInfo, relTime, formatSessionList,
  isActive, shouldPrune, isDeskBusy, resolvePruneMs, formatPruneWindow, resolveShowTools,
  invertRepoMappings, splitThreadKey, buildThreadIndex,
  migrateLegacy, topicName, pickEmoji, pickIcon, openerText, shouldAutoCreate, loadIgnored, persistIgnored, persisted, deskUrl,
  lastExchange, contextTokens, sessionNameById, heldByOtherPids, updatePendingTools, dueStallNotices, createApprovalRegistry,
  titleArgs, PERM_MODE, createTopicCooldown, createInjectionSet, parseRetryAfter, updateSocketTimeoutMs, UPDATE_POLL_TIMEOUT_S,
  loadMcpServerPool, resolveChildMcp,
  STATE_DIR, STATE_FILES, migrateStateFiles, statePath, writeRunningMarker,
  countUserTurns, dueForRename, RENAME_AFTER_TURNS,
  createModuleRegistry,
  resolveModulePath, loadModules,
  buildSpawnArgs, spawnSession, buildModuleApi,
  chunkText, parseActionCallback, buildSessionActionBar, buildSessionPickerKeyboard,
  postWithMarkup, sendChunked, classifySendFailure, resumeCursor, linkCursor, closeSessionTopic,
  resolveToolActivity, parseToolsCommand, setToolPref, loadToolPrefs, persistToolPrefs,
  sha256, appearanceHash, buildCommandList, resolveBotProfile, resolveChatAppearance, chatPhotoPath,
  configureGroup,
  restartReady,
  repoOf, parseTurnUsage, recordTurnUsage,
  formatStats, humanizeMs,
  telemetry,   // exported so tests can assert that failures are actually counted, not just classifiable
};
