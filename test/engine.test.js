'use strict';
/**
 * The game control layer: phases, the city cycle, decay, transfers,
 * council and the Continuity Order, rolling blackout, events, the timeline,
 * pause, configuration and the debrief analytics.
 *
 * Every number asserted here comes from config/scenarios/haven9-standard.json
 * — the engine has none of its own.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { newGame, logEvents, loadContent, rounds } = require('./helpers');
const { submitCode } = require('../lib/resolve');
const { forSector, forBigscreen, forControl } = require('../lib/visibility');
const { analyse } = require('../lib/analytics');
const { ScenarioLibrary, deepMerge } = require('../lib/config');
const { Store } = require('../lib/db');

const SECTORS = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];

/** A game in ROUND_2 with the clock running. */
function running() {
  const game = newGame();
  game.setPhase('ROUND_2');
  game.clock('start');
  return game;
}

// -- phases -------------------------------------------------------------------

test('phases walk SETUP → FINISHED, each stamping round, mode and the log', () => {
  const game = newGame();
  assert.equal(game.state.phase, 'SETUP');
  assert.equal(game.phaseConfig().mode, 'BRIEFING');
  const seen = [];
  while (game.nextPhase()) seen.push(game.state.phase);
  assert.deepEqual(seen, ['ORIENTATION', 'ROUND_1', 'ROUND_2', 'ROUND_3', 'DEBRIEF_1', 'AFTERSHOCK', 'DEBRIEF_2', 'FINISHED']);
  assert.equal(game.state.round, 'R4');
  assert.equal(game.state.mode, 'DEBRIEF');
  assert.equal(game.nextPhase(), false, 'FINISHED is the end');
  const phases = logEvents(game, 'phase');
  assert.equal(phases.length, 8);
  assert.ok(phases.every((p) => p.t && p.phase && p.round), 'every phase change is timestamped');
});

test('START runs the round clock; the retired cycle timer stays still; frozen states stop the clock', () => {
  const game = newGame();
  game.setPhase('ROUND_1');
  game.clock('start');
  assert.equal(game.state.mode, 'PLAY');
  assert.equal(game.state.cycle.running, false, 'no free-running economy timer');
  assert.equal(game.state.round_clock.started, true);
  const before = { round: game.state.round_clock.remaining_s, cycle: game.state.cycle.remaining_s };
  game.tick(5000);
  assert.equal(game.state.round_clock.remaining_s, before.round - 5);
  assert.equal(game.state.cycle.remaining_s, before.cycle, 'the legacy timer does not count');

  game.pause();
  game.tick(60000);
  assert.equal(game.state.round_clock.remaining_s, before.round - 5, 'paused: nothing moves');
  game.resume();
  game.tick(1000);
  assert.equal(game.state.round_clock.remaining_s, before.round - 6, 'resumes from the exact remaining time');
});

test('pause freezes decay and the council clock but not the lockout', () => {
  const game = running();
  game.fireFault('F-201', 'POW');
  const fault = game.findFault('POW', 'F-201');
  for (let i = 0; i < 3; i += 1) submitCode(game, { sector: 'POW', fault_code: 'F-201', code: 'P-04-000', workers_assigned: 2 });
  assert.equal(fault.locked_until_s, 20);
  game.callCouncil();
  game.pause();
  const integrity = game.state.sectors.POW.integrity;
  game.tick(25000);
  assert.equal(game.state.sectors.POW.integrity, integrity);
  assert.equal(game.state.council_clock.remaining_s, 300);
  assert.equal(fault.locked_until_s, 0, 'a locked console still unlocks while paused');
  const frame = forSector(game, 'POW');
  assert.equal(frame.paused, true);
  assert.equal(frame.round_clock.running, false, 'clients must not interpolate while frozen');
});

// -- faults: decay is the only clock ------------------------------------------------

test('opening a card and submitting both count as the first action', () => {
  const game = running();
  game.fireFault('F-201', 'POW');
  game.openFault('POW', 'F-201');
  const f = game.state.sectors.POW.faults[0];
  assert.ok(f.opened_at && f.first_action_at);
  assert.equal(logEvents(game, 'fault_opened').length, 1);
  game.openFault('POW', 'F-201');
  assert.equal(logEvents(game, 'fault_opened').length, 1, 'opened once');
});

test('brownout holds workers back and adds its own bleed to an open fault', () => {
  const game = running();
  game.setStatus('POW', 'BROWNOUT');
  game.fireFault('F-201', 'POW');
  const f = game.findFault('POW', 'F-201');
  assert.equal('deadline_s' in f, false);
  assert.equal(game.availableWorkers(game.state.sectors.POW), 8 - game.cfg.brownout_effects.worker_penalty);
  const before = game.state.sectors.POW.integrity;
  game.tick(60000);
  assert.ok(before - game.state.sectors.POW.integrity >= 1.5 - 0.05, 'the fault stopped bleeding in brownout');
});

// -- faults: decay is the only clock ------------------------------------------------
//
// There is no deadline. A fault has no countdown, no expiry, no penalty at a
// moment in time; it bleeds the sector's health at its decay rate until it is
// solved. The screen tells the team WHAT is wrong; the binder tells them HOW.

const DEADLINE_KEYS = ['deadline', 'deadline_s', 'deadline_remaining_s', 'deadline_at', 'time_remaining', 'time_limit',
  'integrity_penalty', 'expired', 'expired_at', 'warned_30'];
const DEADLINE_EVENTS = ['deadline_expired', 'fault_failed', 'deadline_started', 'deadline_warning', 'fault_timeout', 'deadline_reset'];
const SECTOR_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'sector', 'index.html'), 'utf8');
const SECTOR_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'sector', 'sector.js'), 'utf8');
const SECTOR_CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'sector', 'sector.css'), 'utf8');

test('a fired fault carries no deadline fields, and F-302 / F-304 / F-404 have no countdown', () => {
  const game = running();
  for (const [code, sector] of [['F-201', 'POW'], ['F-302', 'WTR'], ['F-304', 'TRN'], ['F-404', 'TRN']]) {
    game.fireFault(code, sector);
    const f = game.findFault(sector, code);
    for (const k of DEADLINE_KEYS) assert.equal(k in f, false, `${code} carries ${k}`);
    assert.ok(f.decay_per_min > 0, `${code} has no decay`);
  }
  // the content's old deadline_s on the three special faults is inert
  const content = loadContent().faults.faults;
  assert.equal(content.find((f) => f.code === 'F-302').deadline_s, 480, 'the content still says 480 — and the engine ignores it');
  game.tick(15 * 60 * 1000);   // long past every old limit
  for (const [code, sector] of [['F-302', 'WTR'], ['F-304', 'TRN'], ['F-404', 'TRN']]) {
    const f = game.findFault(sector, code);
    assert.ok(f && !f.resolved, `${code} was closed by a clock`);
    assert.equal(f.status, 'ACTIVE');
  }
  for (const ev of DEADLINE_EVENTS) assert.equal(logEvents(game, ev).length, 0, `${ev} was logged`);
  assert.equal(logEvents(game, 'fault_fired').every((e) => !('deadline_s' in e)), true, 'fault_fired still logs a deadline');
});

test('decay bleeds the owner every second, stacks across faults, and stops the moment a fault is solved', () => {
  const game = running();
  game.fireFault('F-201', 'POW');            // 1.5 / min
  game.fireFault('F-202', 'POW');            // 1.0 / min
  const before = game.state.sectors.POW.integrity;
  game.tick(60000);
  assert.ok(Math.abs(game.state.sectors.POW.integrity - (before - 2.5)) < 0.01, 'two faults did not stack');
  const res = submitCode(game, { sector: 'POW', fault_code: 'F-201', code: 'P-04-340', workers_assigned: 2 });
  assert.equal(res.accepted, true);
  const after = game.state.sectors.POW.integrity;
  game.tick(60000);
  assert.ok(Math.abs(game.state.sectors.POW.integrity - (after - 1.0)) < 0.01, 'the solved fault kept bleeding');
  game.pauseFault('POW', 'F-202', true);
  const paused = game.state.sectors.POW.integrity;
  game.tick(60000);
  assert.equal(game.state.sectors.POW.integrity, paused, 'a paused fault still bled');
});

test('the tick never expires, penalises or fails a fault, however long it runs', () => {
  const game = running();
  game.fireFault('F-101', 'POW');            // an incident: 0.8 / min, no old deadline
  game.fireFault('F-302', 'WTR');            // 3.0 / min, old 8:00 limit
  const pow = game.state.sectors.POW.integrity;
  const wtr = game.state.sectors.WTR.integrity;
  game.tick(9 * 60 * 1000);
  assert.ok(Math.abs(game.state.sectors.POW.integrity - (pow - 0.8 * 9)) < 0.05, 'POW lost more than decay');
  assert.ok(Math.abs(game.state.sectors.WTR.integrity - (wtr - 3.0 * 9)) < 0.05, 'WTR lost more than decay: a hidden penalty');
  assert.equal(game.findFault('WTR', 'F-302').status, 'ACTIVE');
  assert.equal(game.state.sectors.WTR.faults.some((f) => f.status === 'FAILED' || f.status === 'EXPIRED'), false);
  assert.equal(logEvents(game, 'deadline_expired').length + logEvents(game, 'fault_failed').length, 0);
});

test('a saved run from the deadline era loads with its clocks dead and its faults still open', () => {
  const game = running();
  game.fireFault('F-302', 'WTR');
  const snap = JSON.parse(JSON.stringify(game.serialise()));
  const f = snap.state.sectors.WTR.faults[0];
  Object.assign(f, { deadline_s: 480, deadline_remaining_s: 3, integrity_penalty: 15, expired: false, warned_30: false });
  snap.state.sectors.POW.faults.push({ ...f, id: 'F-legacy', code: 'F-201', deadline_remaining_s: 0, expired: true, expired_at: 'x', status: 'EXPIRED', resolved: false });
  const back = newGame();
  assert.equal(back.restore(snap), true);
  const wtr = back.findFault('WTR', 'F-302');
  const pow = back.findFault('POW', 'F-201');
  for (const k of DEADLINE_KEYS) { assert.equal(k in wtr, false, `restored fault carries ${k}`); assert.equal(k in pow, false, `legacy fault carries ${k}`); }
  assert.equal(pow.status, 'ACTIVE', 'a legacy EXPIRED-but-open fault is simply open');
  const integrity = back.state.sectors.WTR.integrity;
  back.tick(10000);
  assert.ok(back.state.sectors.WTR.integrity > integrity - 1, 'a legacy clock fired a penalty');
  for (const ev of DEADLINE_EVENTS) assert.equal(logEvents(back, ev).length, 0);
  // and the snapshot the new engine writes has nothing to migrate
  const fresh = JSON.parse(JSON.stringify(back.serialise()));
  for (const k of DEADLINE_KEYS) assert.equal(k in fresh.state.sectors.WTR.faults[0], false, `new snapshot writes ${k}`);
});

test('the sector is told what is wrong and what it pays — never crew, materials, procedure or where to look', () => {
  const game = running();
  game.patchConfig({ card_shows_dependency: true });   // even with the old hint switch on
  game.fireFault('F-201', 'POW');                       // flavour: "…; needs reservoir rating from WTR."
  const f = forSector(game, 'POW').sectors.POW.faults[0];
  for (const k of ['crew_required', 'resources_required', 'procedure', 'spec_refs', 'valid_codes', 'binder', 'table', ...DEADLINE_KEYS]) {
    assert.equal(k in f, false, `the sector frame carries ${k}`);
  }
  assert.equal(f.flavour, 'Turbine coolant pressure collapsing.', 'the dependency half leaked');
  assert.ok(!/WTR|reservoir rating|Appendix|binder|procedure/i.test(f.flavour));
  assert.equal(typeof f.decay_per_min, 'number');
  assert.equal(f.reward.text, '+2 WATER');
  assert.equal(typeof f.attempts, 'number');
  // the facilitator still sees the whole line
  const c = forControl(game).sectors.POW.faults[0];
  assert.equal(c.crew_required, 2);
  assert.deepEqual(c.resources_required, { parts: 2, water: 1 });
  assert.ok(/WTR/.test(c.flavour));
});

test('refusals name the problem and never the answer', () => {
  const game = running();
  game.patchConfig({ resolve_requires_resources: true });
  game.fireFault('F-201', 'POW');                       // crew 2; parts 2, water 1
  const crew = submitCode(game, { sector: 'POW', fault_code: 'F-201', code: 'P-04-340', workers_assigned: 1 });
  assert.equal(crew.accepted, false);
  assert.equal(crew.reason, 'insufficient_crew');
  for (const k of ['crew_required', 'workforce_active', 'short', 'needed', 'missing']) assert.equal(k in crew, false, `crew refusal carries ${k}`);
  const many = submitCode(game, { sector: 'POW', fault_code: 'F-201', code: 'P-04-340', workers_assigned: 99 });
  assert.equal(many.reason, 'invalid_workers');
  game.setInventory('POW', { parts: 0 });
  const mats = submitCode(game, { sector: 'POW', fault_code: 'F-201', code: 'P-04-340', workers_assigned: 2 });
  assert.equal(mats.reason, 'insufficient_resources');
  for (const k of ['short', 'crew_required', 'resources_required']) assert.equal(k in mats, false, `materials refusal carries ${k}`);
  game.setInventory('POW', { parts: 3 });
  const wrong = submitCode(game, { sector: 'POW', fault_code: 'F-201', code: 'P-04-999', workers_assigned: 2 });
  assert.equal(wrong.reason, 'invalid_code');
  for (const k of ['valid_codes', 'procedure', 'hint']) assert.equal(k in wrong, false);
  // the debrief still gets the numbers, in the log only
  const logged = logEvents(game, 'submit').find((e) => e.reason === 'insufficient_crew');
  assert.equal(logged.crew_required, 2);
  assert.equal(logged.workforce_active, 8);
  // and the screen's words for them
  for (const word of ['RESOLUTION REJECTED', 'INSUFFICIENT CREW', 'MATERIALS NOT READY', 'WORKER ASSIGNMENT INVALID']) {
    assert.ok(SECTOR_JS.includes(word), `the screen lacks "${word}"`);
  }
  assert.ok(!/needs \$\{v\.crew_required\}|Insufficient resources: \$\{/.test(SECTOR_JS), 'the screen still prints the numbers');
});

test('the reward is unchanged by the removal: previewed before, paid once after', () => {
  const game = running();
  game.fireFault('F-302', 'WTR');
  assert.equal(forSector(game, 'WTR').sectors.WTR.faults[0].reward.text, '+2 POWER · +5 SECTOR HEALTH');
  const power = game.state.sectors.WTR.inventory.power;
  game.setIntegrity('WTR', 60);
  const def = loadContent().faults.faults.find((x) => x.code === 'F-302');
  const res = submitCode(game, { sector: 'WTR', fault_code: 'F-302', code: def.valid_codes[0], workers_assigned: def.crew_required });
  assert.equal(res.accepted, true);
  assert.equal(res.reward.applied, true);
  assert.equal(game.state.sectors.WTR.inventory.power, power - ((def.resources_required || {}).power || 0) + 2);
  assert.equal(game.state.sectors.WTR.integrity, 60 + game.cfg.resolve_recovery + 5);
  assert.equal(logEvents(game, 'fault_reward_applied').length, 1);
});

test('the wall and the facilitator get no deadline either; the wall ranks faults by severity then age', () => {
  const game = running();
  game.fireFault('F-101', 'POW');   // sev 1
  game.fireFault('F-201', 'POW');   // sev 2
  const w = forBigscreen(game).sectors.POW.top_fault;
  assert.equal(w.code, 'F-201');
  for (const k of DEADLINE_KEYS) assert.equal(k in w, false, `the wall's fault carries ${k}`);
  const c = forControl(game).sectors.POW.faults[0];
  for (const k of DEADLINE_KEYS) assert.equal(k in c, false, `the facilitator's fault carries ${k}`);
  assert.equal('deadline_default_s' in game.cfg, false, 'the scenario still carries deadline defaults');
  assert.equal('deadline_penalty' in game.cfg, false);
  assert.equal('expired_faults_remain_solvable' in game.cfg, false);
});

test('the fault screen has one expanded card, compact rows, a status row and one action area — and nothing about deadlines or the answer', () => {
  // one card, one console: several faults are rows that swap the card, never stacked cards
  assert.equal((SECTOR_HTML.match(/id="card"/g) || []).length, 1);
  assert.equal((SECTOR_HTML.match(/id="code-input"/g) || []).length, 1);
  assert.ok(/id="fault-list"/.test(SECTOR_HTML));
  // nothing about deadlines, in markup, script or style
  for (const bad of ['card-deadline', 'card-time', 'card-penalty', 'NO DEADLINE', 'DEADLINE', 'Time remaining', 'card-hints', 'card-meta',
    'FAULT INDEX', 'TECHNICAL OPERATIONS BINDER', 'CREW REQUIRED', 'SPEND']) {
    assert.equal(SECTOR_HTML.includes(bad), false, `markup still has "${bad}"`);
    assert.equal(SECTOR_JS.includes(bad), false, `script still has "${bad}"`);
  }
  for (const bad of ['deadline', 'card-time', 'card-clock', 'card-penalty', 'card-hints', 'card-meta', 'fr-dl']) {
    assert.equal(SECTOR_CSS.includes(bad), false, `style still has "${bad}"`);
  }
  // the status row holds severity, decay and reward only; the action area the four controls
  const status = SECTOR_HTML.match(/<div class="card-status">([\s\S]*?)<\/div>\s*<!--/);
  assert.ok(status, 'no status row');
  assert.deepEqual((status[1].match(/id="([^"]+)"/g) || []).map((m) => m.slice(4, -1)), ['card-sev', 'card-decay', 'card-reward', 'card-reward-text']);
  const console_ = SECTOR_HTML.match(/<div class="console" id="console">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/);
  assert.ok(console_, 'no action area');
  assert.deepEqual((console_[1].match(/id="([^"]+)"/g) || []).map((m) => m.slice(4, -1)), ['code-input', 'workers-select', 'submit-btn', 'console-msg', 'card-attempts']);
  // the code and title appear once each in the card
  const card = SECTOR_HTML.match(/<div class="panel card" id="card" hidden>([\s\S]*?)<\/section>/)[1];
  assert.equal((card.match(/id="card-code"/g) || []).length, 1);
  assert.equal((card.match(/id="card-name"/g) || []).length, 1);
  assert.equal((card.match(/id="card-sev"/g) || []).length, 1);
  // the decay chip reads the way the spec wants
  assert.ok(/DECAY −\$\{[^}]+\} HEALTH \/ MIN/.test(SECTOR_JS), 'decay is not printed as DECAY −rate HEALTH / MIN');
  // a fresh selection assigns one worker, not the answer
  assert.ok(!/Number\(f\.crew_required\)/.test(SECTOR_JS), 'the worker selector still defaults to the required crew');
});

// -- the city cycle ------------------------------------------------------------------

test('the upkeep pass: generated output, upkeep, shortage penalty, recovery, summary', () => {
  const game = running();
  const pow = game.state.sectors.POW;
  const wtr = game.state.sectors.WTR;
  pow.inventory = { power: 0, water: 0, parts: 3, med: 1 };   // will miss 1 water, after generating +3 power
  wtr.workforce.injured = 2; wtr.workforce.active = 6;
  game.state.sectors.MED.inventory.med = 3;
  // Output is generated by hand (v10): POW and WTR press the button before the round ends.
  assert.equal(game.generateOutput('POW', { by: 'POW' }).ok, true);
  assert.equal(game.generateOutput('WTR', { by: 'WTR' }).ok, true);

  const summary = game.cycleControl('process');
  assert.deepEqual(summary.sectors.POW.produced, { power: 3 }, 'the pass reports what POW generated');
  assert.equal(summary.round, 'R2');
  // POW: +3 power generated, then upkeep 2 power 1 water → power 1, water short by 1
  assert.equal(pow.inventory.power, 1);
  assert.equal(pow.inventory.water, 0);
  assert.deepEqual(summary.sectors.POW.shortfall, { water: 1 });
  assert.equal(summary.sectors.POW.integrity_delta, -game.cfg.upkeep_shortfall_penalty);
  assert.equal(summary.missed_upkeep_count, 1);
  // WTR produced water and MED spent med to recover one injured worker
  assert.equal(wtr.inventory.water, 3 + 3 - 1);
  assert.equal(wtr.workforce.injured, 1);
  assert.equal(summary.sectors.WTR.recovered, 1);
  assert.equal(game.state.sectors.MED.inventory.med, 3 - 1, 'MED made nothing and spent 1');
  assert.equal(game.state.cycle.number, 2);
  assert.equal(game.state.cycle.remaining_s, game.cfg.cycle_length_s);
  const ev = logEvents(game, 'cycle_processed');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].summary.cycle, 1);
});

