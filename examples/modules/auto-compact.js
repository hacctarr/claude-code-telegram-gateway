'use strict';
// auto-compact module for the Claude Code Telegram gateway.
// Watches every mirrored session and, once one has gone quiet with a context worth
// summarizing, injects /compact (optionally behind a prelude turn such as /remember).
// The gateway is the only component that can do this: from Claude Code's side it is
// the user, and /compact is dispatchable non-interactively.
//
// External module: lives outside the published package, loaded via config.MODULES.

// Quiet + big enough to be worth a summarization call + not already handled this
// quiet period. mtime is the gateway's own idea of last write, so a session the
// gateway can't stat (mtime 0) reads as active rather than as infinitely idle.
function decideCompaction(sessionState, cfg, now, mtime, tokens) {
  const s = sessionState || {};
  if (!mtime || now - mtime < cfg.idleMs) return { fire: false, reason: 'active' };
  if (tokens < cfg.minTokens) return { fire: false, reason: 'below-floor' };
  if (s.firedAtMtime === mtime) return { fire: false, reason: 'already-fired' };
  return { fire: true, reason: 'idle' };
}

// A prelude (e.g. /remember) is its own turn ahead of the compaction: the queue drains
// one prompt per tick, so ordering holds and the durable capture lands before the discard.
function compactPrompts(cfg) {
  const compact = cfg.instructions ? `/compact ${cfg.instructions}` : '/compact';
  return cfg.prelude ? [cfg.prelude, compact] : [compact];
}

const DEFAULT_INSTRUCTIONS =
  'Preserve decisions, their rationale, open questions, and any identifiers ' +
  '(paths, ticket ids, account or permit numbers). Drop file listings and tool output.';

function factory(api) {
  const cfgSrc = (api && api.config) || {};
  const cfg = {
    idleMs: (cfgSrc.AUTO_COMPACT_IDLE_MINUTES || 45) * 60000,
    minTokens: cfgSrc.AUTO_COMPACT_MIN_TOKENS || 120000,
    prelude: cfgSrc.AUTO_COMPACT_PRELUDE || null,
    instructions: cfgSrc.AUTO_COMPACT_INSTRUCTIONS !== undefined
      ? cfgSrc.AUTO_COMPACT_INSTRUCTIONS
      : DEFAULT_INSTRUCTIONS,
  };
  const store = api.state('auto-compact');   // { data, save() }
  const prompts = compactPrompts(cfg);
  // A compaction turn must not arm the session that just got compacted, whether the
  // module injected it or a human texted one in with their own wording.
  const isCompactionTurn = (text) => {
    const t = (text || '').trim();
    return t === cfg.prelude || /^\/compact\b/.test(t);
  };

  // Sessions are learned by observation: desk activity arrives as transcript lines,
  // texted-in turns only as onInjectedTurn. Registering from both is what keeps
  // phone-driven sessions in scope, since injected turns bypass the mirror.
  function register(sessionId) {
    if (!sessionId || store.data[sessionId]) return;
    store.data[sessionId] = {};
    store.save();
  }

  return {
    name: 'auto-compact',
    onTranscriptLine(ctx) { register(ctx.sessionId); },
    onInjectedTurn(ctx, prompt) { if (!isCompactionTurn(prompt)) register(ctx.sessionId); },
    onTick(now) {
      // Older gateways have no getContextTokens; without it there is no floor to
      // enforce, and firing blind would compact short sessions. Stay inert instead.
      if (typeof api.getContextTokens !== 'function') return;
      let changed = false;
      for (const sessionId of Object.keys(store.data)) {
        const info = api.getSessionInfo(sessionId);
        if (!info) { delete store.data[sessionId]; changed = true; continue; }
        const tokens = api.getContextTokens(sessionId) || 0;
        const mtime = info.mtime || 0;
        if (!decideCompaction(store.data[sessionId], cfg, now, mtime, tokens).fire) continue;
        for (const p of prompts) api.injectTurn(sessionId, p);
        api.postToTopic(sessionId, `🗜️ Topic idle — compacting (~${Math.round(tokens / 1000)}k tokens).`);
        store.data[sessionId] = { firedAtMtime: mtime, firedAt: now };
        changed = true;
      }
      if (changed) store.save();
    },
  };
}

module.exports = factory;
module.exports.decideCompaction = decideCompaction;
module.exports.compactPrompts = compactPrompts;
