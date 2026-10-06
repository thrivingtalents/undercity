'use strict';
/**
 * CITY EVENTS — ACTIVATE / DEACTIVATE and the colour overlay (2026-10-06).
 *
 * Every event can be activated and deactivated. Activation is immediate and
 * paints every console and the wall: GREEN with the words POSITIVE CITY EVENT
 * for a GOOD event, RED with CITY EMERGENCY for a BAD one, four seconds of
 * wash and then a subtle active state. Deactivation ends only what is still
 * in force — a round modifier still live, an upkeep modifier not yet consumed
 * — and never what already happened: Health taken or given, Workers injured,
 * transfers approved, heals performed. The newest active event owns the
 * colour; when it goes, the colour falls back to the one before it.
 *
 *   EVT-UI-001  every inactive event shows ACTIVATE
 *   EVT-UI-002  after activation the same event shows ACTIVE and DEACTIVATE; ACTIVATE is refused while active, DEACTIVATE when inactive
 *   EVT-UI-003  a GOOD activation paints a green overlay on every console and the wall
 *   EVT-UI-004  a BAD activation paints a red overlay on every console and the wall
 *   EVT-UI-005  the overlay never hides DARK or CRITICAL
 *   EVT-UI-006  deactivation removes the overlay and the banner at once
 *   EVT-UI-007  deactivating CITY SYSTEMS STABILISED does not subtract the Health it restored
 *   EVT-UI-008  deactivating MONSTER ATTACK restores no Health and heals nobody
 *   EVT-UI-009  deactivating TRANSPORT CORRIDOR CLEARED removes only its +2 TRN capacity
 *   EVT-UI-010  deactivating TUNNEL NETWORK DAMAGE removes only its -1 TRN capacity
 *   EVT-UI-011  deactivating CITY RECOVERY PROTOCOL keeps the +5 Health and the heals done, removes the +2 healing capacity
 *   EVT-UI-012  deactivating EMERGENCY LOCKDOWN keeps the damage, removes the TRN and MED penalties
 *   EVT-UI-013  deactivating an unconsumed NEXT_UPKEEP event cancels its pending modifier
 *   EVT-UI-014  deactivating a NEXT_UPKEEP event after its upkeep reverses nothing
 *   EVT-UI-015  different active events coexist
 *   EVT-UI-016  the most recently activated active event controls the colour
 *   EVT-UI-017  when the latest event is deactivated the colour falls back to the previous one
 *   EVT-UI-018  save/restore preserves the active events without replaying their consequences
 *   EVT-UI-019  RESET RUN clears every activation and the overlay
 *   EVT-UI-020  the rest of the suite is the regression run (node --test test/*.test.js)
 *   plus        auto-expiry by category, the log, the admin panel and the double press
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { newGame, logEvents } = require('./helpers');
const { forSector, forControl, forBigscreen } = require('../lib/visibility');
const economy = require('../lib/economy');
const B = require('../public/shared/bigscreen');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SECTORS = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];
const ALL = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'];
const GOOD = ['CITY_SYSTEMS_STABILISED', 'TRANSPORT_CORRIDOR_CLEARED', 'EMERGENCY_MAINTENANCE_CREW', 'UTILITY_RESERVE_RELEASED', 'CITY_RECOVERY_PROTOCOL'];
const BAD = ['MONSTER_ATTACK', 'TUNNEL_NETWORK_DAMAGE', 'CORE_ENERGY_INSTABILITY', 'CITYWIDE_STRUCTURAL_DAMAGE', 'EMERGENCY_LOCKDOWN'];

/** A run played to `round` with every table stocked and its clock running. */
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
const health = (g, s) => Math.round(g.state.sectors[s].integrity);
const fire = (g, id) => g.activateCityEvent(id, { by: 'facilitator' });
const stop = (g, id) => g.deactivateCityEvent(id, { by: 'facilitator' });
const live = (g, id = null) => g.cityEventEffects(id);
const view = (g) => forControl(g).city_events;
const card = (g, id) => view(g).events.find((e) => e.id === id);
const overlay = (frame) => frame.city_event;
const current = (frame) => (frame.city_event ? frame.city_event.current : undefined);
const everyScreen = (g) => [...SECTORS.map((s) => forSector(g, s)), forBigscreen(g)];

// -- the cards --------------------------------------------------------------------------------------

