'use strict';
/**
 * UPKEEP HEALTH PENALTY (undercity_upkeep_health_penalty_spec 1.0, 2026-10-05).
 *
 * Every sector owes 2 Power + 1 Water when the next operational round is
 * entered. The whole bill or none of it: a sector that can pay, pays and is
 * PAID; one that cannot pays nothing, keeps its stock, and loses a flat 10
 * Sector Health (its Integrity — the same value) once for that round, however
 * many units it was short. Round 0's start charges nothing; the first bill
 * lands on entering Round 1. The charge is recorded per sector per round and
 * never repeated by a refresh, a reconnect, a second press or a round
 * re-entered after PREV. 0 Health is the existing DARK behaviour.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { newGame, logEvents } = require('./helpers');
const { forSector, forControl } = require('../lib/visibility');
const { analyse } = require('../lib/analytics');
const economy = require('../lib/economy');

const ROOT = path.join(__dirname, '..');
const SECTOR_SCRIPT = fs.readFileSync(path.join(ROOT, 'public/sector/sector.js'), 'utf8');
const SECTOR_INDEX = fs.readFileSync(path.join(ROOT, 'public/sector/index.html'), 'utf8');
const CONTROL_SCRIPT = fs.readFileSync(path.join(ROOT, 'public/control/control.js'), 'utf8');
const STANDARD = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/scenarios/haven9-standard.json'), 'utf8'));
const SECTORS = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];
const ALL = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'];

/** A run played to `round` with every table stocked so nothing is short on the way there. */
function at(round) {
  const g = newGame();
  g.clock('start'); g.tick(1000);   // Round 0 is played, so entering Round 1 charges its bill
  for (const r of ALL.slice(1, ALL.indexOf(round) + 1)) {
    for (const s of SECTORS) g.setInventory(s, { power: 9, water: 9, parts: 9, med: 9 });
    g.activateRound(r); g.clock('start'); g.tick(1000);
  }
  return g;
}
const next = (r) => ALL[ALL.indexOf(r) + 1];
const inv = (g, s) => ({ ...g.state.sectors[s].inventory });
const results = (g, round) => (g.state.upkeep_results || {})[round] || {};
const upkeepEvents = (g, sector) => logEvents(g, 'upkeep_result').filter((e) => e.sector === sector);

// -- the spec's seven acceptance tests ----------------------------------------------------------

test('POW enters R1 with at least 2 Power and 1 Water: exactly 2 Power and 1 Water go, R1 is PAID, Health is untouched', () => {
  const g = at('R0');
  g.setInventory('POW', { power: 2, water: 1, parts: 3, med: 1 });
  const health = g.state.sectors.POW.integrity;
  const res = g.activateRound('R1');
  assert.equal(res.ok, true);
  assert.equal(res.charged, 'R0', 'entering Round 1 charges the bill');
  assert.deepEqual(inv(g, 'POW'), { power: 0, water: 0, parts: 3, med: 1 });
  assert.equal(g.state.sectors.POW.integrity, health, 'Health moved on a paid upkeep');
  const r = results(g, 'R0').POW;
  assert.deepEqual([r.upkeep_status, r.resources_deducted, r.health_penalty, r.health_before, r.health_after], ['PAID', { power: 2, water: 1 }, 0, 100, 100]);
  assert.deepEqual(r.upkeep_required, { power: 2, water: 1 });
  assert.equal(upkeepEvents(g, 'POW').length, 1);
  assert.equal(forSector(g, 'POW').sectors.POW.last_upkeep.message, 'UPKEEP PAID — Sector stable.');
});

test('AGR enters R2 with only 1 Power and 1 Water: UNPAID, its stock untouched, exactly 10 Health once', () => {
  const g = at('R1');
  g.setInventory('AGR', { power: 1, water: 1, parts: 2, med: 0 });
  g.setIntegrity('AGR', 80);
  g.activateRound('R2');
  assert.deepEqual(inv(g, 'AGR'), { power: 1, water: 1, parts: 2, med: 0 }, 'a partial deduction was made');
  assert.equal(g.state.sectors.AGR.integrity, 70);
  const r = results(g, 'R1').AGR;
  assert.deepEqual([r.upkeep_status, r.resources_deducted, r.health_penalty, r.health_before, r.health_after], ['UNPAID', {}, 10, 80, 70]);
  assert.equal(upkeepEvents(g, 'AGR').length, 2, 'one record per round entered');
  const view = forSector(g, 'AGR').sectors.AGR.last_upkeep;
  assert.equal(view.message, 'UPKEEP SHORTFALL — -10 SECTOR HEALTH.');
  assert.deepEqual([view.status, view.round, view.round_number, view.health_after], ['UNPAID', 'R1', 1, 70]);
  // The others, stocked, paid as usual.
  for (const s of SECTORS.filter((x) => x !== 'AGR')) assert.equal(results(g, 'R1')[s].upkeep_status, 'PAID', s);
});

