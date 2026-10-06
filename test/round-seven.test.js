'use strict';
/**
 * EIGHT ROUNDS (2026-10-05): R5, R6 and R7 join the table, R4 stops being
 * the end, and no round has a name anywhere.
 *
 * Rounds 0 to 3 teach the mechanics; Rounds 4 to 7 mix them under rising
 * pressure with nothing new to learn. Everything the engine does with a round
 * — the timer, upkeep at the change, the AGR hand, delayed consequences,
 * a freight slot's next-round cost — keys on "the next activation", so the
 * three new rounds work by existing; what this suite pins is that nothing
 * still believes Round 4 is last, that the end moves to Round 7, and that a
 * round is identified by its number and nothing else.
 *
 * R7-001 … R7-016 and NAME-001 … NAME-006 are the specs' acceptance tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { newGame, loadContent, logEvents, rounds } = require('./helpers');
const { forSector, forBigscreen, forControl } = require('../lib/visibility');
const { analyse } = require('../lib/analytics');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ROUNDS = JSON.parse(read('lib/rounds.json'));
const STANDARD = JSON.parse(read('config/scenarios/haven9-standard.json'));
const CONTROL = read('public/control/control.js');
const UI_FILES = [
  'public/control/control.js', 'public/control/index.html',
  'public/wall/wall.js', 'public/wall/index.html',
  'public/sector/sector.js', 'public/sector/index.html',
  'public/shared/bigscreen.js', 'public/shared/ws.js',
  'lib/analytics.js', 'lib/visibility.js',
];
const GUIDEBOOK = read('tools/kit/build_guidebook.js');
/** The titles a round must never carry, in the forms a label would print. */
const NAMES = ['ONBOARDING', 'STABLE OPS', 'STABLE OPERATIONS', 'INTERDEPENDENCE', 'CORE FAILURE', 'AFTERSHOCK',
  'SYSTEMS UNDER PRESSURE', 'FINAL CONTINUITY', 'TEMPORARY STABILISATION', 'FINAL CRISIS', 'ESCALATION'];
const ALL = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'];

const deal = (g, id) => { g.state.agr.offered = [id, ...g.state.agr.offered.filter((x) => x !== id)].slice(0, 3); };
const def = (code) => loadContent().faults.faults.find((f) => f.code === code);

/** A run moved by the facilitator's own button into the round named, clock running. */
function at(round) {
  const g = newGame();
  for (const r of ALL.slice(1, ALL.indexOf(round) + 1)) { g.activateRound(r); g.clock('start'); g.tick(1000); }
  return g;
}

// -- R7-001 / R7-002: the table and what it ends on --------------------------------------

test('R7-001: lib/rounds.json carries R0 through R7, numbered, timed, and nameless', () => {
  assert.deepEqual(ROUNDS.rounds.map((r) => r.id), ALL);
  assert.deepEqual(ROUNDS.rounds.map((r) => r.length_s), [1200, 900, 900, 720, 480, 600, 600, 600]);
  assert.deepEqual(ROUNDS.phases.map((p) => p.id), ['ROUND_0', 'ROUND_1', 'ROUND_2', 'ROUND_3', 'ROUND_4', 'ROUND_5', 'ROUND_6', 'ROUND_7', 'ENDED']);
  assert.deepEqual(ROUNDS.phases.map((p) => p.number), [0, 1, 2, 3, 4, 5, 6, 7, null]);
  assert.deepEqual(ROUNDS.phases.map((p) => p.round), [...ALL, 'R7']);
  for (const r of ROUNDS.rounds) assert.match(r.name, /^Round \d$/, `${r.id} carries a title: ${r.name}`);
  for (const p of ROUNDS.phases) assert.ok(/^Round \d$/.test(p.name) || p.id === 'ENDED', `${p.id} carries a title: ${p.name}`);
  const g = newGame();
  for (const r of ALL) assert.equal(g.roundConfig(r).length_s, ROUNDS.rounds.find((x) => x.id === r).length_s, r);
  assert.deepEqual(STANDARD.defaults.round_length_s, { R0: 1200, R1: 900, R2: 900, R3: 720, R4: 480, R5: 600, R6: 600, R7: 600 });
});