test('the legacy cycle timer fires only if a facilitator starts it, and not while frozen', () => {
  const game = running();
  assert.equal(game.state.cycle.running, false);
  game.cycleControl('start');
  game.state.cycle.remaining_s = 2;
  game.pause();
  game.tick(5000);
  assert.equal(game.state.cycle.number, 1);
  game.resume();
  game.tick(3000);
  assert.equal(game.state.cycle.number, 2);
});

test('with auto_economy off the cycle is logged but moves nothing (contract §3.5)', () => {
  const game = running();
  game.patchConfig({ auto_economy: false });
  const before = JSON.stringify(game.state.sectors.POW.inventory);
  game.state.sectors.POW.inventory.power = 0;
  const snapshot = JSON.stringify(game.state.sectors.POW.inventory);
  const summary = game.cycleControl('process');
  assert.equal(JSON.stringify(game.state.sectors.POW.inventory), snapshot);
  assert.equal(summary.sectors.POW.integrity_delta, 0, 'no penalty either');
  assert.notEqual(before, snapshot);
});

test('brownout halves production and upkeep; DARK has no economy; a supply delay skips production', () => {
  const game = running();
  game.setStatus('WTR', 'BROWNOUT');
  game.setStatus('TRN', 'DARK');
  game.fireEvent('supply_delay', { target: 'POW' });
  const frame = forControl(game);
  assert.deepEqual(frame.sectors.WTR.production_next, { water: 1 }, 'floor(3 × 0.5)');
  assert.deepEqual(frame.sectors.WTR.upkeep_delivery, { power: 1, water: 0 });
  assert.deepEqual(frame.sectors.TRN.production_next, {});
  assert.deepEqual(frame.sectors.POW.production_next, {}, 'the delayed sector still shows production');
  assert.deepEqual(frame.sectors.MED.production_next, {}, 'MED never produces');
  game.cycleControl('process');
  assert.equal(game.hasEffect('no_production', 'POW'), false, 'the one-cycle effect is spent');
});

test('MED produces nothing: medical stock is finite, and no scenario falls back to a med line', () => {
  const content = loadContent();
  assert.equal(content.sectors.sectors.MED.produces, null, 'the content still says MED produces med');
  const lib = new ScenarioLibrary({ rounds, content });
  assert.deepEqual(lib.resolve('haven9-standard').sectors.MED.production, {});
  assert.deepEqual(lib.resolve('haven9-demo').sectors.MED.production, {});
  const game = running();
  const med = game.state.sectors.MED;
  assert.deepEqual(forSector(game, 'MED').sectors.MED.production_next, {});
  med.inventory.med = 2;
  game.cycleControl('process');                       // nobody injured: nothing spent, nothing made
  assert.equal(med.inventory.med, 2, 'a cycle made med');
  game.state.sectors.WTR.workforce.injured = 1;
  game.state.sectors.WTR.workforce.active = 7;
  game.cycleControl('process');                       // one recovery costs one med, and nothing refills it
  assert.equal(med.inventory.med, 1);
  assert.equal(game.state.sectors.WTR.workforce.injured, 0);
});

test('city stability: automatic formula reacts to damage; manual mode holds a number', () => {
  const game = running();
  const start = game.state.city_stability;
  assert.equal(start, 100);
  game.setStatus('AGR', 'BROWNOUT');
  game.setIntegrity('MED', 0);
  game.fireFault('F-301', 'POW');
  game.tick(1000);
  const w = game.cfg.stability.weights;
  assert.ok(game.state.city_stability < start - w.brownout_sector - w.dark_sector);
  game.setStability({ mode: 'manual', value: 55 });
  game.tick(1000);
  assert.equal(game.state.city_stability, 55);
  assert.equal(forBigscreen(game).city_stability, 55);
});

// -- requests, transfers, TRN approval and MED healing --------------------------------
//
// The chain the room walks: a sector ASKS, the supplier FULFILS by raising a
// transfer, the Liaisons sign the paper, TRANSPORT APPROVES and only then does
// stock move. Healing is a separate chain that Transport has no part in: any
// sector asks, and only MEDICAL heals. Three approvals and three heals a round.

const ALL_SIX = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];

/** Ask, have the supplier fulfil it, and put the chit in Transport's hand. */
function readyTransfer(game, { from, to, resource, amount }) {
  const r = game.requestTransfer({ from, to, resource, amount, by: to });
  assert.equal(r.ok, true, 'request refused');
  const f = game.fulfillRequest(r.request.id, { by: from });
  assert.equal(f.ok, true, `fulfil refused: ${f.reason}`);
  assert.equal(game.confirmChit(f.transfer.id, true, { by: 'TRN' }).ok, true);
  return f.transfer;
}

test('every one of the six sectors can raise a resource request', () => {
  const game = running();
  for (const code of ALL_SIX) {
    const supplier = code === 'POW' ? 'WTR' : 'POW';
    const r = game.requestTransfer({ from: supplier, to: code, resource: 'parts', amount: 1, by: code });
    assert.equal(r.ok, true, `${code} could not request`);
    assert.equal(r.request.status, 'REQUESTED');
    assert.equal(r.request.requester, code);
    assert.equal(r.request.supplier, supplier);
    assert.equal(forSector(game, code).requests.some((x) => x.id === r.request.id), true, `${code} cannot see it`);
  }
  assert.equal(logEvents(game, 'request_created').length, 6);
});

test('every one of the six sectors can raise a resource transfer of its own stock', () => {
  const game = running();
  for (const code of ALL_SIX) {
    const receiver = code === 'POW' ? 'WTR' : 'POW';
    const t = game.createTransfer({ from: code, to: receiver, resource: 'parts', amount: 1, by: code });
    assert.equal(t.ok, true, `${code} could not transfer`);
    assert.equal(t.transfer.status, 'PENDING_TRN_APPROVAL');
    assert.equal(t.transfer.created_by, code);
  }
  // …but only its OWN stock.
  assert.equal(game.createTransfer({ from: 'POW', to: 'MED', resource: 'power', amount: 1, by: 'AGR' }).reason, 'not_supplier');
  assert.equal(forSector(game, 'TRN').transfer_queue.items.length, 6, 'all six land in the approval queue');
});

test('a request moves no stock and spends no allowance', () => {
  const game = running();
  const before = { pow: game.state.sectors.POW.inventory.power, med: game.state.sectors.MED.inventory.power };
  game.requestTransfer({ from: 'POW', to: 'MED', resource: 'power', amount: 2, by: 'MED' });
  assert.equal(game.state.sectors.POW.inventory.power, before.pow);
  assert.equal(game.state.sectors.MED.inventory.power, before.med);
  assert.equal(game.stampsUsed(), 0);
  assert.equal(forSector(game, 'TRN').transfer_queue.items.length, 0, 'a request is not Transport business');
});

test('creating a transfer moves no stock and spends no allowance', () => {
  const game = running();
  const before = game.state.sectors.POW.inventory.power;
  game.createTransfer({ from: 'POW', to: 'MED', resource: 'power', amount: 2, by: 'POW' });
  assert.equal(game.state.sectors.POW.inventory.power, before);
  assert.equal(game.stampsUsed(), 0);
});

test('the supplier can decline a request, and only the supplier can', () => {
  const game = running();
  const r = game.requestTransfer({ from: 'POW', to: 'MED', resource: 'power', amount: 2, by: 'MED' });
  assert.equal(game.declineRequest(r.request.id, { by: 'MED' }).reason, 'not_supplier');
  assert.equal(game.declineRequest(r.request.id, { by: 'WTR' }).reason, 'not_supplier');
  const d = game.declineRequest(r.request.id, { by: 'POW' });
  assert.equal(d.ok, true);
  assert.equal(d.request.status, 'DECLINED_BY_SUPPLIER');
  assert.equal(logEvents(game, 'request_declined').length, 1);
});

test('the supplier fulfils a request by raising a linked transfer, which is not approval', () => {
  const game = running();
  const r = game.requestTransfer({ from: 'POW', to: 'MED', resource: 'power', amount: 2, by: 'MED' });
  assert.equal(game.fulfillRequest(r.request.id, { by: 'MED' }).reason, 'not_supplier',
    'the requester cannot fulfil its own ask');

  const before = game.state.sectors.POW.inventory.power;
  const f = game.fulfillRequest(r.request.id, { by: 'POW' });
  assert.equal(f.ok, true);
  assert.equal(f.request.status, 'TRANSFER_CREATED');
  assert.equal(f.request.transfer_id, f.transfer.id);
  assert.equal(f.transfer.request_id, r.request.id);
  assert.equal(f.transfer.status, 'PENDING_TRN_APPROVAL', 'supplier consent is NOT approval');
  assert.equal(f.transfer.approved_at, null);
  assert.equal(game.state.sectors.POW.inventory.power, before, 'fulfilment moves nothing');
  assert.equal(game.stampsUsed(), 0, 'fulfilment spends no Transport allowance');
  assert.equal(logEvents(game, 'request_fulfilled').length, 1);
});

test('a supplier short of stock cannot fulfil', () => {
  const game = running();
  game.setInventory('POW', { power: 1 });
  const r = game.requestTransfer({ from: 'POW', to: 'MED', resource: 'power', amount: 2, by: 'MED' });
  const f = game.fulfillRequest(r.request.id, { by: 'POW' });
  assert.equal(f.ok, false);
  assert.equal(f.reason, 'insufficient_stock_accept');
  assert.equal(game.findRequest(r.request.id).status, 'REQUESTED');
  assert.equal(game.state.sectors.MED.inventory.power, 3);
});

test('no sector but Transport can approve a transfer', () => {
  const game = running();
  const t = readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 2 });
  for (const code of ALL_SIX.filter((c) => c !== 'TRN')) {
    const a = game.approveTransfer(t.id, { by: code });
    assert.equal(a.ok, false, `${code} approved a transfer`);
    assert.equal(a.reason, 'approval_trn_only');
  }
  assert.equal(game.state.sectors.MED.inventory.power, 3, 'nothing moved');
  assert.equal(game.stampsUsed(), 0, 'and no allowance was spent');
  assert.equal(game.approveTransfer(t.id, { by: 'TRN' }).ok, true);
});

test('only Transport is sent an approval queue, and only Medical a healing queue', () => {
  const game = running();
  game.injure('AGR', 1);
  game.requestHealing('AGR', { by: 'AGR' });
  readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 });
  for (const code of ALL_SIX) {
    const f = forSector(game, code);
    assert.equal(!!f.transfer_queue, code === 'TRN', `${code} approval queue wrong`);
    assert.equal(!!f.healing_queue, code === 'MED', `${code} healing queue wrong`);
  }
});

test('a successful approval moves the full amount atomically and spends exactly one', () => {
  const game = running();
  const before = { pow: game.state.sectors.POW.inventory.power, med: game.state.sectors.MED.inventory.power };
  const t = readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 2 });

  const a = game.approveTransfer(t.id, { by: 'TRN' });
  assert.equal(a.ok, true);
  assert.equal(a.transfer.status, 'DELIVERED');
  assert.equal(a.transfer.approved_by, 'TRN');
  assert.equal(game.state.sectors.POW.inventory.power, before.pow - 2);
  assert.equal(game.state.sectors.MED.inventory.power, before.med + 2);
  assert.equal(a.transfer.moved, 2);
  assert.equal(game.stampsUsed(), 1);
  assert.equal(a.transfer.round_approved, 'R2');

  const log = logEvents(game, 'transfer_approved')[0];
  assert.equal(log.moved, 2);
  assert.equal(log.used_after, 1);
  assert.equal(log.facilitator_override, false);
  assert.ok(log.t && log.round);
});

test('a failed approval moves zero and spends no allowance', () => {
  const game = running();
  const t = readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 3 });
  game.setInventory('POW', { power: 2 });

  const a = game.approveTransfer(t.id, { by: 'TRN' });
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'insufficient_stock_stamp');
  assert.equal(game.state.sectors.POW.inventory.power, 2, 'zero moved, not two');
  assert.equal(game.state.sectors.MED.inventory.power, 3);
  assert.equal(game.stampsUsed(), 0);
  assert.equal(game.findTransfer(t.id).status, 'PENDING_TRN_APPROVAL', 'still waiting');

  // The old part-delivery is still available as configuration.
  game.patchConfig({ insufficient_stock_behavior: 'legacy_partial_if_supported' });
  assert.equal(game.approveTransfer(t.id, { by: 'TRN' }).ok, true);
  assert.equal(game.state.sectors.POW.inventory.power, 0);
  assert.equal(game.state.sectors.MED.inventory.power, 5, 'two moved, not three');
});

test('Transport approves only three transfers in a round by default', () => {
  const game = running();
  game.setInventory('POW', { power: 10 });
  const ids = [];
  for (let i = 0; i < 4; i += 1) ids.push(readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 }).id);
  for (let i = 0; i < 3; i += 1) assert.equal(game.approveTransfer(ids[i], { by: 'TRN' }).ok, true);
  assert.equal(game.stampsUsed(), 3);

  const fourth = game.approveTransfer(ids[3], { by: 'TRN' });
  assert.equal(fourth.ok, false);
  assert.equal(fourth.reason, 'capacity');
  assert.equal(fourth.capacity, 3);
  assert.equal(game.findTransfer(ids[3]).status, 'PENDING_TRN_APPROVAL', 'it just waits');
  assert.equal(game.stampsUsed(), 3, 'the refusal cost nothing');
});

test('a cycle change does not restore Transport approvals', () => {
  const game = running();
  game.setInventory('POW', { power: 10 });
  for (let i = 0; i < 2; i += 1) {
    game.approveTransfer(readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 }).id, { by: 'TRN' });
  }
  const cycle = game.state.cycle.number;
  game.cycleControl('process');
  assert.equal(game.state.cycle.number, cycle + 1, 'the cycle really turned over');
  assert.equal(game.stampsUsed(), 2, 'a cycle boundary hands Transport nothing back');
  assert.equal(forSector(game, 'TRN').transfer_queue.remaining, 1);
});

test('a round change resets Transport approvals to zero', () => {
  const game = running();
  game.setInventory('POW', { power: 10 });
  for (let i = 0; i < 3; i += 1) {
    game.approveTransfer(readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 }).id, { by: 'TRN' });
  }
  assert.equal(game.stampsUsed(), 3);
  game.setRound('R3');
  assert.equal(game.stampsUsed(), 0);
  assert.equal(forSector(game, 'TRN').transfer_queue.remaining, 3);
  assert.ok(logEvents(game, 'trn_approval_counter_reset').some((e) => e.by === 'round_change'));
});

test('Transport can decline a transfer, and that costs no allowance', () => {
  const game = running();
  const t = readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 2 });
  assert.equal(game.declineTransfer(t.id, { by: 'AGR' }).reason, 'approval_trn_only');
  const d = game.declineTransfer(t.id, { by: 'TRN' });
  assert.equal(d.ok, true);
  assert.equal(d.transfer.status, 'DECLINED_BY_TRN');
  assert.equal(game.stampsUsed(), 0);
  assert.equal(game.state.sectors.MED.inventory.power, 3);
  assert.equal(forSector(game, 'TRN').transfer_queue.items.length, 0);
});

test('no approval until Transport confirms the physical chit', () => {
  const game = running();
  const r = game.requestTransfer({ from: 'POW', to: 'MED', resource: 'power', amount: 2, by: 'MED' });
  const f = game.fulfillRequest(r.request.id, { by: 'POW' });

  const early = game.approveTransfer(f.transfer.id, { by: 'TRN' });
  assert.equal(early.ok, false);
  assert.equal(early.reason, 'chit_required');
  assert.equal(game.stampsUsed(), 0);

  game.confirmChit(f.transfer.id, true, { by: 'TRN' });
  assert.equal(game.approveTransfer(f.transfer.id, { by: 'TRN' }).ok, true);
  assert.equal(logEvents(game, 'transfer_chit')[0].confirmed, true);
});

test('unfinished requests, transfers and healing all expire at a round change; finished ones do not', () => {
  const game = running();
  const delivered = readyTransfer(game, { from: 'WTR', to: 'POW', resource: 'water', amount: 1 });
  game.approveTransfer(delivered.id, { by: 'TRN' });
  const openRequest = game.requestTransfer({ from: 'POW', to: 'MED', resource: 'power', amount: 1, by: 'MED' });
  const openTransfer = game.createTransfer({ from: 'AGR', to: 'MED', resource: 'parts', amount: 1, by: 'AGR' });
  game.injure('COM', 1);
  const openHeal = game.requestHealing('COM', { by: 'COM' });
  game.injure('WTR', 1);
  const healed = game.requestHealing('WTR', { by: 'WTR' });
  game.healWorker(healed.healing.id, { by: 'MED' });

  game.setRound('R3');
  assert.equal(game.findRequest(openRequest.request.id).status, 'EXPIRED');
  assert.equal(game.findTransfer(openTransfer.transfer.id).status, 'EXPIRED');
  assert.equal(game.findHealing(openHeal.healing.id).status, 'EXPIRED');
  assert.equal(game.findTransfer(delivered.id).status, 'DELIVERED', 'history is not rewritten');
  assert.equal(game.findHealing(healed.healing.id).status, 'HEALED');
  assert.equal(game.state.sectors.WTR.workforce.injured, 0, 'a healed worker stays healed');
  assert.equal(forSector(game, 'TRN').transfer_queue.items.length, 0);
  assert.equal(forSector(game, 'MED').healing_queue.items.length, 0);

  // Each collection has its own switch.
  game.patchConfig({ expire_pending_transfers_on_round_change: false });
  const survivor = game.createTransfer({ from: 'AGR', to: 'MED', resource: 'parts', amount: 1, by: 'AGR' });
  game.setRound('R4');
  assert.equal(game.findTransfer(survivor.transfer.id).status, 'PENDING_TRN_APPROVAL');
});

test('the facilitator can force an approval, and it is flagged as an override', () => {
  const game = running();
  game.setInventory('POW', { power: 10 });
  for (let i = 0; i < 3; i += 1) {
    game.approveTransfer(readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 }).id, { by: 'TRN' });
  }
  // Neither chit-confirmed nor within the allowance.
  const t = game.createTransfer({ from: 'POW', to: 'MED', resource: 'power', amount: 2, by: 'POW' });
  assert.equal(game.approveTransfer(t.transfer.id, { by: 'TRN' }).ok, false);

  const forced = game.approveTransfer(t.transfer.id, { by: 'facilitator', force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.transfer.facilitator_override, true);
  assert.equal(logEvents(game, 'transfer_approved').at(-1).facilitator_override, true);
  assert.equal(logEvents(game, 'facilitator_force_transfer').length, 1);

  // The override is not a licence to invent stock.
  game.setInventory('POW', { power: 0 });
  const empty = game.createTransfer({ from: 'POW', to: 'MED', resource: 'power', amount: 2, by: 'POW' });
  assert.equal(game.approveTransfer(empty.transfer.id, { force: true }).reason, 'insufficient_stock_stamp');
});

test('the facilitator can reset the approval allowance by hand, and it is logged', () => {
  const game = running();
  game.setInventory('POW', { power: 10 });
  for (let i = 0; i < 3; i += 1) {
    game.approveTransfer(readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 }).id, { by: 'TRN' });
  }
  assert.equal(game.resetStamps('all', { by: 'facilitator' }).ok, true);
  assert.equal(game.stampsUsed(), 0);
  assert.equal(forControl(game).transfer_capacity.remaining, 3);
  assert.ok(logEvents(game, 'trn_approval_counter_reset').some((e) => e.by === 'facilitator'));
});

