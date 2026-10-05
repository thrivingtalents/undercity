'use strict';
/**
 * The hosted platform: session isolation, join codes and admin auth.
 *
 * The isolation tests are the important ones. Two cohorts running at the same
 * time share a process, so a leak here would mean one client's crisis showing
 * up on another client's projector — the worst failure this product could have.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 3224;
const BASE = `http://localhost:${PORT}`;
const PASSWORD = 'test-password-123';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let dataDir;

/** A websocket client that keeps its latest state frame. */
function client(hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const api = { ws, state: null, messages: [], welcome: null, closed: false };
    const timer = setTimeout(() => reject(new Error('never welcomed')), 5000);
    ws.on('open', () => ws.send(JSON.stringify(hello)));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      api.messages.push(msg);
      if (msg.type === 'welcome') api.welcome = msg;
      if (msg.type === 'state') api.state = msg;
      if (msg.type === 'error') { clearTimeout(timer); reject(new Error(msg.reason)); }
      if (api.state) { clearTimeout(timer); resolve(api); }
    });
    ws.on('close', () => { api.closed = true; });
    ws.on('error', reject);
  });
}

/** Cookie-preserving fetch, so the admin API can be driven as a browser would. */
function makeAgent() {
  let cookie = null;
  return async function call(url, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`${BASE}${url}`, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercity-hosted-'));

  const seed = spawn(process.execPath,
    ['scripts/create-user.js', 'facilitator@test.local', 'Test Facilitator', PASSWORD],
    { cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir }, stdio: 'ignore' });
  await new Promise((r) => seed.on('exit', r));

  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, MODE: 'hosted' },
    stdio: 'ignore',
  });

  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await wait(250);
  }
  throw new Error('server never came up');
});

