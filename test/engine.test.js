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
  const dealt = game.state.sectors.POW.faults[0].reward;
  assert.equal(f.reward.text, dealt.display_label, 'the preview is the exact reward this instance was dealt');
  assert.ok(!/PARTS REQUIRED|CREW|MATERIAL/i.test(f.reward.text));
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
  game.fireFault('F-002', 'WTR');
  const inst = game.state.sectors.WTR.faults[0];
  const view = forSector(game, 'WTR').sectors.WTR.faults[0].reward;
  assert.ok(view && view.text === inst.reward.display_label, 'no exact preview before completion');
  const def = loadContent().faults.faults.find((f) => f.code === 'F-002');
  game.setIntegrity('WTR', 60);
  game.setInventory('WTR', { parts: 1 });
  const res = submitCode(game, { sector: 'WTR', fault_code: 'F-002', code: def.valid_codes[0], workers_assigned: def.crew_required });
  assert.equal(res.accepted, true);
  assert.ok(res.reward.applied || res.reward.pending, 'the reward was neither paid nor offered');
  assert.equal(logEvents(game, 'fault_reward_applied').length + logEvents(game, 'fault_reward_pending').length, 1);
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
  assert.equal(forControl(game).city_stability, 55, 'the facilitator sees the score');
  assert.equal(forBigscreen(game).city_stability, undefined, 'the wall is not sent an aggregate city figure');
  assert.equal(forSector(game, 'POW').city_stability, undefined, 'nor is a laptop');
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

// -- v12: RESOURCE REQUESTS & TRANSFERS — one card per movement -----------------------
//
// The same requests and transfers, projected for one table: labelled in the
// room's words, split into ACTIVE and HISTORY, a fulfilled request folded
// into its transfer. The rules underneath do not move.

test('a fulfilled request folds into its linked transfer: one ACTIVE card, the request in HISTORY, nothing moved', () => {
  const game = running();
  const before = { pow: game.state.sectors.POW.inventory.power, med: game.state.sectors.MED.inventory.power };
  const r = game.requestTransfer({ from: 'POW', to: 'MED', resource: 'power', amount: 1, by: 'MED' });
  let mv = forSector(game, 'MED').movement;
  assert.equal(mv.active.length, 1);
  assert.equal(mv.active[0].kind, 'request'); assert.equal(mv.active[0].label, 'WAITING FOR SUPPLIER');
  assert.equal(mv.active[0].direction, 'OUTGOING'); assert.equal(mv.active[0].can_withdraw, true);
  assert.deepEqual([game.state.sectors.POW.inventory.power, game.state.sectors.MED.inventory.power], [before.pow, before.med], 'a request moved stock');

  const f = game.fulfillRequest(r.request.id, { by: 'POW' });
  assert.equal(f.ok, true);
  assert.equal(f.transfer.request_id, r.request.id); assert.equal(game.findRequest(r.request.id).transfer_id, f.transfer.id, 'linked both ways');
  assert.equal(f.transfer.status, 'PENDING_TRN_APPROVAL', 'fulfilment is consent, not approval');
  assert.equal(game.stampsUsed(), 0, 'fulfilment spent no Transport allowance');
  assert.deepEqual([game.state.sectors.POW.inventory.power, game.state.sectors.MED.inventory.power], [before.pow, before.med], 'fulfilment moved stock');

  for (const code of ['MED', 'POW']) {
    mv = forSector(game, code).movement;
    assert.equal(mv.active.length, 1, `${code}: the request and its transfer are two active cards`);
    assert.equal(mv.active[0].id, f.transfer.id); assert.equal(mv.active[0].label, 'WAITING FOR TRN');
    assert.equal(mv.active[0].linked_id, r.request.id);
    const hist = mv.history.find((c) => c.id === r.request.id);
    assert.ok(hist, `${code}: the request left the audit trail`);
    assert.equal(hist.label, 'SUPPLIER ACCEPTED'); assert.equal(hist.linked_id, f.transfer.id); assert.equal(hist.active, false);
  }
  assert.equal(forSector(game, 'MED').movement.active[0].direction, 'INCOMING');
  assert.equal(forSector(game, 'POW').movement.active[0].direction, 'OUTGOING');

  // Only Transport finishes it.
  assert.equal(game.approveTransfer(f.transfer.id, { by: 'MED' }).reason, 'approval_trn_only');
  assert.equal(game.approveTransfer(f.transfer.id, { by: 'POW' }).reason, 'approval_trn_only');
  game.confirmChit(f.transfer.id, true, { by: 'TRN' });
  assert.equal(game.approveTransfer(f.transfer.id, { by: 'TRN' }).ok, true);
  assert.equal(game.state.sectors.MED.inventory.power, before.med + 1);
  mv = forSector(game, 'MED').movement;
  assert.equal(mv.active.length, 0, 'a delivered transfer is not active');
  assert.equal(mv.history[0].id, f.transfer.id); assert.equal(mv.history[0].label, 'DELIVERED');
});

test('direction is relative to the table looking: the same four movements from MED and from POW', () => {
  const game = running();
  game.setInventory('MED', { med: 5 });
  const a = game.requestTransfer({ from: 'WTR', to: 'MED', resource: 'water', amount: 1, by: 'MED' }).request;   // MED asks WTR
  const b = game.requestTransfer({ from: 'MED', to: 'POW', resource: 'med', amount: 1, by: 'POW' }).request;     // POW asks MED
  const c = game.createTransfer({ from: 'POW', to: 'MED', resource: 'water', amount: 1, by: 'POW' }).transfer;  // POW sends MED
  const d = game.createTransfer({ from: 'MED', to: 'POW', resource: 'med', amount: 1, by: 'MED' }).transfer;    // MED sends POW
  const med = Object.fromEntries(forSector(game, 'MED').movement.active.map((x) => [x.id, x]));
  assert.equal(med[a.id].direction, 'OUTGOING'); assert.equal(med[a.id].label, 'WAITING FOR SUPPLIER');
  assert.equal(med[b.id].direction, 'INCOMING'); assert.equal(med[b.id].label, 'ACTION REQUIRED'); assert.equal(med[b.id].action_required, true); assert.equal(med[b.id].can_fulfill, true);
  assert.equal(med[c.id].direction, 'INCOMING'); assert.equal(med[c.id].label, 'WAITING FOR TRN');
  assert.equal(med[d.id].direction, 'OUTGOING');
  const pow = Object.fromEntries(forSector(game, 'POW').movement.active.map((x) => [x.id, x]));
  assert.equal(pow[a.id], undefined, "POW is not party to MED's ask of WTR");
  assert.equal(pow[b.id].direction, 'OUTGOING'); assert.equal(pow[b.id].label, 'WAITING FOR SUPPLIER'); assert.equal(pow[b.id].action_required, false);
  assert.equal(pow[c.id].direction, 'OUTGOING'); assert.equal(pow[d.id].direction, 'INCOMING');
  const wtr = forSector(game, 'WTR').movement.active;
  assert.equal(wtr.length, 1); assert.equal(wtr[0].direction, 'INCOMING'); assert.equal(wtr[0].action_required, true);
});

test('ACTIVE is oldest first and only the unresolved; HISTORY is newest first, bounded, and keeps every kind of ending', () => {
  const game = running();
  game.setInventory('POW', { power: 30, parts: 30 });
  const stamp = (rec, iso) => { rec.requested_at = iso; rec.created_at = iso; rec.updated_at = iso; };
  const r1 = game.requestTransfer({ from: 'POW', to: 'MED', resource: 'power', amount: 1, by: 'MED' }).request; stamp(r1, '2026-09-18T02:00:00.000Z');
  const t1 = game.createTransfer({ from: 'POW', to: 'MED', resource: 'parts', amount: 1, by: 'POW' }).transfer;  stamp(t1, '2026-09-18T02:00:05.000Z');
  const r2 = game.requestTransfer({ from: 'POW', to: 'MED', resource: 'parts', amount: 1, by: 'MED' }).request; stamp(r2, '2026-09-18T02:00:09.000Z');
  let mv = forSector(game, 'MED').movement;
  assert.deepEqual(mv.active.map((c) => c.id), [r1.id, t1.id, r2.id], 'oldest first');
  assert.deepEqual(forSector(game, 'MED').movement.active.map((c) => c.id), [r1.id, t1.id, r2.id], 'a reprojection (refresh) keeps it');

  game.declineRequest(r2.id, { by: 'POW' });                           // DECLINED
  game.confirmChit(t1.id, true, { by: 'TRN' }); game.approveTransfer(t1.id, { by: 'TRN' });   // DELIVERED
  const f = game.fulfillRequest(r1.id, { by: 'POW' });                 // SUPPLIER ACCEPTED + a new active transfer
  game.declineTransfer(f.transfer.id, { by: 'TRN' });                  // TRN DECLINED
  const r3 = game.requestTransfer({ from: 'POW', to: 'MED', resource: 'power', amount: 1, by: 'MED' }).request;
  game.cancelRequest(r3.id, { by: 'MED' });                             // CANCELLED
  mv = forSector(game, 'MED').movement;
  assert.equal(mv.active.length, 0, 'nothing unresolved is left');
  const labels = Object.fromEntries(mv.history.map((c) => [c.id, c.label]));
  assert.equal(labels[r2.id], 'DECLINED'); assert.equal(labels[t1.id], 'DELIVERED'); assert.equal(labels[r1.id], 'SUPPLIER ACCEPTED');
  assert.equal(labels[f.transfer.id], 'TRN DECLINED'); assert.equal(labels[r3.id], 'CANCELLED');
  const times = mv.history.map((c) => Date.parse(c.updated_at));
  assert.ok(times.every((t, i) => i === 0 || t <= times[i - 1]), 'newest first');
  assert.equal(mv.history[0].id, r3.id, 'the last thing that happened is on top');

  // a long history stays bounded, and never crowds ACTIVE
  for (let i = 0; i < 25; i += 1) {
    const x = game.requestTransfer({ from: 'POW', to: 'MED', resource: 'power', amount: 1, by: 'MED' }).request;
    game.declineRequest(x.id, { by: 'POW' });
  }
  const live = game.requestTransfer({ from: 'POW', to: 'MED', resource: 'power', amount: 1, by: 'MED' }).request;
  mv = forSector(game, 'MED').movement;
  assert.equal(mv.history.length, 20); assert.ok(mv.history_total >= 30);
  assert.deepEqual(mv.active.map((c) => c.id), [live.id]);
});

test('a short supplier cannot fulfil: no transfer, no stock touched, the request stays active and says so', () => {
  const game = running();
  game.setInventory('WTR', { water: 1 });
  const r = game.requestTransfer({ from: 'WTR', to: 'AGR', resource: 'water', amount: 2, by: 'AGR' }).request;
  const card = forSector(game, 'WTR').movement.active.find((c) => c.id === r.id);
  assert.equal(card.action_required, true); assert.equal(card.can_fulfill, false, 'the card would let a short supplier press FULFILL');
  const f = game.fulfillRequest(r.id, { by: 'WTR' });
  assert.equal(f.ok, false); assert.equal(f.reason, 'insufficient_stock_accept');
  assert.equal(game.state.transfers.length, 0, 'a partial transfer was created');
  assert.equal(game.state.sectors.WTR.inventory.water, 1); assert.equal(game.state.sectors.AGR.inventory.water, 3);
  assert.equal(game.findRequest(r.id).status, 'REQUESTED');
  assert.equal(forSector(game, 'WTR').movement.active[0].id, r.id, 'the request left ACTIVE');
  assert.equal(forSector(game, 'AGR').movement.active[0].label, 'WAITING FOR SUPPLIER');
  assert.equal(forSector(game, 'AGR').movement.active[0].can_fulfill, false, 'the requester was told about the supplier stock');
});