test('Transport capacity still bends to brownout and to temporary effects', () => {
  const game = running();
  assert.equal(game.trnCapacity(), 3);
  game.setStatus('TRN', 'BROWNOUT');
  assert.equal(game.trnCapacity(), game.cfg.brownout_effects.per_sector.TRN.transfer_capacity);
  game.setStatus('TRN', 'ACTIVE');
  game.fireEvent('transport_gridlock');
  assert.equal(game.trnCapacity(), 0);
  game.tick(181000);
  assert.equal(game.trnCapacity(), 3, 'the effect expires');
});

test('a worker loan moves people and is tracked as loaned/borrowed', () => {
  const game = running();
  const t = readyTransfer(game, { from: 'AGR', to: 'MED', resource: 'workers', amount: 2 });
  game.approveTransfer(t.id, { by: 'TRN' });
  assert.equal(game.state.sectors.AGR.workforce.active, 6);
  assert.equal(game.state.sectors.AGR.workforce.loaned, 2);
  assert.equal(game.state.sectors.MED.workforce.active, 10);
  assert.equal(forSector(game, 'AGR').sectors.AGR.workforce.total, 8);
});

test('a sector sees only its own paperwork', () => {
  const game = running();
  game.requestTransfer({ from: 'WTR', to: 'POW', resource: 'water', amount: 2, by: 'POW' });
  game.createTransfer({ from: 'AGR', to: 'COM', resource: 'parts', amount: 1, by: 'AGR' });
  assert.equal(forSector(game, 'POW').requests.length, 1);
  assert.equal(forSector(game, 'POW').transfers.length, 0);
  assert.equal(forSector(game, 'MED').requests.length, 0);
  assert.equal(forSector(game, 'MED').transfers.length, 0);
  assert.equal(forSector(game, 'COM').transfers.length, 1);
});

// -- healing ---------------------------------------------------------------------------

test('any sector with an injured worker can ask, and the target is always Medical', () => {
  const game = running();
  for (const code of ALL_SIX) {
    game.injure(code, 1);
    const h = game.requestHealing(code, { by: code });
    assert.equal(h.ok, true, `${code} could not ask`);
    assert.equal(h.healing.target_sector, 'MED', `${code} aimed elsewhere`);
    assert.equal(h.healing.sector, code);
    assert.ok(h.healing.worker_id && h.healing.worker_label);
  }
  assert.equal(forSector(game, 'MED').healing_queue.items.length, 6);
  assert.equal(logEvents(game, 'heal_requested').length, 6);
  // There is no target to choose: the reducer takes a sector, never a target.
  assert.equal(logEvents(game, 'heal_requested').every((e) => e.target === 'MED'), true);
});

test('a healthy sector cannot put a worker forward, and nor can it ask twice for one worker', () => {
  const game = running();
  assert.equal(game.state.sectors.AGR.workforce.injured, 0);
  const none = game.requestHealing('AGR', { by: 'AGR' });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'worker_not_injured');

  game.injure('AGR', 1);
  assert.equal(game.requestHealing('AGR', { by: 'AGR' }).ok, true);
  const twice = game.requestHealing('AGR', { by: 'AGR' });
  assert.equal(twice.ok, false, 'one injured worker, one request');
  assert.equal(twice.reason, 'worker_not_injured');
  // A sector cannot ask on another sector's behalf.
  game.injure('COM', 1);
  assert.equal(game.requestHealing('COM', { by: 'AGR' }).reason, 'not_own_sector');
});

test('no sector but Medical can heal', () => {
  const game = running();
  game.injure('AGR', 1);
  const h = game.requestHealing('AGR', { by: 'AGR' });
  for (const code of ALL_SIX.filter((c) => c !== 'MED')) {
    const r = game.healWorker(h.healing.id, { by: code });
    assert.equal(r.ok, false, `${code} healed a worker`);
    assert.equal(r.reason, 'heal_med_only');
  }
  assert.equal(game.state.sectors.AGR.workforce.injured, 1, 'still injured');
  assert.equal(game.medHealsUsed(), 0, 'and no capacity was spent');
});

test('Medical heals an injured worker, spending exactly one heal', () => {
  const game = running();
  game.injure('COM', 1);
  const before = { injured: game.state.sectors.COM.workforce.injured, active: game.state.sectors.COM.workforce.active };
  const h = game.requestHealing('COM', { by: 'COM' });

  const done = game.healWorker(h.healing.id, { by: 'MED' });
  assert.equal(done.ok, true);
  assert.equal(done.healing.status, 'HEALED');
  assert.equal(done.healing.healed_by, 'MED');
  assert.equal(game.state.sectors.COM.workforce.injured, before.injured - 1);
  assert.equal(game.state.sectors.COM.workforce.active, before.active + 1);
  assert.equal(game.medHealsUsed(), 1);
  const log = logEvents(game, 'worker_healed')[0];
  assert.equal(log.sector, 'COM');
  assert.equal(log.used_after, 1);
  assert.ok(log.t && log.round);
});

test('a failed heal spends no capacity', () => {
  const game = running();
  game.injure('AGR', 1);
  const h = game.requestHealing('AGR', { by: 'AGR' });
  // The facilitator gets there first, through the existing recover path.
  game.recover('AGR', 1);
  const late = game.healWorker(h.healing.id, { by: 'MED' });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'worker_not_injured');
  assert.equal(game.medHealsUsed(), 0);
  assert.equal(logEvents(game, 'heal_refused').length, 1);
});

test('Medical heals only three a round by default', () => {
  const game = running();
  const ids = [];
  for (const code of ['POW', 'WTR', 'AGR', 'COM']) {
    game.injure(code, 1);
    ids.push(game.requestHealing(code, { by: code }).healing.id);
  }
  for (let i = 0; i < 3; i += 1) assert.equal(game.healWorker(ids[i], { by: 'MED' }).ok, true);
  assert.equal(game.medHealsUsed(), 3);

  const fourth = game.healWorker(ids[3], { by: 'MED' });
  assert.equal(fourth.ok, false);
  assert.equal(fourth.reason, 'med_capacity');
  assert.equal(fourth.capacity, 3);
  assert.equal(game.state.sectors.COM.workforce.injured, 1, 'the fourth is still hurt');
  assert.equal(game.medHealsUsed(), 3, 'the refusal cost nothing');
  assert.equal(forSector(game, 'MED').healing_queue.remaining, 0);
});

test('a cycle change does not restore healing capacity; a round change does', () => {
  const game = running();
  // Keep the cycle's own MED recovery out of it — this is about the counter.
  game.patchConfig({ injured_recovery_per_cycle: 0 });
  for (const code of ['POW', 'WTR']) {
    game.injure(code, 1);
    game.healWorker(game.requestHealing(code, { by: code }).healing.id, { by: 'MED' });
  }
  assert.equal(game.medHealsUsed(), 2);

  game.cycleControl('process');
  assert.equal(game.medHealsUsed(), 2, 'a cycle boundary hands Medical nothing back');
  assert.equal(forSector(game, 'MED').healing_queue.remaining, 1);

  game.setRound('R3');
  assert.equal(game.medHealsUsed(), 0);
  assert.equal(forSector(game, 'MED').healing_queue.remaining, 3);
  assert.ok(logEvents(game, 'med_healing_counter_reset').some((e) => e.by === 'round_change'));
});

test('Medical can decline a healing request, and that costs no capacity', () => {
  const game = running();
  game.injure('AGR', 1);
  const h = game.requestHealing('AGR', { by: 'AGR' });
  assert.equal(game.declineHealing(h.healing.id, { by: 'AGR' }).reason, 'heal_med_only');
  const d = game.declineHealing(h.healing.id, { by: 'MED' });
  assert.equal(d.ok, true);
  assert.equal(d.healing.status, 'DECLINED_BY_MED');
  assert.equal(game.medHealsUsed(), 0);
  assert.equal(game.state.sectors.AGR.workforce.injured, 1);
  assert.equal(forSector(game, 'MED').healing_queue.items.length, 0);
});

test('Medical may ask for healing for its own injured worker, and heal it', () => {
  const game = running();
  game.injure('MED', 1);
  const h = game.requestHealing('MED', { by: 'MED' });
  assert.equal(h.ok, true);
  assert.equal(h.healing.sector, 'MED');
  assert.equal(h.healing.target_sector, 'MED');
  assert.equal(game.healWorker(h.healing.id, { by: 'MED' }).ok, true);
  assert.equal(game.state.sectors.MED.workforce.injured, 0);
  const log = logEvents(game, 'worker_healed')[0];
  assert.equal(log.sector, 'MED', 'the requester is recorded');
  assert.equal(log.healed_by, 'MED', 'and so is the healer');
});

test('the facilitator can force a heal and reset the healing allowance, both logged', () => {
  const game = running();
  for (const code of ['POW', 'WTR', 'AGR']) {
    game.injure(code, 1);
    game.healWorker(game.requestHealing(code, { by: code }).healing.id, { by: 'MED' });
  }
  assert.equal(game.medHealsUsed(), 3);
  game.injure('COM', 1);
  const h = game.requestHealing('COM', { by: 'COM' });
  assert.equal(game.healWorker(h.healing.id, { by: 'MED' }).reason, 'med_capacity');

  const forced = game.healWorker(h.healing.id, { by: 'facilitator', force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.healing.facilitator_override, true);
  assert.equal(logEvents(game, 'facilitator_force_heal').length, 1);
  assert.equal(game.state.sectors.COM.workforce.injured, 0);

  assert.equal(game.resetHeals({ by: 'facilitator' }).ok, true);
  assert.equal(game.medHealsUsed(), 0);
  assert.ok(logEvents(game, 'med_healing_counter_reset').some((e) => e.by === 'facilitator'));
  assert.equal(forControl(game).healing_capacity.remaining, 3);
});

test('a dark Medical Bay heals nobody, and a dark Transport approves nothing', () => {
  const game = running();
  game.setStatus('MED', 'DARK');
  assert.equal(game.medCapacity(), 0);
  game.injure('AGR', 1);
  const h = game.requestHealing('AGR', { by: 'AGR' });
  assert.equal(game.healWorker(h.healing.id, { by: 'MED' }).reason, 'med_capacity');
  game.setStatus('TRN', 'DARK');
  assert.equal(game.trnCapacity(), 0);
});

test('the debrief keeps the whole chain: requests, fulfilment, approvals, heals and overrides', () => {
  const game = running();
  const r = game.requestTransfer({ from: 'POW', to: 'MED', resource: 'power', amount: 2, by: 'MED' });
  const f = game.fulfillRequest(r.request.id, { by: 'POW' });
  game.confirmChit(f.transfer.id, true, { by: 'TRN' });
  game.approveTransfer(f.transfer.id, { by: 'TRN' });
  const declined = game.requestTransfer({ from: 'WTR', to: 'MED', resource: 'water', amount: 1, by: 'MED' });
  game.declineRequest(declined.request.id, { by: 'WTR' });
  game.injure('AGR', 2);
  const h1 = game.requestHealing('AGR', { by: 'AGR' });
  game.healWorker(h1.healing.id, { by: 'MED' });
  const h2 = game.requestHealing('AGR', { by: 'AGR' });
  game.declineHealing(h2.healing.id, { by: 'MED' });

  const d = analyse(game.log.readAll(), { runId: 'test-run' }).rounds.R2;
  assert.equal(d.requests.created, 2);
  assert.equal(d.requests.fulfilled, 1);
  assert.equal(d.requests.declined, 1);
  assert.equal(d.transfers.created, 1);
  assert.equal(d.transfers.approved, 1);
  assert.equal(d.transfers.delivered, 1);
  assert.equal(d.healing.requested, 2);
  assert.equal(d.healing.healed, 1);
  assert.equal(d.healing.declined, 1);
  assert.ok(d.transfers.list.some((x) => x.status === 'DELIVERED'));
  assert.ok(d.healing.list.some((x) => x.status === 'HEALED'));
});

test('a snapshot from the one-array build is split into requests and transfers on restore', () => {
  const game = running();
  const legacy = {
    state: {
      ...game.state,
      requests: undefined,
      healing: undefined,
      trn_approvals_used_this_round: undefined,
      med_heals_used_this_round: undefined,
      stamps_this_round: 2,
      transfers: [
        { id: 'T-1', from: 'POW', to: 'MED', resource: 'power', amount: 2, status: 'REQUESTED', requested_at: new Date().toISOString() },
        { id: 'T-2', from: 'WTR', to: 'POW', resource: 'water', amount: 1, status: 'AGREED', requested_at: new Date().toISOString() },
        { id: 'T-3', from: 'AGR', to: 'MED', resource: 'parts', amount: 1, status: 'STAMPED', stamped_at: new Date().toISOString(), requested_at: new Date().toISOString() },
      ],
    },
  };
  assert.equal(game.restore(legacy), true);
  assert.equal(game.findRequest('T-1').status, 'REQUESTED');
  assert.equal(game.findRequest('T-1').supplier, 'POW');
  assert.equal(game.findTransfer('T-2').status, 'PENDING_TRN_APPROVAL');
  assert.equal(game.findTransfer('T-3').status, 'APPROVED');
  assert.equal(game.stampsUsed(), 2, 'the old counter carries over');
  assert.equal(game.medHealsUsed(), 0);
  assert.equal(game.state.stamps_this_round, undefined);
});

const economy = require('../lib/economy');
const economyFor = (game, code) => economy.productionFor(game, game.state.sectors[code]);

// -- COM: the city broadcast ------------------------------------------------------------
//
// The big screen's resource board is a public information layer COM keeps by
// hand. It is never read from inventory, never written to it, and it goes
// stale on purpose: freshness is a round count, never a clock.

const BOARD_ROLES = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];

test('only COM can edit the public big screen; the facilitator overrides and is logged as such', () => {
  const game = running();
  for (const code of BOARD_ROLES.filter((c) => c !== 'COM')) {
    const r = game.setBroadcastRow('POW', { power: 8 }, { by: code });
    assert.equal(r.ok, false, `${code} edited the board`);
    assert.equal(r.reason, 'com_edit_forbidden');
    assert.equal(game.setBroadcastAnnouncement({ headline: 'X' }, { by: code }).reason, 'com_edit_forbidden');
  }
  assert.equal(game.setBroadcastRow('POW', { power: 8 }, { by: 'COM' }).ok, true);
  const f = game.setBroadcastRow('WTR', { water: 1 }, { by: 'facilitator' });
  assert.equal(f.ok, true);
  assert.equal(logEvents(game, 'com_row_updated').at(-1).facilitator_override, true);
  assert.equal(logEvents(game, 'facilitator_com_override').length, 1);
  // Only COM's frame says the board is editable.
  for (const code of BOARD_ROLES) assert.equal(forSector(game, code).broadcast.editable, code === 'COM', `${code} editable wrong`);
});

test('changing COM displayed stock never changes real inventory', () => {
  const game = running();
  game.setInventory('POW', { power: 2 });
  const r = game.setBroadcastRow('POW', { power: 8, water: 9, med: 9, parts: 9 }, { by: 'COM' });
  assert.equal(r.ok, true);
  assert.equal(forBigscreen(game).broadcast.rows.POW.power, 8, 'the wall shows what COM reported');
  assert.equal(game.state.sectors.POW.inventory.power, 2, 'real stock untouched');
  assert.deepEqual(game.state.sectors.POW.inventory, { ...game.state.sectors.POW.inventory, power: 2 });
});

test('a COM save stamps the current round, and players see a round, not a clock', () => {
  const game = running();
  game.setRound('R3');
  const r = game.setBroadcastRow('POW', { power: 2 }, { by: 'COM' });
  assert.equal(r.row.round, 'R3');
  assert.equal(r.freshness, 'CURRENT');
  const row = forBigscreen(game).broadcast.rows.POW;
  assert.equal(forSector(game, 'WTR').broadcast.rows, undefined, 'a table is not sent the board');
  assert.equal(row.round_number, 3);
  assert.equal(row.freshness, 'CURRENT');
  // The player-facing projection carries no timestamp field of any kind.
  for (const key of Object.keys(row)) assert.ok(!/(_at|time|stamp)/i.test(key), `player row leaks ${key}`);
  const a = game.setBroadcastAnnouncement({ headline: 'HOLD POWER', message: 'MED needs 2 power' }, { by: 'COM' });
  assert.equal(a.announcement.round, 'R3');
  for (const key of Object.keys(forBigscreen(game).broadcast.announcement)) assert.ok(!/(_at|time|stamp)/i.test(key), `announcement leaks ${key}`);
  // The audit trail keeps the backend timestamp.
  assert.ok(logEvents(game, 'com_row_updated')[0].t);
});

test('displayed values do not auto-sync after production, a transfer, or an AGR card', () => {
  const game = running();
  game.setBroadcastRow('POW', { power: 5 }, { by: 'COM' });
  game.setBroadcastRow('AGR', { parts: 1 }, { by: 'COM' });
  game.setInventory('POW', { power: 3 });
  assert.equal(forBigscreen(game).broadcast.rows.POW.power, 5, 'a stock change did not move the board');

  game.cycleControl('process');                                              // production + upkeep
  assert.equal(forBigscreen(game).broadcast.rows.POW.power, 5, 'production did not move the board');

  const t = readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 });
  game.approveTransfer(t.id, { by: 'TRN' });
  assert.equal(forBigscreen(game).broadcast.rows.POW.power, 5, 'a transfer did not move the board');

  game.state.agr.offered = ['AGR_EMERGENCY_PARTS', 'AGR_POWER_SURGE', 'AGR_WATER_RESERVE'];
  assert.equal(game.agrActivate('AGR_EMERGENCY_PARTS', { by: 'AGR' }).ok, true);
  assert.equal(game.state.sectors.AGR.inventory.parts, 6, 'the card changed real stock');
  assert.equal(forBigscreen(game).broadcast.rows.AGR.parts, 1, 'but not the board');
  assert.equal(forBigscreen(game).broadcast.rows.POW.power, 5);
});

test('a row from last round is STALE, two rounds old is OUTDATED, never set is NOT UPDATED', () => {
  const game = running();
  game.setBroadcastRow('POW', { power: 5 }, { by: 'COM' });
  assert.equal(forBigscreen(game).broadcast.rows.POW.freshness, 'CURRENT');
  assert.equal(forBigscreen(game).broadcast.rows.WTR.freshness, 'NOT UPDATED');
  game.setRound('R3');
  assert.equal(forBigscreen(game).broadcast.rows.POW.freshness, 'STALE');
  assert.equal(forBigscreen(game).broadcast.rows.POW.power, 5, 'values survive the round change unchanged');
  game.setRound('R4');
  assert.equal(forBigscreen(game).broadcast.rows.POW.freshness, 'OUTDATED');
  assert.equal(forBigscreen(game).broadcast.rows.POW.round_number, 2);
  assert.equal(forBigscreen(game).broadcast.round_number, 4);
});

test('COM publishes one priority announcement, replaces it, and clears it; nothing else moves', () => {
  const game = running();
  const snap = JSON.stringify({ s: game.state.sectors, t: game.state.transfers, h: game.state.healing });
  assert.equal(game.setBroadcastAnnouncement({}, { by: 'COM' }).reason, 'empty_announcement');
  assert.equal(game.setBroadcastAnnouncement({ headline: 'MED NEEDS POWER', message: 'Send 2 power via TRN' }, { by: 'COM' }).ok, true);
  assert.equal(forSector(game, 'COM').broadcast.announcement.headline, 'MED NEEDS POWER');
  assert.equal(forSector(game, 'POW').broadcast.announcement_active, true, 'a table is told one exists');
  assert.equal(forSector(game, 'POW').broadcast.announcement, undefined, 'but never the words');
  game.setBroadcastAnnouncement({ headline: 'A'.repeat(60), message: 'B'.repeat(200) }, { by: 'COM' });
  const a = forBigscreen(game).broadcast.announcement;
  assert.equal(a.headline.length, 40, 'headline capped at 40');
  assert.equal(a.message.length, 160, 'message capped at 160');
  assert.equal(game.clearBroadcastAnnouncement({ by: 'AGR' }).reason, 'com_edit_forbidden');
  assert.equal(game.clearBroadcastAnnouncement({ by: 'COM' }).ok, true);
  assert.equal(forBigscreen(game).broadcast.announcement, null);
  assert.equal(JSON.stringify({ s: game.state.sectors, t: game.state.transfers, h: game.state.healing }), snap, 'the world is untouched');
  assert.equal(logEvents(game, 'com_announcement_published').length, 2);
  assert.equal(logEvents(game, 'com_announcement_cleared').length, 1);
});

