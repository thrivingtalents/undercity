'use strict';
/**
 * AGR DECISIONS (2026-10-04): a gain and a consequence, from Round 2.
 *
 * The cards are the twelve AGR has always had. What changed is the bargain:
 * from the round the scenario names, authorising a card commits Agriculture
 * to its consequence in the same breath as its gain, and there is no path on
 * which one lands without the other. Before that round the same cards are the
 * free teaching deck they were, and no table is shown a cost the engine will
 * not collect.
 *
 * One card is a proposal rather than a decision: RELEASE THE FREIGHT SLOT is
 * Transport's to accept, and while it waits AGR's round is spoken for.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { newGame, logEvents, loadContent } = require('./helpers');
const { forSector, forControl, forBigscreen } = require('../lib/visibility');
const economy = require('../lib/economy');
const CARDS = require('../lib/agr-deck').cards;   // the deck as the engine reads it: each half with its targets

const ROOT = path.join(__dirname, '..');
const SECTOR_INDEX = fs.readFileSync(path.join(ROOT, 'public/sector/index.html'), 'utf8');
const SECTOR_SCRIPT = fs.readFileSync(path.join(ROOT, 'public/sector/sector.js'), 'utf8');
const CONTROL_SCRIPT = fs.readFileSync(path.join(ROOT, 'public/control/control.js'), 'utf8');

function game(phase = 'ROUND_2') {
  const g = newGame();
  g.setPhase(phase);
  g.clock('start');
  return g;
}
/** Put a card at the top of the hand so a test can play it regardless of the draw. */
const deal = (g, id) => { g.state.agr.offered = [id, ...g.state.agr.offered.filter((x) => x !== id)].slice(0, 3); };
const agrView = (g) => forSector(g, 'AGR').agr_cards;
const obligations = (g) => g.state.effects.filter((e) => e.kind === 'upkeep_extra');
const AGR_UPKEEP = { power: 2, water: 1 };

// -- AGR-001 / 002: the round the mechanic switches on ---------------------------------

test('AGR-001: Round 1 deals cards without consequences, and shows none', () => {
  for (const phase of ['ROUND_0', 'ROUND_1']) {
    const g = game(phase);
    assert.equal(g.agrConsequencesActive(), false, `${phase} is live`);
    const v = agrView(g);
    assert.equal(v.consequences_active, false);
    assert.equal(v.notice, null, `${phase} showed the Round 2 notice`);
    for (const c of v.offered) {
      assert.equal(c.consequence, undefined, `${c.id} shows a consequence in ${phase}`);
      assert.equal(c.description, undefined, `${c.id} shows operational copy in ${phase}`);
      assert.ok(c.summary, `${c.id} lost its teaching summary`);
    }
    // The hand is the whole pool in a teaching round.
    assert.equal(g.agrRiskPoolFor(g.state.round), null);
  }
});

test('AGR-002: from Round 2 every card carries its consequence, and the notice shows once', () => {
  const g = game('ROUND_1');
  g.activateRound('R2');
  assert.equal(g.agrConsequencesActive(), true);
  const v = agrView(g);
  assert.equal(v.consequences_active, true);
  assert.deepEqual(v.notice, { round: 'R2' }, 'the operating notice did not appear');
  for (const c of v.offered) {
    assert.ok(c.description && c.description.length > 80, `${c.id} has no operational description`);
    assert.ok(c.immediate_gain, `${c.id} has no IMMEDIATE GAIN`);
    assert.ok(c.consequence, `${c.id} has no CONSEQUENCE`);
    assert.ok(c.consequence_timing, `${c.id} has no timing`);
  }
  assert.equal(g.agrAcknowledgeNotice({ by: 'AGR' }).ok, true);
  assert.equal(agrView(g).notice, null);
  g.activateRound('R3');
  assert.equal(agrView(g).notice, null, 'the notice came back in Round 3');
  assert.equal(g.agrAcknowledgeNotice({ by: 'AGR' }).reason, 'no_notice');
  assert.equal(logEvents(g, 'agr_notice_shown').length, 1);
});