test('worker and resource movements render alike, and a restart keeps statuses, links and order without duplicates', () => {
  const game = running();
  const w = game.createTransfer({ from: 'POW', to: 'MED', resource: 'workers', amount: 2, by: 'POW' }).transfer;
  const r = game.requestTransfer({ from: 'POW', to: 'MED', resource: 'parts', amount: 1, by: 'MED' }).request;
  const f = game.fulfillRequest(r.id, { by: 'POW' });
  let mv = forSector(game, 'MED').movement;
  const wc = mv.active.find((c) => c.id === w.id);
  assert.equal(wc.resource, 'workers'); assert.equal(wc.amount, 2); assert.equal(wc.kind, 'transfer'); assert.equal(wc.label, 'WAITING FOR TRN');
  assert.deepEqual(mv.active.map((c) => c.id), [w.id, f.transfer.id]);
  const again = newGame({ runId: 'movement-restore' });
  again.restore(JSON.parse(JSON.stringify(game.serialise())));
  const back = forSector(again, 'MED').movement;
  assert.deepEqual(back.active.map((c) => c.id), [w.id, f.transfer.id], 'a restart changed the active cards');
  assert.equal(new Set(back.active.map((c) => c.id)).size, back.active.length, 'duplicates');
  assert.ok(!back.active.some((c) => c.id === r.id), 'the fulfilled request came back to ACTIVE');
  assert.equal(back.history.find((c) => c.id === r.id).linked_id, f.transfer.id);
  assert.equal(again.findRequest(r.id).status, 'TRANSFER_CREATED');
  assert.equal(again.stampsUsed(), 0);
});

test('the panel markup: RESOURCE REQUESTS & TRANSFERS, two forms, ACTIVE with filters, HISTORY folded, no inbox, no old words', () => {
  const html = SECTOR_INDEX; const js = SECTOR_SCRIPT;
  assert.ok(/RESOURCE REQUESTS &amp; TRANSFERS/.test(html), 'panel title');
  assert.ok(!/RESOURCES IN &amp; OUT/.test(html) && !/id="inbox-panel"/.test(html) && !/INBOUND REQUESTS/.test(html), 'the old panel or the inbox is still there');
  assert.ok(/data-mode="request"/.test(html) && /data-mode="transfer"/.test(html));
  assert.ok(/Ask another sector for stock\. No resources move until a transfer is created and TRN approves it\./.test(html));
  assert.ok(/'SEND TO'/.test(js) && /'CREATE TRANSFER'/.test(js) && /Creates a proposed movement\. TRN must approve before stock or workers move\./.test(js), 'the transfer form wording');
  assert.ok(/'RESOURCE \/ WORKER'/.test(js) && /'QUANTITY'/.test(js));
  assert.ok(/id="mv-active-count"/.test(html) && /data-filter="ALL"/.test(html) && /data-filter="INCOMING"/.test(html) && /data-filter="OUTGOING"/.test(html));
  assert.ok(/id="mv-history-count"/.test(html) && /VIEW HISTORY/.test(html) && /id="history" hidden/.test(html), 'history is not folded by default');
  assert.ok(/let historyOpen = false/.test(js) && /let movementFilter = 'ALL'/.test(js));
  assert.ok(/NO ACTIVE REQUESTS OR TRANSFERS/.test(js) && /New activity will appear here/.test(js));
  assert.ok(/class="mv-id"/.test(js) && /class="mv-route"/.test(js) && /class="mv-item"/.test(js) && /class="mv-status"/.test(js), 'a card lacks id, route, item or status');
  assert.ok(/requested from/.test(js), 'a request card does not say who asked whom');
  assert.ok(/data-fulfill/.test(js) && /data-decline/.test(js) && /data-withdraw/.test(js));
  assert.ok(/'WORKER' : 'WORKERS'/.test(js));
  for (const bad of ['AWAITING TRANSPORT', 'FULFILLED — AWAITING', 'renderInbox', 'function statusLine', 'function paperLine', 'WAITING ${U.mmss', 'q-wait clock']) {
    assert.ok(!js.includes(bad), `sector.js still carries ${bad}`);
  }
  assert.ok(!/Waiting \d|elapsedText\(c\./.test(js.slice(js.indexOf('function movementCard'), js.indexOf('function renderTransfers'))), 'the movement card shows a waiting time');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'sector', 'sector.css'), 'utf8');
  assert.ok(/\.mv-id \{[^}]*font-size: 9px/.test(css), 'the id is not small');
  assert.ok(/\.mv-item \{[^}]*font-size: 18px/.test(css), 'the item is not the biggest thing on the card');
  assert.ok(/\.mv-status\[data-label="DECLINED"\]::before/.test(css) && /\.mv-status\[data-label="DELIVERED"\]::before/.test(css), 'status relies on colour alone');
  assert.ok(/\.transfers \{[^}]*overflow-y: auto/.test(css), 'the list does not scroll');
  assert.ok(/focus-visible/.test(css));
  assert.ok(!/\.inbox-block|\.ib-btns/.test(css), 'inbox styles remain');
});

// -- v16: the facilitator's command centre --------------------------------------------
//
// UNDERSTAND → DECIDE → INTERVENE. The frame tells the facilitator where to
// look; the console shows one thing per place; a hand on authoritative state
// asks why and is written down. No gameplay rule moves.

const CONTROL_INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'control', 'index.html'), 'utf8');
const CONTROL_SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'public', 'control', 'control.js'), 'utf8');
const override = require('../lib/override');

test('the live console and the session launcher are different files, and the launcher is untouched by v16', () => {
  assert.ok(/id="view-overview"/.test(CONTROL_INDEX), 'public/control is the live console');
  const launcher = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'index.html'), 'utf8');
  assert.ok(/login-view|list-view/.test(launcher), 'public/admin is the launcher');
  assert.ok(!/NEEDS ATTENTION|admin_override/.test(launcher));
  const launcherJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'admin.js'), 'utf8');
  assert.ok(!/admin_override|needs_attention/.test(launcherJs));
});

test('NEEDS ATTENTION is derived from authoritative state, in priority order, each item naming its problem and its place', () => {
  const game = running();
  let att = forControl(game).needs_attention;
  assert.deepEqual(att.filter((a) => a.priority <= 4), [], 'a fresh round has nothing urgent');
  assert.deepEqual(att.map((a) => a.kind), ['com'], 'only COM, who has reported nothing this round');
  game.setIntegrity('AGR', 27);                                  // CRITICAL
  game.setInventory('WTR', { power: 1 });                       // upkeep needs 2 power
  game.setInventory('POW', { power: 10 });
  const ids = [];
  for (let i = 0; i < 4; i += 1) ids.push(readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 }).id);
  for (let i = 0; i < 3; i += 1) game.approveTransfer(ids[i], { by: 'TRN' });   // 3/3 used, one waiting
  for (const c of ['MED', 'TRN', 'AGR']) { game.injure(c, 1); game.healWorker(game.requestHealing(c, { by: c }).healing.id, { by: 'MED' }); }
  game.injure('POW', 1); game.requestHealing('POW', { by: 'POW' });           // heals exhausted, one waiting
  game.setStatus('COM', 'DARK');
  att = forControl(game).needs_attention;
  const kinds = att.map((a) => a.kind);
  assert.deepEqual(kinds.slice(0, 5), ['dark', 'critical', 'upkeep', 'trn', 'med'], JSON.stringify(att.map((a) => a.text)));
  assert.ok(att.some((a) => a.kind === 'com'), 'COM reports are NOT UPDATED in R2');
  const byKind = Object.fromEntries(att.map((a) => [a.kind, a]));
  assert.equal(byKind.dark.text, 'COM · DARK'); assert.deepEqual(byKind.dark.target, { view: 'overview', sector: 'COM' });
  assert.equal(byKind.critical.text, 'AGR · 27% HEALTH · CRITICAL'); assert.equal(byKind.critical.sector, 'AGR');
  assert.equal(byKind.upkeep.text, 'WTR · NEXT ROUND UPKEEP SHORTFALL · MISSING 1 POWER');
  assert.equal(byKind.trn.text, 'TRN · 3/3 APPROVALS USED · 1 TRANSFER WAITING'); assert.deepEqual(byKind.trn.target, { view: 'systems', tab: 'transfers' });
  assert.ok(/^MED · 3\/3 HEALS USED · 1 INJURED WAITING$/.test(byKind.med.text)); assert.deepEqual(byKind.med.target, { view: 'systems', tab: 'workforce' });
  assert.deepEqual(byKind.com.target, { view: 'systems', tab: 'com' });
  assert.ok(att.every((a) => a.priority >= 0 && a.text && a.target), 'no generic alert');
  assert.ok(!att.some((a) => /something needs attention/i.test(a.text)));
});

test("the facilitator's sector cards carry the real inventory, readiness and each role's round capability", () => {
  const game = running();
  const f = forControl(game);
  const pow = f.sectors.POW;
  assert.deepEqual(pow.inventory, game.state.sectors.POW.inventory, 'real, authoritative stock');
  assert.equal(pow.upkeep_status, 'READY'); assert.deepEqual(pow.upkeep_short, {});
  assert.equal(pow.round_output.used, false); assert.deepEqual(pow.round_output.amount, { power: 3 });
  assert.deepEqual(f.sectors.WTR.round_output.amount, { water: 3 });
  for (const c of ['MED', 'TRN', 'AGR', 'COM']) assert.equal(f.sectors[c].round_output, null, `${c} has no output line`);
  game.setBroadcastRow('POW', { power: 9 }, { by: 'COM' });
  assert.equal(forControl(game).sectors.POW.inventory.power, 3, "COM's report never replaces real inventory");
  assert.equal(forControl(game).broadcast.rows.POW.power, 9, 'and the report is carried separately');
  game.generateOutput('POW', { by: 'POW' });
  assert.equal(forControl(game).sectors.POW.round_output.used, true);
  assert.equal(forControl(game).healing_capacity.capacity, 3); assert.equal(forControl(game).transfer_capacity.capacity, 3);
  assert.equal(forControl(game).agr.used, false); assert.equal(forControl(game).agr.offered.length, 3);
});

test('an ADMIN OVERRIDE needs a reason, reads the target before and after, and writes one audit event with actor, time, target, before, after, reason', () => {
  const game = running();
  assert.equal(override.validate({ action: 'adjust_integrity' }).reason, 'reason_required');
  assert.equal(override.validate({ action: 'adjust_integrity', reason: '   ' }).reason, 'reason_required');
  assert.equal(override.validate({ action: 'not_a_thing', reason: 'x' }).reason, 'unknown_action');
  assert.equal(override.validate({ action: 'reset_run', reason: 'x' }).reason, 'typed_confirmation_required');
  assert.equal(override.validate({ action: 'reset_run', reason: 'x', confirm_text: 'reset' }).ok, true, 'typed RESET, any case');
  assert.equal(override.validate({ action: 'adjust_integrity', reason: 'a'.repeat(200) }).reason, 'reason_too_long');
  const ok = override.validate({ action: 'adjust_integrity', reason: 'binder misprint, compensating' });
  assert.equal(ok.ok, true);

  const before = override.snapshot(game, 'adjust_integrity', { sector: 'POW' });
  assert.equal(before.integrity, 100); assert.equal(before.status_word, 'STABLE');
  game.adjustIntegrity('POW', -10);                                   // the same reducer the server dispatches
  const after = override.snapshot(game, 'adjust_integrity', { sector: 'POW' });
  assert.equal(after.integrity, 90);
  const written = [];
  const fakeLog = { write: (ev, fields) => { const e = { t: new Date().toISOString(), ev, round: game.state.round, phase: game.state.phase, ...fields }; written.push(e); return e; } };
  const rec = override.record(fakeLog, game, { action: 'adjust_integrity', payload: { sector: 'POW', delta: -10 }, reason: ok.reason, before, after });
  assert.equal(written.length, 1);
  const e = written[0];
  assert.equal(e.ev, 'admin_override'); assert.equal(e.actor, 'facilitator'); assert.ok(e.t);
  assert.equal(e.target, 'POW'); assert.equal(e.before.integrity, 100); assert.equal(e.after.integrity, 90);
  assert.equal(e.reason, 'binder misprint, compensating'); assert.equal(e.round, 'R2'); assert.equal(e.phase, 'ROUND_2');
  assert.equal(rec.target, 'POW');
  assert.ok(game.state.ticker.some((t) => t.kind === 'override' && /OVERRIDE ADJUST INTEGRITY · POW — binder misprint/.test(t.text)), 'the override is on the admin ticker');
  assert.ok(forControl(game).ticker.some((t) => t.kind === 'override'));
  assert.ok(!forSector(game, 'POW').ticker.some((t) => t.kind === 'override'), 'never on a table');
  assert.ok(!forBigscreen(game).feed.some((t) => t.kind === 'override'), 'never on the wall');
});

