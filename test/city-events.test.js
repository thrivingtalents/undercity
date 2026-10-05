'use strict';
/**
 * CITY EVENTS (CITY_EVENTS_V1, 2026-10-06).
 *
 * Ten facilitator-triggered, city-wide events — five GOOD, five BAD — applied
 * by one press of ACTIVATE through the engine's existing helpers: Health
 * through setIntegrity, injuries through injure(), temporary Workers through
 * the extra_workers effect, capacities through trn_capacity / med_capacity,
 * upkeep modifiers through the upkeep_extra obligation. EVT-001 … EVT-025 are
 * the specification's acceptance tests; the four interaction scenarios follow.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { newGame, logEvents } = require('./helpers');
const { forSector, forControl, forBigscreen } = require('../lib/visibility');
const { analyse } = require('../lib/analytics');
const economy = require('../lib/economy');
const DEFS = require('../lib/city-events.json');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CONTROL_HTML = read('public/control/index.html');
const CONTROL_JS = read('public/control/control.js');
const SECTOR_JS = read('public/sector/sector.js');
const SERVER_JS = read('server.js');

const SECTORS = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];
const ALL = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'];
const GOOD = ['CITY_SYSTEMS_STABILISED', 'TRANSPORT_CORRIDOR_CLEARED', 'EMERGENCY_MAINTENANCE_CREW', 'UTILITY_RESERVE_RELEASED', 'CITY_RECOVERY_PROTOCOL'];
const BAD = ['MONSTER_ATTACK', 'TUNNEL_NETWORK_DAMAGE', 'CORE_ENERGY_INSTABILITY', 'CITYWIDE_STRUCTURAL_DAMAGE', 'EMERGENCY_LOCKDOWN'];

/** A run played to `round` with every table stocked, its clock running, so the next activation charges upkeep. */
function at(round) {
  const g = newGame();
  g.clock('start'); g.tick(1000);
  for (const r of ALL.slice(1, ALL.indexOf(round) + 1)) {
    for (const s of SECTORS) g.setInventory(s, { power: 9, water: 9, parts: 9, med: 9 });
    g.activateRound(r); g.clock('start'); g.tick(1000);
  }
  for (const s of SECTORS) g.setInventory(s, { power: 9, water: 9, parts: 9, med: 9 });
  return g;
}
const next = (r) => ALL[ALL.indexOf(r) + 1];
const health = (g, s) => Math.round(g.state.sectors[s].integrity);
const avail = (g, s) => g.availableWorkers(g.state.sectors[s]);
const fire = (g, id, by) => g.activateCityEvent(id, { by: by || 'facilitator' });
const liveEffects = (g) => g.state.effects.filter((e) => e.source === 'city_event');
const view = (g) => forControl(g).city_events;
const card = (g, id) => view(g).events.find((e) => e.id === id);
const dark = (g, s) => { g.setIntegrity(s, 0); assert.equal(g.state.sectors[s].status, 'DARK'); };

// -- EVT-001 / EVT-002: the panel ----------------------------------------------------------------------

test('EVT-001: the Admin Control Panel holds exactly ten City Events — five GOOD, five BAD — from one authoritative file', () => {
  assert.equal(DEFS.version, 'CITY_EVENTS_V1');
  assert.equal(DEFS.events.length, 10);
  assert.deepEqual(DEFS.events.filter((e) => e.type === 'GOOD').map((e) => e.id), GOOD);
  assert.deepEqual(DEFS.events.filter((e) => e.type === 'BAD').map((e) => e.id), BAD);
  const v = view(newGame());
  assert.equal(v.events.length, 10);
  assert.equal(v.events.filter((e) => e.type === 'GOOD').length, 5);
  assert.equal(v.events.filter((e) => e.type === 'BAD').length, 5);
  for (const e of v.events) {
    for (const k of ['name', 'description', 'player_message', 'effect_summary', 'duration']) assert.ok(e[k], `${e.id}: ${k}`);
    assert.equal(e.status, 'available');
    assert.equal(e.button, 'ACTIVATE');
  }
  // the specification's example card
  assert.equal(card(newGame(), 'MONSTER_ATTACK').effect_summary, 'ALL SECTORS -10 HEALTH · 1 WORKER INJURED IN EVERY SECTOR');
  // the panel: a CITY EVENTS tab, GOOD and BAD groups, ACTIVE CITY EFFECTS and a history — rendered from the frame
  assert.ok(/data-sub="city">CITY EVENTS</.test(CONTROL_HTML));
  for (const id of ['ce-good', 'ce-bad', 'ce-active', 'ce-history']) assert.ok(CONTROL_HTML.includes(`id="${id}"`), id);
  assert.ok(/function renderCityEvents/.test(CONTROL_JS) && /renderCityEvents\(\);/.test(CONTROL_JS));
  // no event name or number is typed into the UI: the file is the only source
  for (const d of DEFS.events) assert.ok(!CONTROL_JS.includes(d.name) && !CONTROL_HTML.includes(d.name), `${d.name} is typed into the control panel`);
});

