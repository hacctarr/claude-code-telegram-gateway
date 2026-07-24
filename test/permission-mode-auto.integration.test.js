// CLI contract test for PERMISSION_MODE=auto.
//
// The auto-approve design (docs/superpowers/specs/2026-07-22-auto-approve-mode-design.md) ships as
// a config change rather than gateway code, because the CLI's native `auto` mode already
// auto-approves ask-bucket tools while honoring `deny`. Nothing in gateway.js enforces that — it is
// entirely CLI behavior, so a Claude Code upgrade could silently take it away. This test pins it.
//
// Opt-in: it spawns real CLI turns and costs tokens.
//   RUN_CLI_CONTRACT=1 node --test test/permission-mode-auto.integration.test.js
//
// The two assertions that matter:
//   - under `auto`,   an ask-bucket tool runs with NO can_use_tool control request (CLI approved it)
//   - under any mode, a denylisted tool is blocked upstream and NEVER reaches the prompt tool
// The second is the safety gate: a blanket auto-allower can only ever see tools that are safe to
// allow, because denied ones never reach it.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENABLED = process.env.RUN_CLI_CONTRACT === '1';
const CLAUDE = process.env.CLAUDE_PATH || 'claude';
const TURN_TIMEOUT_MS = Number(process.env.CLI_CONTRACT_TIMEOUT_MS || 180000);

// Drive one headless turn the way gateway.js:714-768 does, auto-allowing every permission
// request, and report what the CLI actually did.
function runMode(mode) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perm-${mode}-`));
    const tripwire = path.join(dir, 'EXECUTED-tripwire');   // denied cmd's side effect
    const control = path.join(dir, 'EXECUTED-control');     // allowed cmd's side effect

    // `touch` is denied, `mkdir` is not — otherwise identical ask-bucket Bash calls.
    // Note: no colon in the denied command. A colon inside the command breaks the Bash
    // deny-pattern prefix parse, which silently reads as "deny didn't fire".
    const settings = JSON.stringify({ permissions: { deny: ['Bash(touch:*)'] } });
    const prompt =
      'Use the Bash tool for exactly these two steps, one command per call, no other tools:\n' +
      `1. Run: touch ${tripwire}\n` +
      `2. Run: mkdir -p ${control}\n` +
      'If a command is blocked by permissions, do NOT retry it and do not work around it — just ' +
      'move on to the next step. Then stop.';

    const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
                  '--permission-mode', mode,
                  '--permission-prompt-tool', 'stdio', '--input-format', 'stream-json',
                  '--settings', settings];

    const child = spawn(CLAUDE, args, { cwd: dir, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const prompts = [];
    let rem = '', stderr = '', settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      reject(new Error(`[${mode}] timed out after ${TURN_TIMEOUT_MS}ms`));
    }, TURN_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      rem += d.toString();
      const lines = rem.split('\n');
      rem = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let o; try { o = JSON.parse(line); } catch (e) { continue; }
        if (o.type === 'control_request' && o.request && o.request.subtype === 'can_use_tool') {
          prompts.push({ tool: o.request.tool_name, input: JSON.stringify(o.request.input) });
          // Auto-allow, mirroring what a blanket approver would do.
          try {
            child.stdin.write(JSON.stringify({
              type: 'control_response',
              response: { subtype: 'success', request_id: o.request_id,
                          response: { behavior: 'allow', updatedInput: o.request.input } },
            }) + '\n');
          } catch (e) { /* child gone */ }
          continue;
        }
        // stream-json input mode waits for more input after the result — close stdin to let it exit.
        if (o.type === 'result') { try { child.stdin.end(); } catch (e) { /* */ } }
      }
    });
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        mode,
        prompts,
        deniedPrompted: prompts.some((p) => /touch/.test(p.input)),
        controlPrompted: prompts.some((p) => /mkdir/.test(p.input)),
        deniedRan: fs.existsSync(tripwire),
        controlRan: fs.existsSync(control),
        stderr,
      });
    });

    // stdin must stay open for control responses (gateway.js:766-768). Without this opening
    // message the child hangs forever with no output.
    child.stdin.write(JSON.stringify({
      type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    }) + '\n');
  });
}

test('manual mode: ask-bucket tools prompt, denied tools never reach the prompt tool',
  { skip: ENABLED ? false : 'set RUN_CLI_CONTRACT=1 (spawns real CLI turns)', timeout: TURN_TIMEOUT_MS + 30000 },
  async () => {
    const r = await runMode('manual');
    // Establishes the prompt tool is genuinely live — without this the `auto` result below
    // would be indistinguishable from a broken harness that never prompts for anything.
    assert.ok(r.controlPrompted, `expected mkdir to prompt under manual; prompts=${JSON.stringify(r.prompts)}`);
    assert.ok(r.controlRan, 'expected mkdir to run after being allowed');
    assert.ok(!r.deniedPrompted, 'denied touch must never reach the prompt tool');
    assert.ok(!r.deniedRan, 'denied touch must not execute');
  });

test('auto mode: the CLI approves ask-bucket tools itself, with no control request',
  { skip: ENABLED ? false : 'set RUN_CLI_CONTRACT=1 (spawns real CLI turns)', timeout: TURN_TIMEOUT_MS + 30000 },
  async () => {
    const r = await runMode('auto');
    assert.ok(!r.controlPrompted, `auto must not emit can_use_tool; prompts=${JSON.stringify(r.prompts)}`);
    assert.ok(r.controlRan, 'ask-bucket mkdir must still run under auto');
    assert.ok(!r.deniedPrompted, 'denied touch must never reach the prompt tool');
    assert.ok(!r.deniedRan, 'denied touch must not execute under auto');
  });

// The shipping mode. Under bypass the allow/ask buckets stop mattering, so `deny` is the entire
// guardrail on the machine — this is the assertion that stands between bypass and an unguarded box.
test('bypassPermissions: nothing prompts, but deny is still enforced',
  { skip: ENABLED ? false : 'set RUN_CLI_CONTRACT=1 (spawns real CLI turns)', timeout: TURN_TIMEOUT_MS + 30000 },
  async () => {
    const r = await runMode('bypassPermissions');
    assert.ok(!r.controlPrompted, `bypass must not emit can_use_tool; prompts=${JSON.stringify(r.prompts)}`);
    assert.ok(r.controlRan, 'ask-bucket mkdir must still run under bypass');
    assert.ok(!r.deniedRan, 'denied touch must NOT execute under bypass — deny outranks bypass');
    assert.ok(!r.deniedPrompted, 'denied touch must never reach the prompt tool');
  });