// -- AGR-003 / 008: the content ------------------------------------------------------------

test('AGR-003 / AGR-008: every selectable card has a gain, a consequence, a timing and a reason', () => {
  const g = game('ROUND_2');
  const enabled = new Set(g.agrEnabledIds());
  const banned = /bonus|reward|penalty|bad impact|profit|choose this|you win|risk versus reward/i;
  for (const c of CARDS.filter((x) => enabled.has(x.id))) {
    assert.ok(c.immediate_gain, `${c.id}: no immediate_gain`);
    assert.ok(c.consequence_text, `${c.id}: no consequence_text`);
    assert.ok(c.consequence_timing, `${c.id}: no consequence_timing`);
    assert.ok(Array.isArray(c.consequences) && c.consequences.length, `${c.id}: no structured consequence`);
    assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(c.risk), `${c.id}: risk ${c.risk}`);
    const sentences = c.description.split(/[.!?]\s/).filter(Boolean).length;
    assert.ok(sentences >= 2 && sentences <= 4, `${c.id}: ${sentences} sentences`);
    assert.ok(!banned.test(c.description) && !banned.test(c.immediate_gain) && !banned.test(c.consequence_text), `${c.id}: game-like wording`);
    assert.ok(/AGR|Agriculture|bays?|vault|grow|canopy|irrigation|crop|hydroponic|filter|racks|cache|slot|technician/i.test(c.description), `${c.id}: does not read as Agriculture`);
    // The structured effect matches the words: a NEXT_UPKEEP card owes at upkeep, an IMMEDIATE one costs integrity now, and so on.
    const kinds = c.consequences.map((x) => x.type + (x.apply_at ? '@' + x.apply_at : ''));
    if (c.consequence_timing === 'NEXT_UPKEEP') assert.ok(kinds.every((k) => k === 'upkeep_extra'), `${c.id}: ${kinds}`);
    if (c.consequence_timing === 'NEXT_ROUND') assert.ok(kinds.every((k) => k.endsWith('@round_start')), `${c.id}: ${kinds}`);
    if (c.consequence_timing === 'IMMEDIATE') assert.deepEqual(kinds, ['integrity'], `${c.id}: ${kinds}`);
    if (c.consequence_timing === 'THIS_ROUND') assert.deepEqual(kinds, ['workers'], `${c.id}: ${kinds}`);
  }
  // Not every consequence is the same resource cost.
  const shapes = new Set(CARDS.filter((x) => enabled.has(x.id)).map((c) => c.consequences.map((x) => `${x.type}:${JSON.stringify(x.add || x.delta)}:${x.cycles || ''}`).join('+')));
  assert.ok(shapes.size >= 7, `only ${shapes.size} distinct consequence shapes`);
  // The two under balance watch are flagged, and their gains are untouched.
  assert.equal(CARDS.find((c) => c.id === 'AGR_EMERGENCY_STOCKPILE').balance_watch, true);
  assert.deepEqual(CARDS.find((c) => c.id === 'AGR_EMERGENCY_STOCKPILE').effect.add, { power: 5, water: 5, med: 2, parts: 1 });
  assert.equal(CARDS.find((c) => c.id === 'AGR_CITY_RECOVERY').balance_watch, true);
  assert.deepEqual(CARDS.find((c) => c.id === 'AGR_CITY_RECOVERY').effect, { type: 'health_all', delta: 10 });
  // Stable ids: the twelve are the twelve.
  assert.deepEqual(CARDS.map((c) => c.id).sort(), [
    'AGR_CITY_RECOVERY', 'AGR_CRISIS_RESPONSE', 'AGR_EMERGENCY_PARTS', 'AGR_EMERGENCY_STOCKPILE', 'AGR_LOGISTICS_BOOST', 'AGR_MEDICAL_REINFORCEMENT',
    'AGR_POWER_SURGE', 'AGR_RELIEF_CREW', 'AGR_RESERVE_CACHE', 'AGR_STABILISE_SECTOR', 'AGR_WATER_RESERVE', 'AGR_WORKFORCE_RECOVERY',
  ]);
});