test('R7-002: Round 4 is no longer the final round — NEXT goes to Round 5, and nothing ends by itself', () => {
  const g = at('R4');
  assert.equal(g.nextPhase(), true);
  assert.deepEqual([g.state.phase, g.state.round, g.state.mode], ['ROUND_5', 'R5', 'PLAY']);
  // The console's navigator offers Round 5 after Round 4, not END.
  const f = forControl(at('R4'));
  const i = f.phases.findIndex((p) => p.id === f.phase);
  assert.equal(f.phases[i + 1].number, 5);
  assert.equal(f.phases.length, 9);
  // Round 4's clock running out moves nothing.
  const g2 = at('R4');
  g2.tick(480000 + 5000);
  assert.deepEqual([g2.state.round, g2.state.mode, g2.state.round_clock.status], ['R4', 'PLAY', 'expired']);
});

// -- R7-003 … R7-006: the three new changes and the new end -----------------------------------

for (const [n, from, to] of [[3, 'R4', 'R5'], [4, 'R5', 'R6'], [5, 'R6', 'R7']]) {
  test(`R7-00${n}: the facilitator advances ${from} -> ${to}: timer READY at 10:00, the outgoing round's upkeep charged, nothing dealt`, () => {
    const g = at(from);
    g.setInventory('POW', { power: 9, water: 9, parts: 9, med: 9 });
    const stock = { ...g.state.sectors.POW.inventory };
    const res = g.activateRound(to);
    assert.equal(res.ok, true, res.reason);
    assert.deepEqual([g.state.round, g.state.phase, g.state.mode], [to, `ROUND_${to.slice(1)}`, 'PLAY']);
    assert.deepEqual([g.state.round_clock.status, g.state.round_clock.remaining_s, g.state.round_clock.duration_s], ['ready', 600, 600]);
    assert.equal(res.charged, from, 'the outgoing round was not charged');
    assert.ok(g.state.sectors.POW.inventory.power < stock.power, 'upkeep did not land');
    assert.equal(Object.values(g.state.sectors).flatMap((s) => s.faults).length, 0, 'a round change dealt a fault');
    assert.equal(g.activateRound(to).reason, 'round_already_active');
    assert.equal(typeof g.state.rounds_activated[to], 'string');
  });
}

test('R7-006: completion comes only after Round 7, by the existing hand — and ending never moves the round', () => {
  const g = at('R7');
  assert.equal(g.nextPhase(), true);
  assert.deepEqual([g.state.phase, g.state.mode, g.state.round], ['ENDED', 'ENDED', 'R7']);
  assert.equal(g.nextPhase(), false);
  assert.equal(g.state.round_clock.running, false);
  // END SIMULATION from Round 7
  const g2 = at('R7');
  assert.equal(g2.endSimulation().ok, true);
  assert.deepEqual([g2.state.phase, g2.state.round], ['ENDED', 'R7']);
  assert.equal(logEvents(g2, 'simulation_ended').length, 1);
  // Ending early (it is the facilitator's call) keeps the round the city was in.
  const g3 = at('R5');
  assert.equal(g3.endSimulation().ok, true);
  assert.deepEqual([g3.state.phase, g3.state.round, g3.state.mode], ['ENDED', 'R5', 'ENDED']);
  // Rounds 4, 5 and 6 never end the game: their clocks run out and the city plays on.
  for (const r of ['R4', 'R5', 'R6']) {
    const g4 = at(r);
    g4.tick(700000);
    assert.notEqual(g4.state.mode, 'ENDED', `${r} ended the game by itself`);
    assert.equal(g4.state.round, r);
  }
});

// -- R7-007 / R7-008 / NAME-002 / NAME-003: the screens ---------------------------------------------

test('R7-007 / NAME-003: sector consoles are sent Round 5, 6 and 7 as numbers, and nothing else', () => {
  for (const [r, n] of [['R5', 5], ['R6', 6], ['R7', 7]]) {
    const f = forSector(at(r), 'POW');
    assert.equal(f.round_number, n);
    assert.equal(f.round, undefined, 'a table is sent the round id it has no use for');
    assert.equal(f.round_name, undefined);
    const text = JSON.stringify(f).toUpperCase();
    for (const w of NAMES) assert.ok(!text.includes(w), `${r}: a sector frame carries "${w}"`);
  }
  assert.ok(/`Round \$\{state\.round_number\}`/.test(read('public/sector/sector.js')), 'the console prints something other than the number');
});