// -- AGR: the random draw ----------------------------------------------------------------

test('exactly three unique cards are dealt at round start, from the enabled pool only', () => {
  const game = running();
  const agr = game.state.agr;
  assert.equal(agr.round, 'R2');
  assert.equal(agr.offered.length, 3);
  assert.equal(new Set(agr.offered).size, 3, 'duplicates dealt');
  const enabled = new Set(game.agrEnabledIds());
  for (const id of agr.offered) assert.ok(enabled.has(id), `${id} is not enabled`);
  assert.ok(!agr.offered.includes('AGR_WORKFORCE_RECOVERY'), 'the disabled card was dealt');
  assert.equal(forSector(game, 'AGR').agr_cards.offered.length, 3);
  assert.ok(logEvents(game, 'agr_random_offer_generated').some((e) => e.round === 'R2'));
});

test('a refresh, a reconnect, a reopened screen and a cycle change all show the same hand', () => {
  const game = running();
  const hand = [...game.state.agr.offered];
  // A "refresh"/"reconnect"/"reopen" is a new projection of the same state.
  for (let i = 0; i < 5; i += 1) assert.deepEqual(forSector(game, 'AGR').agr_cards.offered.map((c) => c.id), hand);
  game.cycleControl('process');
  assert.deepEqual(game.state.agr.offered, hand, 'the cycle redealt');
  // A restart from snapshot keeps the hand too.
  const again = newGame({ runId: 'agr-restore' });
  again.restore(JSON.parse(JSON.stringify(game.serialise())));
  assert.deepEqual(again.state.agr.offered, hand, 'a restore redealt');
  assert.equal(logEvents(game, 'agr_random_offer_generated').length, 2, 'only the reset and the round dealt (R0, R2)');
});

test('a new round deals a new hand, archives the old one, and last round\'s cards sit it out', () => {
  const game = running();
  const r2 = [...game.state.agr.offered];
  game.setRound('R3');
  const r3 = [...game.state.agr.offered];
  assert.equal(r3.length, 3);
  assert.notDeepEqual(r3, r2);
  for (const id of r3) assert.ok(!r2.includes(id), `${id} repeated from the round before`);
  assert.deepEqual(game.state.agr.previous, r2);
  assert.equal(game.state.agr.history[0].round, 'R2');
  assert.ok(logEvents(game, 'agr_round_offer_archived').some((e) => e.round === 'R2'));
  // Two rounds back is fair game again.
  game.setRound('R4');
  const r4 = game.state.agr.offered;
  for (const id of r4) assert.ok(!r3.includes(id), `${id} repeated from R3`);
});

test('the fallback fills from last round when fewer than three fresh cards remain', () => {
  const game = running();
  // Five enabled cards: three dealt this round leave two fresh for the next.
  const keep = ['AGR_POWER_SURGE', 'AGR_WATER_RESERVE', 'AGR_EMERGENCY_PARTS', 'AGR_CITY_RECOVERY', 'AGR_LOGISTICS_BOOST'];
  const all = game.agrPool().map((c) => c.id);
  game.patchConfig({ agr_disabled_cards: all.filter((id) => !keep.includes(id)) });
  game.setRound('R3');
  const r3 = [...game.state.agr.offered];
  assert.equal(r3.length, 3);
  game.setRound('R4');
  const r4 = game.state.agr.offered;
  assert.equal(r4.length, 3, 'still three');
  assert.equal(new Set(r4).size, 3, 'still unique');
  const fresh = keep.filter((id) => !r3.includes(id));
  for (const id of fresh) assert.ok(r4.includes(id), `fresh card ${id} was not dealt first`);
  assert.equal(r4.filter((id) => r3.includes(id)).length, 1, 'exactly one slot came from last round');
  for (const id of r4) assert.ok(keep.includes(id), 'a disabled card was dealt');
});

test('the same run and round deal the same hand; a different run deals differently', () => {
  const a = newGame({ runId: 'seeded-run' }); a.setPhase('ROUND_2');
  const b = newGame({ runId: 'seeded-run' }); b.setPhase('ROUND_2');
  const c = newGame({ runId: 'another-run' }); c.setPhase('ROUND_2');
  assert.deepEqual(a.state.agr.offered, b.state.agr.offered);
  const differs = ['R3', 'R4'].some((r) => { a.setRound(r); c.setRound(r); return JSON.stringify(a.state.agr.offered) !== JSON.stringify(c.state.agr.offered); })
    || JSON.stringify(a.state.agr.offered) !== JSON.stringify(c.state.agr.offered);
  assert.ok(differs, 'two different runs dealt identical hands every round');
  assert.ok(logEvents(a, 'agr_random_offer_generated').every((e) => typeof e.seed === 'number'));
});

// -- AGR: selection and activation -------------------------------------------------------

test('AGR activates exactly one card a round; a second is refused, and only AGR may play', () => {
  const game = running();
  game.state.agr.offered = ['AGR_POWER_SURGE', 'AGR_WATER_RESERVE', 'AGR_EMERGENCY_PARTS'];
  for (const code of ['POW', 'WTR', 'MED', 'TRN', 'COM']) {
    assert.equal(game.agrActivate('AGR_POWER_SURGE', { by: code }).reason, 'agr_only', `${code} played a card`);
  }
  assert.equal(game.agrSelect('AGR_POWER_SURGE', { by: 'AGR' }).ok, true);
  const first = game.agrActivate('AGR_POWER_SURGE', { by: 'AGR' });
  assert.equal(first.ok, true);
  assert.equal(game.state.agr.used, true);
  assert.equal(game.state.agr.selected, 'AGR_POWER_SURGE');
  const second = game.agrActivate('AGR_WATER_RESERVE', { by: 'AGR' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'agr_card_already_used');
  assert.equal(game.state.sectors.WTR.inventory.water, 3, 'the second card did nothing');
  assert.equal(game.agrSelect('AGR_EMERGENCY_PARTS', { by: 'AGR' }).reason, 'agr_card_already_used');
  assert.equal(forSector(game, 'AGR').agr_cards.used, true);
});

test('a card not in the hand cannot be played; a failed activation does not spend the round', () => {
  const game = running();
  game.state.agr.offered = ['AGR_STABILISE_SECTOR', 'AGR_POWER_SURGE', 'AGR_WATER_RESERVE'];
  assert.equal(game.agrActivate('AGR_EMERGENCY_STOCKPILE', { by: 'AGR' }).reason, 'agr_card_not_in_offer');
  // Needs a target: refused, nothing spent.
  const noTarget = game.agrActivate('AGR_STABILISE_SECTOR', { by: 'AGR' });
  assert.equal(noTarget.reason, 'agr_target_required');
  // Bad target: refused, nothing spent.
  game.setStatus('COM', 'DARK');
  const dark = game.agrActivate('AGR_STABILISE_SECTOR', { by: 'AGR', target: { sector: 'COM' } });
  assert.equal(dark.reason, 'agr_invalid_target');
  assert.equal(game.state.agr.used, false, 'a refusal consumed the round');
  assert.equal(logEvents(game, 'agr_card_activation_refused').length, 3);
  // The same round's choice is still live.
  assert.equal(game.agrActivate('AGR_STABILISE_SECTOR', { by: 'AGR', target: { sector: 'POW' } }).ok, true);
  assert.equal(game.state.agr.used, true);
});

test('a new round clears the selection and deals again; a cycle does neither', () => {
  const game = running();
  const hand = [...game.state.agr.offered];
  game.state.agr.offered = ['AGR_POWER_SURGE', 'AGR_WATER_RESERVE', 'AGR_EMERGENCY_PARTS'];
  game.agrActivate('AGR_POWER_SURGE', { by: 'AGR' });
  game.cycleControl('process');
  assert.equal(game.state.agr.used, true, 'a cycle unlocked the choice');
  assert.equal(game.agrActivate('AGR_WATER_RESERVE', { by: 'AGR' }).reason, 'agr_card_already_used');
  game.setRound('R3');
  assert.equal(game.state.agr.used, false);
  assert.equal(game.state.agr.selected, null);
  assert.equal(game.state.agr.round, 'R3');
  assert.notDeepEqual(game.state.agr.offered, hand);
  assert.equal(game.state.agr.offered.length, 3);
});

// -- AGR: the cards themselves -----------------------------------------------------------

/** Put a card in the hand so it can be played, whatever the draw was. */
function deal(game, ...ids) {
  game.state.agr.offered = ids.concat(['AGR_POWER_SURGE', 'AGR_WATER_RESERVE', 'AGR_EMERGENCY_PARTS']).slice(0, 3);
  if (!game.state.agr.offered.includes(ids[0])) game.state.agr.offered[0] = ids[0];
}

test('CITY RECOVERY: +10 to every active sector, capped at 100, and 0/DARK stays at 0', () => {
  const game = running();
  game.setIntegrity('POW', 60);
  game.setIntegrity('WTR', 95);
  game.setIntegrity('COM', 0);
  assert.equal(game.state.sectors.COM.status, 'DARK');
  deal(game, 'AGR_CITY_RECOVERY');
  const r = game.agrActivate('AGR_CITY_RECOVERY', { by: 'AGR' });
  assert.equal(r.ok, true);
  assert.equal(game.state.sectors.POW.integrity, 70);
  assert.equal(game.state.sectors.WTR.integrity, 100);
  assert.equal(game.state.sectors.COM.integrity, 0);
  assert.equal(game.state.sectors.COM.status, 'DARK');
  assert.equal(game.state.sectors.MED.integrity, 100, 'a full sector stays full');
  assert.equal(r.before.POW, 60); assert.equal(r.after.POW, 70);
  assert.equal(game.state.sectors.AGR.workforce.injured, 0, 'health, not workers');
});

test('EMERGENCY STOCKPILE: +5 power, +5 water, +2 med, +1 parts to AGR and nobody else', () => {
  const game = running();
  const before = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(game.state.sectors).map(([c, s]) => [c, s.inventory]))));
  deal(game, 'AGR_EMERGENCY_STOCKPILE');
  assert.equal(game.agrActivate('AGR_EMERGENCY_STOCKPILE', { by: 'AGR' }).ok, true);
  const agr = game.state.sectors.AGR.inventory;
  assert.equal(agr.power, before.AGR.power + 5);
  assert.equal(agr.water, before.AGR.water + 5);
  assert.equal(agr.med, before.AGR.med + 2);
  assert.equal(agr.parts, before.AGR.parts + 1);
  for (const code of Object.keys(before).filter((c) => c !== 'AGR')) {
    assert.deepEqual(game.state.sectors[code].inventory, before[code], `${code} changed`);
  }
  assert.equal(game.stampsUsed(), 0, 'no Transport allowance spent');
});

test('WORKFORCE RECOVERY: refuses an injured worker and finds no eligible one; MED stays required', () => {
  const game = running();
  game.injure('AGR', 1);
  game.patchConfig({ agr_disabled_cards: [] });
  deal(game, 'AGR_WORKFORCE_RECOVERY');
  const injured = game.agrActivate('AGR_WORKFORCE_RECOVERY', { by: 'AGR', target: { worker_id: 'AGR-W1', injured: true } });
  assert.equal(injured.ok, false);
  assert.equal(injured.reason, 'agr_injured_worker_blocked');
  const none = game.agrActivate('AGR_WORKFORCE_RECOVERY', { by: 'AGR', target: { worker_id: 'AGR-W9' } });
  assert.equal(none.reason, 'agr_no_valid_worker');
  assert.equal(game.state.sectors.AGR.workforce.injured, 1, 'still hurt');
  assert.equal(game.state.agr.used, false, 'the refusal cost nothing');
  // Medical still heals it.
  const h = game.requestHealing('AGR', { by: 'AGR' });
  assert.equal(game.healWorker(h.healing.id, { by: 'MED' }).ok, true);
  // And the card is out of the default draw.
  const fresh = running();
  assert.ok(fresh.cfg.agr_disabled_cards.includes('AGR_WORKFORCE_RECOVERY'));
  assert.equal(forSector(game, 'AGR').agr_cards.offered.find((c) => c.id === 'AGR_WORKFORCE_RECOVERY').workers.length, 0);
});

test('POWER SURGE and WATER RESERVE add exactly +3 once, and production is unchanged', () => {
  const game = running();
  const prodPow = JSON.stringify(economyFor(game, 'POW'));
  const prodWtr = JSON.stringify(economyFor(game, 'WTR'));
  deal(game, 'AGR_POWER_SURGE');
  assert.equal(game.agrActivate('AGR_POWER_SURGE', { by: 'AGR' }).ok, true);
  assert.equal(game.state.sectors.POW.inventory.power, 6);
  assert.equal(JSON.stringify(economyFor(game, 'POW')), prodPow, 'POW production changed');
  game.setRound('R3');                                   // charges R2's upkeep on the way (v10)
  const water = game.state.sectors.WTR.inventory.water;
  deal(game, 'AGR_WATER_RESERVE');
  assert.equal(game.agrActivate('AGR_WATER_RESERVE', { by: 'AGR' }).ok, true);
  assert.equal(game.state.sectors.WTR.inventory.water, water + 3);
  assert.equal(JSON.stringify(economyFor(game, 'WTR')), prodWtr, 'WTR production changed');
});

test('MEDICAL REINFORCEMENT: +1 heal this round only, and AGR still cannot heal', () => {
  const game = running();
  assert.equal(game.medCapacity(), 3);
  deal(game, 'AGR_MEDICAL_REINFORCEMENT');
  assert.equal(game.agrActivate('AGR_MEDICAL_REINFORCEMENT', { by: 'AGR' }).ok, true);
  assert.equal(game.medCapacity(), 4);
  assert.equal(forSector(game, 'MED').healing_queue.capacity, 4);
  game.injure('POW', 1);
  const h = game.requestHealing('POW', { by: 'POW' });
  assert.equal(game.healWorker(h.healing.id, { by: 'AGR' }).reason, 'heal_med_only');
  assert.equal(game.healWorker(h.healing.id, { by: 'MED' }).ok, true);
  game.cycleControl('process');
  assert.equal(game.medCapacity(), 4, 'a cycle did not end the bonus');
  game.setRound('R3');
  assert.equal(game.medCapacity(), 3, 'the round end did');
  assert.ok(logEvents(game, 'effect_ended').some((e) => e.kind === 'med_capacity'));
});

test('LOGISTICS BOOST: +1 approval this round only, and AGR still cannot approve', () => {
  const game = running();
  assert.equal(game.trnCapacity(), 3);
  deal(game, 'AGR_LOGISTICS_BOOST');
  assert.equal(game.agrActivate('AGR_LOGISTICS_BOOST', { by: 'AGR' }).ok, true);
  assert.equal(game.trnCapacity(), 4);
  assert.equal(forSector(game, 'TRN').transfer_queue.capacity, 4);
  game.setInventory('POW', { power: 10 });
  const ids = [];
  for (let i = 0; i < 4; i += 1) ids.push(readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 }).id);
  assert.equal(game.approveTransfer(ids[0], { by: 'AGR' }).reason, 'approval_trn_only');
  for (const id of ids) assert.equal(game.approveTransfer(id, { by: 'TRN' }).ok, true, 'the fourth approval failed');
  game.setRound('R3');
  assert.equal(game.trnCapacity(), 3, 'the bonus outlived the round');
});

test('CRISIS RESPONSE: +20 to the lowest active sector; AGR chooses among ties; DARK is skipped', () => {
  const game = running();
  game.setIntegrity('POW', 40);
  game.setIntegrity('WTR', 55);
  game.setIntegrity('COM', 0);
  deal(game, 'AGR_CRISIS_RESPONSE');
  assert.equal(game.agrActivate('AGR_CRISIS_RESPONSE', { by: 'AGR' }).ok, true);
  assert.equal(game.state.sectors.POW.integrity, 60);
  assert.equal(game.state.sectors.COM.integrity, 0, 'DARK is not the lowest');
  // A tie needs AGR's pick.
  game.setRound('R3');
  game.setIntegrity('POW', 30);
  game.setIntegrity('WTR', 30);
  deal(game, 'AGR_CRISIS_RESPONSE');
  assert.deepEqual(forSector(game, 'AGR').agr_cards.offered[0].ties, ['POW', 'WTR']);
  const tie = game.agrActivate('AGR_CRISIS_RESPONSE', { by: 'AGR' });
  assert.equal(tie.reason, 'agr_target_required');
  assert.deepEqual(tie.ties, ['POW', 'WTR']);
  assert.equal(game.agrActivate('AGR_CRISIS_RESPONSE', { by: 'AGR', target: { sector: 'MED' } }).reason, 'agr_invalid_target');
  assert.equal(game.agrActivate('AGR_CRISIS_RESPONSE', { by: 'AGR', target: { sector: 'WTR' } }).ok, true);
  assert.equal(game.state.sectors.WTR.integrity, 50);
  assert.equal(game.state.sectors.POW.integrity, 30);
});

test('STABILISE SECTOR: +15 to one chosen active sector, capped at 100', () => {
  const game = running();
  game.setIntegrity('MED', 90);
  deal(game, 'AGR_STABILISE_SECTOR');
  assert.equal(game.agrActivate('AGR_STABILISE_SECTOR', { by: 'AGR', target: { sector: 'MED' } }).ok, true);
  assert.equal(game.state.sectors.MED.integrity, 100);
  assert.equal(game.state.sectors.POW.integrity, 100, 'only the chosen sector');
});

test('EMERGENCY PARTS: +3 parts to AGR only', () => {
  const game = running();
  deal(game, 'AGR_EMERGENCY_PARTS');
  assert.equal(game.agrActivate('AGR_EMERGENCY_PARTS', { by: 'AGR' }).ok, true);
  assert.equal(game.state.sectors.AGR.inventory.parts, 6);
  assert.equal(game.state.sectors.POW.inventory.parts, 3);
});

test('RELIEF CREW: one temporary worker for a chosen sector until the round ends', () => {
  const game = running();
  const pow = game.state.sectors.POW;
  const base = game.availableWorkers(pow);
  deal(game, 'AGR_RELIEF_CREW');
  assert.equal(game.agrActivate('AGR_RELIEF_CREW', { by: 'AGR', target: { sector: 'POW' } }).ok, true);
  assert.equal(game.availableWorkers(pow), base + 1);
  assert.equal(pow.workforce.active, 8, 'the base count is untouched');
  assert.equal(forSector(game, 'POW').sectors.POW.workforce.available, base + 1);
  game.cycleControl('process');
  assert.equal(game.availableWorkers(pow), base + 1, 'a cycle did not end it');
  game.setRound('R3');
  assert.equal(game.availableWorkers(pow), base, 'the round end did');
  assert.equal(pow.workforce.injured, 0, 'nothing to do with injury');
});

test('RESERVE CACHE: exactly the one resource AGR chose', () => {
  const game = running();
  deal(game, 'AGR_RESERVE_CACHE');
  assert.equal(game.agrActivate('AGR_RESERVE_CACHE', { by: 'AGR' }).reason, 'agr_target_required');
  assert.equal(game.agrActivate('AGR_RESERVE_CACHE', { by: 'AGR', target: { resource: 'gold' } }).reason, 'agr_invalid_target');
  assert.equal(game.agrActivate('AGR_RESERVE_CACHE', { by: 'AGR', target: { resource: 'med' } }).ok, true);
  const inv = game.state.sectors.AGR.inventory;
  assert.equal(inv.med, 3);
  assert.equal(inv.power, 3); assert.equal(inv.water, 3); assert.equal(inv.parts, 3);
});

// -- AGR: across systems -----------------------------------------------------------------

