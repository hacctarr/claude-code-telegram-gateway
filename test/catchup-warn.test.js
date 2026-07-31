'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const w = require('../catchup-warn.js');

const J = (o) => JSON.stringify(o) + '\n';

function mkFork() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-warn-'));
  const file = path.join(dir, 'fork-1.jsonl');
  const history = J({ uuid: 'u1', type: 'user', message: { role: 'user', content: 'old desk prompt' } });
  const region = [
    { uuid: 'u2', type: 'user', message: { role: 'user', content: 'phone turn one' } },
    { uuid: 'u3', type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } },
    { uuid: 'u4', type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } },
    { uuid: 'u5', type: 'user', message: { role: 'user', content: '<command-name>/x</command-name>' } },
    { uuid: 'u6', type: 'user', message: { role: 'user', content: 'phone turn two' } },
  ].map(J).join('');
  fs.writeFileSync(file, history + region);
  return { dir, file, offset: Buffer.byteLength(history, 'utf8') };
}

test('countPhoneTurns: real user turns past the offset only', () => {
  const { file, offset } = mkFork();
  assert.equal(w.countPhoneTurns(file, offset), 2);
  assert.equal(w.countPhoneTurns(file, 0), 3, 'offset 0 also counts the history turn');
  assert.equal(w.countPhoneTurns(file, 10_000_000), 0, 'offset past EOF is zero, not a throw');
});

// The offset comes from the DESK file's size but indexes the FORK file. Copied history is
// byte-similar, not byte-identical, so it lands mid-record routinely. Every fixture above
// aligns it to a newline, which is why the truncation below went unnoticed: a partial first
// line fails JSON.parse and is skipped, so a real phone turn silently vanishes from the count.
test('countPhoneTurns: an offset landing mid-record still counts that record', () => {
  const { file, offset } = mkFork();
  // Five bytes INTO the first phone turn, not before it.
  const midRecord = offset + 5;
  assert.equal(w.countPhoneTurns(file, midRecord), 2,
    'rewinding to the previous line boundary keeps the truncated turn');
});

test('countPhoneTurns: a record ending at or before the fork point is desk history, not a phone turn', () => {
  const { file, offset } = mkFork();
  // The realistic drift: the fork file runs slightly LONGER than the desk copy, so the desk's
  // size lands a few bytes inside the record that follows the history it already has. That
  // record must still be counted once, never twice, and the history before it never at all.
  assert.equal(w.countPhoneTurns(file, offset + 5), 2, 'straddling record counts once');
  assert.equal(w.countPhoneTurns(file, offset), 2, 'boundary-aligned offset is unchanged');
  // A record wholly before the offset is history the desk already has.
  const pastFirstPhoneTurn = offset + Buffer.byteLength(
    JSON.stringify({ uuid: 'u2', type: 'user', message: { role: 'user', content: 'phone turn one' } }) + '\n', 'utf8');
  assert.equal(w.countPhoneTurns(file, pastFirstPhoneTurn), 1,
    'the consumed phone turn drops out of the count');
});

test('warnLine: names the turn count and the command', () => {
  const { file, offset } = mkFork();
  const line = w.warnLine('desk-1',
    { 'desk-1': offset },
    { 'fork-1': { forkedFrom: 'desk-1' } },
    () => file);
  assert.equal(line, '📱 Phone branch is 2 turns ahead. Run /catchup to pull them in.');
});

test('warnLine: silent when not superseded, no forkedFrom link, or nothing new', () => {
  const { file, offset } = mkFork();
  assert.equal(w.warnLine('desk-1', {}, { 'fork-1': { forkedFrom: 'desk-1' } }, () => file), null,
    'self-clears once the rebind removes the sid from superseded');
  assert.equal(w.warnLine('desk-1', { 'desk-1': offset }, {}, () => file), null,
    'legacy links without forkedFrom stay silent, warn is best-effort');
  assert.equal(w.warnLine('desk-1', { 'desk-1': offset }, { 'fork-1': { forkedFrom: 'desk-1' } }, () => null), null);
  const size = fs.statSync(file).size;
  assert.equal(w.warnLine('desk-1', { 'desk-1': size }, { 'fork-1': { forkedFrom: 'desk-1' } }, () => file), null,
    'no turns past the fork point');
});

test('installWarnHook: registers both events, idempotent, preserves existing settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-settings-'));
  const settings = path.join(dir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ model: 'opus', hooks: { UserPromptSubmit: [
    { hooks: [{ type: 'command', command: 'echo other' }] },
  ] } }));
  w.installWarnHook(settings, '/opt/gw');
  w.installWarnHook(settings, '/opt/gw');   // second run must not duplicate
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(s.model, 'opus', 'unrelated settings preserved');
  const cmds = (ev) => s.hooks[ev].flatMap((e) => e.hooks.map((h) => h.command));
  assert.deepEqual(cmds('UserPromptSubmit'),
    ['echo other', 'node "/opt/gw/catchup-warn.js"']);
  assert.deepEqual(cmds('SessionStart'), ['node "/opt/gw/catchup-warn.js"']);
});

test('installWarnHook: creates the settings file when absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-settings-'));
  const settings = path.join(dir, 'sub', 'settings.json');
  w.installWarnHook(settings, '/opt/gw');
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(s.hooks.SessionStart.length, 1);
});