test('R7-008 / NAME-002: the big screen is sent Round 5, 6 and 7 as numbers, and prints ROUND n', () => {
  for (const [r, n] of [['R5', 5], ['R6', 6], ['R7', 7]]) {
    const f = forBigscreen(at(r));
    assert.equal(f.round_number, n);
    const text = JSON.stringify(f).toUpperCase();
    for (const w of NAMES) assert.ok(!text.includes(w), `${r}: the wall frame carries "${w}"`);
  }
  assert.ok(/`ROUND \$\{n\}`/.test(read('public/wall/wall.js')));
  const ended = at('R7'); ended.endSimulation();
  assert.equal(forBigscreen(ended).mode, 'ENDED');
});

// -- R7-009 … R7-011: AGR and the delayed effects across the new changes -------------------------

test('R7-009: AGR cards are dealt and usable through Round 7, from the MEDIUM + HIGH pool', () => {
  for (const r of ['R5', 'R6', 'R7']) {
    const g = at(r);
    assert.equal(g.state.agr.round, r);
    assert.equal(g.state.agr.offered.length, 3, `${r}: no hand`);
    assert.deepEqual([...g.agrRiskPoolFor(r)].sort(), ['HIGH', 'MEDIUM']);
    assert.ok(g.state.agr.offered.every((id) => ['MEDIUM', 'HIGH'].includes(g.agrCard(id).risk)), `${r}: ${g.state.agr.offered}`);
    assert.equal(g.agrConsequencesActive(), true);
    deal(g, 'AGR_EMERGENCY_PARTS');
    const res = g.agrActivate('AGR_EMERGENCY_PARTS', { by: 'AGR' });
    assert.equal(res.ok, true, `${r}: ${res.reason}`);
    assert.equal(g.state.agr.used, true);
    assert.equal(g.state.sectors.AGR.inventory.parts >= 3, true);
  }
});

test('R7-010: a NEXT_ROUND AGR consequence lands once at the next start, R4->R5, R5->R6 and R6->R7', () => {
  // Stock every sector so the upkeep the change charges costs no Integrity: the
  // only Integrity that may move here is the card's own scheduled cost.
  const stock = (g) => { for (const s of Object.keys(g.state.sectors)) g.setInventory(s, { power: 9, water: 9, parts: 9, med: 9 }); };
  for (const [from, to] of [['R4', 'R5'], ['R5', 'R6'], ['R6', 'R7']]) {
    const g = at(from);
    deal(g, 'AGR_EMERGENCY_PARTS');
    g.setIntegrity('AGR', 80);
    assert.equal(g.agrActivate('AGR_EMERGENCY_PARTS', { by: 'AGR' }).ok, true);
    assert.equal(g.state.sectors.AGR.integrity, 80, 'the cost landed early');
    assert.ok(g.state.effects.some((e) => e.kind === 'scheduled' && e.apply_at === 'round_start'), 'nothing was scheduled');
    g.tick(60000);
    assert.equal(g.state.sectors.AGR.integrity, 80, 'the cost landed on the clock');
    stock(g);
    g.activateRound(to);
    assert.equal(g.state.sectors.AGR.integrity, 74, `${from}->${to}: the -6 did not land at the start`);
    assert.ok(!g.state.effects.some((e) => e.kind === 'scheduled'), 'the scheduled hit was not retired');
    g.clock('start'); g.tick(60000);
    const nxt = ALL[ALL.indexOf(to) + 1];
    if (nxt) { stock(g); g.activateRound(nxt); assert.equal(g.state.sectors.AGR.integrity, 74, 'it fired twice'); }
  }
  // An extra-upkeep obligation keeps counting across the new rounds.
  const g = at('R4');
  deal(g, 'AGR_WATER_RESERVE');
  g.setInventory('AGR', { power: 9, water: 9, parts: 9, med: 9 });
  assert.equal(g.agrActivate('AGR_WATER_RESERVE', { by: 'AGR' }).ok, true);
  const obligation = () => g.state.effects.find((e) => e.kind === 'upkeep_extra');
  assert.equal(obligation().cycles_remaining, 2);
  g.activateRound('R5'); assert.equal(obligation().cycles_remaining, 1);
  g.clock('start'); g.tick(1000);
  g.activateRound('R6'); assert.equal(obligation(), undefined, 'the obligation did not retire after its two upkeeps');
  // Temporary workers lent "this round" end at the change, in the new rounds as in the old.
  const g2 = at('R6');
  deal(g2, 'AGR_RELIEF_CREW');
  assert.equal(g2.agrActivate('AGR_RELIEF_CREW', { by: 'AGR', target: { sector: 'POW' } }).ok, true);
  assert.ok(g2.state.effects.some((e) => e.kind === 'extra_workers' && e.expires === 'round'));
  g2.activateRound('R7');
  assert.ok(!g2.state.effects.some((e) => e.kind === 'extra_workers'), 'the loan outlived its round');
});