test('resources a card created still need Transport to leave AGR', () => {
  const game = running();
  deal(game, 'AGR_EMERGENCY_STOCKPILE');
  game.agrActivate('AGR_EMERGENCY_STOCKPILE', { by: 'AGR' });
  const t = game.createTransfer({ from: 'AGR', to: 'MED', resource: 'power', amount: 2, by: 'AGR' });
  assert.equal(t.ok, true);
  assert.equal(t.transfer.status, 'PENDING_TRN_APPROVAL');
  assert.equal(game.state.sectors.MED.inventory.power, 3, 'nothing moved yet');
  assert.equal(game.approveTransfer(t.transfer.id, { by: 'AGR' }).reason, 'approval_trn_only');
  game.confirmChit(t.transfer.id, true, { by: 'TRN' });
  assert.equal(game.approveTransfer(t.transfer.id, { by: 'TRN' }).ok, true);
  assert.equal(game.state.sectors.MED.inventory.power, 5);
  assert.equal(game.stampsUsed(), 1);
});

test('the facilitator can reroll, force a card, and disable one, each logged as an override', () => {
  const game = running();
  const before = [...game.state.agr.offered];
  assert.equal(game.agrReroll({ by: 'AGR' }).reason, 'agr_only');
  assert.equal(game.agrReroll({ by: 'facilitator' }).ok, true);
  assert.notDeepEqual(game.state.agr.offered, before);
  assert.equal(game.state.agr.offered.length, 3);
  assert.equal(logEvents(game, 'agr_admin_reroll').length, 1);

  game.agrActivate(game.state.agr.offered[0], { by: 'facilitator', force: true, target: { sector: 'POW', resource: 'power' } });
  assert.equal(game.state.agr.used, true);
  assert.equal(logEvents(game, 'agr_admin_force_activate').length, 1);
  assert.equal(logEvents(game, 'agr_card_activated').at(-1).facilitator_override, true);
  assert.equal(game.agrReroll({ by: 'facilitator' }).reason, 'agr_card_already_used', 'no reroll after the choice is spent');

  assert.equal(game.agrSetCardEnabled('AGR_POWER_SURGE', false).ok, true);
  assert.ok(!game.agrEnabledIds().includes('AGR_POWER_SURGE'));
  game.setRound('R3');
  assert.ok(!game.state.agr.offered.includes('AGR_POWER_SURGE'));
  assert.equal(forControl(game).agr.pool.find((c) => c.id === 'AGR_POWER_SURGE').enabled, false);
});

test('the wall is sent the movement it may watch, never what anyone holds, and nothing when the scenario says so', () => {
  const game = running();
  const r = game.requestTransfer({ from: 'POW', to: 'MED', resource: 'power', amount: 2, by: 'MED' });
  let w = forBigscreen(game);
  assert.equal(w.requests.length, 1);
  assert.equal(w.requests[0].status, 'REQUESTED');
  assert.equal(w.transfers.length, 0);
  const f = game.fulfillRequest(r.request.id, { by: 'POW' });
  game.confirmChit(f.transfer.id, true, { by: 'TRN' });
  game.approveTransfer(f.transfer.id, { by: 'TRN' });
  w = forBigscreen(game);
  const t = w.transfers.find((x) => x.id === f.transfer.id);
  assert.equal(t.status, 'DELIVERED', 'a just-delivered transfer is still shown so the wall can animate it');
  assert.deepEqual(Object.keys(t).sort(), ['amount', 'approved_at', 'from', 'id', 'request_id', 'resource', 'status', 'to', 'updated_at']);
  assert.equal(w.sectors.POW.inventory === undefined || typeof w.sectors.POW.inventory === 'object', true);
  game.patchConfig({ show_completed_transfer_on_wall: false });
  w = forBigscreen(game);
  assert.equal(w.requests.length + w.transfers.length, 0, 'the scenario switch keeps movement off the wall');
});

test('only AGR is dealt the hand, and nobody is shown the deck', () => {
  const game = running();
  for (const code of BOARD_ROLES) assert.equal(!!forSector(game, code).agr_cards, code === 'AGR', `${code} hand wrong`);
  assert.equal(forSector(game, 'AGR').agr_cards.pool, undefined, 'AGR sees the deck');
  assert.equal(forBigscreen(game).agr_cards, undefined);
  assert.ok(forControl(game).agr.pool.length >= 12);
});

test('the debrief keeps COM edits, announcements, AGR offers, activations, refusals and rerolls', () => {
  const game = running();
  game.setBroadcastRow('POW', { power: 2 }, { by: 'COM' });
  game.setBroadcastAnnouncement({ headline: 'HOLD', message: 'x' }, { by: 'COM' });
  game.agrReroll({ by: 'facilitator' });
  deal(game, 'AGR_STABILISE_SECTOR');
  game.agrActivate('AGR_STABILISE_SECTOR', { by: 'AGR' });                       // refused: no target
  game.agrActivate('AGR_STABILISE_SECTOR', { by: 'AGR', target: { sector: 'POW' } });
  const d = analyse(game.log.readAll(), { runId: 'test-run' }).rounds.R2;
  assert.equal(d.broadcast.row_updates, 1);
  assert.equal(d.broadcast.announcements, 1);
  assert.ok(d.agr.offers >= 1);
  assert.equal(d.agr.rerolls, 1);
  assert.equal(d.agr.refused, 1);
  assert.equal(d.agr.activations, 1);
  assert.equal(d.agr.cards.AGR_STABILISE_SECTOR, 1);
  assert.ok(d.agr.list.some((x) => x.kind === 'activated' && x.before && x.after));
});

// -- fault rewards -----------------------------------------------------------------------
//
// Every fault pays once, to its owner, only when the authoritative path
// finishes it. The table is data; these tests hold it to the spec's budget.

const REWARD_TABLE = require('../lib/fault-rewards.json');
const REWARD_IDS = ['F-001', 'F-002', 'F-003', 'F-004', 'F-005', 'F-006',
  'F-101', 'F-102', 'F-103', 'F-104', 'F-105', 'F-106', 'F-107', 'F-108',
  'F-201', 'F-202', 'F-203', 'F-204', 'F-205', 'F-206', 'F-207', 'F-208', 'F-209', 'F-210', 'F-211', 'F-212',
  'F-301', 'F-302', 'F-303', 'F-304', 'F-305', 'F-306',
  'F-401', 'F-402', 'F-403', 'F-404'];

/** Fire a fault and resolve it with its own first valid code and crew. */
function resolveFault(game, code) {
  const def = loadContent().faults.faults.find((f) => f.code === code);
  const fired = game.fireFault(code, def.sector);
  assert.equal(fired.ok, true, `${code} did not fire: ${fired.reason}`);
  const res = submitCode(game, { sector: def.sector, fault_code: code, code: def.valid_codes[0], workers_assigned: def.crew_required });
  assert.equal(res.accepted, true, `${code} was not accepted: ${res.reason}`);
  return res;
}
const inventoriesOf = (game) => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(game.state.sectors).map(([c, s]) => [c, s.inventory]))));

test('all 36 faults have exactly one reward, and no fault appears twice', () => {
  const ids = Object.keys(REWARD_TABLE.rewards);
  assert.equal(ids.length, 36);
  assert.deepEqual([...ids].sort(), [...REWARD_IDS].sort());
  assert.equal(new Set(ids).size, 36, 'a fault id appears twice');
  const content = loadContent().faults.faults.map((f) => f.code).sort();
  assert.deepEqual(content, [...REWARD_IDS].sort(), 'the table and the content disagree on which faults exist');
  const game = running();
  for (const id of REWARD_IDS) {
    const r = game.faultReward(id);
    assert.ok(r, `${id} has no reward`);
    assert.ok(r.rvu > 0, `${id} has no value`);
    assert.ok(r.health >= 0 && Object.values(r.resources).every((v) => v > 0), `${id} has a negative reward`);
    assert.equal(r.rvu, Object.values(r.resources).reduce((a, b) => a + b, 0) + r.health / 5, `${id}: units do not match its effects`);
  }
});

test('phase counts are 6/8/12/6/4 and phase reward totals are 12/8/18/18/12', () => {
  const content = loadContent().faults.faults;
  const counts = {}; const totals = {};
  for (const [id, r] of Object.entries(REWARD_TABLE.rewards)) {
    const def = content.find((f) => f.code === id);
    assert.equal(REWARD_TABLE.phase_of_round[def.round], r.phase, `${id}: phase ${r.phase} does not match round ${def.round}`);
    assert.equal(def.sector, r.owner, `${id}: owner ${r.owner} does not match the content's ${def.sector}`);
    counts[r.phase] = (counts[r.phase] || 0) + 1;
    totals[r.phase] = (totals[r.phase] || 0) + r.rvu;
  }
  assert.deepEqual(counts, { ORIENTATION: 6, SHIFT_1: 8, SHIFT_2: 12, SHIFT_3: 6, AFTERSHOCK: 4 });
  assert.deepEqual(totals, { ORIENTATION: 12, SHIFT_1: 8, SHIFT_2: 18, SHIFT_3: 18, AFTERSHOCK: 12 });
  assert.deepEqual(REWARD_TABLE.phase_budgets, totals);
});

test('F-002 pays WTR exactly +2 power, once', () => {
  const game = running();
  const before = game.state.sectors.WTR.inventory.power;
  const res = resolveFault(game, 'F-002');
  assert.equal(res.reward.applied, true);
  assert.deepEqual(res.reward.resources, { power: 2 });
  assert.equal(res.reward.health, 0);
  assert.equal(res.reward.text, '+2 POWER');
  // the procedure cost one part; the reward added two power
  assert.equal(game.state.sectors.WTR.inventory.power, before + 2);
  assert.equal(game.state.rewards_claimed['F-002'].key, `faultReward:${game.state.run_id}:F-002`);
  assert.equal(logEvents(game, 'fault_reward_applied').length, 1);
});

test('opening, crew, a wrong code and a failed attempt pay nothing', () => {
  const game = running();
  const before = inventoriesOf(game);
  game.fireFault('F-002', 'WTR');
  game.openFault('WTR', 'F-002');
  const wrong = submitCode(game, { sector: 'WTR', fault_code: 'F-002', code: 'P-01-000', workers_assigned: 1 });
  assert.equal(wrong.accepted, false);
  assert.equal(wrong.reward, undefined);
  const noCrew = submitCode(game, { sector: 'WTR', fault_code: 'F-002', code: 'P-01-617', workers_assigned: 0 });
  assert.equal(noCrew.accepted, false);
  assert.deepEqual(inventoriesOf(game), before, 'something moved before an accepted code');
  assert.equal(Object.keys(game.state.rewards_claimed).length, 0);
  assert.equal(logEvents(game, 'fault_reward_applied').length, 0);
  // the second, correct attempt pays — once
  const ok = submitCode(game, { sector: 'WTR', fault_code: 'F-002', code: 'P-01-617', workers_assigned: 1 });
  assert.equal(ok.accepted, true);
  assert.equal(ok.reward.applied, true);
});

test('a fault fired again later cannot pay a second time; the duplicate is logged', () => {
  const game = running();
  resolveFault(game, 'F-002');
  const after = game.state.sectors.WTR.inventory.power;
  const again = resolveFault(game, 'F-002');          // the facilitator re-fired it
  assert.equal(again.accepted, true, 'resolving it again is still allowed');
  assert.equal(again.reward.applied, false);
  assert.equal(again.reward.reason, 'duplicate');
  assert.equal(game.state.sectors.WTR.inventory.power, after, 'paid twice');
  assert.equal(logEvents(game, 'fault_reward_applied').length, 1);
  assert.equal(logEvents(game, 'fault_reward_duplicate_blocked').length, 1);
  // the claim survives a snapshot, so a restart cannot pay it either
  const back = newGame();
  back.restore(JSON.parse(JSON.stringify(game.serialise())));
  assert.ok(back.state.rewards_claimed['F-002']);
  assert.equal(back.applyFaultReward('WTR', { code: 'F-002' }).reason, 'duplicate');
});

test('WTR resolving F-203 gets +2 power and no other sector changes', () => {
  const game = running();
  const before = inventoriesOf(game);
  const def = loadContent().faults.faults.find((f) => f.code === 'F-203');
  resolveFault(game, 'F-203');
  const after = inventoriesOf(game);
  for (const code of Object.keys(before)) {
    if (code === 'WTR') continue;
    assert.deepEqual(after[code], before[code], `${code} changed`);
  }
  // WTR: the procedure's cost left, the reward arrived
  const expected = { ...before.WTR };
  for (const [k, v] of Object.entries(def.resources_required || {})) expected[k] = Math.max(0, expected[k] - v);
  expected.power += 2;
  assert.deepEqual(after.WTR, expected);
});

test('rewarded resources still need Transport to leave the sector', () => {
  const game = running();
  resolveFault(game, 'F-002');
  const t = game.createTransfer({ from: 'WTR', to: 'POW', resource: 'power', amount: 2, by: 'WTR' });
  assert.equal(t.transfer.status, 'PENDING_TRN_APPROVAL');
  assert.equal(game.approveTransfer(t.transfer.id, { by: 'WTR' }).reason, 'approval_trn_only');
  const powBefore = game.state.sectors.POW.inventory.power;
  game.confirmChit(t.transfer.id, true, { by: 'TRN' });
  assert.equal(game.approveTransfer(t.transfer.id, { by: 'TRN' }).ok, true);
  assert.equal(game.state.sectors.POW.inventory.power, powBefore + 2);
});

test('F-202 caps POW health at 100 and discards the overflow', () => {
  const game = running();
  game.setIntegrity('POW', 92);
  const res = resolveFault(game, 'F-202');
  assert.equal(game.state.sectors.POW.integrity, 100, 'went past 100');
  assert.equal(res.reward.health_after, 100);
  // the reward itself paid only what fitted after the base recovery
  assert.ok(res.reward.health <= 5 && res.reward.health >= 0);
  const log = logEvents(game, 'fault_reward_applied')[0];
  assert.equal(log.health_requested, 5);
  assert.equal(log.health_after, 100);
});

test('a health reward never revives a sector at 0 / DARK', () => {
  const game = running();
  game.setIntegrity('AGR', 0);
  assert.equal(game.state.sectors.AGR.status, 'DARK');
  // F-210 is AGR's ghost fault: its completion is the facilitator's clear, which pays
  game.fireFault('F-210', 'AGR');
  assert.equal(game.clearFault('AGR', 'F-210', 'COM confirmed the ghost'), true);
  const log = logEvents(game, 'fault_reward_applied').find((e) => e.fault === 'F-210');
  assert.ok(log, 'the ghost clear did not pay');
  assert.equal(log.via, 'false_alarm_clear');
  assert.equal(log.health_after, 0, 'the reward revived a dark sector');
  assert.equal(game.state.sectors.AGR.integrity, 0);
  assert.equal(game.state.sectors.AGR.status, 'DARK');
  // …and at the reducer, for any fault with a health reward
  game.setIntegrity('POW', 0);
  const r = game.applyFaultReward('POW', { code: 'F-202', id: 'x' }, { via: 'resolve', by: 'POW' });
  assert.equal(r.applied, true);
  assert.equal(r.health, 0);
  assert.equal(game.state.sectors.POW.integrity, 0);
});

test('F-301 is mixed: +2 water and +5 health, applied exactly once', () => {
  const game = running();
  game.setIntegrity('POW', 60);
  const water = game.state.sectors.POW.inventory.water;
  const def = loadContent().faults.faults.find((f) => f.code === 'F-301');
  const res = resolveFault(game, 'F-301');
  assert.deepEqual(res.reward.resources, { water: 2 });
  assert.equal(res.reward.health, 5);
  const cost = (def.resources_required || {}).water || 0;
  assert.equal(game.state.sectors.POW.inventory.water, water - cost + 2);
  assert.equal(game.state.sectors.POW.integrity, 60 + game.cfg.resolve_recovery + 5);
  assert.equal(logEvents(game, 'fault_reward_applied').length, 1);
  assert.equal(res.reward.text, '+2 WATER · +5 SECTOR HEALTH');
});

test("a reward never touches COM's board", () => {
  const game = running();
  game.setBroadcastRow('WTR', { power: 3 }, { by: 'COM' });
  resolveFault(game, 'F-002');
  assert.ok(game.state.sectors.WTR.inventory.power >= 5, 'the real stock did not rise');
  assert.equal(forBigscreen(game).broadcast.rows.WTR.power, 3, 'the board followed the stock');
});

test('a reward never heals an injured worker, approves a transfer, or plays a card', () => {
  const game = running();
  game.injure('WTR', 1);
  const t = game.createTransfer({ from: 'POW', to: 'WTR', resource: 'parts', amount: 1, by: 'POW' });
  const hand = [...game.state.agr.offered];
  resolveFault(game, 'F-002');
  assert.equal(game.state.sectors.WTR.workforce.injured, 1, 'a reward healed a worker');
  assert.equal(game.findTransfer(t.transfer.id).status, 'PENDING_TRN_APPROVAL', 'a reward approved a transfer');
  assert.deepEqual(game.state.agr.offered, hand);
  assert.equal(game.state.agr.used, false, 'a reward played a card');
  assert.equal(game.stampsUsed(), 0);
  assert.equal(game.medHealsUsed(), 0);
});

test('facilitator force-resolve pays nothing by default, and is logged as an override when enabled', () => {
  const game = running();
  const before = inventoriesOf(game);
  game.fireFault('F-002', 'WTR');
  game.clearFault('WTR', 'F-002', 'troubleshooting');
  assert.deepEqual(inventoriesOf(game), before, 'a force-resolve paid');
  assert.equal(logEvents(game, 'fault_reward_applied').length, 0);
  assert.equal(logEvents(game, 'fault_reward_force_resolve_skipped').length, 1);
  assert.equal(game.state.rewards_claimed['F-002'], undefined, 'the claim was spent for nothing');

  game.patchConfig({ reward_on_facilitator_force_resolve: true });
  game.fireFault('F-002', 'WTR');
  game.clearFault('WTR', 'F-002', 'troubleshooting');
  assert.equal(game.state.sectors.WTR.inventory.power, before.WTR.power + 2);
  const log = logEvents(game, 'fault_reward_applied')[0];
  assert.equal(log.facilitator_override, true);
  assert.equal(logEvents(game, 'fault_reward_admin_override').length, 1);
});

test('every successful reward writes exactly one applied event, with the fields the debrief needs', () => {
  const game = running();
  for (const code of ['F-001', 'F-002', 'F-003']) resolveFault(game, code);
  const events = logEvents(game, 'fault_reward_applied');
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.fault), ['F-001', 'F-002', 'F-003']);
  for (const e of events) {
    for (const k of ['t', 'round', 'run_id', 'phase', 'fault', 'sector', 'reward_type', 'resources_added', 'health_before', 'health_after', 'rvu', 'reward_claimed', 'facilitator_override', 'key']) {
      assert.ok(k in e, `${e.fault} lacks ${k}`);
    }
    assert.equal(e.reward_claimed, true);
    assert.equal(e.phase, 'ORIENTATION');
  }
  const d = analyse(game.log.readAll(), { runId: 'test-run' }).rounds.R2;
  assert.equal(d.rewards.applied, 3);
  assert.equal(d.rewards.rvu, 6);
  assert.deepEqual(d.rewards.resources, { water: 2, power: 2, parts: 2 });
});

test('the sector screen is told the reward before completion, and that it was claimed after; the preview can be switched off', () => {
  const game = running();
  game.fireFault('F-002', 'WTR');
  let f = forSector(game, 'WTR').sectors.WTR.faults.find((x) => x.code === 'F-002');
  assert.deepEqual(f.reward, { resources: { power: 2 }, health: 0, text: '+2 POWER' });
  assert.equal(f.reward_claimed, false);
  assert.equal(JSON.stringify(f).includes('rvu'), false, 'units leaked to a player');
  const ok = submitCode(game, { sector: 'WTR', fault_code: 'F-002', code: 'P-01-617', workers_assigned: 1 });
  assert.equal(ok.accepted, true);
  const sec = forSector(game, 'WTR').sectors.WTR;
  f = Object.values(sec).flatMap((v) => (Array.isArray(v) ? v : [])).find((x) => x && x.code === 'F-002');
  assert.ok(f, 'the resolved fault left every list the sector is sent');
  assert.equal(f.reward_claimed, true);
  game.patchConfig({ show_fault_reward_preview: false });
  game.fireFault('F-103', 'WTR');
  f = forSector(game, 'WTR').sectors.WTR.faults.find((x) => x.code === 'F-103');
  assert.equal(f.reward, null);
  assert.ok(forControl(game).rewards_claimed['F-002']);
});