test('MED enters R3 with 2 Power and 0 Water: exactly 10 Health once, and the Power is not partially taken', () => {
  const g = at('R2');
  g.setInventory('MED', { power: 2, water: 0, parts: 1, med: 3 });
  g.activateRound('R3');
  assert.deepEqual(inv(g, 'MED'), { power: 2, water: 0, parts: 1, med: 3 });
  assert.equal(g.state.sectors.MED.integrity, 90);
  assert.deepEqual(results(g, 'R2').MED.resources_deducted, {});
  assert.equal(results(g, 'R2').MED.health_penalty, 10);
});

test('COM enters R4 with no Power and no Water: still only 10 Health, not 30', () => {
  const g = at('R3');
  g.setInventory('COM', { power: 0, water: 0, parts: 0, med: 0 });
  g.activateRound('R4');
  assert.equal(g.state.sectors.COM.integrity, 90);
  assert.deepEqual(results(g, 'R3').COM.upkeep_required, { power: 2, water: 1 });
  assert.equal(results(g, 'R3').COM.health_penalty, 10);
  assert.equal(logEvents(g, 'upkeep_missed').filter((e) => e.sector === 'COM').length, 1);
});

test('a refresh, a reconnect, a rerender or a second pass after an unpaid upkeep deducts nothing more', () => {
  const g = at('R1');
  g.setInventory('AGR', { power: 0, water: 0, parts: 0, med: 0 });
  g.activateRound('R2');
  assert.equal(g.state.sectors.AGR.integrity, 90);
  // Frames are read, not written: the console refreshing, the facilitator revisiting, the wall rerendering.
  for (let i = 0; i < 5; i += 1) { forSector(g, 'AGR'); forSector(g, 'POW'); forControl(g); }
  assert.equal(g.state.sectors.AGR.integrity, 90);
  // The same round charged again — by a second pass, by a second activation attempt, by PREV then NEXT — is a no-op.
  const again = economy.processCycle(g, { round: 'R1' });
  assert.equal(again.repeated, true);
  assert.equal(g.state.sectors.AGR.integrity, 90, 'a second pass for Round 1 took Health again');
  assert.equal(g.activateRound('R2').reason, 'round_already_active');
  g.activateRound('R1');                 // PREV ROUND
  g.clock('start'); g.tick(1000);
  const before = g.state.sectors.AGR.integrity;
  const fwd = g.activateRound('R2');     // NEXT again: Round 1's bill is already on record
  assert.equal(fwd.charged, null, 'Round 1 was charged a second time');
  assert.equal(g.state.sectors.AGR.integrity, before);
  assert.equal(upkeepEvents(g, 'AGR').filter((e) => e.round === 'R1').length, 1);
  assert.ok(logEvents(g, 'upkeep_already_charged').length >= 2);
  // A reconnect after a server restart restores the record, so it is not charged again either.
  const snap = JSON.parse(JSON.stringify(g.serialise()));
  const back = newGame({ runId: 'upkeep-restore' });
  back.restore(snap);
  assert.equal(economy.processCycle(back, { round: 'R1' }).repeated, true);
  assert.equal(back.state.sectors.AGR.integrity, before);
  assert.equal(forSector(back, 'AGR').sectors.AGR.last_upkeep.status, 'UNPAID');
  // PROCESS UPKEEP NOW charges the current round once, by hand; the activation that follows does not charge it again.
  const byHand = g.cycleControl('process');
  assert.equal(byHand.repeated, undefined);
  assert.equal(byHand.round, 'R2');
  assert.equal(g.state.sectors.AGR.integrity, 80, 'the manual pass did not charge Round 2');
  assert.equal(g.cycleControl('process').repeated, true, 'a second manual pass charged again');
  assert.equal(g.state.sectors.AGR.integrity, 80);
  for (const s of SECTORS) g.setInventory(s, { power: 9, water: 9, parts: 9, med: 9 });
  assert.equal(g.activateRound('R3').charged, null, 'the activation charged Round 2 a second time');
  assert.equal(g.state.sectors.AGR.integrity, 80);
  // A restart of the current round charges nothing either; only a full reset of the run forgets.
  assert.equal(g.activateRound('R3', { restart: true }).charged, null);
  g.reset('fresh-run');
  assert.deepEqual(g.state.upkeep_results, {});
});