// -- AGR-004 / 005 / TEST 6 / TEST 7: both or neither ---------------------------------------

test('TEST 6 / TEST 7: the same card is a free intervention in Round 1 and a bargain in Round 2', () => {
  const r1 = game('ROUND_1');
  deal(r1, 'AGR_POWER_SURGE');
  const p1 = r1.state.sectors.POW.inventory.power;
  assert.equal(r1.agrActivate('AGR_POWER_SURGE', { by: 'AGR' }).ok, true);
  assert.equal(r1.state.sectors.POW.inventory.power, p1 + 3);
  assert.equal(obligations(r1).length, 0, 'Round 1 created an obligation');
  assert.equal(logEvents(r1, 'agr_upkeep_obligation_created').length, 0);

  const r2 = game('ROUND_2');
  deal(r2, 'AGR_POWER_SURGE');
  const p2 = r2.state.sectors.POW.inventory.power;
  const res = r2.agrActivate('AGR_POWER_SURGE', { by: 'AGR' });
  assert.equal(res.ok, true);
  assert.equal(r2.state.sectors.POW.inventory.power, p2 + 3, 'the gain did not land');
  assert.equal(obligations(r2).length, 1, 'the consequence did not land');
  assert.deepEqual(obligations(r2)[0].add, { power: 1 });
  assert.deepEqual(res.consequences.map((c) => c.type), ['upkeep_extra']);
  assert.deepEqual(economy.upkeepFor(r2, r2.state.sectors.AGR), { power: 3, water: 1 }, 'upkeep does not carry the obligation');
});

