#!/usr/bin/env node
'use strict';
/**
 * DEMO SCENARIO (spec §50) — drives a running server through the whole
 * arc so the three screens can be watched side by side:
 *
 *   1 normal state · 2 trigger fault · 3 countdown · 4 wrong resolution ·
 *   5 correct resolution · 6 resource transfer · 7 integrity reduction ·
 *   8 critical state · 9 council · 10 continuity order · 11 brownout ·
 *   12 sector dark · 13 aftershock comparison
 *
 *   npm run demo                      # against http://localhost:3000, token haven9
 *   DEMO_URL=http://192.168.1.20:3000 DEMO_TOKEN=haven9 DEMO_FAST=1 npm run demo
 *
 * Open /wall, /sector/POW, /sector/WTR, /sector/TRN and /admin first. The demo
 * plays a POW Systems Lead and a TRN stamp over websockets, exactly as the
 * laptops would. Demo values are not game balance.
 */

const WebSocket = require('ws');

const URL = (process.env.DEMO_URL || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.DEMO_TOKEN || 'haven9';
const SESSION = (process.env.DEMO_SESSION || 'LOCAL').toUpperCase();
const SPEED = process.env.DEMO_FAST ? 0.25 : 1;
const WS = URL.replace(/^http/, 'ws');

const wait = (s) => new Promise((r) => setTimeout(r, s * 1000 * SPEED));
const waitReal = (s) => new Promise((r) => setTimeout(r, s * 1000));   // server-side timers do not speed up
const say = (text) => console.log(`\n▶ ${text}`);

function connect(hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    const api = { ws, state: null, last: {} };
    const timer = setTimeout(() => reject(new Error(`${hello.role} never welcomed — is the server up at ${URL}?`)), 6000);
    ws.on('open', () => ws.send(JSON.stringify(hello)));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'state') api.state = msg;
      else api.last[msg.type] = msg;
      if (msg.type === 'error' && ['bad_token', 'unknown_session'].includes(msg.reason)) {
        clearTimeout(timer); reject(new Error(`${hello.role}: ${msg.reason}`));
      }
      if (api.state) { clearTimeout(timer); resolve(api); }
    });
    ws.on('error', reject);
  });
}

