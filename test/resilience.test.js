'use strict';
/**
 * Failure modes that would end a live session: the facilitator's laptop dies,
 * the server process dies, a table's dashboard drops off the router.
 *
 * "No restarts" is the definition of done, but a run that cannot survive one
 * is a run held together by luck.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 3223;
const TOKEN = 'test-token';

// Own scratch files, so a stray server from another suite cannot overwrite
// the snapshot these tests are about to restore from.
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercity-resilience-'));
const RUNLOG_PATH = path.join(runDir, 'runlog.jsonl');
const SNAPSHOT_PATH = path.join(runDir, 'snapshot.json');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const api = { ws, state: null, messages: [] };
    const timer = setTimeout(() => reject(new Error('never welcomed')), 5000);
    ws.on('open', () => ws.send(JSON.stringify(hello)));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      api.messages.push(msg);
      if (msg.type === 'state') api.state = msg;
      if (api.state) { clearTimeout(timer); resolve(api); }
    });
    ws.on('error', reject);
  });
}

function boot(resume) {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      FACILITATOR_TOKEN: TOKEN,
      RESUME: resume,
      RUNLOG_PATH,
      SNAPSHOT_PATH,
      DATA_DIR: path.join(runDir, 'data'),
      MODE: 'lan',
    },
    stdio: 'ignore',
  });
}

async function waitUp() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const probe = await client({ type: 'hello', role: 'bigscreen' });
      probe.ws.close();
      return;
    } catch { await wait(250); }
  }
  throw new Error('server never came up');
}

test('a mid-run crash is recovered from the snapshot', async () => {
  try { fs.unlinkSync(SNAPSHOT_PATH); } catch { /* fine */ }

  let server = boot('0');
  await waitUp();

  // Build a distinctive mid-run state.
  const control = await client({ type: 'hello', role: 'control', token: TOKEN });
  const say = (m) => control.ws.send(JSON.stringify(m));
  say({ type: 'reset_run', run_id: 'crash-test', confirm: true });
  await wait(200);
  say({ type: 'set_mode', mode: 'PLAY' });
  say({ type: 'set_round', round: 'R3' });
  say({ type: 'set_core_integrity', value: 37 });
  say({ type: 'set_integrity', sector: 'POW', value: 41 });
  say({ type: 'fire_fault', fault_code: 'F-301', sector: 'POW' });
  say({ type: 'snapshot' });
  await wait(600);

  assert.equal(control.state.core_integrity, 37);
  control.ws.close();

  // Kill it the way a tripped power strip would.
  server.kill('SIGKILL');
  await wait(500);

  server = boot('1');
  await waitUp();

  const after = await client({ type: 'hello', role: 'control', token: TOKEN });
  assert.equal(after.state.run_id, 'crash-test', 'the run id survives');
  assert.equal(after.state.core_integrity, 37, 'core integrity survives');
  assert.equal(after.state.round, 'R3', 'the round survives');
  assert.equal(after.state.sectors.POW.integrity, 41, 'sector integrity survives');
  assert.ok(after.state.sectors.POW.faults.some((f) => f.code === 'F-301' && !f.resolved),
    'the live fault survives, with its answer key intact for the facilitator');

  after.ws.close();
  server.kill();
  await wait(300);
});

test('a sector client that drops can rejoin and is fully re-seeded', async () => {
  const server = boot('0');
  await waitUp();

  const control = await client({ type: 'hello', role: 'control', token: TOKEN });
  const say = (m) => control.ws.send(JSON.stringify(m));
  say({ type: 'reset_run', run_id: 'reconnect-test', confirm: true });
  await wait(200);
  say({ type: 'set_mode', mode: 'PLAY' });
  say({ type: 'fire_fault', fault_code: 'F-201', sector: 'POW' });
  await wait(300);

  const pow = await client({ type: 'hello', role: 'sector', sector: 'POW' });
  // The run opens on Round 0 with that round's set dealt (2026-09-29), so what
  // is asserted here is the fault fired by hand, not the length of the board.
  const codes = (c) => c.state.sectors.POW.faults.map((f) => f.code);
  assert.ok(codes(pow).includes('F-201'), 'POW was not sent the fault that fired');

  // The laptop's wifi drops mid-crisis.
  pow.ws.terminate();
  await wait(300);

  // Meanwhile the world moves on.
  say({ type: 'fire_fault', fault_code: 'F-202', sector: 'POW' });
  say({ type: 'announce', text: 'Transport capacity reduced.' });
  await wait(300);

  const rejoined = await client({ type: 'hello', role: 'sector', sector: 'POW' });
  assert.deepEqual(codes(rejoined).filter((c) => c.startsWith('F-2')).sort(), ['F-201', 'F-202'],
    'the rejoining dashboard sees everything it missed');
  assert.equal(codes(rejoined).length, codes(pow).length + 1, 'the reconnect lost or duplicated a fault');
  assert.equal(rejoined.state.announcements[0].text, 'Transport capacity reduced.');
  assert.ok(!JSON.stringify(rejoined.state).includes('valid_codes'),
    'a reconnect must not hand the team the answer key');

  rejoined.ws.close();
  control.ws.close();
  server.kill();
  await wait(300);
});

test('a malformed frame does not take the server down', async () => {
  const server = boot('0');
  await waitUp();

  const pow = await client({ type: 'hello', role: 'sector', sector: 'POW' });
  pow.ws.send('this is not json');
  pow.ws.send(JSON.stringify({ type: 'nonsense' }));
  // A participant reaching for facilitator authority must simply be refused.
  pow.ws.send(JSON.stringify({ type: 'set_core_integrity', value: 0 }));
  await wait(400);

  const still = await client({ type: 'hello', role: 'control', token: TOKEN });
  assert.equal(still.state.core_integrity, 100, 'a sector client cannot move the core');
  assert.ok(pow.messages.some((m) => m.type === 'error' && m.reason === 'forbidden'),
    'the escalation attempt is refused explicitly');

  still.ws.close();
  pow.ws.close();
  server.kill();
  await wait(300);
});
