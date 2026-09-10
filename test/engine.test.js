'use strict';
/**
 * The game control layer: phases, the city cycle, deadlines, transfers,
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

test('START runs the round clock and the city cycle together; frozen states stop both', () => {
  const game = newGame();
  game.setPhase('ROUND_1');
  game.clock('start');
  assert.equal(game.state.mode, 'PLAY');
  assert.equal(game.state.cycle.running, true);
  const before = { round: game.state.round_clock.remaining_s, cycle: game.state.cycle.remaining_s };
  game.tick(5000);
  assert.equal(game.state.round_clock.remaining_s, before.round - 5);
  assert.equal(game.state.cycle.remaining_s, before.cycle - 5);

  game.pause();
  game.tick(60000);
  assert.equal(game.state.round_clock.remaining_s, before.round - 5, 'paused: nothing moves');
  assert.equal(game.state.cycle.remaining_s, before.cycle - 5);
  game.resume();
  game.tick(1000);
  assert.equal(game.state.round_clock.remaining_s, before.round - 6, 'resumes from the exact remaining time');
});

test('pause freezes fault deadlines, decay and the council clock but not the lockout', () => {
  const game = running();
  game.fireFault('F-201', 'POW');
  const fault = game.findFault('POW', 'F-201');
  for (let i = 0; i < 3; i += 1) submitCode(game, { sector: 'POW', fault_code: 'F-201', code: 'P-04-000', workers_assigned: 2 });
  assert.equal(fault.locked_until_s, 20);
  game.callCouncil();
  game.pause();
  const deadline = fault.deadline_remaining_s;
  const integrity = game.state.sectors.POW.integrity;
  game.tick(25000);
  assert.equal(fault.deadline_remaining_s, deadline);
  assert.equal(game.state.sectors.POW.integrity, integrity);
  assert.equal(game.state.council_clock.remaining_s, 300);
  assert.equal(fault.locked_until_s, 0, 'a locked console still unlocks while paused');
  const frame = forSector(game, 'POW');
  assert.equal(frame.paused, true);
  assert.equal(frame.round_clock.running, false, 'clients must not interpolate while frozen');
});

// -- faults: deadlines and expiry --------------------------------------------------

test('a fault without a content deadline gets the scenario default for its severity', () => {
  const game = running();
  game.fireFault('F-201', 'POW');   // severity 2, content deadline null
  game.fireFault('F-101', 'POW');   // severity 1
  assert.equal(game.findFault('POW', 'F-201').deadline_s, game.cfg.deadline_default_s['2']);
  assert.equal(game.findFault('POW', 'F-101').deadline_s, null, 'incidents have no deadline by default');
  game.fireFault('F-302', 'WTR');   // content deadline 480 wins
  assert.equal(game.findFault('WTR', 'F-302').deadline_s, 480);
});

test('at the deadline the fault EXPIRES once, takes its penalty, and stays solvable', () => {
  const game = running();
  game.fireFault('F-201', 'POW');
  const fault = game.findFault('POW', 'F-201');
  fault.deadline_remaining_s = 2;
  const before = game.state.sectors.POW.integrity;
  game.tick(3000);
  assert.equal(fault.expired, true);
  assert.equal(fault.status, 'EXPIRED');
  const decayed = (fault.decay_per_min * 3) / 60;
  assert.ok(Math.abs(game.state.sectors.POW.integrity - (before - decayed - fault.integrity_penalty)) < 0.01,
    'penalty applied on top of continuous decay');
  game.tick(3000);
  assert.equal(logEvents(game, 'deadline_expired').length, 1, 'penalty applies once');
  const res = submitCode(game, { sector: 'POW', fault_code: 'F-201', code: 'P-04-340', workers_assigned: 2 });
  assert.equal(res.accepted, true, 'still solvable after expiry (configurable)');
});

test('with expired_faults_remain_solvable off the fault FAILS at the deadline', () => {
  const game = running();
  game.patchConfig({ expired_faults_remain_solvable: false });
  game.fireFault('F-201', 'POW');
  game.findFault('POW', 'F-201').deadline_remaining_s = 1;
  game.tick(2000);
  assert.equal(game.findFault('POW', 'F-201'), null);
  assert.equal(game.state.sectors.POW.faults[0].status, 'FAILED');
});

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

test('brownout shortens new deadlines and runs fault timers faster', () => {
  const game = running();
  game.setStatus('POW', 'BROWNOUT');
  game.fireFault('F-201', 'POW');
  const f = game.findFault('POW', 'F-201');
  const mult = game.cfg.brownout_effects.fault_timer_multiplier;
  assert.equal(f.deadline_s, Math.round(480 * mult));
  const before = f.deadline_remaining_s;
  game.tick(3000);
  assert.ok(Math.abs((before - f.deadline_remaining_s) - 3 / mult) < 0.01, 'timer runs at 1/multiplier');
  assert.equal(game.availableWorkers(game.state.sectors.POW), 8 - game.cfg.brownout_effects.worker_penalty);
});

// -- the city cycle ------------------------------------------------------------------

test('PROCESS CYCLE: production, upkeep, shortage penalty, recovery, summary, next cycle', () => {
  const game = running();
  const pow = game.state.sectors.POW;
  const wtr = game.state.sectors.WTR;
  pow.inventory = { power: 0, water: 0, parts: 3, med: 1 };   // will miss 2 power + 1 water... after +3 production
  wtr.workforce.injured = 2; wtr.workforce.active = 6;
  game.state.sectors.MED.inventory.med = 3;

  const summary = game.cycleControl('process');
  // POW: +3 power produced, then upkeep 2 power 1 water → power 1, water short by 1
  assert.equal(pow.inventory.power, 1);
  assert.equal(pow.inventory.water, 0);
  assert.deepEqual(summary.sectors.POW.shortfall, { water: 1 });
  assert.equal(summary.sectors.POW.integrity_delta, -game.cfg.upkeep_shortfall_penalty);
  assert.equal(summary.missed_upkeep_count, 1);
  // WTR produced water and MED spent med to recover one injured worker
  assert.equal(wtr.inventory.water, 3 + 3 - 1);
  assert.equal(wtr.workforce.injured, 1);
  assert.equal(summary.sectors.WTR.recovered, 1);
  assert.equal(game.state.sectors.MED.inventory.med, 3 + 1 - 1, 'MED produced 1, spent 1');
  assert.equal(game.state.cycle.number, 2);
  assert.equal(game.state.cycle.remaining_s, game.cfg.cycle_length_s);
  const ev = logEvents(game, 'cycle_processed');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].summary.cycle, 1);
});

test('the cycle fires itself when its clock reaches zero, and not while frozen', () => {
  const game = running();
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
  game.fireEvent('supply_delay', { target: 'MED' });
  const frame = forControl(game);
  assert.deepEqual(frame.sectors.WTR.production_next, { water: 1 }, 'floor(3 × 0.5)');
  assert.deepEqual(frame.sectors.WTR.upkeep_delivery, { power: 1, water: 0 });
  assert.deepEqual(frame.sectors.TRN.production_next, {});
  assert.deepEqual(frame.sectors.MED.production_next, {});
  game.cycleControl('process');
  assert.equal(game.hasEffect('no_production', 'MED'), false, 'the one-cycle effect is spent');
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

// -- transfers -----------------------------------------------------------------------

test('a transfer moves stock only when TRN stamps it, within capacity', () => {
  const game = running();
  const r = game.requestTransfer({ from: 'WTR', to: 'POW', resource: 'water', amount: 2, by: 'WTR' });
  assert.equal(r.ok, true);
  assert.equal(r.transfer.status, 'REQUESTED');
  game.updateTransfer(r.transfer.id, 'AGREED', { by: 'POW' });
  game.updateTransfer(r.transfer.id, 'WAITING_TRN', { by: 'WTR' });
  assert.equal(game.state.sectors.POW.inventory.water, 3, 'nothing moved yet');

  const s = game.stampTransfer(r.transfer.id, { by: 'TRN' });
  assert.equal(s.ok, true);
  assert.equal(s.transfer.status, 'DELIVERED', 'deliver_on_stamp');
  assert.equal(game.state.sectors.POW.inventory.water, 5);
  assert.equal(game.state.sectors.WTR.inventory.water, 1);
  assert.ok(logEvents(game, 'transfer_stamped')[0].t);
  assert.equal(game.stampTransfer(r.transfer.id).reason, 'already_stamped');
});

test('transport capacity is per cycle, reduced by brownout and by effects, and admin can force', () => {
  const game = running();
  const cap = game.cfg.trn_capacity_per_cycle;
  const ids = [];
  for (let i = 0; i < cap + 1; i += 1) {
    ids.push(game.requestTransfer({ from: 'WTR', to: 'POW', resource: 'water', amount: 1 }).transfer.id);
  }
  for (let i = 0; i < cap; i += 1) assert.equal(game.stampTransfer(ids[i]).ok, true);
  const refused = game.stampTransfer(ids[cap]);
  assert.equal(refused.reason, 'capacity');
  assert.equal(logEvents(game, 'transfer_refused').length, 1);
  assert.equal(game.stampTransfer(ids[cap], { force: true }).ok, true, 'facilitator override');

  game.cycleControl('process');
  assert.equal(game.transfersStampedThisCycle(), 0, 'a new cycle resets the count');
  game.setStatus('TRN', 'BROWNOUT');
  assert.equal(game.trnCapacity(), game.cfg.brownout_effects.per_sector.TRN.transfer_capacity);
  game.setStatus('TRN', 'ACTIVE');
  game.fireEvent('transport_gridlock');
  assert.equal(game.trnCapacity(), 0);
  game.tick(181000);
  assert.equal(game.trnCapacity(), cap, 'the effect expires');
});

test('a worker loan moves people and is tracked as loaned/borrowed', () => {
  const game = running();
  const r = game.requestTransfer({ from: 'AGR', to: 'MED', resource: 'workers', amount: 2 });
  game.stampTransfer(r.transfer.id);
  assert.equal(game.state.sectors.AGR.workforce.active, 6);
  assert.equal(game.state.sectors.AGR.workforce.loaned, 2);
  assert.equal(game.state.sectors.MED.workforce.active, 10);
  assert.equal(forSector(game, 'AGR').sectors.AGR.workforce.total, 8);
});

test('the TRN screen sees the queue and capacity; other sectors only their own transfers', () => {
  const game = running();
  game.requestTransfer({ from: 'WTR', to: 'POW', resource: 'water', amount: 2 });
  game.requestTransfer({ from: 'AGR', to: 'MED', resource: 'med', amount: 1 });
  const trn = forSector(game, 'TRN');
  assert.equal(trn.transfer_queue.items.length, 2);
  assert.equal(trn.transfer_queue.capacity, game.cfg.trn_capacity_per_cycle);
  assert.equal(forSector(game, 'POW').transfers.length, 1);
  assert.equal(forSector(game, 'COM').transfer_queue, undefined);
  assert.equal(forSector(game, 'COM').transfers.length, 0);
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
  assert.equal(game.cfg.brownout_effects.fault_timer_multiplier, 0.75, 'deep merge keeps siblings');
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
  assert.equal(mine.upkeep_due_in_s, Math.ceil(game.state.cycle.remaining_s));
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
  const t = game.requestTransfer({ from: 'WTR', to: 'POW', resource: 'water', amount: 1 });
  game.tick(20000);
  game.stampTransfer(t.transfer.id);
  game.callCouncil();
  game.tick(120000);
  game.submitContinuityOrder(['POW', 'MED', 'WTR', 'TRN', 'COM', 'AGR']);
  game.findFault('WTR', 'F-302').deadline_remaining_s = 1;
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
  assert.equal(r3.faults.expired, 1);
  assert.equal(r3.faults.cross_sector, 2);
  assert.equal(r3.console.invalid_code, 1);
  const f301 = r3.faults.list.find((f) => f.code === 'F-301');
  assert.equal(f301.attempts, 2);
  assert.ok(f301.time_to_first_action_s != null && f301.time_to_resolution_s != null,
    'durations come from real timestamps (game ticks do not move the wall clock)');
  assert.deepEqual(f301.consumed, { parts: 3, water: 2 });
  assert.equal(r3.transfers.requested, 1);
  assert.equal(r3.transfers.stamped, 1);
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

test('per-fault overrides: deadline, expiry penalty and extra accepted codes; the content answer stays', () => {
  const game = running();
  assert.equal(game.setFaultOverride('F-999', { deadline_s: 10 }).ok, false);

  game.setFaultOverride('F-201', { deadline_s: 100, integrity_penalty: 3, extra_valid_codes: ['p-04-777', ''] });
  const { fault } = game.fireFault('F-201', 'POW');
  assert.equal(fault.deadline_s, 100);
  assert.equal(fault.integrity_penalty, 3);
  assert.ok(fault.valid_codes.includes('P-04-340') && fault.valid_codes.includes('P-04-777'));
  assert.equal(forControl(game).config.fault_overrides['F-201'].deadline_s, 100);
  assert.ok(!JSON.stringify(forSector(game, 'POW')).includes('P-04-777'), 'an extra code is still an answer key');

  const r = submitCode(game, { sector: 'POW', fault_code: 'F-201', code: 'P-04-777', workers_assigned: 2 });
  assert.equal(r.accepted, true, 'the extra code resolves it');

  game.setFaultOverride('F-201', null);
  assert.equal(forControl(game).config.fault_overrides['F-201'], undefined);
  const again = game.fireFault('F-201', 'POW').fault;
  assert.equal(again.deadline_s, 480, 'back to the severity default');
  assert.equal(again.integrity_penalty, 10);
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