test('a scenario override changes one reward without touching the table; disabling rewards pays nothing', () => {
  const game = running();
  game.patchConfig({ fault_reward_overrides: { 'F-002': { resources: { power: 3 }, rvu: 3 } } });
  assert.deepEqual(game.faultReward('F-002').resources, { power: 3 });
  assert.deepEqual(REWARD_TABLE.rewards['F-002'].resources, { power: 2 }, 'the data file was mutated');
  game.patchConfig({ fault_reward_overrides: {}, fault_rewards_enabled: false });
  const before = game.state.sectors.WTR.inventory.power;
  const res = resolveFault(game, 'F-002');
  assert.equal(res.reward.applied, false);
  assert.equal(res.reward.reason, 'disabled');
  assert.equal(game.state.sectors.WTR.inventory.power, before);
});

// -- v9: the city board lives on the wall ---------------------------------------------
//
// A table's console is local truth. The city's reported figures are COM's to
// publish and the wall's to show; a laptop gets the round and one flag.

const SECTOR_INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'sector', 'index.html'), 'utf8');
const SECTOR_SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'public', 'sector', 'sector.js'), 'utf8');

test('POW, WTR, MED, TRN and AGR are not sent the six-sector board; COM and the wall are', () => {
  const game = running();
  game.setBroadcastRow('POW', { power: 5 }, { by: 'COM' });
  game.setBroadcastAnnouncement({ headline: 'HOLD', message: 'Route parts to POW' }, { by: 'COM' });
  for (const code of ['POW', 'WTR', 'MED', 'TRN', 'AGR']) {
    const b = forSector(game, code).broadcast;
    assert.equal(b.rows, undefined, `${code} carries the board`);
    assert.equal(b.announcement, undefined, `${code} carries the announcement text`);
    assert.equal(b.editable, false);
    assert.equal(b.announcement_active, true);
    assert.equal(typeof b.round_number, 'number');
    assert.ok(!JSON.stringify(forSector(game, code)).includes('Route parts to POW'), `${code}'s frame carries the message`);
  }
  const com = forSector(game, 'COM').broadcast;
  assert.deepEqual(Object.keys(com.rows).sort(), ['AGR', 'COM', 'MED', 'POW', 'TRN', 'WTR']);
  assert.equal(com.editable, true);
  assert.equal(com.announcement.headline, 'HOLD');
  const wall = forBigscreen(game).broadcast;
  assert.deepEqual(Object.keys(wall.rows).sort(), ['AGR', 'COM', 'MED', 'POW', 'TRN', 'WTR']);
  assert.equal(wall.rows.POW.power, 5);
  assert.equal(wall.rows.POW.freshness, 'CURRENT');
  assert.equal(wall.rows.WTR.freshness, 'NOT UPDATED');
  assert.equal(wall.announcement.headline, 'HOLD');
  assert.equal(forControl(game).broadcast.editable, true, 'the facilitator keeps the override editor');
});

test("the round is on every sector screen, and it is not COM's to control", () => {
  const game = running();
  for (const code of BOARD_ROLES) {
    const f = forSector(game, code);
    assert.equal(f.round, 'R2');
    assert.ok(f.round_name);
    assert.equal(f.broadcast.round_number, 2);
  }
  game.setRound('R3');
  assert.equal(forSector(game, 'AGR').broadcast.round_number, 3);
  assert.ok(/id="hdr-phase"/.test(SECTOR_INDEX), 'the header prints the round');
});

test("a sector sees its own real stock and never another sector's", () => {
  const game = running();
  game.setInventory('POW', { power: 7 });
  const pow = forSector(game, 'POW').sectors;
  assert.equal(pow.POW.inventory.power, 7);
  for (const code of BOARD_ROLES.filter((c) => c !== 'POW')) {
    assert.equal(pow[code].inventory, undefined, `POW can see ${code}'s stock`);
    assert.equal(forSector(game, code).sectors.POW.inventory, undefined, `${code} can see POW's stock`);
  }
});

test("the board is COM's report, untouched by production, upkeep, a transfer, a reward, a card or a round", () => {
  const game = running();
  game.setBroadcastRow('POW', { power: 9, water: 9, parts: 9 }, { by: 'COM' });
  game.setBroadcastRow('AGR', { parts: 9 }, { by: 'COM' });
  const wall = () => forBigscreen(game).broadcast.rows;
  game.cycleControl('process');                                   // production and upkeep
  assert.equal(wall().POW.power, 9, 'the cycle moved the board');
  const t = readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 });
  game.approveTransfer(t.id, { by: 'TRN' });
  assert.equal(wall().POW.power, 9, 'a transfer moved the board');
  const def = loadContent().faults.faults.find((f) => f.code === 'F-001');
  game.fireFault('F-001', 'POW');
  submitCode(game, { sector: 'POW', fault_code: 'F-001', code: def.valid_codes[0], workers_assigned: def.crew_required });
  assert.equal(wall().POW.water, 9, 'a reward moved the board');
  game.state.agr.offered = ['AGR_EMERGENCY_PARTS', 'AGR_POWER_SURGE', 'AGR_WATER_RESERVE'];
  assert.equal(game.agrActivate('AGR_EMERGENCY_PARTS', { by: 'AGR' }).ok, true);
  assert.equal(wall().AGR.parts, 9, 'a card moved the board');
  game.setRound('R3');
  assert.equal(wall().POW.power, 9, 'the round change moved the board');
  assert.equal(wall().POW.freshness, 'STALE');
  assert.notEqual(game.state.sectors.POW.inventory.power, 9, 'real stock and the board have parted, as they should');
});

test('the sector features survive the removal: faults, upkeep, healing, approvals, cards, stock', () => {
  const game = running();
  game.fireFault('F-201', 'POW');
  game.injure('AGR', 1);
  game.requestHealing('AGR', { by: 'AGR' });
  readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 });
  const pow = forSector(game, 'POW');
  assert.equal(pow.sectors.POW.faults.length, 1);
  assert.ok(pow.sectors.POW.upkeep_delivery && pow.sectors.POW.inventory && pow.sectors.POW.workforce);
  assert.equal(forSector(game, 'MED').healing_queue.items.length, 1);
  assert.equal(forSector(game, 'TRN').transfer_queue.items.length, 1);
  assert.equal(forSector(game, 'AGR').agr_cards.offered.length, 3);
  for (const code of BOARD_ROLES) {
    assert.equal(forSector(game, code).broadcast.rows === undefined, code !== 'COM', `${code} board presence wrong`);
  }
});

test("the sector markup has no city table, no legend, an announcement nudge, and COM's controls", () => {
  assert.equal(SECTOR_INDEX.includes('bc-key'), false, 'the legend is still there');
  assert.equal(SECTOR_SCRIPT.includes('bc-v'), false, 'the read-only board cells are still built');
  assert.equal(SECTOR_SCRIPT.includes("'CITY BIG SCREEN'"), false, 'a read-only board title remains');
  assert.ok(/id="banner-city"/.test(SECTOR_INDEX), 'no announcement nudge');
  assert.ok(/CITY ANNOUNCEMENT UPDATED/.test(SECTOR_INDEX));
  assert.ok(/id="bc-rows"/.test(SECTOR_INDEX) && /id="bc-publish"/.test(SECTOR_INDEX) && /id="bc-clear"/.test(SECTOR_INDEX), 'COM lost a control');
  assert.ok(/CITY BIG SCREEN CONTROL/.test(SECTOR_INDEX));
  assert.ok(/show\(\$\('broadcast-panel'\), editable\)/.test(SECTOR_SCRIPT), 'the panel is not gated to COM');
  assert.ok(/show\(\$\('banner-city'\), !!\(b && !editable && b\.announcement_active\)\)/.test(SECTOR_SCRIPT), 'the nudge is not gated to non-COM');
});

// -- v10: one clock, the round's ------------------------------------------------------
//
// Upkeep falls due when the round ends; POW and WTR generate their output by
// hand, once a round; the word CYCLE leaves the tables' screens and stays in
// the charter's history.

const KIT_JS = fs.readFileSync(path.join(__dirname, '..', 'tools', 'kit', 'build_kit.js'), 'utf8');
const BINDER_JS = fs.readFileSync(path.join(__dirname, '..', 'tools', 'kit', 'build_binders.js'), 'utf8');

test('the sector screen speaks in rounds: no CYCLE label in its markup or its live strings', () => {
  assert.ok(!/cycle/i.test(SECTOR_INDEX), 'index.html still says cycle');
  for (const bad of ['NEXT CYCLE', 'CORE CYCLE', 'PER CYCLE', 'CURRENT CYCLE', 'CYCLE OUTPUT', 'CYCLE${', 'PRODUCTION NEXT CYCLE', 'hdr-cycle', 'hdr-core']) {
    assert.ok(!SECTOR_SCRIPT.includes(bad), `sector.js still carries ${bad}`);
  }
  for (const good of ['Next round in', 'Current round', 'NEXT ROUND UPKEEP', 'ROUND OUTPUT', 'HEALING THIS ROUND',
    'TRANSFER APPROVALS', 'INTERVENTIONS THIS ROUND', 'CITY BIG SCREEN CONTROL', 'ROUND OUTPUT ALREADY GENERATED']) {
    assert.ok(SECTOR_INDEX.includes(good), `index.html lacks ${good}`);
  }
  assert.ok(!/Core output/.test(SECTOR_INDEX), 'CORE OUTPUT is still on the generic top bar');
});

test("the charter's history keeps its Cycles; the scenario phases keep their names", () => {
  assert.ok(KIT_JS.includes('Ratified Cycle 12 · Amended Cycle 31'));
  assert.ok(BINDER_JS.includes('Cycle 31 records purge'));
  const game = running();
  const ids = (game.rounds.phases || []).map((p) => p.id);
  assert.ok(ids.includes('ORIENTATION') && ids.includes('AFTERSHOCK'));
  assert.equal(game.roundConfig('R2').name, 'Interdependence');
});

test('MED sees the current round and the time to the next one, and no production line', () => {
  const game = running();
  const f = forSector(game, 'MED');
  assert.equal(f.round, 'R2');
  assert.equal(f.round_number, 2);
  assert.equal(f.round_name, 'Interdependence');
  assert.equal(f.round_clock.running, true);
  assert.ok(f.round_clock.remaining_s > 0);
  assert.equal(f.sectors.MED.round_output, null, 'MED has no output panel');
  assert.deepEqual(f.sectors.MED.production_next, {});
  assert.ok(/id="hdr-phase"/.test(SECTOR_INDEX) && /id="hdr-round-clock"/.test(SECTOR_INDEX));
  assert.ok(!/production-next/.test(SECTOR_INDEX), 'the upkeep panel still has a production row');
});

test('MED: HEALING THIS ROUND reads 0 / 3 USED · 3 LEFT when unused, and the queue still heals', () => {
  const game = running();
  let q = forSector(game, 'MED').healing_queue;
  assert.equal(q.used, 0); assert.equal(q.capacity, 3); assert.equal(q.remaining, 3);
  game.injure('POW', 1);
  const h = game.requestHealing('POW', { by: 'POW' });
  assert.equal(game.healWorker(h.healing.id, { by: 'MED' }).ok, true);
  q = forSector(game, 'MED').healing_queue;
  assert.equal(q.used, 1); assert.equal(q.remaining, 2);
  assert.ok(/USED · \$\{left\} LEFT/.test(SECTOR_SCRIPT), 'the capacity line is not USED · LEFT');
});

test('POW: ROUND OUTPUT is +3 power, generated once a round, into the real tray', () => {
  const game = running();
  const pow = game.state.sectors.POW;
  let ro = forSector(game, 'POW').sectors.POW.round_output;
  assert.deepEqual(ro.base, { power: 3 });
  assert.deepEqual(ro.amount, { power: 3 });
  assert.equal(ro.used, false); assert.equal(ro.available, true); assert.equal(ro.manual, true);
  const before = pow.inventory.power;
  const r = game.generateOutput('POW', { by: 'POW' });
  assert.equal(r.ok, true); assert.deepEqual(r.added, { power: 3 });
  assert.equal(pow.inventory.power, before + 3);
  ro = forSector(game, 'POW').sectors.POW.round_output;
  assert.equal(ro.used, true); assert.equal(ro.available, false); assert.deepEqual(ro.added, { power: 3 });
  assert.equal(game.generateOutput('POW', { by: 'POW' }).reason, 'already_generated');
  assert.equal(pow.inventory.power, before + 3, 'a second press added nothing');
  assert.equal(game.generateOutput('POW', { by: 'WTR' }).reason, 'not_your_sector');
  assert.equal(game.generateOutput('MED', { by: 'MED' }).reason, 'no_output');
  assert.equal(forBigscreen(game).broadcast.rows.POW.power, null, "COM's board did not move");
  const ev = logEvents(game, 'round_output');
  assert.equal(ev.length, 1); assert.equal(ev[0].sector, 'POW');
});

test('WTR: ROUND OUTPUT is +3 water, once a round; the next round opens it again', () => {
  const game = running();
  const wtr = game.state.sectors.WTR;
  const before = wtr.inventory.water;
  assert.deepEqual(game.generateOutput('WTR', { by: 'WTR' }).added, { water: 3 });
  assert.equal(wtr.inventory.water, before + 3);
  assert.equal(game.generateOutput('WTR', { by: 'WTR' }).reason, 'already_generated');
  game.state.round_clock.started = false;              // isolate: no upkeep pass on this change
  game.setRound('R3');
  assert.equal(forSector(game, 'WTR').sectors.WTR.round_output.used, false, 'a new round, a new output');
  assert.equal(game.generateOutput('WTR', { by: 'WTR' }).ok, true);
  assert.equal(wtr.inventory.water, before + 6);
});

test('a refresh, a reconnect and a restart never hand out a second output', () => {
  const game = running();
  game.generateOutput('POW', { by: 'POW' });
  for (let i = 0; i < 3; i += 1) assert.equal(forSector(game, 'POW').sectors.POW.round_output.used, true);
  const again = newGame({ runId: 'output-restore' });
  again.restore(JSON.parse(JSON.stringify(game.serialise())));
  assert.equal(again.state.sectors.POW.round_output.round, 'R2');
  assert.equal(again.generateOutput('POW', { by: 'POW' }).reason, 'already_generated');
  assert.equal(forSector(again, 'POW').sectors.POW.round_output.used, true);
});

test('NEXT ROUND UPKEEP: the exact requirement and READY or SHORTFALL from the real tray', () => {
  const game = running();
  let pow = forSector(game, 'POW').sectors.POW;
  assert.deepEqual(pow.upkeep_delivery, { power: 2, water: 1 });
  assert.equal(pow.upkeep_status, 'READY');
  assert.deepEqual(pow.upkeep_short, {});
  game.setInventory('POW', { power: 1 });
  game.setBroadcastRow('POW', { power: 9, water: 9 }, { by: 'COM' });   // the board says plenty; the tray decides
  pow = forSector(game, 'POW').sectors.POW;
  assert.equal(pow.upkeep_status, 'SHORTFALL');
  assert.deepEqual(pow.upkeep_short, { power: 1 });
  assert.equal(pow.upkeep_due_in_s, Math.ceil(game.state.round_clock.remaining_s));
  assert.ok(/NEXT ROUND UPKEEP/.test(SECTOR_INDEX) && !/NEXT CYCLE UPKEEP/.test(SECTOR_INDEX));
});

test('upkeep is charged once, when a played round ends; an unplayed round costs nothing; no timer fires on its own', () => {
  const game = running();                                 // R2, clock started
  const pow = game.state.sectors.POW;
  const passes = game.state.cycle.number;
  game.state.cycle.remaining_s = 3;                       // the old timer, about to expire — but nobody started it
  game.state.round_clock.remaining_s = 5;
  game.tick(10000);
  assert.equal(game.state.cycle.number, passes, 'nothing ticked the economy');
  assert.equal(game.state.cycle.remaining_s, 3, 'the retired timer did not count');
  assert.deepEqual(pow.inventory, { power: 3, water: 3, parts: 3, med: 1 });
  assert.equal(game.state.round_clock.remaining_s, 0, 'the round clock ran out');
  game.setRound('R3');                                    // the facilitator advances: R2 is charged
  assert.equal(game.state.cycle.number, passes + 1);
  assert.deepEqual(pow.inventory, { power: 1, water: 2, parts: 3, med: 1 });
  const ev = logEvents(game, 'cycle_processed');
  assert.equal(ev[ev.length - 1].round, 'R2');
  game.setRound('R4');                                    // R3 never started: nothing charged
  assert.equal(game.state.cycle.number, passes + 1);
  assert.deepEqual(pow.inventory, { power: 1, water: 2, parts: 3, med: 1 });
});

test('the tables no longer render the City Feed or an Announcements panel; the wall still has the city', () => {
  assert.ok(!/id="announce-block"/.test(SECTOR_INDEX), 'the announcements panel is still there');
  assert.ok(!/renderAnnouncements/.test(SECTOR_SCRIPT));
  assert.ok(/id="city-block" hidden/.test(SECTOR_INDEX), 'the feed is not hidden by default');
  assert.ok(/show\(\$\('city-block'\), SECTOR === 'COM'/.test(SECTOR_SCRIPT), 'the feed is not gated to COM');
  const game = running();
  game.announce('Evacuate Tunnel 7', { sector: 'TRN' });
  game.setBroadcastAnnouncement({ headline: 'HOLD', message: 'Hold the line' }, { by: 'COM' });
  const wall = forBigscreen(game);
  assert.equal(Object.keys(wall.sectors).length, 6);
  assert.ok(Object.values(wall.sectors).every((s) => typeof s.integrity === 'number' && s.status_word));
  assert.equal(wall.broadcast.announcement.headline, 'HOLD');
  assert.ok(wall.broadcast.rows.POW);
  assert.equal(forSector(game, 'TRN').announcements.some((a) => a.sector === 'TRN'), true, 'a notice to one table still reaches it');
  assert.equal(forSector(game, 'POW').announcements.some((a) => a.sector === 'TRN'), false);
});

test('the role queues, the cards, the board and the faults all still work after the redesign', () => {
  const game = running();
  game.setInventory('POW', { power: 9 });
  let tq = forSector(game, 'TRN').transfer_queue;
  assert.equal(tq.used, 0); assert.equal(tq.capacity, 3);
  game.approveTransfer(readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 }).id, { by: 'TRN' });
  tq = forSector(game, 'TRN').transfer_queue;
  assert.equal(tq.used, 1); assert.equal(tq.remaining, 2);
  const hand = forSector(game, 'AGR').agr_cards.offered.map((c) => c.id);
  assert.equal(hand.length, 3);
  assert.deepEqual(forSector(game, 'AGR').agr_cards.offered.map((c) => c.id), hand, 'a reprojection rerolled');
  game.setBroadcastRow('WTR', { water: 4 }, { by: 'COM' });
  assert.equal(forBigscreen(game).broadcast.rows.WTR.water, 4);
  game.fireFault('F-201', 'POW');
  const f = forSector(game, 'POW').sectors.POW.faults[0];
  assert.equal(f.code, 'F-201');
  assert.equal(f.crew_required, undefined); assert.equal(f.resources_required, undefined);
  assert.ok(typeof f.decay_per_min === 'number');
});

// -- v11: Transport's approval queue, as cards ----------------------------------------
//
// Route, item, chit, one strong APPROVE. Oldest first. The rules underneath
// do not move: the same counter, the same paper chit, the same refusals.