test('EVT-002: ACTIVATE is one press — no confirmation modal, no second step — and the server applies at once', () => {
  const start = CONTROL_JS.indexOf('function renderCityEvents');
  const end = CONTROL_JS.indexOf("$('btn-alert').addEventListener", start);
  const handler = CONTROL_JS.slice(start, end);
  assert.ok(/activate_city_event/.test(handler), 'the button does not send activate_city_event');
  assert.ok(!/confirm\(|openModal\(|openPicker\(/.test(handler), 'the press asks for confirmation');
  assert.ok(/case 'activate_city_event'/.test(SERVER_JS) && /city_event_result/.test(SERVER_JS), 'the server has no activate_city_event intent');
  // nothing optimistic: the card's state comes from the frame
  assert.ok(/e\.status === 'available'/.test(handler) && /esc\(e\.button\)/.test(handler));
  const g = at('R2');
  g.setIntegrity('POW', 80);
  const res = fire(g, 'CITY_SYSTEMS_STABILISED');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(health(g, 'POW'), 90, 'the effect did not apply in the same call');
});

// -- EVT-003 … EVT-014: the ten events ---------------------------------------------------------------

test('EVT-003 / EVT-004: CITY SYSTEMS STABILISED gives +10 Health to every non-DARK sector, capped at 100, and revives nobody', () => {
  const g = at('R3');
  g.setIntegrity('POW', 95); g.setIntegrity('WTR', 50); dark(g, 'MED');
  const res = fire(g, 'CITY_SYSTEMS_STABILISED');
  assert.equal(res.ok, true);
  assert.equal(health(g, 'POW'), 100, 'cap');
  assert.equal(health(g, 'WTR'), 60);
  for (const s of ['TRN', 'AGR', 'COM']) assert.equal(health(g, s), 100, s);
  assert.equal(health(g, 'MED'), 0, 'a DARK sector was revived');
  assert.equal(g.state.sectors.MED.status, 'DARK');
  assert.deepEqual(res.applied[0].skipped_dark, ['MED']);
  assert.equal(res.health.MED, undefined);
  assert.deepEqual(res.health.WTR, { before: 50, after: 60 });
  // immediate: nothing stays in ACTIVE CITY EFFECTS, the history keeps it
  assert.equal(view(g).active_effects.length, 0);
  assert.equal(view(g).history[0].event_id, 'CITY_SYSTEMS_STABILISED');
});

test('EVT-005: TRANSPORT CORRIDOR CLEARED lifts normal TRN capacity from 3 to 5 for the current round, without touching approvals used', () => {
  const g = at('R3');
  assert.equal(g.trnCapacity(), 3);
  g.state.trn_approvals_used_this_round = 1;
  const res = fire(g, 'TRANSPORT_CORRIDOR_CLEARED');
  assert.equal(res.ok, true);
  assert.equal(g.trnCapacity(), 5);
  assert.equal(g.stampsUsed(), 1, 'approvals used were reset');
  assert.equal(res.applied[0].capacity_before, 3);
  assert.equal(res.applied[0].capacity_after, 5);
  assert.equal(card(g, 'TRANSPORT_CORRIDOR_CLEARED').button, 'USED THIS ROUND');
  assert.deepEqual(view(g).active_effects.map((a) => a.text), ['TRN +2 TRANSFER CAPACITY · UNTIL ROUND END']);
  g.activateRound('R4');
  assert.equal(g.trnCapacity(), 3, 'the lift outlived the round');
  assert.equal(liveEffects(g).length, 0);
  assert.equal(card(g, 'TRANSPORT_CORRIDOR_CLEARED').button, 'ACTIVATE', 'the card did not come back');
  const expired = logEvents(g, 'city_event_effect_expired');
  assert.equal(expired.length, 1);
  assert.equal(expired[0].event_id, 'TRANSPORT_CORRIDOR_CLEARED');
});

test('EVT-006: EMERGENCY MAINTENANCE CREW gives every operating sector one temporary Worker and takes it back at round change', () => {
  const g = at('R3');
  dark(g, 'COM');
  const before = Object.fromEntries(SECTORS.map((s) => [s, avail(g, s)]));
  const res = fire(g, 'EMERGENCY_MAINTENANCE_CREW');
  assert.equal(res.ok, true);
  for (const s of SECTORS) assert.equal(avail(g, s), before[s] + (s === 'COM' ? 0 : 1), s);
  for (const s of SECTORS) assert.equal(g.state.sectors[s].workforce.active, 8, `${s}: the starting workforce was changed`);
  // the table reads its chip in the event's words
  const chip = forSector(g, 'POW').effects.find((e) => e.kind === 'extra_workers');
  assert.ok(chip && chip.player_label === '+1 WORKER · THIS ROUND', JSON.stringify(chip));
  assert.ok(/if \(e\.player_label\) return e\.player_label;/.test(SECTOR_JS));
  assert.equal(view(g).active_effects[0].text, 'POW + WTR + MED + TRN + AGR +1 WORKER · UNTIL ROUND END');
  g.activateRound('R4');
  for (const s of SECTORS) assert.equal(avail(g, s), before[s], `${s} kept the crew`);
  assert.equal(logEvents(g, 'city_event_effect_expired').length, 5);
});

test('EVT-007: UTILITY RESERVE RELEASED takes 1 Power off every sector\'s next upkeep, shows at once, and is consumed once', () => {
  const g = at('R3');
  for (const s of SECTORS) assert.deepEqual(economy.upkeepFor(g, g.state.sectors[s]), { power: 2, water: 1 });
  const res = fire(g, 'UTILITY_RESERVE_RELEASED');
  assert.equal(res.ok, true);
  for (const s of SECTORS) assert.deepEqual(economy.upkeepFor(g, g.state.sectors[s]), { power: 1, water: 1 }, s);
  assert.deepEqual(forSector(g, 'POW').sectors.POW.upkeep_delivery, { power: 1, water: 1 }, 'NEXT UPKEEP does not show the modifier');
  assert.equal(card(g, 'UTILITY_RESERVE_RELEASED').button, 'PENDING');
  assert.equal(fire(g, 'UTILITY_RESERVE_RELEASED').reason, 'city_event_pending');
  assert.deepEqual(view(g).active_effects.map((a) => a.text), ['ALL SECTORS -1 POWER · NEXT UPKEEP']);
  const power = g.state.sectors.POW.inventory.power;
  const act = g.activateRound('R4');
  assert.equal(act.charged, 'R3');
  const r = g.state.upkeep_results.R3.POW;
  assert.deepEqual([r.upkeep_status, r.upkeep_required, r.resources_deducted], ['PAID', { power: 1, water: 1 }, { power: 1, water: 1 }]);
  assert.equal(g.state.sectors.POW.inventory.power, power - 1);
  for (const s of SECTORS) assert.deepEqual(economy.upkeepFor(g, g.state.sectors[s]), { power: 2, water: 1 }, `${s}: the modifier survived its upkeep`);
  assert.equal(liveEffects(g).length, 0);
  assert.equal(logEvents(g, 'city_event_upkeep_effect_consumed').length, 6);
  assert.equal(card(g, 'UTILITY_RESERVE_RELEASED').button, 'ACTIVATE');
});

test('EVT-008: CITY RECOVERY PROTOCOL gives +5 Health to non-DARK sectors and lifts MED\'s healing allowance from 3 to 5 this round', () => {
  const g = at('R3');
  g.setIntegrity('WTR', 70); dark(g, 'COM');
  assert.equal(g.medCapacity(), 3);
  const res = fire(g, 'CITY_RECOVERY_PROTOCOL');
  assert.equal(res.ok, true);
  assert.equal(health(g, 'WTR'), 75);
  assert.equal(health(g, 'POW'), 100);
  assert.equal(health(g, 'COM'), 0);
  assert.equal(g.state.sectors.COM.status, 'DARK');
  assert.equal(g.medCapacity(), 5);
  assert.equal(g.medHealsUsed(), 0);
  for (const s of SECTORS) assert.equal(g.state.sectors[s].workforce.injured, 0, 'a Worker was healed by the event');
  assert.deepEqual(view(g).active_effects.map((a) => a.text), ['MED +2 HEALS · UNTIL ROUND END']);
  g.activateRound('R4');
  assert.equal(g.medCapacity(), 3);
});

test('EVT-009 / EVT-010: MONSTER ATTACK takes 10 Health and injures one Worker everywhere through the injury pipeline, which MED then heals', () => {
  const g = at('R3');
  g.adjustWorkforce('AGR', -8, 0);   // nobody left to injure
  assert.equal(g.state.sectors.AGR.workforce.active, 0);
  const injuriesBefore = logEvents(g, 'injury').length;
  const res = fire(g, 'MONSTER_ATTACK');
  assert.equal(res.ok, true);
  for (const s of SECTORS) assert.equal(health(g, s), 90, s);
  for (const s of SECTORS.filter((x) => x !== 'AGR')) {
    assert.equal(g.state.sectors[s].workforce.active, 7, s);
    assert.equal(g.state.sectors[s].workforce.injured, 1, s);
  }
  assert.deepEqual(g.state.sectors.AGR.workforce, { ...g.state.sectors.AGR.workforce, active: 0, injured: 0 }, 'a sector with no Worker went negative');
  assert.equal(logEvents(g, 'injury').length - injuriesBefore, 6, 'the existing injury pipeline was not used');
  assert.equal(res.applied[1].sectors.AGR, 0);
  assert.equal(res.applied[1].sectors.POW, 1);
  // EVT-010: the normal MED healing system processes the injury
  const h = g.requestHealing('POW', { by: 'POW' });
  assert.equal(h.ok, true, JSON.stringify(h));
  const healed = g.healWorker(h.healing.id, { by: 'MED' });
  assert.equal(healed.ok, true, JSON.stringify(healed));
  assert.equal(g.state.sectors.POW.workforce.injured, 0);
  assert.equal(g.state.sectors.POW.workforce.active, 8);
  assert.equal(g.medHealsUsed(), 1);
});

test('EVT-011: TUNNEL NETWORK DAMAGE drops TRN capacity from 3 to 2 without undoing approvals, and never below zero', () => {
  const g = at('R3');
  g.state.trn_approvals_used_this_round = 2;
  const res = fire(g, 'TUNNEL_NETWORK_DAMAGE');
  assert.equal(res.ok, true);
  assert.equal(g.trnCapacity(), 2);
  assert.equal(g.stampsUsed(), 2, 'approvals already made were revoked');
  assert.equal(Math.max(0, g.trnCapacity() - g.stampsUsed()), 0, 'further approvals are still open');
  assert.equal(g.pressureView().trn_capacity, 2);
  // used already above the new allowance: nothing is reversed, nothing goes negative
  g.state.trn_approvals_used_this_round = 3;
  assert.equal(g.trnCapacity(), 2);
  assert.equal(g.stampsUsed(), 3);
  g.activateRound('R4');
  assert.equal(g.trnCapacity(), 3);
});

test('EVT-012: CORE ENERGY INSTABILITY makes the next upkeep 3 Power + 1 Water, once, and goes with that upkeep', () => {
  const g = at('R3');
  const res = fire(g, 'CORE_ENERGY_INSTABILITY');
  assert.equal(res.ok, true);
  for (const s of SECTORS) assert.deepEqual(economy.upkeepFor(g, g.state.sectors[s]), { power: 3, water: 1 }, s);
  assert.deepEqual(forSector(g, 'TRN').sectors.TRN.upkeep_delivery, { power: 3, water: 1 });
  assert.equal(card(g, 'CORE_ENERGY_INSTABILITY').button, 'PENDING');
  const power = g.state.sectors.TRN.inventory.power;
  g.activateRound('R4');
  const r = g.state.upkeep_results.R3.TRN;
  assert.deepEqual([r.upkeep_required, r.resources_deducted], [{ power: 3, water: 1 }, { power: 3, water: 1 }]);
  assert.equal(g.state.sectors.TRN.inventory.power, power - 3);
  for (const s of SECTORS) assert.deepEqual(economy.upkeepFor(g, g.state.sectors[s]), { power: 2, water: 1 }, s);
  assert.equal(liveEffects(g).length, 0);
  assert.equal(logEvents(g, 'city_event_upkeep_effect_consumed').length, 6);
  assert.equal(card(g, 'CORE_ENERGY_INSTABILITY').button, 'ACTIVATE');
});

test('EVT-013: CITYWIDE STRUCTURAL DAMAGE takes 5 Health and one Worker of capacity this round, and injures nobody', () => {
  const g = at('R3');
  g.adjustWorkforce('AGR', -8, 0);
  dark(g, 'COM');
  const before = Object.fromEntries(SECTORS.map((s) => [s, avail(g, s)]));
  const injuries = logEvents(g, 'injury').length;
  const res = fire(g, 'CITYWIDE_STRUCTURAL_DAMAGE');
  assert.equal(res.ok, true);
  for (const s of SECTORS) assert.equal(health(g, s), s === 'COM' ? 0 : 95, s);
  for (const s of ['POW', 'WTR', 'MED', 'TRN']) assert.equal(avail(g, s), before[s] - 1, s);
  assert.equal(avail(g, 'AGR'), 0, 'available Workers went negative');
  assert.equal(avail(g, 'COM'), before.COM, 'a DARK sector lost capacity');
  for (const s of SECTORS) assert.equal(g.state.sectors[s].workforce.injured, 0, `${s}: an injury was created`);
  assert.equal(logEvents(g, 'injury').length, injuries, 'the injury pipeline was used');
  assert.equal(g.state.healing.length, 0, 'a Worker was sent to MED');
  assert.equal(forSector(g, 'POW').effects.find((e) => e.kind === 'extra_workers').player_label, '-1 WORKER · THIS ROUND');
  g.activateRound('R4');
  for (const s of SECTORS) assert.equal(avail(g, s), before[s], `${s} did not get its capacity back`);
});

test('EVT-014: EMERGENCY LOCKDOWN takes 5 Health and one approval and one heal off this round\'s allowances', () => {
  const g = at('R3');
  const res = fire(g, 'EMERGENCY_LOCKDOWN');
  assert.equal(res.ok, true);
  for (const s of SECTORS) assert.equal(health(g, s), 95, s);
  assert.equal(g.trnCapacity(), 2);
  assert.equal(g.medCapacity(), 2);
  assert.deepEqual(view(g).active_effects.map((a) => a.text).sort(), ['MED -1 HEAL · UNTIL ROUND END', 'TRN -1 TRANSFER CAPACITY · UNTIL ROUND END']);
  g.activateRound('R4');
  assert.equal(g.trnCapacity(), 3);
  assert.equal(g.medCapacity(), 3);
});

// -- EVT-015 / EVT-016: how effects end ------------------------------------------------------------

test('EVT-015: every THIS_ROUND effect ends when NEXT ROUND is activated, and is logged as expired', () => {
  const g = at('R3');
  for (const id of ['TRANSPORT_CORRIDOR_CLEARED', 'EMERGENCY_MAINTENANCE_CREW', 'CITY_RECOVERY_PROTOCOL', 'EMERGENCY_LOCKDOWN']) assert.equal(fire(g, id).ok, true, id);
  const round = liveEffects(g).filter((e) => e.expires === 'round');
  assert.equal(round.length, 1 + 6 + 1 + 2, 'the round effects');
  assert.equal(view(g).active_effects.length, 5);
  g.activateRound('R4');
  assert.equal(liveEffects(g).length, 0);
  assert.equal(view(g).active_effects.length, 0);
  assert.equal(logEvents(g, 'city_event_effect_expired').length, 10);
  assert.equal(g.trnCapacity(), 3);
  assert.equal(g.medCapacity(), 3);
});

test('EVT-016: a NEXT_UPKEEP effect stays pending until an upkeep is actually processed — a round change that charges nothing leaves it', () => {
  const g = newGame();   // Round 0, its clock never started: moving on charges nothing
  assert.equal(fire(g, 'CORE_ENERGY_INSTABILITY').ok, true);
  g.tick(120000);
  const act = g.activateRound('R1');
  assert.equal(act.ok, true);
  assert.equal(act.charged, null, 'Round 0 was charged without a clock');
  assert.equal(liveEffects(g).length, 6, 'the modifier went without an upkeep');
  assert.equal(card(g, 'CORE_ENERGY_INSTABILITY').button, 'PENDING');
  for (const s of SECTORS) assert.deepEqual(economy.upkeepFor(g, g.state.sectors[s]), { power: 3, water: 1 });
  for (const s of SECTORS) g.setInventory(s, { power: 9, water: 9, parts: 9, med: 9 });
  economy.processCycle(g, { round: g.state.round });
  assert.equal(liveEffects(g).length, 0, 'the upkeep did not consume the modifier');
  assert.equal(logEvents(g, 'city_event_upkeep_effect_consumed').length, 6);
  assert.equal(card(g, 'CORE_ENERGY_INSTABILITY').button, 'ACTIVATE');
});

// -- EVT-017 … EVT-020: the room, the log, not a fault -----------------------------------------------

test('EVT-017: every activation raises the City Alert on all six consoles — the name, the plain effect, nothing internal', () => {
  const g = at('R3');
  assert.equal(fire(g, 'MONSTER_ATTACK').ok, true);
  for (const s of SECTORS) {
    const frame = forSector(g, s);
    assert.ok(frame.alert, `${s}: no alert`);
    assert.equal(frame.alert.title, 'MONSTER ATTACK');
    assert.equal(frame.alert.subtitle, 'All sectors lose 10 Health. 1 Worker is injured in every sector.');
    assert.equal(frame.alert.full_screen, true);
    assert.equal(frame.alert.full_s, 8);
    assert.ok(frame.ticker.some((e) => e.kind === 'event' && e.text === 'MONSTER ATTACK'), `${s}: the feed has no entry`);
    assert.equal(frame.city_events, undefined, `${s} was sent the admin catalogue`);
    assert.ok(!JSON.stringify(frame).includes('MONSTER_ATTACK'), `${s} was sent the internal id`);
  }
  const alerts = logEvents(g, 'alert');
  assert.equal(alerts[alerts.length - 1].title, 'MONSTER ATTACK');
});

test('EVT-018: every activation reaches the big screen at once — the alert strip and the city event feed', () => {
  const g = at('R3');
  assert.equal(fire(g, 'CITY_RECOVERY_PROTOCOL').ok, true);
  const wall = forBigscreen(g);
  assert.ok(wall.alert && wall.alert.title === 'CITY RECOVERY PROTOCOL');
  assert.equal(wall.alert.subtitle, 'All operating sectors recover 5 Health. MED receives 2 additional heals this round.');
  const feed = Array.isArray(wall.ticker) ? wall.ticker : wall.feed;
  assert.ok(feed.some((e) => e.kind === 'event' && e.text === 'CITY RECOVERY PROTOCOL'), 'the wall feed has no entry');
  assert.ok(!JSON.stringify(wall).includes('CITY_RECOVERY_PROTOCOL') && !JSON.stringify(wall).includes('city_events'), 'the wall was sent admin data');
});

test('EVT-019: every activation is written to the run log with what was asked, what happened, to whom, and for how long', () => {
  const g = at('R3');
  g.setIntegrity('WTR', 50);
  assert.equal(fire(g, 'EMERGENCY_LOCKDOWN', 'facilitator').ok, true);
  const logged = logEvents(g, 'city_event_activated');
  assert.equal(logged.length, 1);
  const e = logged[0];
  assert.equal(e.round, 'R3');
  assert.equal(e.event_id, 'EMERGENCY_LOCKDOWN');
  assert.equal(e.event_name, 'EMERGENCY LOCKDOWN');
  assert.equal(e.event_type, 'BAD');
  assert.equal(e.by, 'facilitator');
  assert.ok(e.t && e.activation);
  assert.equal(e.effects_requested.length, 3);
  assert.deepEqual(e.effects_applied.map((a) => a.kind), ['health', 'trn_capacity', 'med_capacity']);
  assert.deepEqual([...e.affected_sectors].sort(), [...SECTORS].sort());
  assert.deepEqual(e.health.WTR, { before: 50, after: 45 });
  assert.equal(e.duration, 'MIXED');
  assert.equal(e.expiry, 'ROUND_CHANGE');
  assert.equal(e.repeat_policy, 'ONCE_PER_ROUND');
  // the debrief timeline carries it as a city event, never as a fault
  const report = analyse(g.log.readAll());
  const line = (report.timeline || []).find((x) => x.kind === 'city_event');
  assert.ok(line && /EMERGENCY LOCKDOWN/.test(line.text), JSON.stringify(line));
  assert.ok(!(report.timeline || []).some((x) => x.kind === 'fault' && /LOCKDOWN/.test(x.text)));
});

test('EVT-020: City Events never appear as ACTIVE FAULTS, on any screen', () => {
  const g = at('R3');
  for (const id of [...GOOD, ...BAD]) assert.equal(fire(g, id).ok, true, id);
  for (const s of SECTORS) {
    assert.equal(g.state.sectors[s].faults.length, 0, `${s} grew a fault`);
    assert.equal(forSector(g, s).sectors[s].faults.length, 0);
    assert.equal(forControl(g).sectors[s].faults.length, 0);
  }
  assert.equal(logEvents(g, 'fault_fired').length, 0);
  assert.equal(logEvents(g, 'city_event_activated').length, 10);
});

// -- EVT-021 / EVT-022: repeats and combinations ------------------------------------------------------

test('EVT-021: the same event cannot apply twice from a rapid double-click, and a bad request applies nothing', () => {
  const g = at('R3');
  const first = fire(g, 'MONSTER_ATTACK');
  const second = fire(g, 'MONSTER_ATTACK');
  assert.equal(first.ok, true);
  assert.deepEqual([second.ok, second.reason], [false, 'city_event_used_this_round']);
  for (const s of SECTORS) assert.equal(health(g, s), 90, `${s} was hit twice`);
  for (const s of SECTORS) assert.equal(g.state.sectors[s].workforce.injured, 1, `${s} was injured twice`);
  assert.equal(logEvents(g, 'city_event_activated').length, 1);
  // a NEXT_UPKEEP event: PENDING until its upkeep, then available again
  assert.equal(fire(g, 'UTILITY_RESERVE_RELEASED').ok, true);
  assert.equal(fire(g, 'UTILITY_RESERVE_RELEASED').reason, 'city_event_pending');
  assert.equal(liveEffects(g).filter((e) => e.kind === 'upkeep_extra').length, 6);
  // unknown, and after the run has ended: refused, nothing touched
  const before = JSON.stringify(g.state.sectors);
  assert.equal(fire(g, 'NOT_AN_EVENT').reason, 'unknown_city_event');
  g.state.mode = 'ENDED';
  assert.equal(fire(g, 'CITY_SYSTEMS_STABILISED').reason, 'run_ended');
  assert.equal(JSON.stringify(g.state.sectors), before);
  // a new round frees a ONCE_PER_ROUND card
  g.state.mode = 'PLAY';
  g.activateRound('R4');
  assert.equal(card(g, 'MONSTER_ATTACK').button, 'ACTIVATE');
  assert.equal(fire(g, 'MONSTER_ATTACK').ok, true);
});

test('EVT-022: different events coexist and their modifiers combine — TRN 5 then 4, MED 5 then 4, upkeep -1 then back to 2', () => {
  const g = at('R3');
  // GOOD + BAD on TRN
  assert.equal(fire(g, 'TRANSPORT_CORRIDOR_CLEARED').ok, true);
  assert.equal(g.trnCapacity(), 5);
  assert.equal(fire(g, 'TUNNEL_NETWORK_DAMAGE').ok, true);
  assert.equal(g.trnCapacity(), 4);
  // GOOD + BAD on MED
  assert.equal(fire(g, 'CITY_RECOVERY_PROTOCOL').ok, true);
  assert.equal(g.medCapacity(), 5);
  assert.equal(fire(g, 'EMERGENCY_LOCKDOWN').ok, true);
  assert.equal(g.medCapacity(), 4);
  assert.equal(g.trnCapacity(), 3, 'the lockdown also costs TRN one');
  // opposing upkeep effects
  assert.equal(fire(g, 'UTILITY_RESERVE_RELEASED').ok, true);
  assert.deepEqual(economy.upkeepFor(g, g.state.sectors.POW), { power: 1, water: 1 });
  assert.equal(fire(g, 'CORE_ENERGY_INSTABILITY').ok, true);
  assert.deepEqual(economy.upkeepFor(g, g.state.sectors.POW), { power: 2, water: 1 }, 'the net modifier is not zero');
  assert.equal(card(g, 'UTILITY_RESERVE_RELEASED').button, 'PENDING');
  assert.equal(card(g, 'CORE_ENERGY_INSTABILITY').button, 'PENDING');
  // seven lines: TRN +2, TRN -1 (tunnel), MED +2, TRN -1 and MED -1 (lockdown), -1 POWER, +1 POWER — one per activation and kind, never merged across events
  assert.equal(view(g).active_effects.length, 7, JSON.stringify(view(g).active_effects.map((a) => a.text)));
  g.activateRound('R4');
  assert.deepEqual(g.state.upkeep_results.R3.POW.resources_deducted, { power: 2, water: 1 });
  assert.equal(liveEffects(g).length, 0);
  assert.equal(g.trnCapacity(), 3);
  assert.equal(g.medCapacity(), 3);
});

test('a BAD event can take a sector to 0 and DARK; a GOOD one leaves it DARK until Emergency Restart', () => {
  const g = at('R3');
  g.setIntegrity('POW', 8);
  assert.equal(fire(g, 'MONSTER_ATTACK').ok, true);
  assert.equal(health(g, 'POW'), 0);
  assert.equal(g.state.sectors.POW.status, 'DARK');
  assert.ok(logEvents(g, 'status').some((e) => e.sector === 'POW' && e.status === 'DARK'), 'the existing DARK pathway did not fire');
  assert.equal(fire(g, 'CITY_SYSTEMS_STABILISED').ok, true);
  assert.equal(health(g, 'POW'), 0, 'a City Event revived a DARK sector');
  assert.equal(g.state.sectors.POW.status, 'DARK');
  assert.equal(health(g, 'WTR'), 100);
  assert.equal(forSector(g, 'POW').sectors.POW.status, 'DARK');
});

// -- EVT-023 / EVT-024: persistence and reset ---------------------------------------------------------

test('EVT-023: save/restore keeps active effects, pending modifiers, used-this-round marks and the history; nothing expired comes back', () => {
  const g = at('R3');
  assert.equal(fire(g, 'TRANSPORT_CORRIDOR_CLEARED').ok, true);
  assert.equal(fire(g, 'UTILITY_RESERVE_RELEASED').ok, true);
  assert.equal(fire(g, 'MONSTER_ATTACK').ok, true);
  const snap = JSON.parse(JSON.stringify(g.serialise()));
  const back = newGame({ runId: 'city-events-restore' });
  back.restore(snap);
  assert.equal(back.trnCapacity(), 5);
  assert.deepEqual(economy.upkeepFor(back, back.state.sectors.POW), { power: 1, water: 1 });
  assert.equal(card(back, 'MONSTER_ATTACK').button, 'USED THIS ROUND');
  assert.equal(card(back, 'UTILITY_RESERVE_RELEASED').button, 'PENDING');
  assert.equal(card(back, 'TRANSPORT_CORRIDOR_CLEARED').button, 'USED THIS ROUND');
  assert.equal(view(back).history.length, 3);
  assert.equal(fire(back, 'MONSTER_ATTACK').reason, 'city_event_used_this_round');
  // expired effects do not reactivate after a restore
  g.activateRound('R4');
  assert.equal(liveEffects(g).filter((e) => e.expires === 'round').length, 0);
  const later = newGame({ runId: 'city-events-restore-2' });
  later.restore(JSON.parse(JSON.stringify(g.serialise())));
  assert.equal(later.trnCapacity(), 3);
  assert.equal(card(later, 'TRANSPORT_CORRIDOR_CLEARED').button, 'ACTIVATE');
  assert.equal(card(later, 'UTILITY_RESERVE_RELEASED').button, 'ACTIVATE', 'the consumed modifier came back');
  assert.equal(view(later).history.length, 3);
  // a snapshot from before City Events existed restores with a clean catalogue
  const old = JSON.parse(JSON.stringify(g.serialise()));
  delete old.state.city_events;
  const legacy = newGame({ runId: 'city-events-legacy' });
  legacy.restore(old);
  assert.equal(view(legacy).events.length, 10);
  assert.equal(fire(legacy, 'CITY_SYSTEMS_STABILISED').ok, true);
});

test('EVT-024: RESET RUN removes every City Event effect, pending modifier, mark and history, and restores normal capacities', () => {
  const g = at('R3');
  for (const id of ['TRANSPORT_CORRIDOR_CLEARED', 'UTILITY_RESERVE_RELEASED', 'MONSTER_ATTACK', 'EMERGENCY_MAINTENANCE_CREW']) assert.equal(fire(g, id).ok, true, id);
  assert.ok(liveEffects(g).length > 0);
  g.reset('city-events-fresh');
  assert.deepEqual(g.state.effects, []);
  assert.deepEqual(g.state.city_events, { used: {}, history: [] });
  assert.equal(g.trnCapacity(), 3);
  assert.equal(g.medCapacity(), 3);
  for (const s of SECTORS) {
    assert.deepEqual([g.state.sectors[s].workforce.active, g.state.sectors[s].workforce.injured], [8, 0], s);
    assert.deepEqual(economy.upkeepFor(g, g.state.sectors[s]), { power: 2, water: 1 }, s);
    assert.equal(health(g, s), 100, s);
  }
  for (const e of view(g).events) assert.equal(e.button, 'ACTIVATE', e.id);
  assert.equal(view(g).history.length, 0);
  assert.equal(view(g).active_effects.length, 0);
});

// -- the engine underneath -----------------------------------------------------------------------------

test('every effect is applied through the engine\'s existing helper — no second Health, Worker, TRN, MED or upkeep system', () => {
  const src = read('lib/city-events.js');
  for (const helper of ['this.setIntegrity(', 'this.injure(', 'this.addEffect(', 'this.trnCapacity()', 'this.medCapacity()', 'this.setAlert(', 'this.periodKey()']) {
    assert.ok(src.includes(helper), `the mixin does not call ${helper}`);
  }
  for (const forbidden of ['.integrity =', 'workforce.active =', 'workforce.injured =', 'trn_approvals_used_this_round', 'med_heals_used_this_round', 'upkeep_per_round']) {
    assert.ok(!src.includes(forbidden), `the mixin writes ${forbidden} itself`);
  }
  // the effect kinds the events create are the ones the engine already reads
  const g = at('R3');
  for (const id of [...GOOD, ...BAD]) fire(g, id);
  const kinds = new Set(liveEffects(g).map((e) => e.kind));
  assert.deepEqual([...kinds].sort(), ['extra_workers', 'med_capacity', 'trn_capacity', 'upkeep_extra']);
  for (const e of liveEffects(g)) assert.ok(e.event_id && e.activation && e.player_label, `${e.id} is not marked as a City Event's`);
  // the economy's single calculator never goes below zero, even stacked
  const h = at('R3');
  fire(h, 'UTILITY_RESERVE_RELEASED');
  h.setStatus('WTR', 'BROWNOUT');   // half rations: floor(2 * 0.5) = 1 Power, then -1
  assert.deepEqual(economy.upkeepFor(h, h.state.sectors.WTR).power, 0);
});