test('AGR-004: there is no path to the gain without the consequence', () => {
  const g = game('ROUND_2');
  deal(g, 'AGR_CRISIS_RESPONSE');
  g.setIntegrity('WTR', 30);
  const agrHealth = g.state.sectors.AGR.integrity;
  const r = g.agrActivate('AGR_CRISIS_RESPONSE', { by: 'AGR' });
  assert.equal(r.ok, true);
  assert.equal(g.state.sectors.WTR.integrity, 50, 'the gain did not land');
  assert.equal(g.state.sectors.AGR.integrity, agrHealth - 10, 'the integrity cost did not land');
  // Every door into a gain is agrCommit, and agrCommit applies the consequences
  // in the same call — the intent layer has no "gain only" message to send.
  assert.ok(/return this\.agrCommit\(card/.test(fs.readFileSync(path.join(ROOT, 'lib/state.js'), 'utf8')));
  assert.ok(!/agr_gain_only|skip_consequence|without_consequence/.test(SECTOR_SCRIPT + fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')));
  assert.ok(logEvents(g, 'agr_card_activated')[0].consequences === 1);
  assert.equal(logEvents(g, 'agr_integrity_cost').length, 1);
});

test('AGR-005: a card AGR never authorises applies nothing', () => {
  const g = game('ROUND_2');
  const before = JSON.stringify({ e: g.state.effects, s: Object.values(g.state.sectors).map((s) => [s.integrity, s.inventory]) });
  assert.equal(g.agrSelect(g.state.agr.offered[0], { by: 'AGR' }).ok, true);   // looked at, not authorised
  assert.equal(JSON.stringify({ e: g.state.effects, s: Object.values(g.state.sectors).map((s) => [s.integrity, s.inventory]) }), before);
  g.activateRound('R3');
  assert.equal(g.state.agr.history[0].used, false);
  assert.equal(obligations(g).length, 0);
});

// -- TEST 1–5: the freight slot ------------------------------------------------------------

test('TEST 1: TRN accepts — +1 approval now, −1 next round, each exactly once', () => {
  const g = game('ROUND_2');
  deal(g, 'AGR_LOGISTICS_BOOST');
  const base = g.trnCapacity();
  const r = g.agrActivate('AGR_LOGISTICS_BOOST', { by: 'AGR' });
  assert.equal(r.pending, true);
  assert.equal(g.state.agr.used, false, 'the round was spent before Transport answered');
  assert.equal(g.trnCapacity(), base);
  assert.equal(forSector(g, 'TRN').slot_requests[0].action_required, true, 'TRN was not asked');
  assert.equal(forSector(g, 'AGR').agr_cards.pending.card, 'AGR_LOGISTICS_BOOST');
  const a = g.agrSlotRespond(r.request.id, { accept: true, by: 'TRN' });
  assert.equal(a.ok && a.accepted, true);
  assert.equal(g.trnCapacity(), base + 1);
  assert.equal(g.state.agr.used, true);
  assert.ok(g.state.effects.some((e) => e.kind === 'scheduled' && e.apply_at === 'round_start'));
  assert.equal(forControl(g).agr.pending_consequences.find((e) => e.kind === 'scheduled').fires, 'NEXT ROUND START');
  g.activateRound('R3');
  assert.equal(g.trnCapacity(), base - 1, 'the borrowed slot was not paid back');
  assert.ok(!g.state.effects.some((e) => e.kind === 'scheduled'), 'the scheduled effect survived');
  g.activateRound('R4');
  assert.equal(g.trnCapacity(), base, 'the debt outlived its round');
});

test('TEST 2: TRN declines — nothing applies, and AGR chooses another card', () => {
  const g = game('ROUND_2');
  deal(g, 'AGR_LOGISTICS_BOOST'); deal(g, 'AGR_POWER_SURGE');
  const base = g.trnCapacity();
  const r = g.agrActivate('AGR_LOGISTICS_BOOST', { by: 'AGR' });
  const d = g.agrSlotRespond(r.request.id, { accept: false, by: 'TRN' });
  assert.equal(d.ok, true); assert.equal(d.accepted, false);
  assert.equal(g.trnCapacity(), base);
  assert.equal(g.state.effects.length, 0);
  assert.equal(g.state.agr.used, false);
  assert.equal(logEvents(g, 'agr_card_declined')[0].declined_by, 'TRN');
  assert.equal(g.agrActivate('AGR_POWER_SURGE', { by: 'AGR' }).ok, true);
});

test('TEST 3: while Transport is reviewing, AGR cannot select or authorise anything else', () => {
  const g = game('ROUND_2');
  deal(g, 'AGR_LOGISTICS_BOOST'); deal(g, 'AGR_POWER_SURGE');
  g.agrActivate('AGR_LOGISTICS_BOOST', { by: 'AGR' });
  assert.equal(g.state.agr.used, false, 'agr.used is not the guard');
  assert.ok(g.agrPendingDecision(), 'no pending decision');
  assert.equal(g.agrActivate('AGR_POWER_SURGE', { by: 'AGR' }).reason, 'agr_decision_pending');
  assert.equal(g.agrSelect('AGR_POWER_SURGE', { by: 'AGR' }).reason, 'agr_decision_pending');
  assert.equal(g.agrActivate('AGR_LOGISTICS_BOOST', { by: 'AGR' }).reason, 'agr_decision_pending', 'the same card could be proposed twice');
  // Only Transport answers.
  const id = g.agrPendingDecision().id;
  assert.equal(g.agrSlotRespond(id, { accept: true, by: 'AGR' }).reason, 'trn_only');
  assert.equal(g.agrSlotRespond(id, { accept: true, by: 'POW' }).reason, 'trn_only');
  // The console says so and disables the others.
  assert.ok(/<b>PENDING TRN APPROVAL<\/b>/.test(SECTOR_SCRIPT));
  assert.ok(/a\.used \|\| pending \? ' disabled'/.test(SECTOR_SCRIPT), 'the other cards are not disabled while pending');
});

test('TEST 4: a paperwork timeout in the same round expires the proposal and frees AGR', () => {
  const g = game('ROUND_2');
  g.patchConfig({ request_timeout_s: 90 });
  deal(g, 'AGR_LOGISTICS_BOOST'); deal(g, 'AGR_POWER_SURGE');
  const r = g.agrActivate('AGR_LOGISTICS_BOOST', { by: 'AGR' });
  g.tick(89000);
  assert.equal(g.agrPendingDecision().id, r.request.id, 'expired early');
  g.tick(2000);
  const req = g.state.slot_requests.find((x) => x.id === r.request.id);
  assert.equal(req.status, 'EXPIRED'); assert.equal(req.expire_reason, 'timeout');
  assert.equal(g.state.round, 'R2');
  assert.equal(g.agrPendingDecision(), null);
  assert.equal(g.state.agr.used, false);
  assert.equal(g.agrActivate('AGR_POWER_SURGE', { by: 'AGR' }).ok, true);
  assert.equal(g.trnCapacity(), 3);
  assert.equal(logEvents(g, 'agr_slot_request_expired')[0].reason, 'timeout');
});

test('TEST 5: a round change expires the proposal, closes the old decision, and deals the new round', () => {
  const g = game('ROUND_2');
  deal(g, 'AGR_LOGISTICS_BOOST');
  const r = g.agrActivate('AGR_LOGISTICS_BOOST', { by: 'AGR' });
  g.activateRound('R3');
  const req = g.state.slot_requests.find((x) => x.id === r.request.id);
  assert.equal(req.status, 'EXPIRED'); assert.equal(req.expire_reason, 'round_change');
  assert.deepEqual([g.state.agr.history[0].round, g.state.agr.history[0].used], ['R2', false]);
  assert.equal(g.state.agr.round, 'R3'); assert.equal(g.state.agr.offered.length, 3);
  assert.equal(g.agrPendingDecision(), null);
  // No retroactive answer, no effects.
  assert.equal(g.agrSlotRespond(r.request.id, { accept: true, by: 'TRN' }).reason, 'not_open');
  assert.equal(g.state.effects.filter((e) => e.source === 'agr_card').length, 0);
  assert.equal(g.trnCapacity(), 3);
});

// -- AGR-006 / 007: persistence and single firing -----------------------------------------

test('AGR-006: obligations, scheduled hits and a pending proposal all survive a restore', () => {
  const g = game('ROUND_2');
  deal(g, 'AGR_WATER_RESERVE'); deal(g, 'AGR_EMERGENCY_PARTS');
  assert.equal(g.agrActivate('AGR_WATER_RESERVE', { by: 'AGR' }).ok, true);
  g.state.agr.used = false;                                   // let a second decision through, to stack a round-start hit
  assert.equal(g.agrActivate('AGR_EMERGENCY_PARTS', { by: 'AGR' }).ok, true);
  g.state.agr.used = false;
  deal(g, 'AGR_LOGISTICS_BOOST');
  const r = g.agrActivate('AGR_LOGISTICS_BOOST', { by: 'AGR' });
  assert.equal(r.pending, true);

  const back = newGame({ runId: 'agr-restore' });
  assert.equal(back.restore(JSON.parse(JSON.stringify(g.serialise()))), true);
  assert.deepEqual(obligations(back)[0].add, { water: 1 });
  assert.equal(obligations(back)[0].cycles_remaining, 2);
  assert.ok(back.state.effects.some((e) => e.kind === 'scheduled' && e.payload.delta === -6));
  assert.equal(back.agrPendingDecision().id, r.request.id, 'the pending proposal was lost');
  assert.equal(forSector(back, 'TRN').slot_requests[0].action_required, true);
  assert.deepEqual(economy.upkeepFor(back, back.state.sectors.AGR), { power: 2, water: 2 });
  // And a run saved before any of this restores with the fields present and empty.
  const old = JSON.parse(JSON.stringify(g.serialise()));
  delete old.state.slot_requests; delete old.state.agr.notice;
  const older = newGame({ runId: 'agr-restore-old' });
  assert.equal(older.restore(old), true);
  assert.deepEqual(older.state.slot_requests, []);
  assert.equal(older.state.agr.notice, null);
});

test('AGR-007: a delayed consequence fires exactly once, whatever happens around it', () => {
  // NEXT_UPKEEP: collected on one pass and gone.
  const g = game('ROUND_2');
  deal(g, 'AGR_STABILISE_SECTOR');
  g.setIntegrity('MED', 50);
  assert.equal(g.agrActivate('AGR_STABILISE_SECTOR', { by: 'AGR', target: { sector: 'MED' } }).ok, true);
  assert.deepEqual(economy.upkeepFor(g, g.state.sectors.AGR), { power: 3, water: 2 });
  const stock = { ...g.state.sectors.AGR.inventory };
  g.activateRound('R3');
  assert.deepEqual([g.state.sectors.AGR.inventory.power, g.state.sectors.AGR.inventory.water], [stock.power - 3, stock.water - 2]);
  assert.equal(obligations(g).length, 0, 'the obligation survived its pass');
  assert.deepEqual(economy.upkeepFor(g, g.state.sectors.AGR), AGR_UPKEEP);
  g.cycleControl('process');                                  // a facilitator's extra pass finds nothing owed
  assert.deepEqual(economy.upkeepFor(g, g.state.sectors.AGR), AGR_UPKEEP);

  // NEXT_UPKEEP ×2: two passes, then gone.
  const g2 = game('ROUND_2');
  deal(g2, 'AGR_WATER_RESERVE');
  g2.agrActivate('AGR_WATER_RESERVE', { by: 'AGR' });
  g2.activateRound('R3');
  assert.equal(obligations(g2)[0].cycles_remaining, 1, 'the two-cycle obligation did not count down');
  // A round whose clock never ran is never charged, so an obligation waits
  // for a round that was actually played — the second pass needs R3 started.
  g2.activateRound('R4');
  assert.equal(obligations(g2)[0].cycles_remaining, 1, 'an unplayed round collected the obligation');
  g2.activateRound('R3'); g2.clock('start'); g2.activateRound('R4');
  assert.equal(obligations(g2).length, 0);

  // NEXT_ROUND: fires on the first change of round, not on a restart of the same one.
  const g3 = game('ROUND_2');
  deal(g3, 'AGR_EMERGENCY_PARTS');
  g3.agrActivate('AGR_EMERGENCY_PARTS', { by: 'AGR' });
  const h = g3.state.sectors.AGR.integrity;
  g3.activateRound('R2', { restart: true });
  assert.equal(g3.state.sectors.AGR.integrity, h, 'a restart of the same round fired the hit');
  g3.activateRound('R3');
  assert.equal(g3.state.sectors.AGR.integrity, h - 6);
  g3.activateRound('R4');
  assert.equal(g3.state.sectors.AGR.integrity, h - 6, 'the hit fired twice');
  assert.equal(logEvents(g3, 'agr_integrity_cost').length, 1);
});

// -- AGR-009 / 010 / 011: nothing else moved -------------------------------------------------

test('AGR-009 / AGR-010: AGR faults and reference-chain faults are untouched', () => {
  const content = loadContent();
  const agrFaults = content.faults.faults.filter((f) => f.sector === 'AGR');
  // six from the workbook, two reference chains, and since 2026-10-05 the two late-shift faults F-609 / F-610
  assert.equal(agrFaults.length, 10, 'AGR has a different number of faults');
  assert.ok(agrFaults.some((f) => f.code === 'F-509' && f.reference_chain), 'the AGR reference-chain faults are gone');
  const g = game('ROUND_2');
  deal(g, 'AGR_EMERGENCY_PARTS');
  g.agrActivate('AGR_EMERGENCY_PARTS', { by: 'AGR' });
  assert.equal(g.fireFault('F-005', 'AGR').ok, true);
  assert.equal(g.fireFault('F-509', 'AGR').ok, true);
  const { submitCode } = require('../lib/resolve');
  const f509 = content.faults.faults.find((f) => f.code === 'F-509');
  assert.equal(submitCode(g, { sector: 'AGR', fault_code: 'F-509', code: f509.valid_codes[0], workers_assigned: 2 }).accepted, true);
});

test('AGR-011: every effect lands on the existing fields and nothing else — and no Food', () => {
  const g = game('ROUND_2');
  deal(g, 'AGR_RESERVE_CACHE');
  g.agrActivate('AGR_RESERVE_CACHE', { by: 'AGR', target: { resource: 'med' } });
  assert.deepEqual(Object.keys(g.state.sectors.AGR.inventory).sort(), ['med', 'parts', 'power', 'water']);
  assert.deepEqual(obligations(g)[0].add, { med: 1 }, 'the chosen-resource obligation is wrong');
  assert.ok(!/food/i.test(JSON.stringify(CARDS)), 'a card mentions Food, which is not a resource');
  assert.ok(!/food/i.test(fs.readFileSync(path.join(ROOT, 'lib/state.js'), 'utf8').slice(0, 400000).split('agrApplyOne')[1] || ''), 'the engine invented Food');
  // Integrity is the sector's integrity, and the wall reads it.
  deal(g, 'AGR_CRISIS_RESPONSE'); g.state.agr.used = false;
  g.setIntegrity('COM', 20);
  g.agrActivate('AGR_CRISIS_RESPONSE', { by: 'AGR' });
  assert.equal(forBigscreen(g).sectors.AGR.integrity, 90);
  assert.equal(forBigscreen(g).sectors.COM.integrity, 40);
});

// -- AGR-012 / 013 / 014: who sees what ------------------------------------------------------

test('AGR-012: the facilitator sees every pending consequence and when it lands', () => {
  const g = game('ROUND_2');
  deal(g, 'AGR_EMERGENCY_STOCKPILE');
  g.agrActivate('AGR_EMERGENCY_STOCKPILE', { by: 'AGR' });
  const a = forControl(g).agr;
  assert.equal(a.consequences_active, true);
  const fires = a.pending_consequences.map((e) => e.fires);
  assert.deepEqual(fires, ['NEXT UPKEEP'], JSON.stringify(a.pending_consequences));
  assert.deepEqual(a.pending_consequences[0].add, { power: 1, water: 1 });
  assert.ok(/ca-pending/.test(CONTROL_SCRIPT) && /ACCEPT FOR TRN/.test(CONTROL_SCRIPT));
  // The balance-watch line carries what the review needs.
  const bw = logEvents(g, 'agr_balance_watch');
  assert.equal(bw.length, 1);
  assert.deepEqual(logEvents(g, 'agr_immediate_value_generated')[0].granted, { power: 5, water: 5, med: 2, parts: 1 });
  const g2 = game('ROUND_2');
  deal(g2, 'AGR_CITY_RECOVERY');
  for (const s of ['POW', 'WTR']) g2.setIntegrity(s, 60);
  g2.agrActivate('AGR_CITY_RECOVERY', { by: 'AGR' });
  const v = logEvents(g2, 'agr_immediate_value_generated')[0];
  assert.equal(v.sectors_affected, 6);
  assert.equal(v.health_restored, 20, 'four sectors at 100 restore nothing; two at 60 restore 10 each');
  for (const ev of ['agr_card_drawn', 'agr_card_selected', 'agr_card_effect_applied', 'agr_integrity_cost', 'agr_upkeep_obligation_created']) {
    assert.ok(logEvents(g2, ev).length || ev === 'agr_card_selected', `${ev} was not logged`);
  }
});

test('AGR-013 / AGR-014: the table sees the trade-off beside the gain before confirming, and is told both apply', () => {
  const g = game('ROUND_2');
  const v = agrView(g);
  for (const c of v.offered) {
    assert.ok(c.consequence, `${c.id} reached the table without its consequence`);
    assert.ok(c.gain && c.gain.length && c.trade_off && c.trade_off.length, `${c.id} reached the table without its GAIN / TRADE-OFF lines`);
  }
  // CARD UI v3: one block, GAIN column first, rendered in every state of the
  // card after any selector and before the button; the sentence once, on the
  // confirmation step only; the card's own verb and BACK.
  const card = SECTOR_SCRIPT.slice(SECTOR_SCRIPT.indexOf('const summary = live'), SECTOR_SCRIPT.indexOf("}).join('') || '<div class=\"empty\">No cards dealt"));
  const block = SECTOR_SCRIPT.slice(SECTOR_SCRIPT.indexOf('function agrSummary'), SECTOR_SCRIPT.indexOf('function agrDefaultTarget'));
  assert.ok(block.indexOf("'GAIN'") < block.indexOf("'TRADE-OFF'"), 'the gain is not shown before the trade-off');
  assert.ok(!/agr-both|agr-terms|IMMEDIATE GAIN|CONSEQUENCE</.test(SECTOR_SCRIPT), 'the old duplicate blocks are back');
  const confirm = card.slice(card.indexOf('confirming'));
  assert.equal((card.match(/BOTH EFFECTS APPLY IF CONFIRMED\./g) || []).length, 1, 'the sentence is not shown exactly once');
  assert.ok(/BOTH EFFECTS APPLY IF CONFIRMED\./.test(confirm), 'the confirmation step does not say both apply');
  assert.ok(/\$\{agrTargetPicker\(card\)\}\$\{summary\}/.test(confirm), 'the summary does not follow the selector');
  assert.ok(/card\.action_label \|\| 'CONFIRM DECISION'/.test(confirm) && /'BACK'/.test(confirm));
  // The notice says the same, once, and is acknowledged into the log.
  assert.ok(/AGRICULTURE OPERATING NOTICE/.test(SECTOR_INDEX) && /If confirmed, both effects apply\./.test(SECTOR_INDEX) && /id="agr-notice-ack"/.test(SECTOR_INDEX));
  assert.ok(/agr_acknowledge_notice/.test(SECTOR_SCRIPT));
  // No reward-coloured buttons, no score graphics.
  assert.ok(!/\+5<\/|class="score|casino|jackpot/i.test(SECTOR_SCRIPT));
  // Round 1 shows none of it.
  const r1 = game('ROUND_1');
  for (const c of agrView(r1).offered) assert.equal(c.consequence, undefined);
});

// -- the draw ------------------------------------------------------------------------------

test('the draw: full pool in R0–R1, LOW+MEDIUM in R2, MEDIUM+HIGH from R3, three cards, choose one', () => {
  const risk = (g) => g.state.agr.offered.map((id) => g.agrCard(id).risk);
  for (const phase of ['ROUND_0', 'ROUND_1']) assert.equal(game(phase).state.agr.offered.length, 3);
  for (let i = 0; i < 6; i += 1) {
    const g2 = newGame({ runId: `draw-${i}` }); g2.setPhase('ROUND_2');
    assert.ok(risk(g2).every((r) => ['LOW', 'MEDIUM'].includes(r)), `R2 run ${i}: ${risk(g2)}`);
    assert.equal(g2.state.agr.offered.length, 3);
    g2.activateRound('R3');
    assert.ok(risk(g2).every((r) => ['MEDIUM', 'HIGH'].includes(r)), `R3 run ${i}: ${risk(g2)}`);
    g2.activateRound('R4');
    assert.ok(risk(g2).every((r) => ['MEDIUM', 'HIGH'].includes(r)), `R4 run ${i}: ${risk(g2)}`);
  }
  const g = game('ROUND_2');
  assert.equal(g.cfg.agr_cards_per_round, 3);
  deal(g, 'AGR_POWER_SURGE'); deal(g, 'AGR_RELIEF_CREW');
  assert.equal(g.agrActivate('AGR_POWER_SURGE', { by: 'AGR' }).ok, true);
  assert.equal(g.agrActivate('AGR_RELIEF_CREW', { by: 'AGR', target: { sector: 'MED' } }).reason, 'agr_card_already_used');
});