test('the approval queue is oldest first, stable, and survives a restart in that order', () => {
  const game = running();
  game.setInventory('POW', { power: 9, parts: 9 });
  const a = readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 });
  game.findTransfer(a.id).created_at = '2026-09-18T01:00:00.000Z';
  const b = readyTransfer(game, { from: 'POW', to: 'MED', resource: 'parts', amount: 1 });
  game.findTransfer(b.id).created_at = '2026-09-18T01:00:05.000Z';
  const c = readyTransfer(game, { from: 'WTR', to: 'AGR', resource: 'water', amount: 2 });
  game.findTransfer(c.id).created_at = '2026-09-18T01:00:09.000Z';
  const order = () => forSector(game, 'TRN').transfer_queue.items.map((t) => t.id);
  assert.deepEqual(order(), [a.id, b.id, c.id], 'newest-first storage, oldest-first queue');
  assert.deepEqual(game.state.transfers.map((t) => t.id).slice(0, 3), [c.id, b.id, a.id], 'storage order untouched');
  for (let i = 0; i < 3; i += 1) assert.deepEqual(order(), [a.id, b.id, c.id], 'a reprojection (refresh) keeps the order');
  const again = newGame({ runId: 'queue-order' });
  again.restore(JSON.parse(JSON.stringify(game.serialise())));
  assert.deepEqual(forSector(again, 'TRN').transfer_queue.items.map((t) => t.id), [a.id, b.id, c.id], 'a restart keeps the order');
  assert.equal(forSector(again, 'TRN').transfer_queue.used, 0, 'and the counter');
});

test('every queue item carries route, item and quantity, for stock and for workers alike', () => {
  const game = running();
  const w = game.createTransfer({ from: 'POW', to: 'MED', resource: 'workers', amount: 2, by: 'POW' });
  assert.equal(w.ok, true);
  const r = readyTransfer(game, { from: 'WTR', to: 'AGR', resource: 'water', amount: 1 });
  const items = forSector(game, 'TRN').transfer_queue.items;
  for (const t of items) {
    assert.ok(t.from && t.to && t.resource && Number(t.amount) > 0, `${t.id} lacks route or item`);
    assert.ok(t.created_at, `${t.id} has no creation time to wait from`);
    assert.equal(typeof t.chit_confirmed, 'boolean');
    assert.equal(typeof t.supplier_ok, 'boolean');
  }
  const worker = items.find((t) => t.id === w.transfer.id);
  assert.equal(worker.resource, 'workers'); assert.equal(worker.amount, 2); assert.equal(worker.chit_confirmed, false);
  assert.equal(items.find((t) => t.id === r.id).chit_confirmed, true);
});

test('a worker transfer spends the same allowance as a resource transfer', () => {
  const game = running();
  const w = game.createTransfer({ from: 'POW', to: 'MED', resource: 'workers', amount: 1, by: 'POW' }).transfer;
  game.confirmChit(w.id, true, { by: 'TRN' });
  assert.equal(game.approveTransfer(w.id, { by: 'TRN' }).ok, true);
  assert.equal(game.stampsUsed(), 1);
  assert.equal(game.state.sectors.MED.workforce.borrowed, 1);
  assert.equal(forSector(game, 'TRN').transfer_queue.remaining, 2);
});

test('the chit is one honest boolean: TRN says the paper is in hand, and APPROVE waits for it', () => {
  const game = running();
  const r = game.requestTransfer({ from: 'POW', to: 'MED', resource: 'power', amount: 1, by: 'MED' });
  const t = game.fulfillRequest(r.request.id, { by: 'POW' }).transfer;
  let item = forSector(game, 'TRN').transfer_queue.items.find((x) => x.id === t.id);
  assert.equal(item.chit_confirmed, false);
  assert.equal(forSector(game, 'TRN').transfer_queue.requires_chit, true);
  const refused = game.approveTransfer(t.id, { by: 'TRN' });
  assert.equal(refused.reason, 'chit_required');
  assert.equal(game.stampsUsed(), 0, 'the refusal spent nothing');
  assert.equal(game.state.sectors.MED.inventory.power, 3, 'and moved nothing');
  assert.equal(game.findTransfer(t.id).status, 'PENDING_TRN_APPROVAL', 'the request stays');
  game.confirmChit(t.id, true, { by: 'TRN' });
  item = forSector(game, 'TRN').transfer_queue.items.find((x) => x.id === t.id);
  assert.equal(item.chit_confirmed, true);
  assert.equal(game.approveTransfer(t.id, { by: 'TRN' }).ok, true);
  assert.equal(game.stampsUsed(), 1);
});

test('a failed approval — capacity, chit, short supplier — consumes nothing and moves nothing', () => {
  const game = running();
  game.setInventory('POW', { power: 10 });
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push(readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 }).id);
  for (const id of ids) assert.equal(game.approveTransfer(id, { by: 'TRN' }).ok, true);
  const med = game.state.sectors.MED.inventory.power;
  const fourth = readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 });
  assert.equal(game.approveTransfer(fourth.id, { by: 'TRN' }).reason, 'capacity');
  assert.equal(game.stampsUsed(), 3);
  assert.equal(game.state.sectors.MED.inventory.power, med, 'capacity refusal moved nothing');
  game.state.round_clock.started = false;             // no upkeep pass on this change
  game.setRound('R3');
  const short = readyTransfer(game, { from: 'WTR', to: 'AGR', resource: 'water', amount: 2 });
  game.setInventory('WTR', { water: 1 });
  assert.equal(forSector(game, 'TRN').transfer_queue.items.find((x) => x.id === short.id).supplier_ok, false);
  assert.equal(game.approveTransfer(short.id, { by: 'TRN' }).reason, 'insufficient_stock_stamp');
  assert.equal(game.stampsUsed(), 0);
  assert.equal(game.state.sectors.AGR.inventory.water, 3, 'a short supplier moved nothing');
  assert.equal(game.findTransfer(short.id).status, 'PENDING_TRN_APPROVAL', 'a still-valid request stays in the queue');
  assert.equal(logEvents(game, 'transfer_refused').length, 2);
});

