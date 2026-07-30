'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const c = require('../catchup.js');

// Fixture mirrors real transcript shape: two project dirs, a desk file, and a fork
// carrying the desk's copied history (same uuids) plus new phone turns.
const J = (o) => JSON.stringify(o) + '\n';
const DESK_LINES = [
  { uuid: 'u1', type: 'user', cwd: '/Users/me/repo', message: { role: 'user', content: 'first desk prompt' } },
  { uuid: 'u2', type: 'assistant', message: { content: [{ type: 'text', text: 'desk reply' }] } },
];
const FORK_NEW = [
  { uuid: 'u3', type: 'user', message: { role: 'user', content: 'phone: check  the\ndeploy' } },
  { uuid: 'u4', type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Bash', input: { command: 'git status' } },
    { type: 'text', text: 'All clean.' },
  ] } },
  { uuid: 'u5', type: 'user', isMeta: true, message: { role: 'user', content: 'meta noise' } },
  { uuid: 'u6', type: 'user', message: { role: 'user', content: '<command-name>/foo</command-name>' } },
  { uuid: 'u7', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'big output' }] } },
];

function mkFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-'));
  const projectsDir = path.join(root, 'projects');
  const proj = path.join(projectsDir, '-Users-me-repo');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.join(projectsDir, '-Users-me-other'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'desk-sid.jsonl'), DESK_LINES.map(J).join(''));
  fs.writeFileSync(path.join(proj, 'fork-sid.jsonl'), DESK_LINES.concat(FORK_NEW).map(J).join(''));
  return { root, projectsDir, proj };
}

test('readTranscriptLines: parses records, skips blank and malformed lines', () => {
  const { proj } = mkFixture();
  const file = path.join(proj, 'weird.jsonl');
  fs.writeFileSync(file, J({ uuid: 'a' }) + '\n' + 'not json\n' + J({ uuid: 'b' }));
  const lines = c.readTranscriptLines(file);
  assert.deepEqual(lines.map((o) => o.uuid), ['a', 'b']);
});

test('uuidSet: collects uuid fields, ignores records without one', () => {
  const s = c.uuidSet([{ uuid: 'a' }, { type: 'summary' }, { uuid: 'b' }]);
  assert.deepEqual([...s].sort(), ['a', 'b']);
});

test('findTranscript: locates a session file across project dirs', () => {
  const { projectsDir, proj } = mkFixture();
  assert.equal(c.findTranscript('desk-sid', projectsDir), path.join(proj, 'desk-sid.jsonl'));
  assert.equal(c.findTranscript('nope', projectsDir), null);
});

test('renderDigestEntry: user text is verbatim with the phone prefix', () => {
  assert.deepEqual(c.renderDigestEntry(FORK_NEW[0]), ['📱 phone: phone: check  the\ndeploy']);
});

test('renderDigestEntry: assistant text verbatim, tool calls as one-line traces', () => {
  assert.deepEqual(c.renderDigestEntry(FORK_NEW[1]), ['🔧 Bash: git status', 'All clean.']);
});

test('renderDigestEntry: meta lines, command envelopes, tool results excluded', () => {
  assert.deepEqual(c.renderDigestEntry(FORK_NEW[2]), []);
  assert.deepEqual(c.renderDigestEntry(FORK_NEW[3]), []);
  assert.deepEqual(c.renderDigestEntry(FORK_NEW[4]), []);
});

test('buildDigest: only entries whose uuid the desk file lacks', () => {
  const { proj } = mkFixture();
  const deskUuids = c.uuidSet(c.readTranscriptLines(path.join(proj, 'desk-sid.jsonl')));
  const digest = c.buildDigest(c.readTranscriptLines(path.join(proj, 'fork-sid.jsonl')), deskUuids);
  assert.equal(digest,
    '📱 phone: phone: check  the\ndeploy\n\n🔧 Bash: git status\n\nAll clean.');
  assert.ok(!digest.includes('desk reply'), 'copied history must not appear');
});