test('Sector Health that would drop below zero clamps at 0 and the sector goes DARK as it always has', () => {
  const g = at('R1');
  g.setInventory('TRN', { power: 0, water: 0, parts: 0, med: 0 });
  g.setIntegrity('TRN', 6);
  g.activateRound('R2');
  assert.equal(g.state.sectors.TRN.integrity, 0);
  assert.equal(g.state.sectors.TRN.status, 'DARK');
  assert.deepEqual([results(g, 'R1').TRN.health_before, results(g, 'R1').TRN.health_after, results(g, 'R1').TRN.health_penalty], [6, 0, 10]);
  assert.equal(forSector(g, 'TRN').sectors.TRN.status_word, 'DARK');
  // A dark sector has no economy: the next pass charges it nothing and records nothing for it.
  for (const s of SECTORS.filter((x) => x !== 'TRN')) g.setInventory(s, { power: 9, water: 9, parts: 9, med: 9 });
  g.clock('start'); g.tick(1000);
  g.activateRound('R3');
  assert.equal(results(g, 'R2').TRN, undefined);
  assert.equal(g.state.sectors.TRN.integrity, 0);
});

test('R0 starts: no upkeep is paid and no Health is lost; the first bill lands on entering Round 1', () => {
  const g = newGame();
  const stock = Object.fromEntries(SECTORS.map((s) => [s, inv(g, s)]));
  g.activateRound('R0');
  g.clock('start'); g.tick(60000);
  for (const s of SECTORS) {
    assert.deepEqual(inv(g, s), stock[s], `${s} paid at Round 0`);
    assert.equal(g.state.sectors[s].integrity, 100);
  }
  assert.deepEqual(g.state.upkeep_results, {});
  assert.equal(logEvents(g, 'upkeep_result').length, 0);
  // Entering Round 1 charges Round 0's bill, once, for every sector.
  g.activateRound('R1');
  assert.equal(Object.keys(results(g, 'R0')).length, 6);
  for (const s of SECTORS) assert.deepEqual(inv(g, s), { ...stock[s], power: stock[s].power - 2, water: stock[s].water - 1 }, s);
  assert.equal(logEvents(g, 'upkeep_result').length, 6);
});

// -- the rest of the rule ---------------------------------------------------------------------------

test('the bill is the full requirement: an AGR obligation counts, a brownout halves it, and every operational round charges', () => {
  // An obligation on top of the standing upkeep is part of "full upkeep".
  const g = at('R2');
  g.setInventory('AGR', { power: 2, water: 1, parts: 9, med: 9 });
  g.state.agr.offered = ['AGR_POWER_SURGE', ...g.state.agr.offered.filter((x) => x !== 'AGR_POWER_SURGE')].slice(0, 3);
  assert.equal(g.agrActivate('AGR_POWER_SURGE', { by: 'AGR' }).ok, true);   // AGR owes +1 power at next upkeep
  assert.deepEqual(economy.upkeepFor(g, g.state.sectors.AGR), { power: 3, water: 1 });
  g.activateRound('R3');
  assert.equal(results(g, 'R2').AGR.upkeep_status, 'UNPAID', 'a short obligation did not count');
  assert.deepEqual(inv(g, 'AGR').power, 2, 'the standing part was taken although the bill could not be paid');
  assert.equal(g.state.sectors.AGR.integrity, 90);
  // A brownout halves the requirement, as before.
  const g2 = at('R2');
  g2.setStatus('WTR', 'BROWNOUT');
  g2.setInventory('WTR', { power: 1, water: 0, parts: 0, med: 0 });
  assert.deepEqual(economy.upkeepFor(g2, g2.state.sectors.WTR), { power: 1, water: 0 });
  g2.activateRound('R3');
  assert.equal(results(g2, 'R2').WTR.upkeep_status, 'PAID');
  assert.deepEqual(inv(g2, 'WTR'), { power: 0, water: 0, parts: 0, med: 0 });
  // Rounds 1 to 7 each charge once; the record names each.
  const g3 = newGame();
  g3.clock('start'); g3.tick(1000);
  for (const r of ALL.slice(1)) {
    for (const s of SECTORS) g3.setInventory(s, { power: 9, water: 9, parts: 9, med: 9 });
    g3.activateRound(r); g3.clock('start'); g3.tick(1000);
  }
  assert.deepEqual(Object.keys(g3.state.upkeep_results), ALL.slice(0, 7));
  for (const r of ALL.slice(0, 7)) for (const s of SECTORS) assert.equal(results(g3, r)[s].upkeep_status, 'PAID', `${r} ${s}`);
  assert.equal(g3.state.sectors.POW.integrity, 100);
});

