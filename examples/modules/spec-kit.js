'use strict';
// spec-kit workflow module for the Claude Code Telegram gateway.
// Arms when a spec-kit slash command appears in a watched session; on settle it
// injects /compact after non-terminal steps and spawns a fresh /code-review
// session when the terminal step (/implement) completes.
//
// External module: lives outside the published package, loaded via config.MODULES.

// A spec-kit step shows up as a user record containing <command-name>/x</command-name>.
function recordText(record) {
  if (!record || record.type !== 'user' || !record.message) return '';
  const c = record.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join(' ');
  return '';
}

function extractCommand(record) {
  const t = recordText(record);
  const mtch = /<command-name>\s*(\/[a-z0-9:_-]+)\s*<\/command-name>/i.exec(t);
  return mtch ? mtch[1].toLowerCase() : null;
}

// A texted-in command arrives as the raw prompt the user sent (e.g. "/plan" or "/plan foo").
function commandFromText(text) {
  const mtch = /^\s*(\/[a-z0-9:_-]+)/i.exec(typeof text === 'string' ? text : '');
  return mtch ? mtch[1].toLowerCase() : null;
}

// Settle-driven: a step is "done" once the transcript has been idle (no writes)
// for the threshold window since the step was armed. Terminal step uses a longer
// window because a false positive there spawns a whole review session.
function decideReaction(sessionState, cfg, now, mtime) {
  const none = { action: null, step: null };
  const s = sessionState;
  if (!s || !s.armedStep) return none;
  const isTerminal = s.armedStep === cfg.terminalCommand;
  if (isTerminal && s.reviewFired) return none;
  if (!isTerminal && (s.firedSteps || []).includes(s.armedStep)) return none;
  const idle = now - mtime;
  const threshold = isTerminal ? cfg.reviewSettleMs : cfg.settleMs;
  if (idle < threshold) return none;
  return isTerminal ? { action: 'review', step: s.armedStep } : { action: 'compact', step: s.armedStep };
}

const DEFAULT_STEPS = ['/specify', '/clarify', '/plan', '/tasks', '/analyze', '/implement'];

function factory(api) {
  const cfgSrc = (api && api.config) || {};
  const STEP_COMMANDS = Array.isArray(cfgSrc.STEP_COMMANDS) ? cfgSrc.STEP_COMMANDS.map((c) => c.toLowerCase()) : DEFAULT_STEPS;
  const cfg = {
    terminalCommand: (cfgSrc.TERMINAL_COMMAND || '/implement').toLowerCase(),
    settleMs: (cfgSrc.SPEC_KIT_SETTLE_SECONDS || 30) * 1000,
    reviewSettleMs: (cfgSrc.SPEC_KIT_REVIEW_SETTLE_SECONDS || 90) * 1000,
  };
  const store = api.state('spec-kit');   // { data, save() }

  // Desk-typed (onTranscriptLine) and texted-in (onInjectedTurn) commands both funnel here.
  function arm(sessionId, cmd) {
    if (!cmd || !STEP_COMMANDS.includes(cmd)) return;   // /compact & /code-review excluded → no re-arm
    const prev = store.data[sessionId] || {};
    store.data[sessionId] = {
      armedStep: cmd,
      armedAt: Date.now(),
      firedSteps: prev.firedSteps || [],
      reviewFired: prev.reviewFired || false,
    };
    store.save();
  }

  return {
    name: 'spec-kit',
    onTranscriptLine(ctx, record) { arm(ctx.sessionId, extractCommand(record)); },
    onInjectedTurn(ctx, prompt) { arm(ctx.sessionId, commandFromText(prompt)); },
    onTick(now) {
      let changed = false;
      for (const sessionId of Object.keys(store.data)) {
        const s = store.data[sessionId];
        const info = api.getSessionInfo(sessionId);
        if (!info) continue;
        const { action, step } = decideReaction(s, cfg, now, info.mtime || 0);
        if (action === 'compact') {
          api.injectTurn(sessionId, '/compact');
          api.postToTopic(sessionId, `✅ spec-kit: ${step} done → compacting`);
          s.firedSteps = (s.firedSteps || []).concat(step);
          changed = true;
        } else if (action === 'review') {
          api.spawnSession({ cwd: info.cwd, prompt: '/code-review', mode: undefined });
          api.postToTopic(sessionId, '🔍 implementation complete → launching review');
          s.reviewFired = true;
          changed = true;
        }
      }
      if (changed) store.save();
    },
  };
}

module.exports = factory;
module.exports.extractCommand = extractCommand;
module.exports.decideReaction = decideReaction;
module.exports.commandFromText = commandFromText;