test('override snapshots name every target kind, and the debrief counts overrides on its timeline', () => {
  const game = running();
  game.setInventory('POW', { power: 9 });
  const t = readyTransfer(game, { from: 'POW', to: 'MED', resource: 'power', amount: 1 });
  game.fireFault('F-201', 'POW');
  game.injure('AGR', 1);
  const h = game.requestHealing('AGR', { by: 'AGR' }).healing;
  assert.equal(override.targetName(game, 'clear_fault', { sector: 'POW', fault_code: 'F-201' }), 'F-201 @ POW');
  assert.equal(override.snapshot(game, 'clear_fault', { sector: 'POW', fault_code: 'F-201' }).status, 'ACTIVE');
  assert.equal(override.snapshot(game, 'transfer_approve', { id: t.id }).status, 'PENDING_TRN_APPROVAL');
  assert.equal(override.snapshot(game, 'heal_worker', { id: h.id }).status, 'WAITING_FOR_MED');
  assert.equal(override.snapshot(game, 'reset_stamps', {}).trn_used, 0);
  assert.equal(override.snapshot(game, 'set_core_output', {}).core_output, 100);
  assert.equal(override.snapshot(game, 'agr_reroll', {}).offered.length, 3);
  assert.equal(override.snapshot(game, 'reset_run', {}).run_id, 'test-run');
  assert.equal(override.targetName(game, 'reset_run', {}), 'RUN test-run');
  assert.equal(override.snapshot(game, 'set_config', { patch: { council_clock_s: 1 } }).council_clock_s, game.cfg.council_clock_s);
  assert.equal(override.snapshot(game, 'adjust_integrity', { sector: 'XXX' }), null, 'an unknown sector is null, not a crash');

  const lines = [
    { t: '2026-09-18T03:00:00.000Z', ev: 'run_reset', run_id: 'r', round: 'R2', phase: 'ROUND_2' },
    { t: '2026-09-18T03:01:00.000Z', ev: 'admin_override', round: 'R2', phase: 'ROUND_2', actor: 'facilitator', action: 'adjust_integrity', target: 'POW', reason: 'test', before: { integrity: 100 }, after: { integrity: 90 } },
  ].map((l) => JSON.stringify(l)).join('\n');
  const d = analyse(lines, { runId: 'r' });
  assert.equal(d.rounds.R2.overrides, 1);
  assert.ok(d.timeline.some((e) => e.kind === 'override' && /OVERRIDE ADJUST INTEGRITY · POW — test/.test(e.text)));
});

test('an observation carries phase, round and time, and reaches the facilitator alone', () => {
  const game = running();
  game.log.write('observe', { sector: 'POW', tag: 'DOMINANCE', note: 'chief talks over liaison' });
  const ev = logEvents(game, 'observe')[0];
  assert.equal(ev.round, 'R2'); assert.equal(ev.phase, 'ROUND_2'); assert.ok(ev.t); assert.equal(ev.tag, 'DOMINANCE');
});

test('the console markup: four destinations, OVERVIEW first, one PAUSE, no city figure, phase and round shown, STOP CLOCK ≠ NEXT PHASE', () => {
  const html = CONTROL_INDEX; const js = CONTROL_SCRIPT;
  const primary = [...html.matchAll(/<nav class="primary"[\s\S]*?<\/nav>/g)][0][0];
  assert.deepEqual([...primary.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]), ['overview', 'events', 'systems', 'debrief']);
  assert.ok(/data-view="overview" class="on"/.test(html) && /id="view-overview"[^>]*class="view on"|class="view on" id="view-overview"/.test(html), 'OVERVIEW is not the default');
  assert.equal((html.match(/id="btn-pause"/g) || []).length, 1);
  assert.ok(!/quick-pause|data-quick="pause"/.test(html) && !/data-quick="pause"/.test(js), 'a second PAUSE remains');
  assert.ok(!/id="city-value"|>CITY<|CITY HEALTH/.test(html), 'a city figure is on the console');
  assert.ok(!/city-value|city_stability/.test(js.slice(0, js.indexOf('function renderCore'))), 'the overview reads the city score');
  assert.ok(/id="phase-name"/.test(html) && /id="round-value"/.test(html) && /id="master-clock"/.test(html));
  assert.ok(/round_number/.test(js), 'the round number is not printed');
  assert.ok(/id="btn-end-phase"[^>]*>STOP CLOCK/.test(html) && /id="btn-next-phase"/.test(html));
  assert.ok(/action: 'end' \}/.test(js) && /type: 'next_phase'/.test(js), 'stop-clock and next-phase are different intents');
  assert.ok(!/ADVANCE ROUND|set_round/.test(js), 'no invented round action');
  assert.ok(/id="btn-reset"/.test(html) && /id="more"/.test(html) && !/class="tb-right">[\s\S]*?id="btn-reset"/.test(html.split('id="more"')[0]), 'RESET is still on the top bar');
  assert.ok(/id="rs-typed"/.test(js) && /typed !== 'RESET'/.test(js) && /confirm_text/.test(js), 'RESET does not ask for the typed word');
  assert.ok(/id="progress"/.test(html) && /state\.phases/.test(js), 'no session progress from the configured phases');
});