test('the queue markup: dots and words for capacity, cards with route / item / chit, APPROVE primary, DECLINE secondary, CHIT tertiary, confirmations, no countdown', () => {
  const html = SECTOR_INDEX; const js = SECTOR_SCRIPT;
  assert.ok(/id="queue-dots"/.test(html) && /id="queue-cap"/.test(html) && /id="queue-left"/.test(html), 'capacity is not dots + words');
  assert.ok(/PENDING APPROVALS <span class="count" id="queue-count">/.test(html), 'no pending count');
  assert.ok(!/Only Transport approves resource movement/.test(html), 'the long footer is still there');
  assert.ok(/`\$\{used\} OF \$\{cap\} USED`/.test(js), 'capacity words');
  assert.ok(/APPROVAL CAPACITY REACHED/.test(js) && /LEFT THIS ROUND/.test(js));
  assert.ok(!/USED · \$\{left\} LEFT THIS \$\{period\}/.test(js), 'the dense capacity line remains');
  assert.ok(/class="q-route"/.test(js) && /class="q-item"/.test(js) && /class="q-chitword"/.test(js), 'a card lacks route, item or chit');
  assert.ok(/class="q-chit tertiary"/.test(js) && /class="q-no secondary"/.test(js) && /class="q-stamp primary"/.test(js), 'the action hierarchy is not marked');
  assert.ok(!/ON REQUEST/.test(js), 'ON REQUEST is still printed');
  assert.ok(/function elapsedText/.test(js) && /`Waiting \$\{secs\}s`/.test(js) && /`Waiting \$\{m\}m \$\{r\}s`/.test(js), 'waiting is not "Waiting 27s" / "Waiting 1m 12s"');
  assert.ok(!/WAITING \$\{U\.mmss/.test(js) && !/class="q-wait clock"/.test(js), 'waiting is still a clock');
  assert.ok(/'CHIT: READY'/.test(js) && /'CHIT: CHECK REQUIRED'/.test(js) && /'CHIT: NOT REQUIRED'/.test(js));
  assert.ok(!/CHIT: INVALID|CHIT: NOT AVAILABLE/.test(js), 'a chit state the engine cannot know');
  assert.ok(/APPROVE TRANSFER\?/.test(js) && /CONFIRM APPROVAL/.test(js) && /DECLINE TRANSFER\?/.test(js) && /CONFIRM DECLINE/.test(js), 'confirmations missing');
  assert.ok(/'CHIT REQUIRED'/.test(js) && /'SUPPLIER SHORT OF STOCK'/.test(js) && /'TRANSPORT DARK'/.test(js), 'a disabled reason is missing');
  assert.ok(/CHIT REQUIRED BEFORE APPROVAL/.test(js) && /REQUEST NO LONGER AVAILABLE/.test(js) && /TRANSFER APPROVED/.test(js) && /TRANSFER DECLINED/.test(js));
  assert.ok(/`👤 \$\{n\}|\$\{r\.glyph\} \$\{n\} \$\{name\}/.test(js), 'the item line has no icon + word');
  assert.ok(/'WORKER' : 'WORKERS'/.test(js));
  assert.ok(/NO PENDING APPROVALS/.test(js) && /New transfer requests will appear here/.test(js));
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'sector', 'sector.css'), 'utf8');
  assert.ok(/\.queue \{[^}]*overflow-y: auto/.test(css), 'the queue does not scroll');
  assert.ok(/\.q-actions button \{[^}]*min-height: 34px/.test(css), 'touch targets');
  assert.ok(/focus-visible/.test(css), 'no visible focus');
  assert.ok(/\.q-actions \.q-stamp:disabled \{[^}]*line-through/.test(css), 'a disabled APPROVE relies on colour alone');
});

test('grouping is only a look: two same-route requests are two approvals, two chits, two ids', () => {
  const game = running();
  game.setInventory('POW', { power: 9, parts: 9 });
  const a = readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 });
  const b = game.fulfillRequest(game.requestTransfer({ from: 'POW', to: 'MED', resource: 'parts', amount: 1, by: 'MED' }).request.id, { by: 'POW' }).transfer;
  const items = forSector(game, 'TRN').transfer_queue.items;
  assert.equal(items.length, 2);
  assert.notEqual(items[0].id, items[1].id);
  assert.equal(items[0].chit_confirmed, true); assert.equal(items[1].chit_confirmed, false, 'chits are not merged');
  assert.equal(game.approveTransfer(a.id, { by: 'TRN' }).ok, true);
  assert.equal(game.findTransfer(b.id).status, 'PENDING_TRN_APPROVAL', 'approving one did not approve the other');
  assert.equal(game.stampsUsed(), 1, 'one approval, one stamp');
  assert.ok(/classList\.toggle\('grouped', sameRoute\)/.test(SECTOR_SCRIPT), 'grouping is not a class on the card');
  assert.ok(!/data-approve-group|approveGroup|approve-all/i.test(SECTOR_SCRIPT), 'a group approve exists');
});

test('a queue of six stays six independent items, and a decline is its own reducer with no side effects', () => {
  const game = running();
  game.setInventory('POW', { power: 9, water: 9, parts: 9 });
  const ids = [];
  for (const res of ['power', 'water', 'parts', 'power', 'water', 'parts']) ids.push(readyTransfer(game, { from: 'POW', to: 'AGR', resource: res, amount: 1 }).id);
  assert.equal(forSector(game, 'TRN').transfer_queue.items.length, 6);
  assert.equal(game.declineTransfer(ids[2], { by: 'TRN' }).ok, true);
  assert.equal(forSector(game, 'TRN').transfer_queue.items.length, 5);
  assert.equal(game.stampsUsed(), 0, 'a decline spends no allowance');
  assert.equal(game.state.sectors.AGR.inventory.parts, 3, 'and moves nothing');
  assert.equal(game.declineTransfer(ids[0], { by: 'POW' }).reason, 'approval_trn_only');
});

// -- council and the Continuity Order ------------------------------------------------

test('CALL COUNCIL reaches every projection with a running 5:00 clock', () => {
  const game = running();
  game.callCouncil();
  for (const code of SECTORS) {
    const f = forSector(game, code);
    assert.equal(f.mode, 'COUNCIL');
    assert.equal(f.council.active, true);
    assert.equal(f.council_clock.remaining_s, 300);
    assert.equal(f.council_clock.running, true);
  }
  assert.equal(forBigscreen(game).council.active, true);
  game.tick(10000);
  assert.equal(game.state.council_clock.remaining_s, 290);
});

test('the Continuity Order requires all six sectors once; ranks 5 and 6 go BROWNOUT; council ends', () => {
  const game = running();
  game.callCouncil();
  game.tick(47000);
  assert.equal(game.submitContinuityOrder(['POW', 'MED']).reason, 'order_incomplete');
  assert.equal(game.submitContinuityOrder(['POW', 'POW', 'WTR', 'TRN', 'COM', 'AGR']).reason, 'order_incomplete');

  const res = game.submitContinuityOrder(['POW', 'MED', 'WTR', 'TRN', 'COM', 'AGR']);
  assert.equal(res.ok, true);
  assert.deepEqual(res.order.brownout, ['COM', 'AGR']);
  assert.equal(res.order.time_used_s, 47);
  assert.equal(game.state.sectors.COM.status, 'BROWNOUT');
  assert.equal(game.state.sectors.AGR.status, 'BROWNOUT');
  assert.equal(game.state.sectors.POW.status, 'ACTIVE');
  assert.equal(game.state.council.active, false);
  assert.equal(game.state.mode, 'PLAY');
  assert.equal(game.state.alert.title, 'CONTINUITY ORDER ACCEPTED');
  const ev = logEvents(game, 'continuity_order')[0];
  assert.deepEqual(ev.order, ['POW', 'MED', 'WTR', 'TRN', 'COM', 'AGR']);
  assert.equal(logEvents(game, 'council_ended')[0].order_submitted, true);
  assert.deepEqual(forSector(game, 'WTR').continuity_order.brownout, ['COM', 'AGR'], 'the order is public');
});

test('no order at 00:00 raises the prompt; rolling blackout rotates brownout through the city', () => {
  const game = running();
  game.callCouncil();
  game.tick(301000);
  assert.equal(game.state.council.no_order, true);
  assert.equal(game.state.blackout.active, false, 'automatic blackout is off by default');
  assert.equal(forControl(game).council.no_order, true);

  game.startRollingBlackout();
  const b = game.state.blackout;
  assert.equal(b.active, true);
  assert.deepEqual(b.current, ['POW', 'WTR']);
  assert.equal(game.state.sectors.POW.status, 'BROWNOUT');
  assert.equal(game.state.sectors.MED.status, 'ACTIVE');
  game.tick(game.cfg.rolling_blackout.interval_s * 1000 + 1000);
  assert.deepEqual(game.state.blackout.current, ['MED', 'TRN']);
  assert.equal(game.state.sectors.POW.status, 'ACTIVE', 'the previous pair is restored');
  assert.equal(game.state.sectors.MED.status, 'BROWNOUT');
  game.endRollingBlackout();
  assert.ok(SECTORS.every((c) => game.state.sectors[c].status === 'ACTIVE'));
});

test('auto_blackout_on_no_order starts the blackout by itself', () => {
  const game = running();
  game.patchConfig({ auto_blackout_on_no_order: true });
  game.callCouncil();
  game.tick(301000);
  assert.equal(game.state.blackout.active, true);
  assert.equal(logEvents(game, 'blackout_started')[0].by, 'auto');
});

test('a blackout never lifts a brownout the Continuity Order imposed', () => {
  const game = running();
  game.submitContinuityOrder(['POW', 'MED', 'WTR', 'TRN', 'COM', 'AGR']);
  game.startRollingBlackout();
  for (let i = 0; i < 4; i += 1) game.tick(game.cfg.rolling_blackout.interval_s * 1000 + 1000);
  game.endRollingBlackout();
  assert.equal(game.state.sectors.COM.status, 'BROWNOUT');
  assert.equal(game.state.sectors.AGR.status, 'BROWNOUT');
  assert.equal(game.state.sectors.POW.status, 'ACTIVE');
});

// -- events -----------------------------------------------------------------------------

test('events apply their configured consequences and respect visibility', () => {
  const game = running();
  const res = game.fireEvent('tunnel_collapse');
  assert.equal(res.ok, true);
  assert.equal(game.state.sectors.TRN.integrity, 85);
  assert.equal(game.trnCapacity(), game.cfg.trn_capacity_per_cycle - 1);
  assert.equal(game.state.alert.title, 'TUNNEL COLLAPSE');
  assert.ok(forBigscreen(game).feed.some((e) => e.text === 'TUNNEL COLLAPSE'), 'CITY_WIDE reaches the wall');

  game.fireEvent('false_sensor_reading');
  assert.equal(game.state.intel.find((i) => i.key === 'tunnel_4_sensor').value, 'UNRELIABLE');
  const com = forSector(game, 'COM');
  assert.equal(com.intel.items.find((i) => i.key === 'tunnel_4_sensor').value, 'UNRELIABLE');
  assert.equal(forSector(game, 'POW').intel, undefined, 'COMMS_ONLY: others never see it');
  assert.ok(!forBigscreen(game).feed.some((e) => /FALSE SENSOR/i.test(e.text)), 'nor does the wall');

  assert.equal(game.fireEvent('supply_delay').reason, 'target_required');
  game.fireEvent('supply_delay', { target: 'AGR' });
  assert.equal(forSector(game, 'AGR').announcements[0].sector, 'AGR');
  assert.equal(forSector(game, 'POW').announcements.length, 0, 'TARGET_SECTOR: only the target hears it');
  assert.equal(game.fireEvent('nope').reason, 'unknown_event');
});

test('a follow-up event fires after its delay; the biological breach is containment, not combat', () => {
  const game = running();
  const med = game.state.sectors.MED.integrity;
  game.fireEvent('biological_breach');
  assert.equal(game.state.sectors.MED.integrity, med - 10);
  assert.equal(game.state.sectors.TRN.workforce.injured, 1);
  assert.equal(game.state.scheduled.length, 1);
  const injuredBefore = SECTORS.reduce((a, c) => a + game.state.sectors[c].workforce.injured, 0);
  game.tick(121000);
  assert.equal(game.state.scheduled.length, 0);
  const injuredAfter = SECTORS.reduce((a, c) => a + game.state.sectors[c].workforce.injured, 0);
  assert.equal(injuredAfter, injuredBefore + 2, 'medical_emergency injured two more');
  assert.equal(logEvents(game, 'event_fired').length, 2);
});

test('a fault preset fires now and schedules the rest; the queue freezes with the game', () => {
  const game = running();
  const res = game.firePreset('r2_wave_a');
  assert.equal(res.ok, true);
  assert.ok(game.findFault('POW', 'F-201'));
  assert.equal(game.state.scheduled.length, 2);
  game.pause();
  game.tick(200000);
  assert.equal(game.state.scheduled.length, 2, 'nothing fires while paused');
  game.resume();
  game.tick(91000);
  assert.ok(game.findFault('WTR', 'F-203'));
  assert.equal(game.findFault('WTR', 'F-203').triggered_by, 'preset:r2_wave_a');
  game.cancelScheduled(game.state.scheduled[0].id);
  assert.equal(game.state.scheduled.length, 0);
});

test('COM goes blind under a comms blackout, and the wall degrades when COM is dark', () => {
  const game = running();
  game.fireFault('F-205', 'MED');
  assert.ok(forSector(game, 'COM').sectors.MED.faults, 'normally COM sees the fault');
  game.fireEvent('communication_blackout');
  const blind = forSector(game, 'COM');
  assert.equal(blind.full_telemetry, false);
  assert.equal(blind.sectors.MED.faults, undefined);
  assert.ok(blind.intel.items.every((i) => i.value === 'UNKNOWN'));
  game.tick(241000);
  assert.equal(forSector(game, 'COM').full_telemetry, true);
  game.setStatus('COM', 'BROWNOUT');
  const brown = forSector(game, 'COM');
  assert.equal(brown.intel.items.find((i) => i.key === 'water_pressure').value, 'UNKNOWN');
  assert.notEqual(brown.intel.items.find((i) => i.key === 'medical_load').value, 'UNKNOWN', 'per-item flag');
});

// -- timeline ---------------------------------------------------------------------------

test('the round script: AUTO fires itself, MANUAL becomes READY TO FIRE, skip and delay work', () => {
  const game = running();   // R2 script from the scenario
  const items = game.state.timeline;
  assert.ok(items.length >= 4);
  assert.equal(items[0].status, 'PENDING');
  game.tick(1000);
  assert.equal(items[0].status, 'READY', 'F-201 at 00:00 is MANUAL');
  assert.equal(game.findFault('POW', 'F-201'), null, 'nothing fired without the facilitator');

  const auto = items.find((i) => i.mode === 'AUTO');
  game.state.round_clock.remaining_s = game.roundConfig().length_s - auto.offset_s - 1;
  game.tick(1000);
  assert.equal(auto.status, 'FIRED');
  assert.equal(game.state.announcements[0].text, auto.text);

  assert.equal(game.fireTimelineItem(items[0].id).ok, true);
  assert.equal(game.findFault('POW', 'F-201').triggered_by, `timeline:${items[0].id}`);
  assert.equal(game.fireTimelineItem(items[0].id).ok, false, 'not twice');

  const later = items.find((i) => i.status === 'PENDING');
  game.skipTimelineItem(later.id);
  assert.equal(later.status, 'SKIPPED');
  const ready = items.filter((i) => i.status === 'READY')[0];
  if (ready) {
    game.delayTimelineItem(ready.id, 600);
    assert.equal(ready.status, 'PENDING', 'delayed back into the future');
  }
  assert.ok(logEvents(game, 'timeline_fired').length >= 2);
});

test('changing round re-arms the timeline for that round', () => {
  const game = running();
  game.setRound('R3');
  assert.ok(game.state.timeline.every((i) => i.round === 'R3'));
  assert.ok(game.state.timeline.some((i) => i.kind === 'core' && i.value === 60));
});

// -- configuration ---------------------------------------------------------------------

test('configuration patches apply live and survive a snapshot', () => {
  const game = running();
  game.patchConfig({ critical_below: 50, brownout_effects: { production_multiplier: 0.25 } });
  assert.equal(game.cfg.critical_below, 50);
  assert.equal(game.cfg.brownout_effects.production_multiplier, 0.25);
  assert.equal(game.cfg.brownout_effects.upkeep_delivery_multiplier, 0.5, 'deep merge keeps siblings');
  game.setIntegrity('POW', 45);
  assert.equal(game.state.sectors.POW.status, 'CRITICAL');

  const snap = JSON.parse(JSON.stringify(game.serialise()));
  const again = newGame();
  again.restore(snap);
  assert.equal(again.cfg.critical_below, 50);
  assert.equal(again.state.phase, 'ROUND_2');
});

test('deepMerge replaces arrays and scalars, merges objects', () => {
  const out = deepMerge({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, d: 2 });
  assert.deepEqual(out, { a: { b: 1, c: [3] }, d: 2 });
});

test('the scenario library resolves built-ins, saves copies and shadows by id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercity-scn-'));
  const store = new Store(path.join(dir, 'db.sqlite'));
  const lib = new ScenarioLibrary({ store, rounds, content: loadContent() });
  assert.ok(lib.list().some((s) => s.id === 'haven9-standard' && s.builtin));

  const std = lib.resolve('haven9-standard');
  assert.equal(std.defaults.cycle_length_s, 420);
  assert.deepEqual(std.sectors.POW.production, { power: 3 });

  const raw = lib.raw('haven9-standard');
  raw.defaults.cycle_length_s = 300;
  const id = lib.save({ name: 'HAVEN-9 HARD', doc: raw });
  assert.equal(id, 'haven-9-hard');
  assert.equal(lib.resolve('haven-9-hard').defaults.cycle_length_s, 300);
  assert.equal(lib.resolve('haven-9-hard').defaults.lockout_s, 20, 'untouched fields come through');

  lib.save({ id: 'haven9-standard', name: 'HAVEN-9 STANDARD', doc: { ...raw, defaults: { ...raw.defaults, council_clock_s: 240 } } });
  assert.equal(lib.resolve('haven9-standard').defaults.council_clock_s, 240, 'a saved copy shadows the built-in');
  lib.remove('haven9-standard');
  assert.equal(lib.resolve('haven9-standard').defaults.council_clock_s, 300, 'deleting it reveals the built-in again');

  const game = newGame();
  game.reset('r2', { scenario: lib.resolve('haven-9-hard') });
  assert.equal(game.state.scenario_id, 'haven-9-hard');
  assert.equal(game.cfg.cycle_length_s, 300);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// -- projections ------------------------------------------------------------------------

test('sector frames carry thresholds, low flags, cycle, effects; never another sector\'s stock', () => {
  const game = running();
  game.setInventory('POW', { power: 0, water: 1, parts: 3, med: 0 });
  const f = forSector(game, 'POW');
  const mine = f.sectors.POW;
  assert.deepEqual(mine.low, { power: true, water: false, parts: false, med: true }, 'zero is always low');
  assert.equal(mine.upkeep_due_in_s, Math.ceil(game.state.round_clock.remaining_s), 'upkeep is due when the round ends');
  assert.equal(f.cycle.length_s, game.cfg.cycle_length_s);
  assert.equal(f.sectors.WTR.inventory, undefined);
  assert.equal(f.sectors.WTR.low, undefined);
  assert.equal(f.thresholds.power, 1);
});

test('the alert is full-screen first and a banner after alert_full_screen_s', () => {
  const game = running();
  game.setAlert({ title: 'ROLLING BLACKOUT INITIATED' });
  assert.equal(forBigscreen(game).alert.full_screen, true);
  game.state.alert.t = new Date(Date.now() - 9000).toISOString();
  const a = forSector(game, 'MED').alert;
  assert.equal(a.full_screen, false);
  assert.ok(a.age_s >= 9);
  game.dismissAlert();
  assert.equal(forBigscreen(game).alert, null);
});

test('wall feed shows public kinds only; facilitator-only and sector-scoped lines stay off it', () => {
  const game = running();
  game.fireFault('F-201', 'POW');
  game.openFault('POW', 'F-201');
  game.announce('Only POW hears this', { sector: 'POW' });
  game.ticker('obs', 'DOMINANCE POW: chief talked over liaison', { scope: 'admin' });
  const wall = forBigscreen(game);
  assert.ok(wall.feed.every((e) => !e.scope));
  assert.ok(!wall.feed.some((e) => /opened|DOMINANCE|Only POW/.test(e.text)));
  assert.ok(wall.feed.length <= game.cfg.wall_feed_max);
  assert.ok(forSector(game, 'WTR').ticker.every((e) => e.scope !== 'admin' && e.scope !== 'POW'));
  assert.ok(forControl(game).ticker.some((e) => e.kind === 'obs'));
});

// -- analytics -----------------------------------------------------------------------------

test('the debrief folds the log into per-round figures and a Round 3 vs Aftershock comparison', () => {
  const game = newGame();
  game.setPhase('ROUND_3');
  game.clock('start');
  game.fireFault('F-301', 'POW');
  game.fireFault('F-302', 'WTR');
  game.tick(30000);
  game.openFault('POW', 'F-301');
  game.tick(15000);
  submitCode(game, { sector: 'POW', fault_code: 'F-301', code: 'P-06-000', workers_assigned: 3 });
  game.tick(15000);
  submitCode(game, { sector: 'POW', fault_code: 'F-301', code: 'P-06-142-261', workers_assigned: 3 });
  const t = readyTransfer(game, { from: 'WTR', to: 'POW', resource: 'water', amount: 1 });
  game.tick(20000);
  game.stampTransfer(t.id);
  game.callCouncil();
  game.tick(120000);
  game.submitContinuityOrder(['POW', 'MED', 'WTR', 'TRN', 'COM', 'AGR']);
  game.tick(2000);

  game.setPhase('DEBRIEF_1');
  game.setPhase('AFTERSHOCK');
  game.clock('start');
  game.fireFault('F-401', 'POW');
  game.tick(10000);
  submitCode(game, { sector: 'POW', fault_code: 'F-401', code: 'P-07-243-534', workers_assigned: 2 });

  const d = analyse(game.log.readAll(), { runId: 'test-run' });
  const r3 = d.rounds.R3;
  assert.equal(r3.faults.fired, 2);
  assert.equal(r3.faults.resolved, 1);
  assert.equal(r3.faults.expired, 0, 'nothing expires any more');
  assert.equal(r3.faults.cross_sector, 2);
  assert.equal(r3.console.invalid_code, 1);
  const f301 = r3.faults.list.find((f) => f.code === 'F-301');
  assert.equal(f301.attempts, 2);
  assert.ok(f301.time_to_first_action_s != null && f301.time_to_resolution_s != null,
    'durations come from real timestamps (game ticks do not move the wall clock)');
  assert.deepEqual(f301.consumed, { parts: 3, water: 2 });
  assert.equal(r3.requests.created, 1);
  assert.equal(r3.requests.fulfilled, 1);
  assert.equal(r3.transfers.approved, 1);
  assert.equal(r3.council.orders, 1);
  assert.equal(r3.council.avg_time_used_s, 120, 'council time used is game time, from the clock');
  assert.equal(r3.sectors.brownouts, 2);

  const r4 = d.rounds.R4;
  assert.equal(r4.faults.fired, 1);
  assert.equal(r4.faults.resolution_rate, 100);
  assert.equal(r4.council.called, 0);

  assert.equal(d.comparison.R3.resolution_rate, 50);
  assert.equal(d.comparison.R4.resolution_rate, 100);
  assert.equal(d.comparison.R3.failed_console_entries, 1);
  assert.equal(d.comparison.R4.failed_console_entries, 0);
  assert.ok(d.comparison.rows.length >= 8);
  assert.ok(d.timeline.length > 5 && d.timeline.every((e) => e.t));
  assert.equal(d.overall.faults.fired, 3);
});

test('analytics durations are computed from the log timestamps', () => {
  const T = (s) => new Date(Date.UTC(2026, 8, 14, 10, 0, s)).toISOString();
  const lines = [
    { t: T(0), ev: 'run_reset', run_id: 'x' },
    { t: T(0), ev: 'fault_fired', round: 'R3', sector: 'POW', fault: 'F-301', severity: 3, cross_sector: true },
    { t: T(30), ev: 'fault_opened', round: 'R3', sector: 'POW', fault: 'F-301' },
    { t: T(45), ev: 'submit', round: 'R3', sector: 'POW', fault: 'F-301', accepted: false, reason: 'invalid_code', attempts: 1 },
    { t: T(60), ev: 'submit', round: 'R3', sector: 'POW', fault: 'F-301', accepted: true, attempts: 2, consumed: { parts: 3 } },
    { t: T(70), ev: 'transfer_requested', round: 'R3', id: 'T-1', from: 'WTR', to: 'POW', resource: 'water', amount: 1 },
    { t: T(90), ev: 'transfer_stamped', round: 'R3', id: 'T-1', from: 'WTR', to: 'POW', resource: 'water', amount: 1, delivered: true },
    { t: T(100), ev: 'fault_fired', round: 'R4', sector: 'MED', fault: 'F-402', severity: 2 },
    { t: T(110), ev: 'submit', round: 'R4', sector: 'MED', fault: 'F-402', accepted: true, attempts: 1 },
  ].map((l) => JSON.stringify(l)).join('\n');
  const d = analyse(lines);
  const f = d.rounds.R3.faults.list[0];
  assert.equal(f.time_to_first_action_s, 30);
  assert.equal(f.time_to_resolution_s, 60);
  assert.equal(f.attempts, 2);
  assert.equal(f.invalid, 1);
  assert.equal(d.rounds.R3.faults.avg_first_action_s, 30);
  assert.equal(d.rounds.R3.transfers.avg_request_to_stamp_s, 20);
  assert.equal(d.rounds.R3.transfers.avg_request_to_delivery_s, 20);
  assert.equal(d.comparison.R3.avg_resolution_s, 60);
  assert.equal(d.comparison.R4.avg_resolution_s, 10);
  assert.equal(d.comparison.R4.avg_first_action_s, 10, 'a submit is a first action too');
});

// -- configuration for spec §5 / §44: thresholds, core start, round lengths,
//    per-fault overrides, scenario inheritance ---------------------------------

test('the status word follows the scenario thresholds and every projection carries it', () => {
  const game = running();
  assert.equal(forSector(game, 'WTR').sectors.POW.status_word, 'STABLE', 'the delayed view names a word too');
  game.setIntegrity('POW', 65);
  assert.equal(forSector(game, 'POW').sectors.POW.status_word, 'STABLE');
  game.patchConfig({ degraded_below: 70 });
  assert.equal(forSector(game, 'POW').sectors.POW.status_word, 'DEGRADED');
  assert.equal(forBigscreen(game).sectors.POW.status_word, 'DEGRADED');
  assert.equal(forControl(game).sectors.POW.status_word, 'DEGRADED');
  game.patchConfig({ critical_below: 66 });
  assert.equal(game.state.sectors.POW.status, 'CRITICAL', 'a live threshold change re-evaluates status at once');
  assert.equal(forBigscreen(game).sectors.POW.status_word, 'CRITICAL');
  game.setStatus('POW', 'BROWNOUT');
  assert.equal(forBigscreen(game).sectors.POW.status_word, 'BROWNOUT');
  game.setStatus('POW', 'DARK');
  assert.equal(forSector(game, 'POW').sectors.POW.status_word, 'DARK');
});

test('core output at start and round lengths come from the scenario', () => {
  const game = newGame();
  game.patchConfig({ core_start_output: 80, round_length_s: { R2: 900 } });
  game.reset('run-2', { silent: true });
  assert.equal(game.state.core_integrity, 80);
  assert.equal(forBigscreen(game).core_output, 80);
  assert.ok(game.state.city_stability < 100, 'stability reflects the lower core from the first frame');

  game.setPhase('ROUND_2');
  assert.equal(game.state.round_clock.remaining_s, 900);
  const r1 = rounds.rounds.find((r) => r.id === 'R1');
  assert.equal(game.roundConfig('R1').length_s, r1.length_s, 'rounds without an override keep rounds.json');

  // The current round's new length applies at once while its clock is held…
  game.patchConfig({ round_length_s: { R2: 600 } });
  assert.equal(game.state.round_clock.remaining_s, 600);
  // …and never while it is running.
  game.clock('start');
  game.patchConfig({ round_length_s: { R2: 300 } });
  assert.equal(game.state.round_clock.remaining_s, 600);
  assert.equal(game.roundConfig().length_s, 300, 'the next START of R2 would use it');
});

test('per-fault overrides: extra accepted codes; the content answer stays; an old deadline override is ignored', () => {
  const game = running();
  assert.equal(game.setFaultOverride('F-999', { extra_valid_codes: ['X'] }).ok, false);

  game.setFaultOverride('F-201', { deadline_s: 100, integrity_penalty: 3, extra_valid_codes: ['p-04-777', ''] });
  const { fault } = game.fireFault('F-201', 'POW');
  assert.equal('deadline_s' in fault, false, 'an old deadline override put a clock on the fault');
  assert.equal(forControl(game).config.fault_overrides['F-201'].deadline_s, undefined, 'the deadline override was kept');
  assert.equal(forControl(game).config.fault_overrides['F-201'].integrity_penalty, undefined, 'the penalty override was kept');
  assert.ok(fault.valid_codes.includes('P-04-340') && fault.valid_codes.includes('P-04-777'));
  assert.ok(!JSON.stringify(forSector(game, 'POW')).includes('P-04-777'), 'an extra code is still an answer key');

  const r = submitCode(game, { sector: 'POW', fault_code: 'F-201', code: 'P-04-777', workers_assigned: 2 });
  assert.equal(r.accepted, true, 'the extra code resolves it');

  game.setFaultOverride('F-201', null);
  assert.equal(forControl(game).config.fault_overrides['F-201'], undefined);
  const again = game.fireFault('F-201', 'POW').fault;
  assert.deepEqual([...again.valid_codes].sort(), ['P-04-290', 'P-04-340']);
  assert.equal(logEvents(game, 'fault_override').length, 2, 'both the override and its removal are logged');
});

test('each Council sitting gets its own 30-second warning', () => {
  const game = running();
  game.callCouncil();
  game.clock('set', 25, 'council');
  game.tick(1000);
  assert.equal(game.state.council.warned_30, true);
  assert.equal(game.submitContinuityOrder(['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM']).ok, true);
  game.callCouncil();
  assert.equal(game.state.council.warned_30, false);
  game.clock('set', 25, 'council');
  game.tick(1000);
  assert.equal(game.state.council.warned_30, true, 'the second sitting warns too');
});

test('the demo scenario extends the standard one: defaults and sectors merge, scripts are taken whole', () => {
  const lib = new ScenarioLibrary({ rounds, content: loadContent() });
  const demo = lib.resolve('haven9-demo');
  const std = lib.resolve('haven9-standard');
  assert.equal(demo.defaults.cycle_length_s, 120);
  assert.equal(demo.defaults.lockout_s, std.defaults.lockout_s, 'unset defaults inherit');
  assert.equal(demo.sectors.MED.start_integrity, 55);
  assert.deepEqual(demo.sectors.MED.upkeep, std.sectors.MED.upkeep, 'unset sector fields inherit');
  assert.equal(demo.events.length, std.events.length, 'events inherit whole');
  assert.ok(demo.timelines.R2.some((t) => t.mode === 'AUTO'), 'the demo R2 script replaces the standard one');
  assert.deepEqual(demo.timelines.R1, std.timelines.R1, 'other rounds keep the parent script');

  const game = newGame();
  game.reset('demo', { silent: true, scenario: demo });
  assert.equal(game.state.scenario_id, 'haven9-demo');
  assert.equal(forBigscreen(game).sectors.MED.status_word, 'DEGRADED', 'MED starts visibly degraded');
  assert.equal(forBigscreen(game).sectors.COM.integrity, 95);
  assert.equal(game.state.cycle.remaining_s, 120);
  assert.equal(game.roundConfig('R2').length_s, 600);
});

test('the alert frame carries the full-screen seconds so clients never guess', () => {
  const game = running();
  game.patchConfig({ alert_full_screen_s: 3 });
  game.setAlert({ title: 'CORE INSTABILITY DETECTED' });
  assert.equal(forBigscreen(game).alert.full_s, 3);
  assert.equal(forSector(game, 'POW').alert.full_s, 3);
  assert.equal(forBigscreen(game).alert.full_screen, true);
});

test('the session registry opens a session on its chosen scenario; RESET RUN WITH SCENARIO switches it; a restart fills new settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercity-reg-'));
  const store = new Store(path.join(dir, 'db.sqlite'));
  const content = loadContent();
  const scenarios = new ScenarioLibrary({ store, rounds, content });
  const { SessionRegistry } = require('../lib/sessions');
  const registry = new SessionRegistry({ store, content, rounds, dataDir: dir, scenarios });
  const sys = store.createFacilitator({ email: 'reg@test', name: 'Reg', passwordHash: 'x', isAdmin: true });
  const row = store.createSession({
    name: 'Reg run', clientName: null, facilitatorId: sys.id,
    sectors: Object.fromEntries(SECTORS.map((s) => [s, s])),
  });
  store.setSessionScenario(row.id, 'haven9-demo');

  const entry = registry.get(row.code);
  assert.equal(entry.game.state.scenario_id, 'haven9-demo', 'the session opens on the scenario it was created with');
  assert.equal(entry.game.cfg.cycle_length_s, 120);

  registry.resetRun(row.code, { runId: 'reg-2', scenarioId: 'haven9-standard' });
  assert.equal(entry.game.state.scenario_id, 'haven9-standard');
  assert.equal(entry.game.cfg.cycle_length_s, 420);
  assert.equal(store.sessionById(row.id).scenario_id, 'haven9-standard', 'the choice is persisted');

  // A restart restores the run, keeps live edits, and fills settings the snapshot predates.
  entry.game.patchConfig({ council_clock_s: 240 });
  registry.evict(row.code);
  const snapPath = registry.paths(row.code).snapshot;
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  delete snap.scenario.defaults.degraded_below;
  fs.writeFileSync(snapPath, JSON.stringify(snap));
  const again = registry.get(row.code);
  assert.equal(again.game.state.run_id, 'reg-2');
  assert.equal(again.game.cfg.council_clock_s, 240, 'live edits survive the restart');
  assert.equal(again.game.cfg.degraded_below, 60, 'fresh defaults fill the gaps');
  registry.evict(row.code);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
