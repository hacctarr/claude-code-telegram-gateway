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
  if (Array.isArray(c)) return c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join(' ');
  return '';
}

function extractCommand(record) {
  const t = recordText(record);
  const mtch = /<command-name>\s*(\/[a-z0-9:_-]+)\s*<\/command-name>/i.exec(t);
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

module.exports = () => ({ name: 'spec-kit' });   // real factory assembled in Task 7
module.exports.extractCommand = extractCommand;
module.exports.decideReaction = decideReaction;