test('R7-011: a freight slot accepted in R4, R5 or R6 lends TRN +1 now and takes it back at the next start', () => {
  for (const [from, to] of [['R4', 'R5'], ['R5', 'R6'], ['R6', 'R7']]) {
    const g = at(from);
    const base = g.trnCapacity();
    deal(g, 'AGR_LOGISTICS_BOOST');
    const r = g.agrActivate('AGR_LOGISTICS_BOOST', { by: 'AGR' });
    assert.equal(r.pending, true);
    assert.equal(g.agrSlotRespond(r.request.id, { accept: true, by: 'TRN' }).accepted, true);
    assert.equal(g.trnCapacity(), base + 1, `${from}: no +1`);
    g.activateRound(to);
    assert.equal(g.trnCapacity(), base - 1, `${from}->${to}: the -1 did not land`);
    g.clock('start'); g.tick(1000);
    const nxt = ALL[ALL.indexOf(to) + 1];
    if (nxt) { g.activateRound(nxt); assert.equal(g.trnCapacity(), base, 'the -1 outlived its round'); }
  }
  // A proposal still open at a change lapses, as before.
  const g = at('R5');
  deal(g, 'AGR_LOGISTICS_BOOST');
  g.agrActivate('AGR_LOGISTICS_BOOST', { by: 'AGR' });
  g.activateRound('R6');
  assert.equal(g.agrPendingDecision(), null);
  assert.equal(g.state.slot_requests[0].status, 'EXPIRED');
});

// -- R7-012 / R7-013: the library, by hand, in every round ----------------------------------------

test('R7-012: late-shift, chain and workbook faults are all fired by hand in Rounds 4 to 7', () => {
  for (const r of ['R4', 'R5', 'R6', 'R7']) {
    const g = at(r);
    for (const code of ['F-601', 'F-602', 'F-501', 'F-401', 'F-101']) {
      const d = def(code);
      assert.equal(g.fireFault(code, d.sector).ok, true, `${r}: ${code}`);
    }
    assert.equal(g.state.sectors.POW.faults.length, 5);
  }
});