test.after(() => {
  if (server) server.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('admin routes are closed to anonymous callers', async () => {
  const anon = makeAgent();
  assert.equal((await anon('/api/admin/sessions')).status, 401);
  assert.equal((await anon('/api/admin/meta')).status, 401);
  assert.equal((await anon('/api/auth/me')).status, 401);

  // An API 401 must be JSON, not a redirect to an HTML login page — the
  // client distinguishes "signed out" from "request failed" on that.
  const res = await anon('/api/admin/sessions');
  assert.equal(res.json.error, 'unauthorised');
});

test('the printable kit is closed to anonymous callers', async () => {
  const anon = makeAgent();
  // The answer key holds every resolution code in the game; the binders hold
  // spec values. None of it may be reachable without signing in.
  for (const url of [
    '/api/admin/kit',
    '/api/admin/kit/download/UNDERCITY_AnswerKey.docx',
    '/api/admin/kit/download/UNDERCITY_Binder_WTR.docx',
    '/api/admin/kit/download-all',
    '/api/admin/kit/download-all?audience=facilitator',
  ]) {
    assert.equal((await anon(url)).status, 401, `${url} must require auth`);
  }
});

test('a signed-in facilitator can read and download the kit', async () => {
  const agent = makeAgent();
  await agent('/api/auth/login', {
    method: 'POST', body: { email: 'facilitator@test.local', password: PASSWORD },
  });

  const summary = await agent('/api/admin/kit');
  assert.equal(summary.status, 200);
  assert.equal(summary.json.available, true);
  assert.equal(summary.json.sync.status, 'ok');
  assert.equal(summary.json.counts.documents, 14);

  const one = await agent('/api/admin/kit/download/UNDERCITY_FaultCards.docx');
  assert.equal(one.status, 200);
  assert.match(one.headers.get('content-disposition'), /UNDERCITY_FaultCards\.docx/);

  const all = await agent('/api/admin/kit/download-all');
  assert.equal(all.status, 200);
  assert.equal(all.headers.get('content-type'), 'application/zip');
  assert.match(all.headers.get('content-disposition'), /undercity-kit-\d{4}-\d{2}-\d{2}\.zip/);
});

test('kit downloads refuse a path outside the manifest', async () => {
  const agent = makeAgent();
  await agent('/api/auth/login', {
    method: 'POST', body: { email: 'facilitator@test.local', password: PASSWORD },
  });
  for (const attempt of ['MANIFEST.json', 'nope.docx', '..%2F..%2Fserver.js']) {
    const res = await agent(`/api/admin/kit/download/${attempt}`);
    assert.equal(res.status, 404, `${attempt} must not resolve`);
  }
});

test('a wrong password is refused and reveals nothing', async () => {
  const agent = makeAgent();
  const bad = await agent('/api/auth/login', {
    method: 'POST', body: { email: 'facilitator@test.local', password: 'wrong' },
  });
  assert.equal(bad.status, 401);

  const noSuchUser = await agent('/api/auth/login', {
    method: 'POST', body: { email: 'nobody@test.local', password: 'wrong' },
  });
  assert.equal(noSuchUser.status, 401);
  assert.equal(bad.json.error, noSuchUser.json.error,
    'the same message either way — never disclose which half was wrong');
});

test('two concurrent sessions never leak into each other', async (t) => {
  const agent = makeAgent();
  const login = await agent('/api/auth/login', {
    method: 'POST', body: { email: 'facilitator@test.local', password: PASSWORD },
  });
  assert.equal(login.status, 200);

  const mk = async (name, teams) => {
    const res = await agent('/api/admin/sessions', { method: 'POST', body: { name, teams } });
    assert.equal(res.status, 201);
    const code = res.json.session.code;
    await agent(`/api/admin/sessions/${code}/status`, { method: 'POST', body: { status: 'LIVE' } });
    const detail = await agent(`/api/admin/sessions/${code}`);
    return { code, token: detail.json.control_token, teams: detail.json.session.teams };
  };

  const alpha = await mk('Alpha cohort', { POW: 'Team Ember' });
  const bravo = await mk('Bravo cohort', { POW: 'Team Tide' });
  assert.notEqual(alpha.code, bravo.code);
  assert.notEqual(alpha.token, bravo.token, 'each session gets its own control token');

  const aCtl = await client({ type: 'hello', role: 'control', session: alpha.code, token: alpha.token });
  const bCtl = await client({ type: 'hello', role: 'control', session: bravo.code, token: bravo.token });
  const aPow = await client({ type: 'hello', role: 'sector', session: alpha.code, sector: 'POW' });
  const bPow = await client({ type: 'hello', role: 'sector', session: bravo.code, sector: 'POW' });

  await t.test('teams are named per session', () => {
    assert.equal(aPow.welcome.team_name, 'Team Ember');
    assert.equal(bPow.welcome.team_name, 'Team Tide');
    assert.equal(aPow.welcome.session, alpha.code);
  });

  await t.test('a fault fired in one session appears only there', async () => {
    aCtl.ws.send(JSON.stringify({ type: 'set_mode', mode: 'PLAY' }));
    aCtl.ws.send(JSON.stringify({ type: 'fire_fault', fault_code: 'F-201', sector: 'POW' }));
    await wait(400);

    // Both sessions open on Round 0 with its set dealt (2026-09-29), so what
    // must not leak is the fault fired by hand, not the board's whole length.
    const has = (c, code) => c.state.sectors.POW.faults.some((f) => f.code === code);
    assert.ok(has(aPow, 'F-201'), 'Alpha POW does not see its fault');
    assert.ok(!has(bPow, 'F-201'), 'Bravo POW was sent a fault from another session');
    assert.equal(aPow.state.sectors.POW.faults.length, bPow.state.sectors.POW.faults.length + 1,
      'the two boards differ by more than the one fault Alpha was dealt');
  });

  await t.test('damage in one session does not move the other', async () => {
    aCtl.ws.send(JSON.stringify({ type: 'set_integrity', sector: 'POW', value: 22 }));
    aCtl.ws.send(JSON.stringify({ type: 'set_core_integrity', value: 40 }));
    await wait(400);

    assert.equal(aPow.state.sectors.POW.integrity, 22);
    assert.equal(aPow.state.core_integrity, 40);
    assert.equal(bPow.state.sectors.POW.integrity, 100, 'Bravo is untouched');
    assert.equal(bPow.state.core_integrity, 100);
  });

  await t.test('a control token is scoped to its own session', async () => {
    await assert.rejects(
      () => client({ type: 'hello', role: 'control', session: bravo.code, token: alpha.token }),
      (err) => err.message === 'bad_token',
      "Alpha's token must not open Bravo's control panel"
    );
  });

  await t.test('the answer key never reaches a participant in either session', () => {
    for (const c of [aPow, bPow]) {
      for (const frame of c.messages.filter((m) => m.type === 'state')) {
        assert.ok(!JSON.stringify(frame).includes('valid_codes'));
      }
    }
  });

  await t.test('resolving in one session leaves the other alone', async () => {
    aPow.ws.send(JSON.stringify({
      type: 'submit_code', sector: 'POW', fault_code: 'F-201',
      code: 'P-03-290', workers_assigned: 2,
    }));
    await wait(400);
    const result = aPow.messages.filter((m) => m.type === 'submit_result').pop();
    assert.equal(result.accepted, true);
    assert.ok(!bPow.state.sectors.POW.faults.some((f) => f.code === 'F-201'),
      "Alpha's fault reached Bravo");
  });

  await t.test('each session writes its own run log', () => {
    const aLog = path.join(dataDir, 'runs', alpha.code, 'runlog.jsonl');
    const bLog = path.join(dataDir, 'runs', bravo.code, 'runlog.jsonl');
    assert.ok(fs.existsSync(aLog) && fs.existsSync(bLog), 'both logs exist');

    const aLines = fs.readFileSync(aLog, 'utf8').trim().split('\n').map(JSON.parse);
    const bLines = fs.readFileSync(bLog, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(aLines.some((e) => e.ev === 'fault_fired' && e.fault === 'F-201'));
    // Bravo has its own Round 0 set in its own log (2026-09-29); what it must
    // never carry is an event from the run next door.
    assert.ok(!bLines.some((e) => e.ev === 'fault_fired' && e.fault === 'F-201'),
      "Bravo's log must not contain Alpha's events");
    assert.ok(!bLines.some((e) => e.ev === 'submit_result' || e.ev === 'fault_resolved'),
      "Bravo's log must not contain Alpha's resolution");
  });

  for (const c of [aCtl, bCtl, aPow, bPow]) c.ws.close();
});

test('a join code opens exactly one team\'s dashboard', async () => {
  const agent = makeAgent();
  await agent('/api/auth/login', {
    method: 'POST', body: { email: 'facilitator@test.local', password: PASSWORD },
  });
  const created = await agent('/api/admin/sessions', {
    method: 'POST', body: { name: 'Join test', teams: { WTR: 'Team Tide' } },
  });
  const code = created.json.session.code;
  await agent(`/api/admin/sessions/${code}/status`, { method: 'POST', body: { status: 'LIVE' } });

  const detail = await agent(`/api/admin/sessions/${code}`);
  const team = detail.json.session.teams.find((t) => t.sector === 'WTR');

  const res = await fetch(`${BASE}/j/${team.join_code}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `/s/${code}/sector/WTR`,
    'the link lands the table on its own sector — nothing to pick, nothing to type');

  const bad = await fetch(`${BASE}/j/NOTACODE`, { redirect: 'manual' });
  assert.equal(bad.status, 404);
});

test('rotating a join code invalidates the old link', async () => {
  const agent = makeAgent();
  await agent('/api/auth/login', {
    method: 'POST', body: { email: 'facilitator@test.local', password: PASSWORD },
  });
  const created = await agent('/api/admin/sessions', {
    method: 'POST', body: { name: 'Rotate test', teams: { MED: 'Team Vital' } },
  });
  const code = created.json.session.code;
  const before = (await agent(`/api/admin/sessions/${code}`)).json.session.teams
    .find((t) => t.sector === 'MED').join_code;

  await agent(`/api/admin/sessions/${code}/teams/MED/rotate`, { method: 'POST' });
  const after = (await agent(`/api/admin/sessions/${code}`)).json.session.teams
    .find((t) => t.sector === 'MED').join_code;

  assert.notEqual(before, after);
  assert.equal((await fetch(`${BASE}/j/${before}`, { redirect: 'manual' })).status, 404);
});

test('an ended session refuses new connections', async () => {
  const agent = makeAgent();
  await agent('/api/auth/login', {
    method: 'POST', body: { email: 'facilitator@test.local', password: PASSWORD },
  });
  const created = await agent('/api/admin/sessions', { method: 'POST', body: { name: 'Ends' } });
  const code = created.json.session.code;
  await agent(`/api/admin/sessions/${code}/status`, { method: 'POST', body: { status: 'LIVE' } });

  const pow = await client({ type: 'hello', role: 'sector', session: code, sector: 'POW' });
  assert.ok(pow.state);

  await agent(`/api/admin/sessions/${code}/status`, { method: 'POST', body: { status: 'ENDED' } });
  await wait(400);
  assert.ok(pow.closed, 'connected screens are disconnected when the run ends');

  await assert.rejects(
    () => client({ type: 'hello', role: 'sector', session: code, sector: 'POW' }),
    (err) => err.message === 'session_ended'
  );
});

test('an unknown session code is refused rather than silently created', async () => {
  await assert.rejects(
    () => client({ type: 'hello', role: 'sector', session: 'NOSUCH', sector: 'POW' }),
    (err) => err.message === 'unknown_session'
  );
});

test('a live session survives a restart', async () => {
  const agent = makeAgent();
  await agent('/api/auth/login', {
    method: 'POST', body: { email: 'facilitator@test.local', password: PASSWORD },
  });
  const created = await agent('/api/admin/sessions', { method: 'POST', body: { name: 'Restart test' } });
  const code = created.json.session.code;
  await agent(`/api/admin/sessions/${code}/status`, { method: 'POST', body: { status: 'LIVE' } });
  const token = (await agent(`/api/admin/sessions/${code}`)).json.control_token;

  const ctl = await client({ type: 'hello', role: 'control', session: code, token });
  ctl.ws.send(JSON.stringify({ type: 'set_mode', mode: 'PLAY' }));
  ctl.ws.send(JSON.stringify({ type: 'set_round', round: 'R3' }));
  ctl.ws.send(JSON.stringify({ type: 'set_core_integrity', value: 33 }));
  ctl.ws.send(JSON.stringify({ type: 'fire_fault', fault_code: 'F-301', sector: 'POW' }));
  ctl.ws.send(JSON.stringify({ type: 'snapshot' }));
  await wait(700);
  ctl.ws.close();

  server.kill('SIGKILL');
  await wait(600);
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, MODE: 'hosted' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* wait */ }
    await wait(250);
  }

  const after = await client({ type: 'hello', role: 'control', session: code, token });
  assert.equal(after.state.core_integrity, 33, 'core integrity survived');
  assert.equal(after.state.round, 'R3', 'the round survived');
  assert.ok(after.state.sectors.POW.faults.some((f) => f.code === 'F-301' && !f.resolved),
    'the live fault survived');
  after.ws.close();
});