test('the flat penalty is the scenario\'s, the per-unit penalty is gone, and the pass still reports production and recovery', () => {
  assert.equal(STANDARD.defaults.upkeep_shortfall_health_penalty, 10);
  assert.equal(STANDARD.defaults.upkeep_shortfall_penalty, undefined);
  assert.equal(STANDARD.defaults.upkeep_shortfall_penalty_cap, undefined);
  assert.ok(!/upkeep_shortfall_penalty_cap|missing \* Number/.test(fs.readFileSync(path.join(ROOT, 'lib/economy.js'), 'utf8')), 'the per-unit penalty survives in the engine');
  assert.ok(/upkeep_shortfall_health_penalty/.test(CONTROL_SCRIPT) && !/upkeep_shortfall_penalty_cap/.test(CONTROL_SCRIPT));
  const g = at('R1');
  g.patchConfig({ upkeep_shortfall_health_penalty: 15 });
  g.setInventory('COM', { power: 0, water: 0, parts: 0, med: 0 });
  g.activateRound('R2');
  assert.equal(g.state.sectors.COM.integrity, 85);
  // The pass's own summary carries the status beside what it always carried.
  const sum = g.state.cycle.last_summary;
  assert.equal(sum.round, 'R1');
  assert.equal(sum.sectors.COM.status, 'UNPAID');
  assert.equal(sum.sectors.POW.status, 'PAID');
  assert.deepEqual(sum.sectors.POW.upkeep, { power: 2, water: 1 });
  assert.equal(sum.missed_upkeep_count, 1);
});

test('what the screens say: NEXT UPKEEP 2 Power + 1 Water, the result line, the facilitator\'s per-sector status, the timeline', () => {
  assert.ok(/<h2 class="ptitle">NEXT UPKEEP<\/h2>/.test(SECTOR_INDEX), 'the panel is not titled NEXT UPKEEP');
  assert.ok(/id="upkeep-result"/.test(SECTOR_INDEX));
  assert.ok(/items\.join\('<span class="uk-plus">\+<\/span>'\)/.test(SECTOR_SCRIPT), 'the items are not joined with +');
  assert.ok(/ROUND \$\{r\.round_number\} · \$\{r\.message\}/.test(SECTOR_SCRIPT));
  assert.ok(/LAST UPKEEP/.test(CONTROL_SCRIPT) && /<th>STATUS<\/th>/.test(CONTROL_SCRIPT), 'the facilitator does not see PAID / UNPAID');
  assert.ok(/−\$\{s\.last_upkeep\.health_penalty\} HEALTH → \$\{s\.last_upkeep\.health_after\}%/.test(CONTROL_SCRIPT), 'the facilitator does not see the resulting Health');
  const g = at('R1');
  g.setInventory('AGR', { power: 0, water: 0, parts: 0, med: 0 });
  g.activateRound('R2');
  const agr = forSector(g, 'AGR').sectors.AGR;
  assert.deepEqual(agr.upkeep_per_round, { power: 2, water: 1 });
  assert.equal(agr.last_upkeep.message, 'UPKEEP SHORTFALL — -10 SECTOR HEALTH.');
  assert.equal(agr.integrity, 90, 'the console reads the same Health the engine holds');
  const pow = forSector(g, 'POW').sectors.POW;
  assert.equal(pow.last_upkeep.message, 'UPKEEP PAID — Sector stable.');
  assert.equal(pow.last_upkeep.health_after, 100);
  const control = forControl(g).sectors;
  assert.deepEqual([control.AGR.last_upkeep.status, control.AGR.last_upkeep.health_after, control.POW.last_upkeep.status], ['UNPAID', 90, 'PAID']);
  // The session timeline keeps every charge, in the spec's words.
  const d = analyse(g.log.readAll(), { runId: 'upkeep' });
  const lines = d.timeline.filter((e) => e.kind === 'upkeep').map((e) => e.text);
  assert.ok(lines.includes('R1 — POW upkeep paid: -2 Power, -1 Water.'), lines.join(' | '));
  assert.ok(lines.includes('R1 — AGR upkeep shortfall: -10 Sector Health.'), lines.join(' | '));
  assert.equal(d.rounds.R1.sectors.missed_upkeep, 1);
  // Nothing of this reaches the wall.
  const { forBigscreen } = require('../lib/visibility');
  assert.ok(!JSON.stringify(forBigscreen(g)).includes('last_upkeep'));
});