test('the console markup: attention, observational cards, drawer, overrides, faults default ACTIVE, compact log, pad', () => {
  const html = CONTROL_INDEX; const js = CONTROL_SCRIPT;
  assert.ok(/id="attention"/.test(html) && /NO CRITICAL ISSUES/.test(js) && /needs_attention/.test(js));
  assert.ok(/a\.target\.sector\) \{ go\('overview'\); openSector\(a\.target\.sector\)/.test(js), 'an attention item does not open its sector');
  const cards = js.slice(js.indexOf('function renderSectors'), js.indexOf('// -- the sector drawer'));
  for (const bad of ['data-int=', 'data-inv=', 'data-wf=', 'data-inj=', 'data-fault=', 'data-injure=', 'data-brown=', 'data-dark=', 'data-slider', 'INT<']) {
    assert.ok(!cards.includes(bad), `the default card still carries ${bad}`);
  }
  assert.ok(/OPEN SECTOR/.test(cards) && /REAL INVENTORY/.test(cards) && /HEALTH/.test(cards) && /NEXT UPKEEP/.test(cards) && /upkeep_short/.test(cards));
  assert.ok(!/−10 INT|\+10 INT/.test(js) && /−10 HEALTH/.test(js) && /\+10 HEALTH/.test(js), 'INT abbreviations remain');
  assert.ok(/function renderDrawer/.test(js) && /CURRENT STATE/.test(js) && /COM REPORTED/.test(js) && /ACTIVE FAULTS/.test(js) && /ROUND CAPABILITY/.test(js) && /ADMIN ACTIONS/.test(js));
  assert.ok(/VIEW DEBUG DETAILS/.test(js) && /faultDebug \? `<div class="dr-debug">answer/.test(js), 'the answer key is not behind a debug toggle');
  assert.ok(/function askOverride/.test(js) && /type: 'admin_override'/.test(js) && /reason\.length < 3/.test(js), 'an override sends without a reason');
  for (const action of ['adjust_integrity', 'set_integrity', 'resource_override', 'adjust_workforce', 'recover_worker', "value: to } })", 'clear_fault', 'set_core_output', 'reset_stamps', 'reset_heals', 'transfer_approve', 'heal_worker', 'agr_reroll', 'agr_activate', 'reset_run']) {
    assert.ok(js.includes(action), `${action} is not an override path`);
  }
  assert.ok(!/send\(\{ type: 'adjust_integrity'|send\(\{ type: 'set_integrity'|send\(\{ type: 'adjust_inventory'|send\(\{ type: 'adjust_core'|send\(\{ type: 'transfer_approve'|send\(\{ type: 'heal_worker'|send\(\{ type: 'agr_reroll'|send\(\{ type: 'reset_run'/.test(js), 'a direct mutation bypasses the override wrapper');
  assert.ok(/let faultView = 'active'/.test(js) && /data-fv="active" class="on"/.test(html));
  assert.ok(/function confirmTrigger/.test(js) && /function previewPreset/.test(js) && /FIRE WAVE/.test(js));
  assert.ok(/data-quick="fault"/.test(html) && /data-quick="injure"/.test(html) && /data-quick="brownout"/.test(html) && /data-quick="announce"/.test(html) && /data-quick="alert"/.test(html) && /data-quick="council"/.test(html), 'a routine event trigger is gone');
  assert.ok(!/data-quick="core"/.test(html), 'CORE −10% is still a quick action');
  assert.ok(/state\.ticker\.slice\(0, 5\)/.test(js) && /id="btn-expand-log"/.test(html) && /data-lf="ADMIN"/.test(html));
  assert.ok(/id="obs-note"/.test(html) && /id="obs2-note"/.test(html) && /type: 'observe'/.test(js));
  assert.ok(/id="drawer"/.test(html) && /override-box/.test(html));
  const subnavs = [...html.matchAll(/<nav class="subnav" data-for="([a-z]+)">([\s\S]*?)<\/nav>/g)];
  assert.deepEqual(subnavs.map((m) => m[1]), ['events', 'systems', 'debrief']);
  assert.ok(/data-sub="overrides"/.test(html), 'no ADMIN OVERRIDES destination');
});

// -- v17.3: binder costs, exact case-balanced rewards, the two scarcity caps -------------
//
// A repair is crew + materials + the code, committed at once; a refusal
// consumes nothing. Every instance is dealt ONE exact reward when it fires —
// sized by its own case record, drawn then, shown verbatim, never rerolled —
// and the stock a reward creates is capped per fault and across the run.

const rewardsMod = require('../lib/rewards');
const V173 = require('C:/Users/faixe/Downloads/UNDERCITY_claude_precise_fault_rewards_v17_3.json');
const MATRIX = Object.entries(V173.binder_fault_matrix).flatMap(([sector, list]) => list.map((m) => ({ ...m, sector })));
const NORMAL = MATRIX.filter((m) => m.fault_id !== 'F-210');
const BALANCE = V173.fault_case_balance_model.per_fault_balance;
const POOLS = rewardsMod.POOLS;
const NO_STOCK = (a) => (POOLS.archetypes[a] ? POOLS.archetypes[a].resource_units : 0) === 0;

/** Stock the tray with exactly the binder materials, plus what is asked. */
function stock(game, code, materials, extra = {}) {
  game.setInventory(code, { power: 0, water: 0, parts: 0, med: 0, ...materials, ...extra });
}
const inventoriesOf = (game) => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(game.state.sectors).map(([c, s]) => [c, s.inventory]))));
const codeOf = (id) => loadContent().faults.faults.find((f) => f.code === id).valid_codes[0];
const liveFault = (game, sector, code) => game.state.sectors[sector].faults.find((f) => f.code === code && !f.resolved);
/** Fire a fault, stock its recipe, submit its first valid code with the binder crew. */
function repair(game, code, sector, extra = {}) {
  const def = loadContent().faults.faults.find((f) => f.code === code);
  if (!liveFault(game, sector, code)) assert.equal(game.fireFault(code, sector).ok, true, `${code} did not fire`);
  const inst = liveFault(game, sector, code);
  stock(game, sector, def.resources_required, extra);
  const res = submitCode(game, { sector, fault_code: code, code: def.valid_codes[0], workers_assigned: def.crew_required });
  return { res, inst, def };
}
/** A fresh running game whose faults are pinned to the archetypes given (they skip the band, never the caps). */
function pinned(overrides, runId = 'pinned') {
  const g = newGame({ runId }); g.setPhase('ROUND_2'); g.clock('start');
  g.patchConfig({ fault_reward_overrides: Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, { archetype: v }])) });
  return g;
}

test('v17.3 case table: every fault matches the spec on sector, title, crew, materials, severity, tier, difficulty, target, band, profile and caps — and the formula reproduces it', () => {
  const content = loadContent().faults.faults;
  const game = running();
  assert.equal(MATRIX.length, 36); assert.equal(Object.keys(POOLS.faults).length, 36); assert.equal(Object.keys(POOLS.archetypes).length, 36);
  for (const m of MATRIX) {
    const def = content.find((f) => f.code === m.fault_id);
    const bal = POOLS.faults[m.fault_id];
    const spec = BALANCE[m.fault_id];
    assert.ok(def && bal && spec, `${m.fault_id} missing`);
    assert.equal(def.sector, m.sector); assert.equal(def.name, m.title); assert.equal(def.severity, m.severity_level);
    assert.deepEqual(def.resources_required, m.materials, `${m.fault_id} materials`);
    if (m.crew === null) assert.equal(def.crew_required, 0); else assert.equal(def.crew_required, m.crew, `${m.fault_id} crew`);
    for (const k of ['severity_level', 'material_units', 'weighted_material_burden', 'minimum_crew', 'external_information_dependencies', 'difficulty_score', 'reward_target_rvu', 'allowed_reward_rvu', 'case_profile', 'max_resource_units_in_single_reward', 'resource_reward_probability_cap']) {
      assert.deepEqual(bal[k], spec[k], `${m.fault_id} ${k}`);
    }
    assert.equal(bal.reward_tier, m.reward_tier);
    assert.equal(rewardsMod.tierOf(game, m.fault_id), m.reward_tier);
    // the difficulty model, from the binder: parts and med weigh more; crew above the first; 0.75 per dependency; severity bonus
    if (m.fault_id !== 'F-210') {
      const d = rewardsMod.difficultyFor({ materials: def.resources_required, minimum_crew: def.crew_required, external_information_dependencies: spec.external_information_dependencies, severity_level: def.severity });
      assert.equal(d.difficulty_score, spec.difficulty_score, `${m.fault_id} difficulty`);
      assert.equal(d.reward_target_rvu, spec.reward_target_rvu, `${m.fault_id} target`);
      assert.deepEqual(d.allowed_reward_rvu, spec.allowed_reward_rvu, `${m.fault_id} band`);
      assert.equal(d.max_resource_units_in_single_reward, Math.min(2, Math.floor(spec.material_units * 0.5)), `${m.fault_id} refund cap`);
      assert.equal(d.max_resource_units_in_single_reward, spec.max_resource_units_in_single_reward);
    }
    // the definition the engine hands out: binder + case record, content untouched
    const fd = game.faultDefinition(m.fault_id);
    assert.equal(fd.reward_target_rvu, spec.reward_target_rvu); assert.deepEqual(fd.allowed_reward_rvu, spec.allowed_reward_rvu);
    assert.equal(fd.reward_case_profile, spec.case_profile); assert.deepEqual(fd.materials, m.materials);
    assert.equal(fd.minimum_crew, m.crew === null ? null : m.crew);
    assert.equal('reward_target_rvu' in def, false, 'the content file grew a balance field');
  }
  assert.equal(POOLS.faults['F-210'].repair_type, 'SPECIAL_VERIFICATION');
  assert.deepEqual(POOLS.material_weights, { power: 1, water: 1, parts: 1.25, med: 1.5 });
  for (const [k, a] of Object.entries(POOLS.archetypes)) {
    assert.equal(a.resource_units, V173.reward_archetypes[k].resource_units_generated, `${k} units`);
    if (V173.reward_archetypes[k].rvu !== undefined) assert.equal(a.rvu, V173.reward_archetypes[k].rvu, `${k} rvu`);
    assert.ok(['local', 'cross', 'capacity', 'resource'].includes(a.category), `${k} category`);
  }
});

test('parameterised: every normal fault refuses a short tray, short crew and a wrong code without consuming, then consumes exactly its recipe once and pays exactly the reward it showed', () => {
  for (const m of NORMAL) {
    const game = newGame({ runId: `p-${m.fault_id}` }); game.setPhase('ROUND_2'); game.clock('start');
    game.fireFault(m.fault_id, m.sector);
    const inst = liveFault(game, m.sector, m.fault_id);
    const shown = JSON.parse(JSON.stringify(inst.reward));
    assert.ok(shown.display_label && shown.reroll_allowed === false && shown.assigned_at_fault_creation === true, `${m.fault_id} no exact payload`);
    const args = (over) => ({ sector: m.sector, fault_code: m.fault_id, code: codeOf(m.fault_id), workers_assigned: m.crew, ...over });
    const [firstMat] = Object.keys(m.materials);
    stock(game, m.sector, m.materials, { [firstMat]: m.materials[firstMat] - 1 });
    let before = inventoriesOf(game);
    let r = submitCode(game, args({}));
    assert.equal(r.reason, 'insufficient_resources', `${m.fault_id}: a short tray was accepted`);
    assert.equal(r.short, undefined, 'the shortfall never reaches the console');
    assert.deepEqual(inventoriesOf(game), before, `${m.fault_id}: a refusal consumed something`);
    assert.equal(inst.wrong_code_attempts, 0, `${m.fault_id}: short materials counted as a wrong code`);
    stock(game, m.sector, m.materials);
    before = inventoriesOf(game);
    r = submitCode(game, args({ workers_assigned: m.crew - 1 }));
    assert.equal(r.reason, 'insufficient_crew', `${m.fault_id}: short crew was accepted`);
    assert.deepEqual(inventoriesOf(game), before);
    assert.equal(inst.wrong_code_attempts, 0, `${m.fault_id}: short crew counted as a wrong code`);
    r = submitCode(game, args({ code: 'P-00-000' }));
    assert.equal(r.reason, 'invalid_code');
    assert.deepEqual(inventoriesOf(game), before, `${m.fault_id}: a wrong code consumed materials`);
    assert.equal(inst.wrong_code_attempts, 1);
    assert.equal(Object.keys(game.state.rewards_claimed).length, 0, `${m.fault_id}: a refusal paid`);
    assert.deepEqual(inst.reward, JSON.parse(JSON.stringify(shown)), `${m.fault_id}: a failed attempt changed the reward`);
    const consumedBefore = game.state.repair_material_units_consumed;
    r = submitCode(game, args({}));
    assert.equal(r.accepted, true, `${m.fault_id}: ${r.reason}`);
    assert.deepEqual(r.consumed, m.materials, `${m.fault_id}: consumed ${JSON.stringify(r.consumed)}`);
    const tray = game.state.sectors[m.sector].inventory;
    const back = {};
    for (const e of shown.resource_effects) back[e.resource] = (back[e.resource] || 0) + e.amount;
    for (const k of ['power', 'water', 'parts', 'med']) assert.equal(tray[k], back[k] || 0, `${m.fault_id}: ${k} left ${tray[k]} (exact reward ${shown.display_label})`);
    assert.equal(game.state.repair_material_units_consumed, consumedBefore + Object.values(m.materials).reduce((a, b) => a + b, 0));
    assert.equal(inst.reward.display_label, shown.display_label, `${m.fault_id}: the paid reward differs from the shown one`);
    assert.equal(submitCode(game, args({})).reason, 'unknown_fault', `${m.fault_id}: resolved twice`);
  }
});

test('F-210 invents nothing: no crew, no materials, no code; any submit is refused and consumes nothing; the clear completes it and never pays stock', () => {
  const def = loadContent().faults.faults.find((f) => f.code === 'F-210');
  assert.equal(def.crew_required, 0); assert.deepEqual(def.resources_required, {}); assert.deepEqual(def.valid_codes, []); assert.equal(def.false_alarm, true);
  const game = running();
  game.fireFault('F-210', 'AGR');
  const inst = liveFault(game, 'AGR', 'F-210');
  assert.equal(inst.reward.tier, 2); assert.equal(inst.reward.rvu, 2); assert.equal(inst.reward.case_profile, 'SPECIAL_VERIFICATION');
  assert.deepEqual(inst.reward.resource_effects, []); assert.equal(inst.reward.resource_units_reserved, 0);
  assert.equal(game.state.repair_material_units_issued, 0, 'a ghost joined the budget basis');
  for (let i = 0; i < 40; i += 1) {
    const g = newGame({ runId: `ghost-${i}` }); g.setPhase('ROUND_2'); g.clock('start');
    g.fireFault('F-210', 'AGR');
    const r = liveFault(g, 'AGR', 'F-210').reward;
    assert.ok(!/SUPPLY|SALVAGE/.test(r.archetype) && NO_STOCK(r.archetype), `run ${i}: a ghost rolled ${r.archetype}`);
    assert.equal(r.rvu, 2, `run ${i}: a ghost rolled rvu ${r.rvu}`);
  }
  const el = rewardsMod.eligible(game, 'AGR', inst);
  assert.ok(el.length && el.every((c) => c.resource_units === 0 && c.rvu === 2));
  const before = inventoriesOf(game);
  const r = submitCode(game, { sector: 'AGR', fault_code: 'F-210', code: 'P-99-999', workers_assigned: 1 });
  assert.equal(r.reason, 'no_procedure'); assert.deepEqual(inventoriesOf(game), before); assert.equal(inst.wrong_code_attempts, 0);
  assert.equal(game.clearFault('AGR', 'F-210', 'COM confirmed the ghost'), true);
  const rr = inst.reward_result;
  assert.ok(rr.applied || rr.pending, 'the ghost clear neither paid nor offered');
  if (rr.applied) assert.equal(game.state.rewards_claimed[inst.id].via, 'false_alarm_clear');
  assert.equal(game.state.fault_reward_resource_units_generated, 0);
});

test('F-302, F-304 and F-404 carry no deadline; stabilisation is a timed reward effect, not one', () => {
  const game = running();
  for (const [code, sector] of [['F-302', 'WTR'], ['F-304', 'TRN'], ['F-404', 'TRN']]) {
    game.fireFault(code, sector);
    const f = liveFault(game, sector, code);
    for (const k of ['deadline', 'deadline_s', 'deadline_remaining_s', 'deadline_at', 'expired', 'integrity_penalty']) assert.equal(k in f, false, `${code} has ${k}`);
    assert.equal('deadline_s' in forSector(game, sector).sectors[sector].faults.find((x) => x.code === code), false);
  }
});

test('two submissions for the same fault cannot double-spend or double-resolve', () => {
  const game = running();
  game.fireFault('F-201', 'POW');
  const inst = liveFault(game, 'POW', 'F-201');
  stock(game, 'POW', { parts: 4, water: 2 });
  const a = submitCode(game, { sector: 'POW', fault_code: 'F-201', code: 'P-04-340', workers_assigned: 2 });
  const b = submitCode(game, { sector: 'POW', fault_code: 'F-201', code: 'P-04-340', workers_assigned: 2 });
  assert.equal(a.accepted, true); assert.equal(b.accepted, false); assert.equal(b.reason, 'unknown_fault');
  const back = {}; for (const e of inst.reward.resource_effects) back[e.resource] = (back[e.resource] || 0) + e.amount;
  assert.equal(game.state.sectors.POW.inventory.parts, 4 - 2 + (back.parts || 0));
  assert.equal(game.state.sectors.POW.inventory.water, 2 - 1 + (back.water || 0));
  assert.equal(logEvents(game, 'repair_completed').length, 1);
  assert.equal(logEvents(game, 'fault_reward_applied').length + logEvents(game, 'fault_reward_pending').length, 1);
  assert.equal(game.state.repair_material_units_consumed, 3);
});

test('the reward is dealt once at creation as an exact persisted payload: refresh, reprojection, failed attempts, a restart and the facilitator looking never reroll it; another run may differ', () => {
  const game = running();
  game.fireFault('F-201', 'POW');
  const inst = liveFault(game, 'POW', 'F-201');
  const dealt = JSON.parse(JSON.stringify(inst.reward));
  assert.ok(dealt.reward_instance_id && dealt.assigned_at && dealt.seed && dealt.display_label);
  assert.equal(dealt.tier, 3); assert.ok(dealt.rvu >= 3 && dealt.rvu <= 4, `rvu ${dealt.rvu} outside F-201's band`);
  assert.equal(dealt.reroll_allowed, false); assert.equal(dealt.assigned_at_fault_creation, true);
  const ev = logEvents(game, 'fault_reward_assigned')[0];
  for (const k of ['run_id', 'instance', 'fault', 'sector', 'difficulty_score', 'reward_target_rvu', 'allowed_reward_rvu', 'eligible_after_filtering', 'selected', 'exact_reward_payload', 'resource_units_reserved', 'assignment_round']) assert.ok(k in ev, `assignment log lacks ${k}`);
  assert.equal(ev.difficulty_score, 5.25); assert.equal(ev.reward_target_rvu, 4); assert.deepEqual(ev.allowed_reward_rvu, [3, 4]);
  for (let i = 0; i < 5; i += 1) {
    const view = forSector(game, 'POW').sectors.POW.faults[0].reward;
    assert.equal(view.text, dealt.display_label, 'a reprojection changed the words');
    assert.equal(view.claimed, false);
    assert.ok(!/rvu|resource_units|seed/.test(JSON.stringify(view)), 'balance internals leaked to a player');
    forControl(game);   // the facilitator looking
  }
  submitCode(game, { sector: 'POW', fault_code: 'F-201', code: 'P-00-000', workers_assigned: 2 });
  submitCode(game, { sector: 'POW', fault_code: 'F-201', code: 'P-04-340', workers_assigned: 1 });
  game.setInventory('POW', { parts: 0 });
  submitCode(game, { sector: 'POW', fault_code: 'F-201', code: 'P-04-340', workers_assigned: 2 });
  game.setPhase('ROUND_3'); game.setPhase('ROUND_2');
  assert.deepEqual(inst.reward, dealt, 'a failed attempt or a phase change rerolled');
  const again = newGame({ runId: 'reward-restore' });
  again.restore(JSON.parse(JSON.stringify(game.serialise())));
  assert.deepEqual(again.state.sectors.POW.faults[0].reward, dealt, 'a restart rerolled');
  assert.equal(again.state.fault_reward_resource_units_reserved, game.state.fault_reward_resource_units_reserved);
  const seen = new Set();
  for (let i = 0; i < 30; i += 1) { const g = newGame({ runId: `r-${i}` }); g.setPhase('ROUND_2'); g.clock('start'); g.fireFault('F-201', 'POW'); seen.add(liveFault(g, 'POW', 'F-201').reward.archetype); }
  assert.ok(seen.size >= 3, `F-201 always rolls the same: ${[...seen]}`);
});

test('a resource reward is exact from the moment it is issued: the type is drawn at creation, shown verbatim, reserved, and paid as shown after the materials are gone', () => {
  const game = pinned({ 'F-101': 'SUPPLY_FIND_1' });
  game.fireFault('F-101', 'POW');                                   // 2 material units → cap 1; issued 2 → max 1
  const inst = liveFault(game, 'POW', 'F-101');
  const r = inst.reward;
  assert.equal(r.archetype, 'SUPPLY_FIND_1');
  assert.equal(r.resource_effects.length, 1); assert.ok(rewardsMod.RESOURCES.includes(r.resource_effects[0].resource));
  assert.equal(r.resource_effects[0].amount, 1); assert.equal(r.resource_units_reserved, 1);
  assert.equal(r.display_label, `+1 ${rewardsMod.NAMES[r.resource_effects[0].resource]}`);
  assert.deepEqual(rewardsMod.budget(game), { issued: 2, consumed: 0, reserved: 1, generated: 0, max: 1, remaining: 0 });
  const frame = JSON.stringify(forSector(game, 'POW'));
  assert.ok(!/SCARCE|RANDOM|MYSTERY/.test(frame), 'a vague label survived');
  assert.ok(frame.includes(r.display_label));
  stock(game, 'POW', { parts: 1, water: 1 });
  const res = submitCode(game, { sector: 'POW', fault_code: 'F-101', code: codeOf('F-101'), workers_assigned: 1 });
  assert.equal(res.accepted, true); assert.equal(res.reward.applied, true);
  assert.deepEqual(res.reward.resources, { [r.resource_effects[0].resource]: 1 }, 'a different resource was paid');
  const tray = game.state.sectors.POW.inventory;
  assert.equal(tray[r.resource_effects[0].resource], 1, 'the cache went somewhere else');
  assert.equal(Object.values(tray).reduce((a, b) => a + b, 0), 1, 'the repair was funded by its own reward');
  assert.deepEqual(rewardsMod.budget(game), { issued: 2, consumed: 2, reserved: 0, generated: 1, max: 1, remaining: 0 });
  const applied = logEvents(game, 'fault_reward_applied')[0];
  assert.equal(applied.exact_reward_applied, r.display_label); assert.equal(applied.reward_instance_id, r.reward_instance_id);
  assert.equal(game.applyFaultReward('POW', inst, { via: 'resolve' }).reason, 'duplicate');
  assert.equal(logEvents(game, 'fault_reward_applied').length, 1);
  assert.equal(inst.reward_applied, true);
  assert.equal(forSector(game, 'POW').sectors.POW.recently_resolved[0].reward.result_text.includes('+1'), true);
});

test('facilitator force-resolve pays nothing by default and releases the reservation and the issued units; the explicit override pays as shown and is logged', () => {
  const game = pinned({ 'F-101': 'SUPPLY_FIND_1' });
  game.fireFault('F-101', 'POW');
  const inst = liveFault(game, 'POW', 'F-101');
  assert.deepEqual(rewardsMod.budget(game), { issued: 2, consumed: 0, reserved: 1, generated: 0, max: 1, remaining: 0 });
  assert.equal(game.clearFault('POW', 'F-101', 'facilitator cleared'), true);
  assert.equal(game.state.rewards_claimed[inst.id], undefined);
  assert.equal(logEvents(game, 'fault_reward_force_resolve_skipped').length, 1);
  assert.equal(logEvents(game, 'fault_reward_reservation_released').length, 1);
  assert.equal(logEvents(game, 'fault_material_issue_cancelled').length, 1);
  assert.deepEqual(rewardsMod.budget(game), { issued: 0, consumed: 0, reserved: 0, generated: 0, max: 1, remaining: 1 });
  const g2 = pinned({ 'F-101': 'SUPPLY_FIND_1' }, 'pinned-2');
  g2.fireFault('F-101', 'POW');
  const inst2 = liveFault(g2, 'POW', 'F-101');
  assert.equal(g2.clearFault('POW', 'F-101', 'facilitator cleared', { withReward: true }), true);
  assert.ok(g2.state.rewards_claimed[inst2.id], 'the explicit override did not pay');
  assert.equal(logEvents(g2, 'fault_reward_admin_override').length, 1);
  assert.equal(logEvents(g2, 'fault_reward_applied')[0].admin_override, true);
  assert.deepEqual(rewardsMod.budget(g2), { issued: 2, consumed: 0, reserved: 0, generated: 1, max: 1, remaining: 0 });
  // a refund on a force-resolve has nothing to refund
  const g3 = pinned({ 'F-101': 'SALVAGE_1' }, 'pinned-3');
  g3.fireFault('F-101', 'POW');
  const inst3 = liveFault(g3, 'POW', 'F-101');
  assert.equal(inst3.reward.resource_effects[0].source, 'SALVAGE');
  assert.ok(['parts', 'water'].includes(inst3.reward.resource_effects[0].resource), 'a refund named a material the recipe lacks');
  const before = { ...g3.state.sectors.POW.inventory };
  g3.clearFault('POW', 'F-101', 'x', { withReward: true });
  assert.deepEqual(g3.state.sectors.POW.inventory, before, 'a refund paid without consumption');
  assert.deepEqual(rewardsMod.budget(g3), { issued: 2, consumed: 0, reserved: 0, generated: 0, max: 1, remaining: 1 });
});

test('health rewards use points, cap at 100 and never revive DARK; TRN and MED bonuses widen the allowance for the round and do nothing by themselves', () => {
  const game = pinned({ 'F-001': 'LOCAL_RECOVERY_20', 'F-002': 'TRN_REINFORCEMENT', 'F-003': 'MED_REINFORCEMENT' });
  game.setIntegrity('POW', 95);
  repair(game, 'F-001', 'POW');
  assert.equal(game.state.sectors.POW.integrity, 100, 'went past 100');
  game.setIntegrity('AGR', 0);
  const dark = game.state.sectors.AGR;
  assert.equal(dark.status, 'DARK');
  assert.equal(rewardsMod.healSector(game, dark, 20), 0, 'a DARK sector was revived'); assert.equal(dark.integrity, 0);
  game.setInventory('WTR', { parts: 1, power: 9 });
  const cap = game.trnCapacity();
  const pending = readyTransfer(game, { from: 'WTR', to: 'MED', resource: 'power', amount: 1 });
  repair(game, 'F-002', 'WTR');
  assert.equal(game.trnCapacity(), cap + 1, 'TRN did not gain an approval');
  assert.equal(game.findTransfer(pending.id).status, 'PENDING_TRN_APPROVAL', 'the reward approved a transfer');
  assert.equal(game.stampsUsed(), 0);
  game.injure('POW', 1);
  const h = game.requestHealing('POW', { by: 'POW' }).healing;
  const medCap = game.medCapacity();
  repair(game, 'F-003', 'MED');
  assert.equal(game.medCapacity(), medCap + 1, 'MED did not gain a heal');
  assert.equal(game.findHealing(h.id).status, 'WAITING_FOR_MED', 'the reward healed somebody');
  assert.equal(game.state.sectors.POW.workforce.injured, 1);
  game.state.round_clock.started = false;
  game.setRound('R3');
  assert.equal(game.trnCapacity(), cap); assert.equal(game.medCapacity(), medCap);
});

test('a 3-sector session never rolls Medical rewards or targets an inactive sector; Transport bonuses, health, stabilisation, caches and salvage stay possible', () => {
  const g = newGame({ runId: 'three' }); g.setPhase('ROUND_2'); g.clock('start');
  g.patchConfig({ active_sectors: ['POW', 'WTR', 'TRN'] });
  assert.deepEqual(rewardsMod.activeSectors(g), ['POW', 'WTR', 'TRN']);
  g.fireFault('F-101', 'POW'); g.fireFault('F-201', 'POW'); g.fireFault('F-301', 'POW');
  for (const code of ['F-101', 'F-201', 'F-301']) {
    const f = liveFault(g, 'POW', code);
    const el = rewardsMod.eligible(g, 'POW', f);
    assert.ok(el.length, `${code}: nothing eligible`);
    assert.ok(!el.some((e) => /MED_/.test(e.reward)), `${code} offers MED: ${el.map((e) => e.reward)}`);
    if (code === 'F-101') assert.equal(el.excluded.MED_REINFORCEMENT, 'med_inactive');   // in band, out of the session
  }
  const el301 = rewardsMod.eligible(g, 'POW', liveFault(g, 'POW', 'F-301'));
  assert.ok(el301.some((e) => /TRN_/.test(e.reward)), 'no TRN bonus for a critical fault');
  assert.ok(el301.some((e) => /RECOVERY|LOWEST|CITY/.test(e.reward)), 'no health reward');
  const el101 = rewardsMod.eligible(g, 'POW', liveFault(g, 'POW', 'F-101'));
  assert.ok(el101.some((e) => e.reward === 'FAULT_STABILISATION'), 'no stabilisation with other faults live');
  assert.equal(el301.excluded.FAULT_STABILISATION, 'outside_rvu_band', 'a critical fault rolled a tier-2 effect');
  const opts = rewardsMod.choiceOptions(g, 'POW', { id: 'x', reward: {} }, { archetype: 'MUTUAL_AID_5', choose: 'sector' });
  assert.deepEqual(opts.map((o) => o.sector).sort(), ['TRN', 'WTR']);
  const six = running();
  six.injure('POW', 1); six.requestHealing('POW', { by: 'POW' });
  six.fireFault('F-101', 'POW');
  const el6 = rewardsMod.eligible(six, 'POW', liveFault(six, 'POW', 'F-101'));
  assert.ok(el6.some((e) => e.reward === 'MED_REINFORCEMENT' && e.weight > 1), 'six sectors with an injury: MED is eligible and wanted');
});

test('per-fault limits: no reward above the target or outside the band; one-material faults never roll stock; F-201 at most 1 unit; F-301 at most 2 units and never 3', () => {
  const game = running();
  for (const m of MATRIX) {
    const g = newGame({ runId: `band-${m.fault_id}` }); g.setPhase('ROUND_2'); g.clock('start');
    g.fireFault(m.fault_id, m.sector);
    const f = liveFault(g, m.sector, m.fault_id);
    const bal = POOLS.faults[m.fault_id];
    const el = rewardsMod.eligible(g, m.sector, f);
    assert.ok(el.every((e) => e.rvu >= bal.allowed_reward_rvu[0] && e.rvu <= bal.allowed_reward_rvu[1] && e.rvu <= bal.reward_target_rvu), `${m.fault_id}: eligible outside the band`);
    assert.ok(el.every((e) => e.resource_units <= bal.max_resource_units_in_single_reward), `${m.fault_id}: stock over the per-fault cap`);
    assert.ok(f.reward.rvu <= bal.reward_target_rvu && f.reward.rvu >= bal.allowed_reward_rvu[0], `${m.fault_id}: dealt rvu ${f.reward.rvu}`);
    assert.ok(f.reward.resource_units_reserved <= bal.max_resource_units_in_single_reward, `${m.fault_id}: dealt ${f.reward.resource_units_reserved} units`);
    if (bal.material_units <= 1) assert.ok(el.every((e) => e.resource_units === 0), `${m.fault_id}: a one-material fault can roll stock`);
  }
  for (let i = 0; i < 40; i += 1) {
    const g = newGame({ runId: `one-${i}` }); g.setPhase('ROUND_2'); g.clock('start');
    g.fireFault('F-001', 'POW');
    const r = liveFault(g, 'POW', 'F-001').reward;
    assert.equal(r.rvu, 1, `F-001 rolled rvu ${r.rvu}`); assert.equal(r.resource_units_reserved, 0, `F-001 rolled stock: ${r.archetype}`);
    assert.ok(!/SUPPLY|SALVAGE/.test(r.archetype));
  }
  // F-301 costs 5 units: up to 2 back, never 3 — once the basis allows it
  game.patchConfig({ fault_reward_overrides: { 'F-201': { archetype: 'LOCAL_RECOVERY_5' }, 'F-207': { archetype: 'LOCAL_RECOVERY_5' }, 'F-301': { archetype: 'LOCAL_RECOVERY_20' } } });
  game.fireFault('F-201', 'POW'); game.fireFault('F-207', 'TRN'); game.fireFault('F-301', 'POW');   // issued 3 + 3 + 5 = 11 → max 3, nothing reserved
  assert.equal(rewardsMod.budget(game).max, 3);
  const el = rewardsMod.eligible(game, 'POW', liveFault(game, 'POW', 'F-301'));
  assert.ok(el.some((e) => e.resource_units === 2), `F-301 cannot roll a 2-unit reward: ${el.map((e) => e.reward)}`);
  assert.ok(el.every((e) => e.resource_units <= 2));
  assert.equal(el.excluded.MAJOR_SUPPLY_CACHE_3_PLUS_HEALTH, 'per_fault_resource_cap');
  const g201 = running(); g201.fireFault('F-201', 'POW');
  const e201 = rewardsMod.eligible(g201, 'POW', liveFault(g201, 'POW', 'F-201'));
  assert.ok(e201.every((e) => e.resource_units <= 1)); assert.equal(e201.excluded.SUPPLY_CACHE_2_PLUS_HEALTH, 'per_fault_resource_cap');
});

test('reward strength follows the case, not the phase: targets differ within a round, the 70/30 level split holds, and a coordinated profile favours the wider city over stock', () => {
  assert.equal(POOLS.faults['F-001'].reward_target_rvu, 1); assert.equal(POOLS.faults['F-102'].reward_target_rvu, 2);   // both Round-1 faults
  assert.equal(POOLS.faults['F-212'].reward_target_rvu, 2); assert.equal(POOLS.faults['F-201'].reward_target_rvu, 4);   // both Round-2 faults
  const counts = { rvu: {}, cat: {} };
  const N = 300;
  for (let i = 0; i < N; i += 1) {
    const g = newGame({ runId: `heavy-${i}` }); g.setPhase('ROUND_2'); g.clock('start');
    g.fireFault('F-201', 'POW');
    const r = liveFault(g, 'POW', 'F-201').reward;
    counts.rvu[r.rvu] = (counts.rvu[r.rvu] || 0) + 1;
    const cat = POOLS.archetypes[r.archetype].category;
    counts.cat[cat] = (counts.cat[cat] || 0) + 1;
  }
  assert.deepEqual(Object.keys(counts.rvu).sort(), ['3', '4'], JSON.stringify(counts.rvu));
  const full = counts.rvu[4] / N;
  assert.ok(full > 0.55 && full < 0.85, `full-target share ${full}`);
  const resource = (counts.cat.resource || 0) / N;
  assert.ok(resource <= 0.3, `resource share ${resource} (cap 0.3)`);
  assert.ok((counts.cat.cross || 0) > (counts.cat.local || 0), `cross ${counts.cat.cross} vs local ${counts.cat.local}`);
  for (let i = 0; i < 60; i += 1) {
    const g = newGame({ runId: `basic-${i}` }); g.setPhase('ROUND_2'); g.clock('start');
    g.fireFault('F-102', 'POW');
    const r = liveFault(g, 'POW', 'F-102').reward;
    assert.equal(r.rvu, 2); assert.ok(NO_STOCK(r.archetype));
  }
});

test('the global cap: units are reserved at issue against 35% of the issued material, released on a no-reward clear, converted once on success, and an over-budget stock reward is excluded for a non-stock one', () => {
  const game = pinned({ 'F-101': 'SUPPLY_FIND_1', 'F-104': 'SUPPLY_FIND_1', 'F-105': 'SUPPLY_FIND_1' });
  assert.deepEqual(rewardsMod.budget(game), { issued: 0, consumed: 0, reserved: 0, generated: 0, max: 1, remaining: 1 });
  game.fireFault('F-101', 'POW');                                     // issued 2 → max 1, reserved 1
  assert.equal(liveFault(game, 'POW', 'F-101').reward.archetype, 'SUPPLY_FIND_1');
  assert.deepEqual(rewardsMod.budget(game), { issued: 2, consumed: 0, reserved: 1, generated: 0, max: 1, remaining: 0 });
  game.fireFault('F-104', 'WTR');                                     // issued 4 → max 1, nothing left: the pin is refused
  const f104 = liveFault(game, 'WTR', 'F-104');
  assert.notEqual(f104.reward.archetype, 'SUPPLY_FIND_1', 'stock was dealt over budget');
  assert.equal(f104.reward.resource_units_reserved, 0); assert.ok(NO_STOCK(f104.reward.archetype));
  assert.equal(logEvents(game, 'fault_reward_override_rejected')[0].reason, 'global_resource_budget');
  const el = rewardsMod.eligible(game, 'WTR', f104);
  assert.ok(el.every((e) => e.resource_units === 0), 'a stock reward is still eligible over budget');
  assert.equal(el.excluded.SALVAGE_1_PLUS_HEALTH_5, 'global_resource_budget');
  // clearing F-101 without a reward releases its unit and its basis
  game.clearFault('POW', 'F-101', 'cancelled');
  assert.deepEqual(rewardsMod.budget(game), { issued: 2, consumed: 0, reserved: 0, generated: 0, max: 1, remaining: 1 });
  // a new instance is a new reward and a new reservation
  game.fireFault('F-101', 'POW');
  const second = liveFault(game, 'POW', 'F-101');
  assert.equal(second.reward.archetype, 'SUPPLY_FIND_1'); assert.equal(second.reward.resource_units_reserved, 1);
  assert.deepEqual(rewardsMod.budget(game), { issued: 4, consumed: 0, reserved: 1, generated: 0, max: 1, remaining: 0 });
  const { res } = repair(game, 'F-101', 'POW');
  assert.equal(res.accepted, true);
  assert.deepEqual(rewardsMod.budget(game), { issued: 4, consumed: 2, reserved: 0, generated: 1, max: 1, remaining: 0 });
  // upkeep, transfers and facilitator stock edits never widen it
  game.adjustInventory('POW', { parts: 5 }); game.cycleControl('process');
  assert.equal(rewardsMod.budget(game).max, 1);
  // more issued material, more allowance
  game.fireFault('F-105', 'MED');                                     // issued 6 → max 2, remaining 1
  assert.equal(liveFault(game, 'MED', 'F-105').reward.archetype, 'SUPPLY_FIND_1');
  assert.deepEqual(rewardsMod.budget(game), { issued: 6, consumed: 2, reserved: 1, generated: 1, max: 2, remaining: 0 });
});

test('the scarcity draw reads real active-sector stock, caps any resource near 45%, prefers distinct types, and ignores COM\'s board and pending transfers', () => {
  const game = running();
  game.setBroadcastRow('POW', { power: 0, water: 0, med: 0, parts: 0 }, { by: 'COM' });
  for (const c of Object.keys(game.state.sectors)) game.setInventory(c, { power: 9, water: 9, parts: 0, med: 9 });
  const w = rewardsMod.scarcityWeights(game);
  assert.ok(Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-6);
  assert.ok(w.parts > w.power && w.parts > w.water && w.parts > w.med, 'the scarce resource is not the likeliest');
  assert.ok(w.parts <= 0.45 + 1e-6, `parts at ${w.parts}`);
  assert.ok(w.power > 0.1, 'a plentiful resource still has a real chance');
  let partsDraws = 0;
  for (let i = 0; i < 400; i += 1) { const [r] = rewardsMod.drawResources(game, 1, rewardsMod.rng(i)); if (r === 'parts') partsDraws += 1; }
  assert.ok(partsDraws > 120 && partsDraws < 220, `parts drawn ${partsDraws}/400`);
  assert.equal(new Set(rewardsMod.drawResources(game, 3, rewardsMod.rng(7))).size, 3, 'a 3-cache repeated a type');
  readyTransfer(game, { from: 'WTR', to: 'POW', resource: 'power', amount: 5 });   // pending, not delivered
  assert.ok(rewardsMod.scarcityWeights(game).parts > 0.4, 'a pending transfer counted as stock');
  game.patchConfig({ active_sectors: ['POW', 'WTR', 'TRN'] });
  game.setInventory('MED', { parts: 99 });
  assert.ok(rewardsMod.scarcityWeights(game).parts > rewardsMod.scarcityWeights(game).power, 'an inactive sector\'s stock counted');
  // a refund is named from the recipe, scarcest first among distinct types
  game.fireFault('F-201', 'POW');
  const drawn = rewardsMod.drawSalvage(game, liveFault(game, 'POW', 'F-201'), 2, rewardsMod.rng(3));
  assert.deepEqual([...drawn].sort(), ['parts', 'water']);
});

test('stabilisation: 90 s halves another fault\'s decay, 60 s pauses it, both in game time; it ends at the round change or when the target resolves, and never resolves or rerolls the target', () => {
  const game = pinned({ 'F-001': 'FAULT_STABILISATION', 'F-002': 'EMERGENCY_STABILISATION', 'F-004': 'FAULT_STABILISATION' });
  game.fireFault('F-201', 'POW');                                     // decays 1.5/min
  const target = liveFault(game, 'POW', 'F-201');
  const targetReward = JSON.parse(JSON.stringify(target.reward));
  const { res, inst } = repair(game, 'F-001', 'POW');
  assert.equal(res.reward.pending, true, 'the choice was not offered');
  assert.deepEqual(res.reward.options.map((o) => o.id), [target.id]);
  assert.equal(inst.reward.display_label, 'CHOOSE ANOTHER ACTIVE FAULT: HALVE ITS DECAY FOR 90 S');
  assert.equal(forSector(game, 'POW').sectors.POW.reward_choices.length, 1, 'the screen was not asked');
  const chosen = game.chooseRewardTarget('POW', inst.id, { fault: target.id }, { by: 'POW' });
  assert.equal(chosen.ok, true);
  assert.equal(game.decayMultiplier(target), 0.5);
  let before = game.state.sectors.POW.integrity;
  game.tick(60000);
  assert.ok(Math.abs((before - game.state.sectors.POW.integrity) - 0.75) < 0.01, `bled ${before - game.state.sectors.POW.integrity} in a minute`);
  game.tick(31000);                                                   // 91 s: the effect has ended
  assert.equal(game.decayMultiplier(target), 1, 'the modifier outlived its 90 s');
  assert.equal(target.resolved, false); assert.deepEqual(target.reward, targetReward);
  assert.equal(logEvents(game, 'effect_ended').some((e) => e.kind === 'fault_stabilised'), true);
  // a pause
  repair(game, 'F-002', 'WTR');
  game.chooseRewardTarget('WTR', liveFault(game, 'WTR', 'F-002') ? null : game.state.sectors.WTR.faults.find((f) => f.code === 'F-002').id, { fault: target.id }, { by: 'WTR' });
  assert.equal(game.decayMultiplier(target), 0);
  before = game.state.sectors.POW.integrity; game.tick(30000);
  assert.equal(game.state.sectors.POW.integrity, before, 'a paused fault still bled');
  game.tick(31000);
  assert.equal(game.decayMultiplier(target), 1, 'the pause outlived its 60 s');
  // the round change ends a running one; resolving the target ends it too
  repair(game, 'F-004', 'TRN');
  game.chooseRewardTarget('TRN', game.state.sectors.TRN.faults.find((f) => f.code === 'F-004').id, { fault: target.id }, { by: 'TRN' });
  assert.equal(game.decayMultiplier(target), 0.5);
  game.state.round_clock.started = false;
  game.setRound('R3');
  assert.equal(game.decayMultiplier(target), 1, 'the modifier outlived the round');
  assert.equal(target.resolved, false);
  game.fireFault('F-004', 'TRN');
  repair(game, 'F-004', 'TRN');
  game.chooseRewardTarget('TRN', game.state.sectors.TRN.faults.filter((f) => f.code === 'F-004').pop().id, { fault: target.id }, { by: 'TRN' });
  assert.equal(game.state.effects.filter((e) => e.kind === 'fault_stabilised' && e.target === target.id).length, 1);
  stock(game, 'POW', { parts: 2, water: 1 });
  assert.equal(submitCode(game, { sector: 'POW', fault_code: 'F-201', code: 'P-04-340', workers_assigned: 2 }).accepted, true);
  assert.equal(game.state.effects.filter((e) => e.kind === 'fault_stabilised' && e.target === target.id).length, 0, 'the effect outlived its target');
  for (const f of game.state.sectors.POW.faults) for (const k of ['deadline_s', 'deadline_remaining_s', 'expired']) assert.equal(k in f, false);
});

test('a choosing reward keeps its amount and only takes the target after success: another table cannot pick, an invalid pick is refused, an unmade choice defaults at the round change', () => {
  const game = pinned({ 'F-001': 'MUTUAL_AID_5', 'F-002': 'SHARED_RECOVERY_5_5' });
  game.setIntegrity('AGR', 40); game.setIntegrity('MED', 80);
  const { res, inst } = repair(game, 'F-001', 'POW');
  assert.equal(res.reward.pending, true);
  assert.equal(inst.reward.display_label, 'CHOOSE ANOTHER ACTIVE SECTOR: +5 HEALTH');
  assert.equal(game.chooseRewardTarget('POW', inst.id, { sector: 'POW' }, { by: 'POW' }).reason, 'reward_invalid_target', 'chose itself');
  assert.equal(game.chooseRewardTarget('WTR', inst.id, { sector: 'MED' }, { by: 'WTR' }).reason, 'unknown_fault', 'another table chose');
  const ok = game.chooseRewardTarget('POW', inst.id, { sector: 'MED' }, { by: 'POW' });
  assert.equal(ok.ok, true); assert.equal(game.state.sectors.MED.integrity, 85);
  assert.equal(game.chooseRewardTarget('POW', inst.id, { sector: 'MED' }, { by: 'POW' }).reason, 'no_choice_pending', 'chose twice');
  assert.equal(logEvents(game, 'fault_reward_applied').length, 1);
  repair(game, 'F-002', 'WTR');
  const wtrBefore = game.state.sectors.WTR.integrity;
  game.state.round_clock.started = false;
  game.setRound('R3');
  assert.equal(logEvents(game, 'fault_reward_default_target')[0].target.sector, 'AGR');
  assert.equal(game.state.sectors.AGR.integrity, 45);
  assert.equal(game.state.sectors.WTR.integrity, Math.min(100, wtrBefore + 5), 'the owner half was paid too');
});

test("rewards never touch COM's board, and stock a reward creates still needs Transport to move", () => {
  const game = pinned({ 'F-101': 'SUPPLY_FIND_1' });
  game.setBroadcastRow('POW', { power: 1, water: 1, med: 1, parts: 1 }, { by: 'COM' });
  const { res, inst } = repair(game, 'F-101', 'POW');
  assert.equal(res.accepted, true);
  assert.deepEqual(forBigscreen(game).broadcast.rows.POW, { ...forBigscreen(game).broadcast.rows.POW, power: 1, water: 1, med: 1, parts: 1 });
  const res0 = inst.reward.resource_effects[0].resource;
  const t = game.createTransfer({ from: 'POW', to: 'MED', resource: res0, amount: 1, by: 'POW' });
  assert.equal(t.transfer.status, 'PENDING_TRN_APPROVAL');
  assert.equal(game.approveTransfer(t.transfer.id, { by: 'POW' }).reason, 'approval_trn_only');
});

test('the console: readiness without the recipe, the exact reward on the card, SUBMIT REPAIR, REWARD CLAIMED after success, the refusal words, training mode without changing the rule', () => {
  const html = SECTOR_INDEX; const js = SECTOR_SCRIPT;
  assert.ok(/REPAIR READINESS/.test(html) && /id="rd-materials"/.test(html) && /id="rd-workers"/.test(html) && /id="workers-select"/.test(html) && /id="code-input"/.test(html));
  assert.ok(/CHECK YOUR BINDER FOR REPAIR REQUIREMENTS/.test(html));
  assert.ok(/id="submit-btn"[^>]*>SUBMIT REPAIR</.test(html));
  assert.ok(/'✓ READY' : '⚠ NOT READY'/.test(js) && /'✓ ASSIGNED'/.test(js));
  assert.ok(/REWARD CLAIMED/.test(js), 'no REWARD CLAIMED after success');
  for (const word of ['RESOLUTION REJECTED', 'INSUFFICIENT CREW', 'MATERIALS NOT READY', 'WORKER ASSIGNMENT INVALID', 'FAULT NO LONGER ACTIVE']) assert.ok(js.includes(word), `console lacks "${word}"`);
  assert.ok(/wrong_code_attempts/.test(js), 'the card does not show the wrong-code count');
  assert.ok(!/SCARCE RESOURCE|RANDOM RESOURCE|MYSTERY REWARD/.test(js) && !/SCARCE RESOURCE/.test(JSON.stringify(POOLS)), 'a vague reward label remains');
  const game = pinned({ 'F-201': 'SUPPLY_CACHE_1_PLUS_HEALTH' });
  game.fireFault('F-201', 'POW');
  let f = forSector(game, 'POW').sectors.POW.faults[0];
  assert.equal(f.materials_ready, true); assert.equal(f.wrong_code_attempts, 0);
  assert.ok(/^\+1 (POWER|WATER|PARTS|MEDICAL) · \+5 SECTOR HEALTH$/.test(f.reward.text), f.reward.text);
  assert.equal(f.resources_required, undefined, 'the recipe is on the table'); assert.equal(f.crew_required, undefined); assert.equal(f.requirements, undefined);
  game.setInventory('POW', { parts: 1 });
  f = forSector(game, 'POW').sectors.POW.faults[0];
  assert.equal(f.materials_ready, false);
  assert.ok(!JSON.stringify(forSector(game, 'POW')).includes('"resources_required"'), 'the recipe leaked');
  game.patchConfig({ training_mode: true });
  f = forSector(game, 'POW').sectors.POW.faults[0];
  assert.deepEqual(f.requirements, { crew: 2, materials: { parts: 2, water: 1 } });
  assert.equal(submitCode(game, { sector: 'POW', fault_code: 'F-201', code: 'P-04-340', workers_assigned: 2 }).reason, 'insufficient_resources', 'training mode changed the rule');
  const c = forControl(game).sectors.POW.faults[0];
  assert.equal(c.crew_required, 2); assert.equal(c.reward_target_rvu, 4); assert.equal(c.reward_profile, 'HEAVY_COORDINATED'); assert.equal(c.reward_reserved, 1);
  assert.deepEqual(Object.keys(forControl(game).reward_budget).sort(), ['consumed', 'generated', 'issued', 'max', 'remaining', 'reserved']);
});

test('the debrief folds repairs, assignments and rewards: materials consumed, profiles, RVU, units generated and released', () => {
  const game = pinned({ 'F-001': 'LOCAL_RECOVERY_5', 'F-101': 'SUPPLY_FIND_1' });
  repair(game, 'F-001', 'POW');
  game.fireFault('F-101', 'POW');
  game.clearFault('POW', 'F-101', 'cancelled');
  const d = analyse(game.log.readAll(), { runId: 'test-run' }).rounds.R2;
  assert.equal(d.repairs.count, 1); assert.equal(d.repairs.material_units, 1); assert.deepEqual(d.repairs.materials, { parts: 1 });
  assert.equal(d.rewards.applied, 1); assert.equal(d.rewards.assigned, 2); assert.equal(d.rewards.archetypes.LOCAL_RECOVERY_5, 1);
  assert.equal(d.rewards.profiles.BASIC_LOCAL, 1); assert.equal(d.rewards.profiles.STANDARD_LOCAL, 1);
  assert.equal(d.rewards.resource_units_generated, 0); assert.equal(d.rewards.released_units, 1);
  assert.equal(d.rewards.assignments.length, 2); assert.equal(d.rewards.assignments[0].difficulty, 1.25);
  const ev = logEvents(game, 'repair_completed')[0];
  for (const k of ['instance', 'fault', 'sector', 'resolved_round', 'crew_assigned', 'materials_consumed', 'resolution_success', 'reward_archetype', 'reward_instance_id', 'exact_reward', 'reward_result', 'reward_targets', 'resource_reward_units_generated']) assert.ok(k in ev, `repair log lacks ${k}`);
  const ap = logEvents(game, 'fault_reward_applied')[0];
  for (const k of ['run_id', 'instance', 'reward_instance_id', 'exact_reward_applied', 'targets', 'resource_units_generated', 'applied_round', 'admin_override']) assert.ok(k in ap, `application log lacks ${k}`);
});

// -- v18: the tray and the round timer by hand -------------------------------------------
//
// RESOURCE CONTROL sets a sector's REAL tray to exact values, atomically,
// with a reason, and nothing else moves. The GAME TIMER drives the one round
// clock every screen shows; 00:00 still moves nothing.

const everythingBut = (game, ...skip) => {
  const st = JSON.parse(JSON.stringify(game.serialise()));
  delete st.saved_at;   // a millisecond stamp, not state
  for (const k of skip) delete st[k];
  if (st.state) for (const k of skip) delete st.state[k];
  return st;
};

test('v18 resource control: an exact override sets the real tray atomically, never below zero, refusing fractions, words and unknown resources', () => {
  const game = running();
  const pow = game.state.sectors.POW;
  const start = { ...pow.inventory };
  const r = game.overrideInventory('POW', { power: start.power + 1 }, { reason: 'playtest correction' });
  assert.equal(r.ok, true); assert.deepEqual(r.delta, { power: 1 });
  assert.equal(pow.inventory.power, start.power + 1);
  assert.equal(forSector(game, 'POW').sectors.POW.inventory.power, start.power + 1, 'the sector console did not see it');
  assert.equal(forControl(game).sectors.POW.inventory.power, start.power + 1, 'the admin did not see it');
  assert.equal('inventory' in (forBigscreen(game).sectors.POW || {}), false, 'the wall shows real stock');
  // atomic: one bad value refuses the whole apply
  const before = { ...pow.inventory };
  assert.equal(game.overrideInventory('POW', { water: 9, parts: -1 }).reason, 'negative_value');
  assert.equal(game.overrideInventory('POW', { water: 9, parts: 1.5 }).reason, 'invalid_value');
  assert.equal(game.overrideInventory('POW', { water: 9, parts: '3' }).reason, 'invalid_value');
  assert.equal(game.overrideInventory('POW', { water: 9, parts: NaN }).reason, 'invalid_value');
  assert.equal(game.overrideInventory('POW', { water: 9, gold: 1 }).reason, 'unknown_resource');
  assert.equal(game.overrideInventory('POW', {}).reason, 'nothing_to_change');
  assert.equal(game.overrideInventory('XXX', { water: 1 }).reason, 'unknown_sector');
  assert.deepEqual(pow.inventory, before, 'a refused apply moved something');
  // several at once, all together
  const multi = game.overrideInventory('POW', { water: 0, parts: 7, med: 2 }, { reason: 'x' });
  assert.equal(multi.ok, true); assert.deepEqual(multi.after, { ...before, water: 0, parts: 7, med: 2 });
  assert.deepEqual(multi.delta, { water: 0 - before.water, parts: 7 - before.parts, med: 2 - before.med });
  assert.equal(pow.inventory.water, 0);
});

test('v18 resource control: a reason is required, the audit line carries before/after/delta with round and phase, and nothing else in the game moves', () => {
  const game = running();
  assert.equal(override.validate({ action: 'resource_override', payload: { sector: 'POW', values: { power: 1 } } }).reason, 'reason_required');
  assert.equal(override.validate({ action: 'resource_override', reason: 'x', payload: { sector: 'POW', values: {} } }).reason, 'values_required');
  assert.equal(override.validate({ action: 'resource_override', reason: 'x', payload: { sector: 'POW', values: { power: -1 } } }).reason, 'negative_value');
  assert.equal(override.validate({ action: 'resource_override', reason: 'x', payload: { sector: 'POW', values: { power: 2.5 } } }).reason, 'invalid_value');
  assert.equal(override.validate({ action: 'resource_override', reason: 'x', payload: { sector: 'POW', values: { power: '' } } }).reason, 'invalid_value');
  assert.equal(override.validate({ action: 'resource_override', reason: 'x', payload: { sector: 'POW', values: { fuel: 1 } } }).reason, 'unknown_resource');
  assert.equal(override.validate({ action: 'resource_override', reason: 'x', payload: { sector: 'POW', values: { power: 4 } } }).ok, true);
  assert.deepEqual(override.snapshot(game, 'resource_override', { sector: 'POW' }).inventory, game.state.sectors.POW.inventory);
  assert.equal(override.targetName(game, 'resource_override', { sector: 'POW' }), 'POW');
  // the world before
  game.setBroadcastRow('POW', { power: 1, water: 1, med: 1, parts: 1 }, { by: 'COM' });
  readyTransfer(game, { from: 'WTR', to: 'POW', resource: 'water', amount: 1 });
  game.fireFault('F-001', 'POW'); game.setInventory('POW', { parts: 1 });
  submitCode(game, { sector: 'POW', fault_code: 'F-001', code: loadContent().faults.faults.find((f) => f.code === 'F-001').valid_codes[0], workers_assigned: 1 });
  game.cycleControl('process');
  const snap = {
    requests: game.state.requests.length, transfers: game.state.transfers.length, stamps: game.stampsUsed(), heals: game.medHealsUsed(),
    board: JSON.stringify(game.state.broadcast.rows.POW), consumed: game.state.repair_material_units_consumed, upkeep_passes: game.state.cycle.number,
    reward_budget: JSON.stringify(game.rewardBudget()), faults: JSON.stringify(game.state.sectors.POW.faults), integrity: game.state.sectors.POW.integrity,
  };
  const r = game.overrideInventory('POW', { power: 6, parts: 0 }, { reason: 'playtest correction', by: 'facilitator' });
  assert.equal(r.ok, true);
  const ev = logEvents(game, 'admin_resource_override').pop();
  for (const k of ['sector', 'before', 'after', 'delta', 'reason', 'by', 'round', 'phase', 'run_id', 't']) assert.ok(k in ev, `audit lacks ${k}`);
  assert.equal(ev.sector, 'POW'); assert.equal(ev.reason, 'playtest correction'); assert.equal(ev.round, 'R2'); assert.equal(ev.phase, 'ROUND_2');
  assert.equal(ev.after.power, 6); assert.equal(ev.delta.power, 6 - ev.before.power); assert.equal(ev.after.parts, 0);
  assert.deepEqual({
    requests: game.state.requests.length, transfers: game.state.transfers.length, stamps: game.stampsUsed(), heals: game.medHealsUsed(),
    board: JSON.stringify(game.state.broadcast.rows.POW), consumed: game.state.repair_material_units_consumed, upkeep_passes: game.state.cycle.number,
    reward_budget: JSON.stringify(game.rewardBudget()), faults: JSON.stringify(game.state.sectors.POW.faults), integrity: game.state.sectors.POW.integrity,
  }, snap, 'something besides the tray moved');
  assert.equal(forBigscreen(game).broadcast.rows.POW.power, 1, "COM's board followed the real tray");
  const again = newGame({ runId: 'v18-restore' });
  again.restore(JSON.parse(JSON.stringify(game.serialise())));
  assert.equal(again.state.sectors.POW.inventory.power, 6, 'a restart lost the override');
  assert.ok(Array.isArray(forControl(game).active_sectors), 'the console cannot tell which sectors are inactive');
});

test('v18 timer control: add and take minutes, set MM:SS, never below 00:00; reset restores the round default and touches nothing else', () => {
  const game = running();
  const clk = game.state.round_clock;
  const len = game.roundConfig('R2').length_s;
  assert.equal(clk.remaining_s, len);
  assert.equal(game.clock('add', 60, 'round', { reason: 'running long' }).ok, true);
  assert.equal(clk.remaining_s, len + 60);
  game.clock('add', -300, 'round', { reason: 'short' });
  assert.equal(clk.remaining_s, len - 240);
  game.clock('set', 125, 'round', { reason: 'restart' });
  assert.equal(clk.remaining_s, 125);
  game.clock('add', -300, 'round', { reason: 'floor' });
  assert.equal(clk.remaining_s, 0, 'went below 00:00');
  game.clock('set', -5, 'round', { reason: 'floor' });
  assert.equal(clk.remaining_s, 0);
  assert.equal(game.clock('warp', 1, 'round').reason, 'unknown_clock_action');
  const adj = logEvents(game, 'admin_timer_adjust');
  assert.equal(adj.length, 5);
  assert.deepEqual([adj[0].before_remaining_ms, adj[0].after_remaining_ms, adj[0].delta_ms, adj[0].reason], [len * 1000, (len + 60) * 1000, 60000, 'running long']);
  assert.equal(adj[3].after_remaining_ms, 0); assert.equal(adj[3].delta_ms, -125000);
  // reset: time only
  game.fireFault('F-201', 'POW'); game.injure('WTR', 1); game.requestHealing('WTR', { by: 'WTR' });
  readyTransfer(game, { from: 'WTR', to: 'POW', resource: 'water', amount: 1 });
  game.approveTransfer(game.state.transfers[0].id, { by: 'TRN' });
  game.setIntegrity('AGR', 61);
  const world = everythingBut(game, 'round_clock', 'ticker', 'feed', 'updated_at', 'game_clock_s');
  const res = game.clock('reset', null, 'round', { reason: 'fresh round' });
  assert.equal(res.ok, true); assert.equal(clk.remaining_s, len); assert.equal(clk.running, true, 'reset stopped a running clock');
  assert.deepEqual(everythingBut(game, 'round_clock', 'ticker', 'feed', 'updated_at', 'game_clock_s'), world, 'reset touched more than the time');
  assert.equal(game.state.round, 'R2'); assert.equal(game.state.phase, 'ROUND_2'); assert.equal(game.stampsUsed(), 1); assert.equal(game.state.sectors.AGR.integrity, 61);
  const rs = logEvents(game, 'admin_timer_reset').pop();
  assert.deepEqual([rs.before_remaining_ms, rs.default_remaining_ms, rs.reason], [0, len * 1000, 'fresh round']);
  // the wrapper checks the payload before anything moves
  assert.equal(override.validate({ action: 'timer_set', reason: 'x', payload: { seconds: -1 } }).reason, 'invalid_time');
  assert.equal(override.validate({ action: 'timer_set', reason: 'x', payload: { seconds: 12.5 } }).reason, 'invalid_time');
  assert.equal(override.validate({ action: 'timer_set', reason: 'x', payload: { seconds: 522 } }).ok, true);
  assert.equal(override.validate({ action: 'timer_adjust', reason: 'x', payload: { delta_s: 0 } }).reason, 'invalid_delta');
  assert.equal(override.validate({ action: 'timer_adjust', payload: { delta_s: 60 } }).reason, 'reason_required');
  assert.equal(override.validate({ action: 'timer_reset', reason: 'x', payload: {} }).ok, true);
  const snap = override.snapshot(game, 'timer_set', {});
  assert.equal(snap.remaining_ms, len * 1000); assert.equal(snap.default_s, len); assert.equal(snap.round, 'R2');
  assert.equal(override.targetName(game, 'timer_set', {}), 'ROUND TIMER');
});

test('v18 timer control: the session pause freezes the one countdown, the time can be edited while paused and RESUME continues from it; every screen reads the same value', () => {
  const game = running();
  const clk = game.state.round_clock;
  const len = game.roundConfig('R2').length_s;
  game.tick(10000);
  assert.equal(Math.round(clk.remaining_s), len - 10);
  game.pause();
  game.tick(30000);
  assert.equal(Math.round(clk.remaining_s), len - 10, 'the countdown ran while the session was paused');
  assert.equal(clk.running, true, 'the session pause changed the clock\'s own flag');
  game.clock('set', 400, 'round', { reason: 'edited while paused' });
  game.tick(30000);
  assert.equal(clk.remaining_s, 400);
  game.resume();
  game.tick(10000);
  assert.equal(Math.round(clk.remaining_s), 390, 'RESUME did not continue from the edited value');
  const shown = [forControl(game).round_clock.remaining_s, forSector(game, 'POW').round_clock.remaining_s, forBigscreen(game).round_clock.remaining_s];
  assert.deepEqual(shown, [390, 390, 390], `the screens disagree: ${shown}`);
  assert.equal(forSector(game, 'POW').round_clock.running, true);
  // the timer-only pause is its own thing and stays
  game.clock('pause', null, 'round');
  game.tick(10000);
  assert.equal(clk.remaining_s, 390); assert.equal(game.frozen, false);
  game.clock('resume', null, 'round');
  game.tick(10000);
  assert.equal(Math.round(clk.remaining_s), 380);
  const pr = logEvents(game, 'admin_timer_pause_resume').map((e) => e.action);
  assert.deepEqual(pr, ['start', 'session_pause', 'session_resume', 'pause', 'resume']);
  assert.ok(logEvents(game, 'admin_timer_pause_resume').every((e) => typeof e.remaining_ms === 'number' && 'round' in e && 'phase' in e));
});

test('v18 timer control: 00:00 stops nothing but the clock; NEXT PHASE still runs the round transition; a restart keeps the exact time and tray', () => {
  const game = running();
  const clk = game.state.round_clock;
  game.clock('set', 5, 'round', { reason: 'nearly over' });
  const rounds = logEvents(game, 'round').length;
  const phases = logEvents(game, 'phase').length;
  const passes = game.state.cycle.number;
  game.tick(10000);
  assert.equal(clk.remaining_s, 0);
  assert.equal(game.state.round, 'R2'); assert.equal(game.state.phase, 'ROUND_2');
  assert.equal(logEvents(game, 'round').length, rounds); assert.equal(logEvents(game, 'phase').length, phases);
  assert.equal(game.state.cycle.number, passes, '00:00 charged upkeep');
  game.tick(60000);
  assert.equal(clk.remaining_s, 0);
  game.overrideInventory('POW', { parts: 5 }, { reason: 'x' });
  const again = newGame({ runId: 'v18-clock' });
  again.restore(JSON.parse(JSON.stringify(game.serialise())));
  assert.equal(again.state.round_clock.remaining_s, 0); assert.equal(again.state.sectors.POW.inventory.parts, 5);
  game.clock('set', 30, 'round', { reason: 'x' });
  const again2 = newGame({ runId: 'v18-clock-2' });
  again2.restore(JSON.parse(JSON.stringify(game.serialise())));
  assert.equal(again2.state.round_clock.remaining_s, 30, 'a restart lost the edited time');
  // NEXT PHASE is the round transition, as before: upkeep, a fresh clock, not started
  const upkeep = game.state.cycle.number;
  assert.equal(game.nextPhase(), true);
  assert.equal(game.state.round, 'R3');
  assert.equal(game.state.cycle.number, upkeep + 1, 'the round transition skipped upkeep');
  assert.equal(clk === game.state.round_clock, false);
  assert.equal(game.state.round_clock.remaining_s, game.roundConfig('R3').length_s); assert.equal(game.state.round_clock.running, false);
  assert.equal(logEvents(game, 'round').length, rounds + 1);
  // the console has what its popover and drawer need
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'control', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'control', 'control.js'), 'utf8');
  for (const id of ['btn-timer', 'timer-pop', 'timer-set-input', 'timer-reset', 'timer-pause']) assert.ok(html.includes(`id="${id}"`), `console lacks ${id}`);
  assert.ok(/data-timer-delta="-300"/.test(html) && /data-timer-delta="300"/.test(html));
  assert.ok(/RESOURCE CONTROL/.test(js) && /APPLY RESOURCE OVERRIDE/.test(js) && /SET EXACT VALUES/.test(js) && /'resource_override'/.test(js));
  assert.ok(!/data-ovr-inv/.test(js), 'the per-click inventory steppers are still there');
  assert.ok(!/ADVANCE ROUND/.test(html), 'a second round-advance control appeared');
  assert.equal(typeof forControl(game).round_length_s, 'number');
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
  game.setInventory('POW', { power: 2, parts: 1 });           // the binder's materials for F-401 (v17)
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
  game.setIntegrity('POW', 75);
  assert.equal(forSector(game, 'POW').sectors.POW.status_word, 'STABLE');
  game.patchConfig({ degraded_below: 80 });
  assert.equal(forSector(game, 'POW').sectors.POW.status_word, 'DEGRADED');
  assert.equal(forBigscreen(game).sectors.POW.status_word, 'DEGRADED');
  assert.equal(forControl(game).sectors.POW.status_word, 'DEGRADED');
  game.patchConfig({ critical_below: 76 });
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
  assert.equal(again.game.cfg.degraded_below, 70, 'fresh defaults fill the gaps');
  registry.evict(row.code);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
