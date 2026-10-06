'use strict';
/**
 * AGR TARGETS (2026-10-05): each half of a decision card lands where it says.
 *
 * AGR still draws three and confirms one, and a card is still a GAIN and a
 * TRADE-OFF. What changed is who the halves touch: each declares its own
 * targets — SELF, one sector, several, all, the pick, the lowest — and
 * nothing lands on AGR merely because AGR played the card. Every sector a
 * decision touches is told, on its own console, what landed and why; AGR
 * keeps the whole picture until the next round deals.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { newGame, logEvents } = require('./helpers');
const { forSector, forControl, forBigscreen } = require('../lib/visibility');
const { cards: DECK, normalise, TARGET_TYPES } = require('../lib/agr-deck');
const RAW = require('../lib/agr-cards.json').cards;
const { agrCardSummary, affectsOf, affectsText } = require('../lib/agr-copy');
const economy = require('../lib/economy');

const ROOT = path.join(__dirname, '..');
const SECTOR_SCRIPT = fs.readFileSync(path.join(ROOT, 'public/sector/sector.js'), 'utf8');
const SECTOR_INDEX = fs.readFileSync(path.join(ROOT, 'public/sector/index.html'), 'utf8');
const SECTORS = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];
const APPROVED_MIX = {
  sector_only: ['AGR_EMERGENCY_PARTS', 'AGR_RESERVE_CACHE', 'AGR_MEDICAL_REINFORCEMENT', 'AGR_LOGISTICS_BOOST', 'AGR_WORKFORCE_RECOVERY'],
  multi: ['AGR_POWER_SURGE', 'AGR_WATER_RESERVE'],
  all: ['AGR_EMERGENCY_STOCKPILE', 'AGR_CITY_RECOVERY'],
  dynamic: ['AGR_CRISIS_RESPONSE', 'AGR_STABILISE_SECTOR', 'AGR_RELIEF_CREW'],
};

function game(phase = 'ROUND_2') {
  const g = newGame();
  g.setPhase(phase);
  g.clock('start');
  for (const s of SECTORS) g.setInventory(s, { power: 9, water: 9, parts: 9, med: 9 });
  return g;
}
const deal = (g, id) => { g.state.agr.offered = [id, ...g.state.agr.offered.filter((x) => x !== id)].slice(0, 3); };
const card = (id) => DECK.find((c) => c.id === id);
const notices = (g, code) => g.state.announcements.filter((a) => a.sector === code).map((a) => a.text);
const workersFx = (g) => g.state.effects.filter((e) => e.kind === 'extra_workers').map((e) => [e.target, e.delta]);
const obligations = (g) => g.state.effects.filter((e) => e.kind === 'upkeep_extra').map((e) => [e.target, e.add]);

// -- the data model ---------------------------------------------------------------------------

test('every card declares both halves with their own targets, and the engine reads the same shape it always has', () => {
  assert.equal(RAW.length, 12);
  for (const raw of RAW) {
    for (const half of ['gain', 'tradeoff']) {
      const h = raw[half];
      assert.ok(h && TARGET_TYPES.includes(h.target_type), `${raw.id} ${half}: no target_type`);
      assert.ok(Array.isArray(h.target_sectors) && Array.isArray(h.effects), `${raw.id} ${half}: shape`);
      for (const e of h.effects) assert.ok(e.sector, `${raw.id} ${half}: an effect names no sector`);
    }
    assert.equal(raw.owner_sector, 'AGR', `${raw.id}: AGR owns the deck`);
    assert.ok(!('effect' in raw) && !('consequences' in raw), `${raw.id}: the legacy fields are stored beside the halves`);
  }
  for (const c of DECK) {
    assert.ok(c.effect && c.gain_effects && Array.isArray(c.consequences), `${c.id}: not normalised`);
    assert.deepEqual(c.consequences.map((x) => x.type), c.tradeoff.effects.map((x) => x.type));
    assert.ok(Array.isArray(c.affects.gain) && Array.isArray(c.affects.tradeoff));
  }
  // The normaliser refuses what the engine cannot apply.
  const bad = JSON.parse(JSON.stringify(RAW[3]));
  bad.tradeoff.target_type = 'EVERYONE';
  assert.throws(() => normalise(bad), /target_type/);
  const bad2 = JSON.parse(JSON.stringify(RAW[3]));
  bad2.tradeoff.effects.push({ type: 'integrity', sector: 'MED', delta: -1 });   // SELF naming MED
  assert.throws(() => normalise(bad2), /SELF names MED/);
  const bad3 = JSON.parse(JSON.stringify(RAW[3]));
  bad3.gain.effects[0].type = 'food';
  assert.throws(() => normalise(bad3), /effect type/);
});

test('the approved mix: five local, two multi, two city-wide, three dynamic — and gains exactly as they were', () => {
  const overall = (c) => [...new Set([...c.affects.gain, ...c.affects.tradeoff])];
  for (const id of APPROVED_MIX.all) assert.ok(overall(card(id)).includes('ALL'), `${id} is not city-wide`);
  for (const id of APPROVED_MIX.dynamic) assert.ok(overall(card(id)).some((t) => t === 'CHOSEN' || t === 'LOWEST'), `${id} is not dynamic`);
  for (const id of APPROVED_MIX.sector_only) assert.equal(overall(card(id)).length, 1, `${id} touches more than one sector: ${overall(card(id))}`);
  for (const id of APPROVED_MIX.multi) assert.equal(overall(card(id)).length, 2, `${id}: ${overall(card(id))}`);
  assert.equal(Object.values(APPROVED_MIX).flat().length, 12);
  // Who pays: six at home, two elsewhere, one on AGR and the pick, two city-wide, one with nothing owed.
  const payers = Object.fromEntries(DECK.map((c) => [c.id, c.affects.tradeoff]));
  assert.deepEqual(payers.AGR_MEDICAL_REINFORCEMENT, ['MED']);
  assert.deepEqual(payers.AGR_LOGISTICS_BOOST, ['TRN']);
  assert.deepEqual(payers.AGR_STABILISE_SECTOR, ['AGR', 'CHOSEN']);
  assert.deepEqual(payers.AGR_EMERGENCY_STOCKPILE, ['ALL']);
  assert.deepEqual(payers.AGR_CITY_RECOVERY, ['ALL']);
  for (const id of ['AGR_POWER_SURGE', 'AGR_WATER_RESERVE', 'AGR_CRISIS_RESPONSE', 'AGR_EMERGENCY_PARTS', 'AGR_RELIEF_CREW', 'AGR_RESERVE_CACHE']) assert.deepEqual(payers[id], ['AGR'], id);
  assert.deepEqual(payers.AGR_WORKFORCE_RECOVERY, []);
  // The gains did not move.
  assert.deepEqual(card('AGR_CITY_RECOVERY').effect, { type: 'health_all', delta: 10 });
  assert.deepEqual(card('AGR_EMERGENCY_STOCKPILE').effect, { type: 'stock', sector: 'AGR', add: { power: 5, water: 5, med: 2, parts: 1 } });
  assert.deepEqual(card('AGR_MEDICAL_REINFORCEMENT').effect, { type: 'capacity', kind: 'med_capacity', sector: 'MED', delta: 1 });
  assert.deepEqual(card('AGR_STABILISE_SECTOR').effect, { type: 'health_one', delta: 15 });
  assert.deepEqual(card('AGR_POWER_SURGE').effect, { type: 'stock', sector: 'POW', add: { power: 3 } });
});

// -- the four redesigned cards land where the table says ------------------------------------------

test('CONVERT A BAY: MED gains the capacity and MED pays the hand — AGR is untouched', () => {
  const g = game();
  deal(g, 'AGR_MEDICAL_REINFORCEMENT');
  const agrBefore = { inv: { ...g.state.sectors.AGR.inventory }, integrity: g.state.sectors.AGR.integrity, upkeep: economy.upkeepFor(g, g.state.sectors.AGR) };
  const medWorkers = g.availableWorkers(g.state.sectors.MED);
  const r = g.agrActivate('AGR_MEDICAL_REINFORCEMENT', { by: 'AGR' });
  assert.equal(r.ok, true);
  assert.equal(g.medCapacity(), 4);
  assert.deepEqual(workersFx(g), [['MED', -1]]);
  assert.equal(g.availableWorkers(g.state.sectors.MED), medWorkers - 1);
  assert.deepEqual(obligations(g), [], 'AGR owes water it should not');
  assert.deepEqual(economy.upkeepFor(g, g.state.sectors.AGR), agrBefore.upkeep);
  assert.equal(g.state.sectors.AGR.integrity, agrBefore.integrity);
  assert.deepEqual(g.state.sectors.AGR.inventory, agrBefore.inv);
  // MED is told, nobody else is, and AGR holds the result.
  assert.equal(notices(g, 'MED').length, 1);
  assert.match(notices(g, 'MED')[0], /^CITY DECISION — AGR: CONVERT A BAY TO MEDICINAL STOCK\. MED \+1 HEAL CAPACITY · THIS ROUND; −1 WORKER · THIS ROUND\.$/);
  for (const s of ['POW', 'WTR', 'TRN', 'COM', 'AGR']) assert.equal(notices(g, s).length, 0, `${s} was told about MED's business`);
  assert.deepEqual(r.summary, { MED: ['+1 HEAL CAPACITY · THIS ROUND', '−1 WORKER · THIS ROUND'] });
  // The round ends the loan of the hand, as any workers effect.
  g.activateRound('R3');
  assert.deepEqual(workersFx(g), []);
});

test('TARGETED PURGE: the chosen sector gains health and loses a worker; AGR pays the pumps', () => {
  const g = game();
  deal(g, 'AGR_STABILISE_SECTOR');
  g.setIntegrity('MED', 70);
  const r = g.agrActivate('AGR_STABILISE_SECTOR', { by: 'AGR', target: { sector: 'MED' } });
  assert.equal(r.ok, true);
  assert.equal(g.state.sectors.MED.integrity, 85);
  assert.deepEqual(workersFx(g), [['MED', -1]]);
  assert.deepEqual(obligations(g), [['AGR', { power: 1, water: 1 }]]);
  assert.deepEqual(r.summary, { MED: ['+15 HEALTH · NOW', '−1 WORKER · THIS ROUND'], AGR: ['+1 POWER · +1 WATER UPKEEP · NEXT UPKEEP'] });
  assert.equal(notices(g, 'MED').length, 1);
  assert.match(notices(g, 'MED')[0], /MED \+15 HEALTH · NOW; −1 WORKER · THIS ROUND\./);
  assert.equal(notices(g, 'AGR').length, 0, 'AGR is not noticed about its own decision');
  // A sector at 95 reads the health it actually got.
  const g2 = game();
  deal(g2, 'AGR_STABILISE_SECTOR');
  g2.setIntegrity('POW', 95);
  assert.deepEqual(g2.agrActivate('AGR_STABILISE_SECTOR', { by: 'AGR', target: { sector: 'POW' } }).summary.POW[0], '+5 HEALTH · NOW');
});

test('OPEN THE STORES: AGR fills up, AGR loses 6, every active sector loses 2, and every sector is told', () => {
  const g = game();
  deal(g, 'AGR_EMERGENCY_STOCKPILE');
  g.setIntegrity('COM', 0);   // dark: no further loss, no notice
  const before = Object.fromEntries(SECTORS.map((s) => [s, g.state.sectors[s].integrity]));
  const r = g.agrActivate('AGR_EMERGENCY_STOCKPILE', { by: 'AGR' });
  assert.equal(r.ok, true);
  assert.equal(g.state.sectors.AGR.inventory.power, 9 + 5);
  assert.equal(g.state.sectors.AGR.integrity, before.AGR - 6 - 2);
  for (const s of ['POW', 'WTR', 'MED', 'TRN']) assert.equal(g.state.sectors[s].integrity, before[s] - 2, s);
  assert.equal(g.state.sectors.COM.integrity, 0);
  assert.deepEqual(obligations(g), [['AGR', { power: 1, water: 1 }]]);
  for (const s of ['POW', 'WTR', 'MED', 'TRN']) {
    assert.equal(notices(g, s).length, 1, `${s} was not told`);
    assert.match(notices(g, s)[0], /^CITY DECISION — AGR: OPEN THE CONTINGENCY STORES\. [A-Z]{3} −2 HEALTH · NOW\.$/);
  }
  assert.equal(notices(g, 'COM').length, 0, 'a dark sector was told');
  assert.deepEqual(r.summary.AGR, ['+5 POWER · +5 WATER · +2 MED · +1 PARTS · NOW', '−6 HEALTH · NOW', '−2 HEALTH · NOW', '+1 POWER · +1 WATER UPKEEP · NEXT UPKEEP']);
  assert.equal(logEvents(g, 'agr_integrity_cost').length, 6, 'one cost line per sector hit');
  assert.equal(logEvents(g, 'agr_balance_watch').length, 1);
});

test('BIOFILTER FLUSH: every active sector gains health and lends a worker; AGR loses 8; WTR owes the water', () => {
  const g = game();
  deal(g, 'AGR_CITY_RECOVERY');
  g.setIntegrity('POW', 60); g.setIntegrity('WTR', 95);
  const r = g.agrActivate('AGR_CITY_RECOVERY', { by: 'AGR' });
  assert.equal(r.ok, true);
  assert.equal(g.state.sectors.POW.integrity, 70);
  assert.equal(g.state.sectors.WTR.integrity, 100);
  assert.equal(g.state.sectors.AGR.integrity, 100 + 10 - 8 > 100 ? 92 : 92);
  assert.deepEqual(workersFx(g).sort(), SECTORS.map((s) => [s, -1]).sort());
  assert.deepEqual(obligations(g), [['WTR', { water: 1 }]]);
  assert.deepEqual(economy.upkeepFor(g, g.state.sectors.AGR), { power: 2, water: 1 }, 'AGR owes nothing extra');
  assert.ok(economy.upkeepFor(g, g.state.sectors.WTR).water >= 1);
  assert.deepEqual(r.summary.POW, ['+10 HEALTH · NOW', '−1 WORKER · THIS ROUND']);
  assert.deepEqual(r.summary.WTR, ['+5 HEALTH · NOW', '−1 WORKER · THIS ROUND', '+1 WATER UPKEEP · NEXT UPKEEP']);
  assert.deepEqual(r.summary.AGR, ['+0 HEALTH · NOW', '−1 WORKER · THIS ROUND', '−8 HEALTH · NOW']);
  for (const s of ['POW', 'WTR', 'MED', 'TRN', 'COM']) assert.equal(notices(g, s).length, 1, s);
  assert.match(notices(g, 'WTR')[0], /WTR \+5 HEALTH · NOW; −1 WORKER · THIS ROUND; \+1 WATER UPKEEP · NEXT UPKEEP\./);
  // WTR pays the extra water at the change (its line is read before the pass retires it); AGR pays only its own.
  const wtr = g.state.sectors.WTR.inventory.water;
  const due = economy.upkeepFor(g, g.state.sectors.WTR).water;
  g.activateRound('R3');
  assert.equal(g.state.sectors.WTR.inventory.water, wtr - due, 'WTR did not pay the extra water');
  assert.equal(due, economy.upkeepFor(g, g.state.sectors.WTR).water + 1, 'the obligation was not one extra unit');
  assert.deepEqual(obligations(g), []);
});

test('a CITY DECISION is said once (2026-10-06): the notice lives for its round, the round change takes it down, and the consequence still lands', () => {
  const g = game();
  deal(g, 'AGR_CITY_RECOVERY');
  g.announce('Keep the pumps on', { sector: 'WTR' });   // a facilitator notice from earlier, for contrast
  assert.equal(g.agrActivate('AGR_CITY_RECOVERY', { by: 'AGR' }).ok, true);
  // during the round: the affected table is told once, and that is the notice its console shows
  assert.equal(notices(g, 'WTR').length, 2);
  assert.match(forSector(g, 'WTR').announcements[0].text, /^CITY DECISION — AGR/);
  assert.deepEqual(obligations(g), [['WTR', { water: 1 }]]);
  // the next round: no AGR banner on any console, the water still charged, the decision still in the log
  const water = g.state.sectors.WTR.inventory.water;
  const due = economy.upkeepFor(g, g.state.sectors.WTR).water;
  g.activateRound('R3');
  for (const s of SECTORS) assert.ok(!forSector(g, s).announcements.some((a) => /CITY DECISION/.test(a.text)), `${s} saw last round's decision again`);
  assert.deepEqual(notices(g, 'WTR'), ['Keep the pumps on'], 'the facilitator\'s own notice went with it');
  assert.equal(g.state.sectors.WTR.inventory.water, water - due, 'the trade-off was not charged');
  assert.equal(logEvents(g, 'agr_card_activated').length, 1);
  assert.equal(logEvents(g, 'agr_decision_notice').length, 5);
  const expired = logEvents(g, 'agr_decision_notices_expired');
  assert.equal(expired.length, 1);
  assert.deepEqual(expired[0].sectors.sort(), ['COM', 'MED', 'POW', 'TRN', 'WTR']);

  // a restart of the same round is not a round change: the notice stays up
  const g2 = game();
  deal(g2, 'AGR_CITY_RECOVERY');
  assert.equal(g2.agrActivate('AGR_CITY_RECOVERY', { by: 'AGR' }).ok, true);
  g2.activateRound('R2', { restart: true });
  assert.ok(notices(g2, 'WTR').some((t) => /CITY DECISION/.test(t)), 'a restart of the round took the notice down');
  assert.equal(logEvents(g2, 'agr_decision_notices_expired').length, 0);
});

// -- the cards that stayed home ----------------------------------------------------------------

test('the six local cards still pay at home, and nobody else is told', () => {
  for (const [id, target] of [['AGR_POWER_SURGE', null], ['AGR_WATER_RESERVE', null], ['AGR_EMERGENCY_PARTS', null], ['AGR_RESERVE_CACHE', { resource: 'med' }], ['AGR_RELIEF_CREW', { sector: 'POW' }], ['AGR_CRISIS_RESPONSE', null]]) {
    const g = game();
    deal(g, id);
    g.setIntegrity('COM', 40);
    const r = g.agrActivate(id, { by: 'AGR', target });
    assert.equal(r.ok, true, `${id}: ${r.reason}`);
    const paid = Object.keys(r.summary).filter((code) => r.summary[code].some((l) => /HEALTH|UPKEEP|−1 WORKER/.test(l) && !/^\+\d+ HEALTH/.test(l)));
    assert.deepEqual(paid, ['AGR'], `${id} charged ${paid}`);
    // Only the sectors the gain reached are noticed — and only when it is not AGR.
    const gainers = card(id).affects.gain.map((t) => (t === 'CHOSEN' ? 'POW' : t === 'LOWEST' ? 'COM' : t));
    for (const s of SECTORS) assert.equal(notices(g, s).length, s !== 'AGR' && gainers.includes(s) ? 1 : 0, `${id}: ${s}`);
  }
});

test('RELEASE THE FREIGHT SLOT is unchanged: Transport gains, Transport pays, Transport agrees', () => {
  const g = game();
  deal(g, 'AGR_LOGISTICS_BOOST');
  const r = g.agrActivate('AGR_LOGISTICS_BOOST', { by: 'AGR' });
  assert.equal(r.pending, true);
  const trn = forSector(g, 'TRN').slot_requests[0];
  assert.deepEqual(trn.affects, { gain: ['TRN'], tradeoff: ['TRN'] });
  assert.equal(g.agrSlotRespond(r.request.id, { accept: true, by: 'TRN' }).accepted, true);
  assert.deepEqual(g.state.agr.last_result.sectors, { TRN: ['+1 APPROVAL · THIS ROUND', '−1 APPROVAL · NEXT ROUND'] });
  assert.equal(notices(g, 'TRN').length, 1);
});

// -- what the screens say -----------------------------------------------------------------------

test('the card says who each half AFFECTS, before the pick and after it', () => {
  const g = game();
  const v = forSector(g, 'AGR').agr_cards;
  for (const c of v.offered) {
    assert.ok(c.affects && Array.isArray(c.affects.gain) && Array.isArray(c.affects.tradeoff), `${c.id} carries no affects`);
  }
  deal(g, 'AGR_STABILISE_SECTOR');
  const stab = forSector(g, 'AGR').agr_cards.offered.find((c) => c.id === 'AGR_STABILISE_SECTOR');
  assert.deepEqual(stab.affects, { gain: ['CHOSEN'], tradeoff: ['AGR', 'CHOSEN'] });
  assert.equal(affectsText(stab.affects.tradeoff), 'AGR · CHOSEN SECTOR');
  assert.equal(affectsText(stab.affects.tradeoff, { sector: 'MED' }), 'AGR · MED');
  assert.equal(affectsText(card('AGR_CITY_RECOVERY').affects.tradeoff), 'ALL SECTORS');
  assert.equal(affectsText(card('AGR_MEDICAL_REINFORCEMENT').affects.gain), 'MED');
  assert.equal(affectsText(card('AGR_CRISIS_RESPONSE').affects.gain), 'LOWEST SECTOR');
  // The console prints the label on both columns, resolves the pick into it, and shows AGR its result.
  assert.ok(/AFFECTS \$\{esc\(affects\)\}/.test(SECTOR_SCRIPT), 'no AFFECTS label');
  assert.ok(/agrAffectsText\(aff\.gain, card, pick\)/.test(SECTOR_SCRIPT) && /agrAffectsText\(aff\.tradeoff, card, pick\)/.test(SECTOR_SCRIPT));
  assert.ok(/function renderAgrResult/.test(SECTOR_SCRIPT) && /DECISION RESULT — /.test(SECTOR_SCRIPT));
  assert.ok(/id="agr-result"/.test(SECTOR_INDEX));
  assert.ok(/id="banner-notice"/.test(SECTOR_INDEX) && /NOTICE TO \$\{SECTOR\}/.test(SECTOR_SCRIPT), 'the notice banner is gone');
  // The frame carries the result after a decision, and drops it when the next round deals.
  deal(g, 'AGR_POWER_SURGE');
  g.agrActivate('AGR_POWER_SURGE', { by: 'AGR' });
  const after = forSector(g, 'AGR').agr_cards;
  assert.deepEqual(after.last_result.sectors, { POW: ['+3 POWER · NOW'], AGR: ['+1 POWER UPKEEP · NEXT UPKEEP'] });
  assert.equal(forSector(g, 'POW').agr_cards, undefined, 'POW was sent AGR\'s cards');
  assert.ok(forSector(g, 'POW').announcements.some((a) => a.sector === 'POW' && /CITY DECISION/.test(a.text)));
  assert.ok(!forSector(g, 'WTR').announcements.some((a) => /CITY DECISION/.test(a.text)), 'WTR read POW\'s notice');
  assert.ok(!forBigscreen(g).announcements.some((a) => /CITY DECISION/.test(a.text)), 'the wall read a per-sector notice');
  assert.ok(forControl(g).announcements.some((a) => /CITY DECISION/.test(a.text)), 'the facilitator does not see the notice');
  g.activateRound('R3');
  assert.equal(forSector(g, 'AGR').agr_cards.last_result, null);
});

test('tokens resolve by the engine: ALL is the active sectors, CHOSEN the pick, LOWEST the lowest, RANDOM2 two of the lit', () => {
  const g = game();
  g.setIntegrity('COM', 0);
  assert.deepEqual(g.agrTargetSectors('ALL'), ['POW', 'WTR', 'MED', 'TRN', 'AGR']);
  assert.deepEqual(g.agrTargetSectors('CHOSEN', { target: { sector: 'wtr' } }), ['WTR']);
  assert.deepEqual(g.agrTargetSectors('CHOSEN', { target: {} }), []);
  g.setIntegrity('MED', 30);
  assert.deepEqual(g.agrTargetSectors('LOWEST'), ['MED']);
  assert.deepEqual(g.agrTargetSectors('SELF'), ['AGR']);
  assert.deepEqual(g.agrTargetSectors('POW'), ['POW']);
  const two = g.agrTargetSectors('RANDOM2');
  assert.equal(two.length, 2);
  assert.ok(two.every((c) => c !== 'COM'), 'a dark sector was drawn');
  assert.deepEqual(g.agrTargetSectors('MARS'), []);
  // A trade-off on a token the pick never gave is refused, not aimed at AGR.
  const r = g.agrApplyOne({ type: 'workers', sector: 'CHOSEN', delta: -1 }, { target: {} });
  assert.deepEqual([r.applied, r.reason], [false, 'no_sector']);
  assert.deepEqual(workersFx(g), []);
});

test('a round change ends the loans and the city-wide hits land once, through the effects the engine already has', () => {
  const g = game();
  deal(g, 'AGR_CITY_RECOVERY');
  g.agrActivate('AGR_CITY_RECOVERY', { by: 'AGR' });
  const avail = Object.fromEntries(SECTORS.map((s) => [s, g.availableWorkers(g.state.sectors[s])]));
  for (const s of SECTORS) assert.ok(avail[s] < 5, `${s} did not lend a worker`);
  g.activateRound('R3');
  for (const s of SECTORS) assert.equal(g.availableWorkers(g.state.sectors[s]), 5, `${s} did not get its worker back`);
  assert.equal(logEvents(g, 'agr_decision_notice').length, 5);
  // The notices went with the round (2026-10-06); the result itself belongs to the round it was made in, and R3 has dealt.
  for (const s of SECTORS) assert.equal(notices(g, s).length, 0, `${s} was told about last round's decision again`);
  const snap = JSON.parse(JSON.stringify(g.serialise()));
  const back = newGame({ runId: 'targets-restore' });
  back.restore(snap);
  assert.equal(back.state.agr.last_result, null, 'a new round kept the old result');
  assert.ok(!back.state.announcements.some((a) => a.sector === 'POW' && /CITY DECISION/.test(a.text)), 'a restore brought the old notice back');
  // Within the round, a restore keeps the result for AGR's screen.
  const g2 = game();
  deal(g2, 'AGR_POWER_SURGE');
  g2.agrActivate('AGR_POWER_SURGE', { by: 'AGR' });
  const back2 = newGame({ runId: 'targets-restore-2' });
  back2.restore(JSON.parse(JSON.stringify(g2.serialise())));
  assert.equal(back2.state.agr.last_result.card, 'AGR_POWER_SURGE');
  assert.deepEqual(forSector(back2, 'AGR').agr_cards.last_result.sectors.POW, ['+3 POWER · NOW']);
});