test('EVT-UI-001: every inactive event shows ACTIVATE, and the panel says INACTIVE beside it', () => {
  const v = view(newGame());
  assert.equal(v.events.length, 10);
  for (const e of v.events) {
    assert.equal(e.active, false, e.id);
    assert.equal(e.button, 'ACTIVATE', e.id);
    assert.equal(e.status, 'available', e.id);
    assert.equal(e.activation, null);
  }
  assert.deepEqual(v.active_events, []);
  const control = read('public/control/control.js');
  const start = control.indexOf('function renderCityEvents');
  const end = control.indexOf("$('btn-alert').addEventListener", start);
  const handler = control.slice(start, end);
  assert.ok(/'INACTIVE'/.test(handler) && /'ACTIVE'/.test(handler), 'the card does not say ACTIVE / INACTIVE');
  assert.ok(/data-act=/.test(handler) && /deactivate_city_event/.test(handler) && /activate_city_event/.test(handler));
  assert.ok(!/confirm\(|openModal\(|openPicker\(/.test(handler), 'a press asks for confirmation');
  assert.ok(/b\.disabled = true/.test(handler), 'the button is not disabled on press — a double-click would send twice');
  assert.ok(/ACTIVE CITY EVENTS/.test(read('public/control/index.html')), 'the panel has no ACTIVE CITY EVENTS block');
  assert.ok(/case 'deactivate_city_event'/.test(read('server.js')), 'the server has no deactivate intent');
});

test('EVT-UI-002: after activation the event shows ACTIVE and DEACTIVATE; a second ACTIVATE is refused, a DEACTIVATE of an inactive event too, and nothing applies twice', () => {
  const g = at('R2');
  g.setIntegrity('POW', 80);
  const on = fire(g, 'CITY_SYSTEMS_STABILISED');
  assert.equal(on.ok, true, on.reason);
  assert.equal(on.action, 'activate');
  assert.equal(on.active, true);
  assert.equal(on.overlay, 'green');
  assert.equal(on.label, 'POSITIVE CITY EVENT');
  const c = card(g, 'CITY_SYSTEMS_STABILISED');
  assert.equal(c.active, true);
  assert.equal(c.button, 'DEACTIVATE');
  assert.equal(c.status, 'active');
  assert.equal(c.activated_round, 'R2');
  assert.ok(c.activated_at && c.activation);
  assert.equal(c.activated_by, 'facilitator');
  assert.equal(c.remaining, 'IMMEDIATE · NO REMAINING EFFECT');
  assert.equal(health(g, 'POW'), 90);
  // the double-click: refused, nothing applied twice
  const again = fire(g, 'CITY_SYSTEMS_STABILISED');
  assert.deepEqual([again.ok, again.reason], [false, 'event_already_active']);
  assert.equal(health(g, 'POW'), 90);
  assert.equal(logEvents(g, 'city_event_activated').length, 1);
  // DEACTIVATE once; a second press meets an inactive event
  const off = stop(g, 'CITY_SYSTEMS_STABILISED');
  assert.equal(off.ok, true);
  assert.equal(off.action, 'deactivate');
  assert.equal(off.active, false);
  assert.deepEqual([stop(g, 'CITY_SYSTEMS_STABILISED').ok, stop(g, 'CITY_SYSTEMS_STABILISED').reason], [false, 'event_not_active']);
  assert.equal(stop(g, 'NOT_AN_EVENT').reason, 'unknown_city_event');
  assert.equal(stop(g, 'TUNNEL_NETWORK_DAMAGE').reason, 'event_not_active');
  assert.equal(logEvents(g, 'city_event_deactivated').length, 1);
  // a once-a-round event that was deactivated waits for the next round, as before
  assert.equal(card(g, 'CITY_SYSTEMS_STABILISED').button, 'USED THIS ROUND');
  assert.equal(card(g, 'CITY_SYSTEMS_STABILISED').active, false);
});

// -- the overlay -------------------------------------------------------------------------------------

test('EVT-UI-003: a GOOD activation paints a green overlay — POSITIVE CITY EVENT, the name, the effect — on every console and the big screen', () => {
  const g = at('R2');
  assert.equal(fire(g, 'TRANSPORT_CORRIDOR_CLEARED').ok, true);
  for (const frame of everyScreen(g)) {
    const cur = current(frame);
    assert.ok(cur, 'no overlay');
    assert.equal(cur.type, 'GOOD');
    assert.equal(cur.colour, 'green');
    assert.equal(cur.label, 'POSITIVE CITY EVENT');
    assert.equal(cur.name, 'TRANSPORT CORRIDOR CLEARED');
    assert.equal(cur.effect_summary, 'TRN +2 TRANSFER APPROVALS · THIS ROUND');
    assert.equal(cur.full_screen, true);
    assert.equal(cur.full_s, 4);
    assert.ok(cur.age_s >= 0 && cur.age_s < 4);
    assert.equal(cur.round_number, 2);
    assert.equal(overlay(frame).count, 1);
    assert.equal(frame.alert, null, 'the red City Alert was raised for a GOOD event');
    assert.ok(!('event_id' in cur) && !JSON.stringify(overlay(frame)).includes('TRANSPORT_CORRIDOR_CLEARED'), 'the room was sent the internal id');
  }
  const chip = B.buildAlerts(forBigscreen(g)).find((c) => c.kind === 'city');
  assert.deepEqual([chip.accent, chip.head, chip.detail], ['green', 'POSITIVE CITY EVENT · TRANSPORT CORRIDOR CLEARED', 'TRN +2 TRANSFER APPROVALS · THIS ROUND']);
  // the screens know the words and the colours
  const sectorJs = read('public/sector/sector.js');
  const sectorCss = read('public/sector/sector.css');
  const wallJs = read('public/wall/wall.js');
  const wallCss = read('public/wall/wall.css');
  assert.ok(/renderCityEvent\(/.test(sectorJs) && /city-good/.test(sectorJs) && /banner-city-event/.test(sectorJs) && /ACTIVE CITY EVENT · /.test(sectorJs));
  assert.ok(/rgba\(30, 170, 90, 0\.20\)/.test(sectorCss) && /rgba\(210, 45, 45, 0\.22\)/.test(sectorCss), 'the console wash is not the brief\'s colours');
  assert.ok(/#2EAD63/.test(sectorCss) && /#D52D2D/.test(sectorCss), 'the console accents are not the brief\'s');
  assert.ok(/renderCityEvent\(/.test(wallJs) && /city-takeover/.test(wallJs) && /dataset\.cityEvent/.test(wallJs));
  assert.ok(/\.takeover\.city \{[^}]*rgba\(30, 170, 90, 0\.20\)/.test(wallCss) && /\.takeover\.city\.bad \{[^}]*rgba\(210, 45, 45, 0\.22\)/.test(wallCss));
  assert.ok(/\.chip\[data-accent="green"\]/.test(wallCss), 'the strip has no green chip');
  assert.ok(/CITY_TAKEOVER_S = 4/.test(sectorJs) && /CITY_TAKEOVER_S = 4/.test(wallJs), 'the wash is not four seconds');
});

test('EVT-UI-004: a BAD activation paints a red overlay — CITY EMERGENCY, the name, the effect — on every console and the big screen', () => {
  const g = at('R2');
  assert.equal(fire(g, 'TUNNEL_NETWORK_DAMAGE').ok, true);
  for (const frame of everyScreen(g)) {
    const cur = current(frame);
    assert.ok(cur, 'no overlay');
    assert.deepEqual([cur.type, cur.colour, cur.label, cur.name], ['BAD', 'red', 'CITY EMERGENCY', 'TUNNEL NETWORK DAMAGE']);
    assert.equal(cur.effect_summary, 'TRN -1 TRANSFER APPROVAL · THIS ROUND');
    assert.equal(cur.full_screen, true);
  }
  const chip = B.buildAlerts(forBigscreen(g)).find((c) => c.kind === 'city');
  assert.deepEqual([chip.accent, chip.head], ['red', 'CITY EMERGENCY · TUNNEL NETWORK DAMAGE']);
});

test('EVT-UI-005: the overlay never hides DARK or CRITICAL — in the frame, in the stacking order, and in the script that withholds the colour', () => {
  const g = at('R2');
  g.setIntegrity('WTR', 0);
  g.setIntegrity('MED', 10);
  assert.equal(g.state.sectors.WTR.status, 'DARK');
  assert.equal(g.state.sectors.MED.status, 'CRITICAL');
  assert.equal(fire(g, 'CITY_SYSTEMS_STABILISED').ok, true);
  // the frames still say DARK and CRITICAL beside the overlay: a gain revives nobody, and 20 is still under 30
  assert.equal(forSector(g, 'WTR').sectors.WTR.status, 'DARK');
  assert.equal(health(g, 'MED'), 20);
  assert.equal(forSector(g, 'MED').sectors.MED.status, 'CRITICAL');
  assert.equal(current(forSector(g, 'WTR')).type, 'GOOD');
  // the wall's strip puts DARK and CRITICAL before the city chip
  const kinds = B.buildAlerts(forBigscreen(g)).map((c) => c.kind);
  assert.ok(kinds.indexOf('dark') < kinds.indexOf('city') && kinds.indexOf('critical') < kinds.indexOf('city'), kinds.join(' '));
  // the console: the wash and the glow sit under the CRITICAL wash, SECTOR OFFLINE, SIMULATION PAUSED and the alert
  const css = read('public/sector/sector.css');
  const z = (re) => Number((css.match(re) || [])[1]);
  const cityZ = z(/\.city-takeover \{[^}]*z-index: (\d+)/);
  const glowZ = z(/body\.city-good::after, body\.city-bad::after \{[^}]*z-index: (\d+)/);
  const criticalZ = z(/\.critical-overlay \{[^}]*z-index: (\d+)/);
  const overlayZ = z(/\.overlay \{[^}]*z-index: (\d+)/);          // SECTOR OFFLINE and SIMULATION PAUSED
  const alertZ = z(/\.alert-full \{[^}]*z-index: (\d+)/);
  assert.ok(cityZ < criticalZ && glowZ < criticalZ && criticalZ < overlayZ && overlayZ < alertZ, `z: city ${cityZ} glow ${glowZ} critical ${criticalZ} overlay ${overlayZ} alert ${alertZ}`);
  assert.ok(/\.city-takeover \{[^}]*pointer-events: none/.test(css) && /body\.city-good::after, body\.city-bad::after \{[^}]*pointer-events: none/.test(css), 'the city overlay takes clicks');
  const js = read('public/sector/sector.js');
  assert.ok(/const suppressed = word === 'DARK' \|\| !!critical \|\| !!state\.paused \|\| !!\(alertSeen && alertSeen\.full\)/.test(js), 'the console does not withhold the colour under DARK / CRITICAL / PAUSED / an alert');
  assert.ok(/body\.classList\.toggle\('city-good', !!cur && cur\.type === 'GOOD' && !suppressed\)/.test(js));
  // the wall: the wash sits under the alert takeover and SIMULATION PAUSED, and the glow is on the map frame alone
  const wall = read('public/wall/wall.css');
  const wz = (re) => Number((wall.match(re) || [])[1]);
  assert.ok(wz(/\.takeover\.city \{[^}]*z-index: (\d+)/) < wz(/\.takeover \{[^}]*z-index: (\d+)/) && wz(/\.takeover \{[^}]*z-index: (\d+)/) < wz(/\.paused \{[^}]*z-index: (\d+)/));
  assert.ok(/\.wall\[data-city-event="good"\] \.city-frame \{/.test(wall) && /\.wall\[data-city-event="bad"\] \.city-frame \{/.test(wall));
  assert.ok(!/data-city-event[^\n]*\.(card|sector|hud)/.test(wall), 'the wall glow touches the cards');
});

test('EVT-UI-006: deactivation removes the overlay and the banner at once, on every screen', () => {
  const g = at('R2');
  assert.equal(fire(g, 'EMERGENCY_MAINTENANCE_CREW').ok, true);
  for (const frame of everyScreen(g)) assert.ok(current(frame));
  assert.equal(stop(g, 'EMERGENCY_MAINTENANCE_CREW').ok, true);
  for (const frame of everyScreen(g)) {
    assert.equal(current(frame), null);
    assert.equal(overlay(frame).count, 0);
    assert.deepEqual(overlay(frame).active, []);
  }
  assert.ok(!B.buildAlerts(forBigscreen(g)).some((c) => c.kind === 'city'));
  // the console clears its banner, classes and wash from the frame, and never replays a wash it has shown
  const js = read('public/sector/sector.js');
  assert.ok(/if \(!cur\) \{\s*cityTakeover = null;\s*show\(\$\('banner-city-event'\), false\);\s*show\(\$\('city-takeover'\), false\);/.test(js));
  assert.ok(/cityTakeoverSeen\.has\(cur\.activation\)/.test(js) && /cityTakeoverSeen\.has\(cur\.activation\)/.test(read('public/wall/wall.js')));
});

// -- what deactivation does and does not undo ---------------------------------------------------------

test('EVT-UI-007: deactivating CITY SYSTEMS STABILISED does not subtract the Health it restored', () => {
  const g = at('R2');
  for (const s of SECTORS) g.setIntegrity(s, 70);
  assert.equal(fire(g, 'CITY_SYSTEMS_STABILISED').ok, true);
  for (const s of SECTORS) assert.equal(health(g, s), 80, s);
  const off = stop(g, 'CITY_SYSTEMS_STABILISED');
  assert.equal(off.ok, true);
  for (const s of SECTORS) assert.equal(health(g, s), 80, `${s} lost the Health again`);
  assert.deepEqual(off.effects_removed, []);
  assert.deepEqual(off.pending_effects_cancelled, []);
  assert.equal(off.effects_not_reversed.length, 1);
  assert.deepEqual([off.effects_not_reversed[0].kind, off.effects_not_reversed[0].delta], ['health', 10]);
  assert.equal(current(forBigscreen(g)), null);
});

test('EVT-UI-008: deactivating MONSTER ATTACK restores no Health and heals nobody', () => {
  const g = at('R3');
  assert.equal(fire(g, 'MONSTER_ATTACK').ok, true);
  for (const s of SECTORS) {
    assert.equal(health(g, s), 90, s);
    assert.deepEqual([g.state.sectors[s].workforce.active, g.state.sectors[s].workforce.injured], [4, 1], s);
  }
  const off = stop(g, 'MONSTER_ATTACK');
  assert.equal(off.ok, true);
  for (const s of SECTORS) {
    assert.equal(health(g, s), 90, `${s} got its Health back`);
    assert.deepEqual([g.state.sectors[s].workforce.active, g.state.sectors[s].workforce.injured], [4, 1], `${s} was healed by the deactivation`);
  }
  assert.deepEqual(off.effects_not_reversed.map((i) => i.kind), ['health', 'injure_workers']);
  assert.equal(logEvents(g, 'worker_healed').length, 0);
  // MED still heals the injured through its own queue, as before
  assert.equal(current(forSector(g, 'MED')), null);
});

test('EVT-UI-009: deactivating TRANSPORT CORRIDOR CLEARED removes only its +2 TRN capacity', () => {
  const g = at('R2');
  assert.equal(g.trnCapacity(), 3);
  assert.equal(fire(g, 'TRANSPORT_CORRIDOR_CLEARED').ok, true);
  assert.equal(g.trnCapacity(), 5);
  const transfersBefore = JSON.stringify(g.state.transfers);
  const off = stop(g, 'TRANSPORT_CORRIDOR_CLEARED');
  assert.equal(off.ok, true);
  assert.equal(g.trnCapacity(), 3);
  assert.equal(off.effects_removed.length, 1);
  assert.deepEqual([off.effects_removed[0].kind, off.effects_removed[0].delta], ['trn_capacity', 2]);
  assert.deepEqual(off.effects_not_reversed, []);
  assert.equal(JSON.stringify(g.state.transfers), transfersBefore, 'a transfer was touched');
  assert.equal(live(g).length, 0);
  assert.equal(logEvents(g, 'city_event_effect_cancelled').length, 1);
});

test('EVT-UI-010: deactivating TUNNEL NETWORK DAMAGE removes only its -1 TRN capacity', () => {
  const g = at('R2');
  assert.equal(fire(g, 'TUNNEL_NETWORK_DAMAGE').ok, true);
  assert.equal(g.trnCapacity(), 2);
  const off = stop(g, 'TUNNEL_NETWORK_DAMAGE');
  assert.equal(off.ok, true);
  assert.equal(g.trnCapacity(), 3);
  assert.deepEqual(off.effects_removed.map((e) => [e.kind, e.delta]), [['trn_capacity', -1]]);
  assert.deepEqual(off.effects_not_reversed, []);
  for (const s of SECTORS) assert.equal(health(g, s), 100, s);
});

test('EVT-UI-011: deactivating CITY RECOVERY PROTOCOL keeps the +5 Health and the heals already done, and removes only the +2 healing capacity', () => {
  const g = at('R3');
  for (const s of SECTORS) g.setIntegrity(s, 60);
  g.injure('AGR', 1);
  assert.equal(fire(g, 'CITY_RECOVERY_PROTOCOL').ok, true);
  for (const s of SECTORS) assert.equal(health(g, s), 65, s);
  assert.equal(g.medCapacity(), 5);
  // a heal performed under the lifted capacity stays performed
  const ask = g.requestHeal ? g.requestHeal('AGR') : null;
  const healed = ask && ask.ok && g.healWorker ? g.healWorker(ask.id, { by: 'MED' }) : null;
  const injuredAfterHeal = g.state.sectors.AGR.workforce.injured;
  const off = stop(g, 'CITY_RECOVERY_PROTOCOL');
  assert.equal(off.ok, true);
  for (const s of SECTORS) assert.equal(health(g, s), 65, `${s} lost the Health again`);
  assert.equal(g.medCapacity(), 3);
  assert.equal(g.state.sectors.AGR.workforce.injured, injuredAfterHeal, 'a heal was undone');
  assert.deepEqual(off.effects_removed.map((e) => [e.kind, e.delta]), [['med_capacity', 2]]);
  assert.deepEqual(off.effects_not_reversed.map((i) => i.kind), ['health']);
  if (healed) assert.equal(healed.ok, true);
});

test('EVT-UI-012: deactivating EMERGENCY LOCKDOWN keeps the Health damage and removes the TRN and MED penalties', () => {
  const g = at('R3');
  assert.equal(fire(g, 'EMERGENCY_LOCKDOWN').ok, true);
  for (const s of SECTORS) assert.equal(health(g, s), 95, s);
  assert.deepEqual([g.trnCapacity(), g.medCapacity()], [2, 2]);
  const off = stop(g, 'EMERGENCY_LOCKDOWN');
  assert.equal(off.ok, true);
  for (const s of SECTORS) assert.equal(health(g, s), 95, `${s} got its Health back`);
  assert.deepEqual([g.trnCapacity(), g.medCapacity()], [3, 3]);
  assert.deepEqual(off.effects_removed.map((e) => e.kind).sort(), ['med_capacity', 'trn_capacity']);
  assert.deepEqual(off.effects_not_reversed.map((i) => [i.kind, i.delta]), [['health', -5]]);
});

test('EVT-UI-013: deactivating an unconsumed NEXT_UPKEEP event cancels its pending modifier', () => {
  const g = at('R3');
  assert.equal(fire(g, 'UTILITY_RESERVE_RELEASED').ok, true);
  for (const s of SECTORS) assert.deepEqual(economy.upkeepFor(g, g.state.sectors[s]), { power: 1, water: 1 }, s);
  assert.equal(card(g, 'UTILITY_RESERVE_RELEASED').button, 'DEACTIVATE');
  const off = stop(g, 'UTILITY_RESERVE_RELEASED');
  assert.equal(off.ok, true);
  for (const s of SECTORS) assert.deepEqual(economy.upkeepFor(g, g.state.sectors[s]), { power: 2, water: 1 }, `${s} still carries the modifier`);
  assert.equal(off.pending_effects_cancelled.length, 6);
  assert.ok(off.pending_effects_cancelled.every((e) => e.kind === 'upkeep_extra' && e.add.power === -1));
  assert.deepEqual(off.effects_removed, []);
  assert.equal(live(g).length, 0);
  assert.equal(logEvents(g, 'city_event_effect_cancelled').length, 6);
  assert.equal(logEvents(g, 'city_event_upkeep_effect_consumed').length, 0, 'a cancellation was logged as a consumption');
  // nothing is pending any more, so the card is free again
  assert.equal(card(g, 'UTILITY_RESERVE_RELEASED').button, 'ACTIVATE');
  // the same for the BAD one
  assert.equal(fire(g, 'CORE_ENERGY_INSTABILITY').ok, true);
  assert.deepEqual(economy.upkeepFor(g, g.state.sectors.POW), { power: 3, water: 1 });
  assert.equal(stop(g, 'CORE_ENERGY_INSTABILITY').pending_effects_cancelled.length, 6);
  assert.deepEqual(economy.upkeepFor(g, g.state.sectors.POW), { power: 2, water: 1 });
});

test('EVT-UI-014: deactivating a NEXT_UPKEEP event after its upkeep reverses nothing — the event has already ended with the upkeep', () => {
  const g = at('R3');
  assert.equal(fire(g, 'CORE_ENERGY_INSTABILITY').ok, true);
  assert.equal(g.state.sectors.POW.inventory.power, 9);
  g.activateRound('R4');                                            // charges Round 3: 2 + 1 Power, 1 Water
  assert.equal(g.state.sectors.POW.inventory.power, 6);
  assert.equal(live(g).length, 0, 'the consumed modifier is still live');
  const ended = logEvents(g, 'city_event_expired');
  assert.equal(ended.length, 1);
  assert.deepEqual([ended[0].event_id, ended[0].reason], ['CORE_ENERGY_INSTABILITY', 'upkeep_consumed']);
  assert.equal(card(g, 'CORE_ENERGY_INSTABILITY').active, false);
  assert.equal(card(g, 'CORE_ENERGY_INSTABILITY').button, 'ACTIVATE');
  const off = stop(g, 'CORE_ENERGY_INSTABILITY');
  assert.deepEqual([off.ok, off.reason], [false, 'event_not_active']);
  assert.equal(g.state.sectors.POW.inventory.power, 6, 'the upkeep was refunded');
  assert.equal(logEvents(g, 'city_event_deactivated').length, 0);
  assert.equal(current(forBigscreen(g)), null);
});

// -- several at once ----------------------------------------------------------------------------------

test('EVT-UI-015: different active events coexist, and their modifiers combine', () => {
  const g = at('R2');
  assert.equal(fire(g, 'TRANSPORT_CORRIDOR_CLEARED').ok, true);
  assert.equal(fire(g, 'TUNNEL_NETWORK_DAMAGE').ok, true);
  assert.equal(fire(g, 'EMERGENCY_MAINTENANCE_CREW').ok, true);
  const v = view(g);
  assert.deepEqual(v.active_events.map((a) => a.event_id), ['TRANSPORT_CORRIDOR_CLEARED', 'TUNNEL_NETWORK_DAMAGE', 'EMERGENCY_MAINTENANCE_CREW']);
  assert.equal(g.trnCapacity(), 4);
  assert.equal(overlay(forBigscreen(g)).count, 3);
  assert.equal(B.buildAlerts(forBigscreen(g)).filter((c) => c.kind === 'city').length, 3);
  for (const id of ['TRANSPORT_CORRIDOR_CLEARED', 'TUNNEL_NETWORK_DAMAGE', 'EMERGENCY_MAINTENANCE_CREW']) assert.equal(card(g, id).button, 'DEACTIVATE', id);
  const rows = v.active_events;
  assert.equal(rows[0].remaining, 'TRN +2 TRANSFER CAPACITY · UNTIL ROUND END');
  assert.equal(rows[1].remaining, 'TRN -1 TRANSFER CAPACITY · UNTIL ROUND END');
  assert.ok(/\+1 WORKER · UNTIL ROUND END$/.test(rows[2].remaining));
  for (const r of rows) {
    assert.equal(r.activated_round, 'R2');
    assert.equal(r.round_number, 2);
    assert.ok(r.activated_at && r.activated_by === 'facilitator' && ['GOOD', 'BAD'].includes(r.type));
  }
});

test('EVT-UI-016: the most recently activated active event controls the colour', () => {
  const g = at('R2');
  assert.equal(fire(g, 'TRANSPORT_CORRIDOR_CLEARED').ok, true);
  for (const frame of everyScreen(g)) assert.equal(current(frame).colour, 'green');
  assert.equal(fire(g, 'TUNNEL_NETWORK_DAMAGE').ok, true);
  for (const frame of everyScreen(g)) {
    assert.deepEqual([current(frame).colour, current(frame).name], ['red', 'TUNNEL NETWORK DAMAGE']);
    assert.deepEqual(overlay(frame).active.map((a) => a.colour), ['green', 'red']);
  }
  const chips = B.buildAlerts(forBigscreen(g)).filter((c) => c.kind === 'city');
  assert.deepEqual(chips.map((c) => c.accent), ['red', 'green'], 'the strip does not put the newest first');
});

test('EVT-UI-017: when the latest event is deactivated the colour falls back to the one still active', () => {
  const g = at('R2');
  assert.equal(fire(g, 'TRANSPORT_CORRIDOR_CLEARED').ok, true);
  assert.equal(fire(g, 'TUNNEL_NETWORK_DAMAGE').ok, true);
  assert.equal(current(forBigscreen(g)).colour, 'red');
  assert.equal(stop(g, 'TUNNEL_NETWORK_DAMAGE').ok, true);
  for (const frame of everyScreen(g)) {
    assert.deepEqual([current(frame).colour, current(frame).name, current(frame).label], ['green', 'TRANSPORT CORRIDOR CLEARED', 'POSITIVE CITY EVENT']);
    assert.equal(overlay(frame).count, 1);
  }
  assert.equal(g.trnCapacity(), 5);
  // and when that one goes too, nothing is left
  assert.equal(stop(g, 'TRANSPORT_CORRIDOR_CLEARED').ok, true);
  for (const frame of everyScreen(g)) assert.equal(current(frame), null);
  assert.equal(g.trnCapacity(), 3);
});

// -- persistence and reset ---------------------------------------------------------------------------

test('EVT-UI-018: save/restore preserves the active events and the colour without replaying their consequences; an older snapshot rebuilds its active list from the live effects', () => {
  const g = at('R3');
  assert.equal(fire(g, 'TRANSPORT_CORRIDOR_CLEARED').ok, true);
  assert.equal(fire(g, 'MONSTER_ATTACK').ok, true);
  for (const s of SECTORS) assert.equal(health(g, s), 90, s);
  const snap = JSON.parse(JSON.stringify(g.serialise()));
  const back = newGame({ runId: 'city-events-active-restore' });
  back.restore(snap);
  for (const s of SECTORS) {
    assert.equal(health(back, s), 90, `${s}: the Health hit was replayed`);
    assert.equal(back.state.sectors[s].workforce.injured, 1, `${s}: the injury was replayed`);
  }
  assert.deepEqual(view(back).active_events.map((a) => a.event_id), ['TRANSPORT_CORRIDOR_CLEARED', 'MONSTER_ATTACK']);
  assert.deepEqual([current(forBigscreen(back)).colour, current(forBigscreen(back)).name], ['red', 'MONSTER ATTACK']);
  assert.equal(card(back, 'MONSTER_ATTACK').button, 'DEACTIVATE');
  assert.equal(back.trnCapacity(), 5);
  assert.equal(logEvents(back, 'city_event_activated').length, 0, 'the restore logged an activation');
  assert.equal(stop(back, 'MONSTER_ATTACK').ok, true);
  assert.equal(current(forBigscreen(back)).colour, 'green');
  for (const s of SECTORS) assert.equal(health(back, s), 90, s);
  // a snapshot from before the active list: the event whose modifier is still live is still active
  const old = JSON.parse(JSON.stringify(g.serialise()));
  delete old.state.city_events.active;
  const legacy = newGame({ runId: 'city-events-active-legacy' });
  legacy.restore(old);
  assert.deepEqual(view(legacy).active_events.map((a) => a.event_id), ['TRANSPORT_CORRIDOR_CLEARED']);
  assert.equal(current(forBigscreen(legacy)).colour, 'green');
  assert.equal(card(legacy, 'TRANSPORT_CORRIDOR_CLEARED').button, 'DEACTIVATE');
  assert.equal(card(legacy, 'MONSTER_ATTACK').button, 'USED THIS ROUND');
  for (const s of SECTORS) assert.equal(health(legacy, s), 90, s);
});

test('EVT-UI-019: RESET RUN clears every activation, the active list, the pending modifiers and the overlay', () => {
  const g = at('R3');
  for (const id of ['TRANSPORT_CORRIDOR_CLEARED', 'UTILITY_RESERVE_RELEASED', 'MONSTER_ATTACK']) assert.equal(fire(g, id).ok, true, id);
  assert.equal(overlay(forBigscreen(g)).count, 3);
  g.reset('city-events-active-fresh');
  assert.deepEqual(g.state.city_events, { used: {}, history: [], active: [] });
  assert.deepEqual(g.state.effects, []);
  for (const frame of everyScreen(g)) {
    assert.equal(current(frame), null);
    assert.equal(overlay(frame).count, 0);
  }
  for (const e of view(g).events) assert.deepEqual([e.active, e.button], [false, 'ACTIVATE'], e.id);
  assert.deepEqual(view(g).active_events, []);
  assert.deepEqual(economy.upkeepFor(g, g.state.sectors.POW), { power: 2, water: 1 });
});

// -- auto-expiry, the log, the double press ---------------------------------------------------------

test('auto-expiry: THIS_ROUND and MIXED end with the round, IMMEDIATE with the round too, NEXT_UPKEEP with its upkeep — each logged as city_event_expired', () => {
  const g = at('R3');
  for (const id of ['TRANSPORT_CORRIDOR_CLEARED', 'CITY_RECOVERY_PROTOCOL', 'MONSTER_ATTACK', 'CORE_ENERGY_INSTABILITY']) assert.equal(fire(g, id).ok, true, id);
  assert.equal(view(g).active_events.length, 4);
  // a round change that charges nothing (the clock never ran) keeps the upkeep one alive
  const h = at('R3');
  assert.equal(fire(h, 'CORE_ENERGY_INSTABILITY').ok, true);
  assert.equal(fire(h, 'MONSTER_ATTACK').ok, true);
  h.setRound('R4');                                                 // the period turns, nothing is charged
  assert.deepEqual(view(h).active_events.map((a) => a.event_id), ['CORE_ENERGY_INSTABILITY']);
  assert.deepEqual(logEvents(h, 'city_event_expired').map((e) => [e.event_id, e.reason]), [['MONSTER_ATTACK', 'round_change']]);
  // a round change that charges upkeep ends them all
  g.activateRound('R4');
  assert.deepEqual(view(g).active_events, []);
  const reasons = Object.fromEntries(logEvents(g, 'city_event_expired').map((e) => [e.event_id, e.reason]));
  assert.deepEqual(reasons, {
    TRANSPORT_CORRIDOR_CLEARED: 'effects_expired', CITY_RECOVERY_PROTOCOL: 'effects_expired',
    MONSTER_ATTACK: 'round_change', CORE_ENERGY_INSTABILITY: 'upkeep_consumed',
  });
  for (const frame of everyScreen(g)) assert.equal(current(frame), null);
  for (const h2 of view(g).history) assert.ok(h2.ended_at && h2.ended_by === 'expiry', h2.name);
  // and every card is a fresh ACTIVATE in the new round
  for (const e of view(g).events) assert.equal(e.button, 'ACTIVATE', e.id);
});

test('the log: activation, deactivation and expiry carry what the debrief needs, and the timeline reads them', () => {
  const g = at('R3');
  assert.equal(fire(g, 'EMERGENCY_LOCKDOWN').ok, true);
  assert.equal(stop(g, 'EMERGENCY_LOCKDOWN').ok, true);
  const on = logEvents(g, 'city_event_activated')[0];
  for (const k of ['activation', 'event_id', 'event_name', 'event_type', 'round', 'by', 'effects_applied']) assert.ok(k in on, `activated lacks ${k}`);
  const off = logEvents(g, 'city_event_deactivated')[0];
  for (const k of ['activation', 'event_id', 'event_name', 'event_type', 'round', 't', 'by', 'effects_removed', 'effects_not_reversed', 'pending_effects_cancelled']) assert.ok(k in off, `deactivated lacks ${k}`);
  assert.equal(off.event_type, 'BAD');
  assert.equal(off.effects_removed.length, 2);
  assert.equal(off.effects_not_reversed.length, 1);
  assert.deepEqual(off.pending_effects_cancelled, []);
  assert.equal(off.activation, on.activation);
  const { analyse } = require('../lib/analytics');
  const d = analyse(g.log.readAll(), { runId: g.state.run_id });
  const lines = Object.values(d.rounds).flatMap((r) => r.timeline).filter((t) => t.kind === 'city_event').map((t) => t.text);
  assert.ok(lines.some((t) => /EMERGENCY LOCKDOWN DEACTIVATED — 2 removed · 0 cancelled · 1 kept/.test(t)), lines.join('\n'));
  assert.ok(lines.some((t) => /EMERGENCY LOCKDOWN: trn capacity on TRN cancelled/.test(t)), lines.join('\n'));
  const hist = view(g).history[0];
  assert.deepEqual([hist.ended_by, hist.ended_reason], ['deactivate', 'facilitator']);
});

test('the double press: two ACTIVATE presses apply once, two DEACTIVATE presses remove once, and the control panel disables the button it pressed', () => {
  const g = at('R3');
  const a = fire(g, 'EMERGENCY_MAINTENANCE_CREW');
  const b = fire(g, 'EMERGENCY_MAINTENANCE_CREW');
  assert.deepEqual([a.ok, b.ok, b.reason], [true, false, 'event_already_active']);
  assert.equal(live(g, 'EMERGENCY_MAINTENANCE_CREW').length, 6);
  for (const s of SECTORS) assert.equal(g.availableWorkers(g.state.sectors[s]), 6, s);
  const c = stop(g, 'EMERGENCY_MAINTENANCE_CREW');
  const d = stop(g, 'EMERGENCY_MAINTENANCE_CREW');
  assert.deepEqual([c.ok, d.ok, d.reason], [true, false, 'event_not_active']);
  assert.equal(live(g).length, 0);
  for (const s of SECTORS) assert.equal(g.availableWorkers(g.state.sectors[s]), 5, s);
  assert.equal(logEvents(g, 'city_event_deactivated').length, 1);
  const control = read('public/control/control.js');
  assert.ok(/const press = \(b\) => \{\s*if \(b\.disabled\) return;\s*b\.disabled = true;/.test(control));
});