async function main() {
  console.log(`UNDERCITY demo → ${URL} (session ${SESSION})`);
  const admin = await connect({ type: 'hello', role: 'control', session: SESSION, token: TOKEN });
  const pow = await connect({ type: 'hello', role: 'sector', session: SESSION, sector: 'POW' });
  const trn = await connect({ type: 'hello', role: 'sector', session: SESSION, sector: 'TRN' });
  const send = (c, m) => c.ws.send(JSON.stringify(m));
  const A = (m) => send(admin, m);

  say('0. Reset to a fresh run of the standard scenario');
  A({ type: 'reset_run', run_id: `demo-${new Date().toISOString().slice(11, 16).replace(':', '')}`, confirm: true });
  await wait(2);
  A({ type: 'set_phase', phase: 'ROUND_2' });
  A({ type: 'clock', which: 'round', action: 'start' });
  A({ type: 'announce', text: 'DEMO — Round 2 begins. Watch the wall, POW and TRN screens.' });
  say('1. Normal state — every sector STABLE at 100, cycle counting down');
  await wait(6);

  say('2. Trigger F-201 on POW — it appears on the POW screen and as the wall headline fault');
  A({ type: 'fire_fault', fault_code: 'F-201', sector: 'POW' });
  await wait(6);

  say('3. Countdown running (EMERGENCY default deadline) — POW opens the card');
  send(pow, { type: 'fault_open', fault_code: 'F-201' });
  await wait(6);

  say('4. Wrong resolution code, twice — attempts recorded, no lockout yet');
  send(pow, { type: 'submit_code', sector: 'POW', fault_code: 'F-201', code: 'P-04-000', workers_assigned: 2 });
  await wait(4);
  send(pow, { type: 'submit_code', sector: 'POW', fault_code: 'F-201', code: 'P-04-999', workers_assigned: 2 });
  await wait(4);
  say('   …and a third — CONSOLE LOCKED 00:20');
  send(pow, { type: 'submit_code', sector: 'POW', fault_code: 'F-201', code: 'P-04-111', workers_assigned: 2 });
  await waitReal(21);

  say('5. Correct code P-04-340 (the binder value; 290 from the wall also works) — FAULT RESOLVED +5, parts −2 water −1');
  send(pow, { type: 'submit_code', sector: 'POW', fault_code: 'F-201', code: 'P-04-340', workers_assigned: 2 });
  await wait(6);

  say('6. Resource transfer WTR → POW, 2 water — requested, then TRN stamps it and stock moves');
  A({ type: 'transfer_request', from: 'WTR', to: 'POW', resource: 'water', amount: 2 });
  await wait(5);
  const t = (admin.state.transfers || [])[0];
  if (t) send(trn, { type: 'transfer_stamp', id: t.id });
  await wait(6);

  say('7. Integrity reduction — second fault F-202 on POW and −20 by the facilitator');
  A({ type: 'fire_fault', fault_code: 'F-202', sector: 'POW' });
  A({ type: 'adjust_integrity', sector: 'POW', delta: -20 });
  await wait(5);

  say('8. CRITICAL — MED drops below 30; the wall strobes, the MED screen goes urgent');
  A({ type: 'set_integrity', sector: 'MED', value: 25 });
  A({ type: 'fire_event', event_id: 'core_output_drop' });
  await wait(8);

  say('9. CALL COUNCIL — every screen shows the 5:00 summons');
  A({ type: 'call_council' });
  await wait(10);

  say('10. Continuity Order POW › MED › WTR › TRN › COM › AGR — ranks 5 and 6 enter brownout');
  A({ type: 'continuity_order', order: ['POW', 'MED', 'WTR', 'TRN', 'COM', 'AGR'], confirm: true });
  await wait(8);

  say('11. Brownout — COM loses telemetry, AGR production halves; a core cycle is processed');
  A({ type: 'cycle', action: 'process' });
  await wait(8);

  say('12. Sector DARK — TRN goes offline; its console locks, the wall shows SECTOR DARK');
  A({ type: 'set_status', sector: 'TRN', value: 'DARK' });
  await wait(8);
  A({ type: 'set_status', sector: 'TRN', value: 'ACTIVE' });

  say('13. Aftershock — Round 3 vs Aftershock comparison on the wall');
  A({ type: 'set_phase', phase: 'ROUND_3' });
  A({ type: 'clock', which: 'round', action: 'start' });
  A({ type: 'fire_fault', fault_code: 'F-301', sector: 'POW' });
  await wait(4);
  send(pow, { type: 'submit_code', sector: 'POW', fault_code: 'F-301', code: 'P-06-000', workers_assigned: 3 });
  await wait(3);
  send(pow, { type: 'submit_code', sector: 'POW', fault_code: 'F-301', code: 'P-06-142-261', workers_assigned: 3 });
  await wait(3);
  A({ type: 'set_phase', phase: 'AFTERSHOCK' });
  A({ type: 'clock', which: 'round', action: 'start' });
  A({ type: 'fire_fault', fault_code: 'F-401', sector: 'POW' });
  await wait(4);
  send(pow, { type: 'submit_code', sector: 'POW', fault_code: 'F-401', code: 'P-07-243-534', workers_assigned: 2 });
  await wait(3);
  A({ type: 'set_phase', phase: 'DEBRIEF_2' });
  A({ type: 'wall_debrief', on: true });
  await wait(10);

  say('Done. The wall holds the comparison until you press HIDE FROM WALL in Admin → DEBRIEF. Export the log from the Admin top bar.');
  for (const c of [admin, pow, trn]) c.ws.close();
}

main().catch((err) => { console.error(`✗ ${err.message}`); process.exit(1); });