test('R7-013: no fault scheduler — a round change deals nothing, and the round broadcast waits for the facilitator instead of playing on START', () => {
  for (const r of ['R5', 'R6', 'R7']) {
    assert.deepEqual(newGame().faultsForRound(r), [], `${r} groups faults`);
    const beats = STANDARD.timelines[r];
    assert.ok(Array.isArray(beats) && beats.length === 1 && beats[0].kind === 'alert' && beats[0].offset_s === 0 && beats[0].mode === 'MANUAL', `${r}: ${JSON.stringify(beats)}`);
  }
  for (const [r, title, major] of [['R4', 'TRAINING PROTOCOLS CONCLUDED', true], ['R5', 'SYSTEM LOAD INCREASING', false], ['R6', 'CASCADE CONDITIONS DETECTED', false], ['R7', 'FINAL OPERATING WINDOW', true]]) {
    const g = newGame();
    for (const x of ALL.slice(1, ALL.indexOf(r))) { g.activateRound(x); g.clock('start'); g.tick(1000); }
    g.activateRound(r);
    // QUIET TRANSITION (2026-10-06): neither NEXT ROUND nor START plays the broadcast.
    assert.equal(g.state.alert, null, `${r}: a broadcast played on NEXT ROUND`);
    g.clock('start'); g.tick(1000); g.tick(1000);
    assert.equal(g.state.alert, null, `${r}: the broadcast played on START`);
    const beat = g.state.timeline.find((t) => t.kind === 'alert' && t.offset_s === 0);
    assert.ok(beat && beat.mode === 'MANUAL' && beat.status === 'READY' && beat.transition === true, `${r}: ${JSON.stringify(beat)}`);
    // The facilitator's press plays it, with its weight.
    assert.equal(g.fireTimelineItem(beat.id).ok, true);
    assert.ok(g.state.alert && g.state.alert.title === title, `${r}: ${JSON.stringify(g.state.alert)}`);
    assert.ok(g.state.alert.subtitle.length > 20, 'the body is missing');
    const view = forSector(g, 'POW').alert;
    assert.equal(view.full_s, major ? 14 : 8, `${r}: a ${major ? 'major' : 'normal'} broadcast holds the wrong time`);
    assert.equal(Object.values(g.state.sectors).flatMap((s) => s.faults).length, 0, `${r}: START fired a fault`);
    const text = (g.state.alert.title + ' ' + g.state.alert.subtitle).toUpperCase();
    for (const w of ['ROUND 4', 'ROUND 5', 'ROUND 6', 'ROUND 7', 'FINAL CONTINUITY', 'SYSTEMS UNDER PRESSURE']) assert.ok(!text.includes(w), `${r}: the broadcast names the round`);
  }
  assert.ok(!/setInterval|schedule\(\{ kind: 'fault'/.test(read('lib/state.js').split('activateRound(id')[1].split('startFirstRound')[0]), 'activation schedules faults');
});

// -- R7-014 / R7-015: persistence and regression -----------------------------------------------------

test('R7-014: a game saved in Round 5, 6 or 7 restores there — never clamped — and an old Round 0–4 save still restores', () => {
  for (const r of ['R5', 'R6', 'R7']) {
    const g = at(r);
    g.fireFault('F-601', 'POW');
    const snap = JSON.parse(JSON.stringify(g.serialise()));
    const back = newGame({ runId: `restore-${r}` });
    back.restore(snap);
    assert.deepEqual([back.state.round, back.state.phase, back.state.mode], [r, `ROUND_${r.slice(1)}`, 'PLAY'], r);
    assert.equal(back.state.round_clock.duration_s, 600);
    assert.equal(back.state.sectors.POW.faults.length, 1);
    assert.equal(back.activateRound(r).reason, 'round_already_active');
    assert.equal(logEvents(back, 'phase_migrated').length, 0, `${r}: the phase was rewritten on restore`);
  }
  for (const r of ['R0', 'R2', 'R4']) {
    const g = r === 'R0' ? newGame() : at(r);
    const back = newGame({ runId: `old-${r}` });
    back.restore(JSON.parse(JSON.stringify(g.serialise())));
    assert.equal(back.state.round, r);
  }
  // A raw set_round to a round that does not exist is refused, never read as Round 0.
  const g = at('R3');
  assert.equal(g.setRound('R9'), false);
  assert.equal(g.state.round, 'R3');
  assert.equal(logEvents(g, 'round_refused').length, 1);
});

test('R7-015: Rounds 0 to 4 are exactly as they were — lengths, order, upkeep at the change, AGR pools', () => {
  const g = newGame();
  assert.deepEqual(['R0', 'R1', 'R2', 'R3', 'R4'].map((r) => g.roundConfig(r).length_s), [1200, 900, 900, 720, 480]);
  assert.equal([...g.agrRiskPoolFor('R2')].sort().join('+'), 'LOW+MEDIUM');
  assert.equal([...g.agrRiskPoolFor('R3')].sort().join('+'), 'HIGH+MEDIUM');
  assert.equal(g.agrRiskPoolFor('R1'), null);
  for (const r of ['R1', 'R2', 'R3', 'R4']) {
    const res = g.activateRound(r);
    assert.equal(res.ok, true, r);
    g.clock('start'); g.tick(1000);
  }
  assert.equal(g.state.round, 'R4');
  assert.equal(g.activateRound('R4').reason, 'round_already_active');
});

// -- R7-016 / NAME-001 / NAME-004 / NAME-005 / NAME-006: a round is its number -----------------------

test('R7-016 / NAME-001: the facilitator console identifies Round 7 as ROUND 7 and every round only by number', () => {
  const f = forControl(at('R7'));
  assert.deepEqual(f.phases.map((p) => p.number), [0, 1, 2, 3, 4, 5, 6, 7, null]);
  assert.ok(f.phases.every((p) => p.name === undefined), 'the navigator carries names');
  assert.equal(f.round_number, 7);
  assert.equal(f.round_name, undefined);
  assert.ok(/const roundLabel = \(p\) => \(p && p\.number !== null && p\.number !== undefined \? `ROUND \$\{p\.number\}` : 'END'\);/.test(CONTROL));
  assert.ok(/`Round \$\{state\.round_number\}`/.test(CONTROL));
  assert.ok(/round_length_s\.R7/.test(CONTROL) && /round_length_s\.R5/.test(CONTROL) && /round_length_s\.R6/.test(CONTROL), 'the settings stop at Round 4');
});

test('NAME-004: analytics compares ROUND 3 with ROUND 7, by number', () => {
  const g = at('R3');
  g.fireFault('F-301', 'POW');
  for (const r of ['R4', 'R5', 'R6', 'R7']) { g.activateRound(r); g.clock('start'); g.tick(1000); }
  g.fireFault('F-401', 'POW');
  const d = analyse(g.log.readAll(), { runId: 'r7' });
  assert.deepEqual([d.comparison.from, d.comparison.to], ['R3', 'R7']);
  assert.equal(d.comparison.R3.faults_fired, 1);
  assert.equal(d.comparison.R7.faults_fired, 1);
  assert.equal(d.rounds.R7.faults.fired, 1);
  assert.ok(/cmpLabel\(cmp\.from\)/.test(CONTROL) && /cmpLabel\(cmp\.to\)/.test(CONTROL), 'the panel does not print the compared rounds by number');
  assert.ok(!/AFTERSHOCK/.test(CONTROL));
});

test('NAME-005: the guidebook gives no round a title or nickname', () => {
  const headings = [...GUIDEBOOK.matchAll(/H[123]\("([^"]*)"\)/g)].map((m) => m[1]);
  const upper = headings.map((h) => h.toUpperCase());
  for (const h of upper) for (const w of NAMES) assert.ok(!h.includes(w), `a heading names a round: ${h}`);
  assert.ok(!headings.some((h) => /^Wave \d/.test(h)), 'the runbook still numbers waves instead of rounds');
  for (const r of [1, 2, 3, 4, 5, 6, 7]) assert.ok(headings.some((h) => h.startsWith(`Round ${r} (`)), `no runbook section for Round ${r}`);
  // The rounds table and the day shape count to seven and name nothing.
  assert.ok(GUIDEBOOK.includes('row(["Round 7", "00:00–10:00"'));
  assert.ok(GUIDEBOOK.includes('THE SHIFT — seven timed rounds'));
  for (const w of ['Stable Operations', 'Temporary Stabilisation', 'Final Crisis', 'Aftershock', 'Core Failure wave', 'ORIENTATION / SHIFT']) {
    assert.ok(!GUIDEBOOK.includes(w), `the guidebook still says "${w}"`);
  }
  assert.ok(GUIDEBOOK.includes('END SIMULATION. Every clock stops'));
  assert.ok(GUIDEBOOK.indexOf('END SIMULATION. Every clock stops') > GUIDEBOOK.indexOf('Round 7 (00:00 – 10:00)'), 'the end comes before Round 7');
});

test('NAME-006: no screen source carries a round-name label', () => {
  for (const file of UI_FILES) {
    const text = read(file).toUpperCase();
    for (const w of NAMES) assert.ok(!text.includes(w), `${file} contains "${w}"`);
  }
  // The content the room sees is numbered only; a card names its sector and nothing about when it is dealt (2026-10-06).
  const cards = read('tools/kit/build_cards.js');
  assert.ok(!/ROUND_LABEL|tabLabel/.test(cards) && !/AFTERSHOCK|ORIENTATION|SHIFT 1/.test(cards));
  for (const r of ROUNDS.rounds) assert.ok(!NAMES.some((w) => JSON.stringify(r).toUpperCase().includes(w)), `${r.id} carries a name`);
});
