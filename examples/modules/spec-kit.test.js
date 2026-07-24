'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const m = require('./spec-kit.js');

test('extractCommand: pulls the command name from a slash-command user record', () => {
  const rec = { type: 'user', message: { content: '<command-name>/implement</command-name><command-message>implement</command-message>' } };
  assert.equal(m.extractCommand(rec), '/implement');
});

test('extractCommand: array content is scanned too', () => {
  const rec = { type: 'user', message: { content: [{ type: 'text', text: '<command-name>/plan</command-name>' }] } };
  assert.equal(m.extractCommand(rec), '/plan');
});

test('extractCommand: plain user prose and non-user records return null', () => {
  assert.equal(m.extractCommand({ type: 'user', message: { content: 'just a normal message' } }), null);
  assert.equal(m.extractCommand({ type: 'assistant', message: { content: [] } }), null);
  assert.equal(m.extractCommand(null), null);
});
