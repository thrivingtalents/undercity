'use strict';
/**
 * AGR CARD UI v3 (2026-10-04): the decision card in three seconds.
 *
 * The approved mechanic did not move — same twelve cards, same effects, same
 * draw, same Transport proposal. What changed is how a card is read: a
 * two-sentence situation, the pick if one is needed, then ONE block of two
 * columns, GAIN and TRADE-OFF, each line leading with the sector and the
 * number over a standard timing word. The lines are derived from the card's
 * own effect data, so the summary cannot drift from what the engine applies.
 *
 * UI-AGR-001 … UI-AGR-010 are the spec's acceptance tests, in order.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { newGame } = require('./helpers');
const { forSector } = require('../lib/visibility');
const { agrCardSummary, lineText, timingLabel, TIMING_LABELS } = require('../lib/agr-copy');
const DECK = require('../lib/agr-deck').cards;   // normalised: `effect` / `consequences` derived from each half's targets
const STANDARD = require('../config/scenarios/haven9-standard.json');

const ROOT = path.join(__dirname, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'public/sector/sector.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public/sector/sector.css'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public/sector/index.html'), 'utf8');

/** The scenario's benched cards, wherever the file keeps its config block. */
const findKey = (o, k) => {
  if (!o || typeof o !== 'object') return undefined;
  if (k in o) return o[k];
  for (const v of Object.values(o)) { const r = findKey(v, k); if (r !== undefined) return r; }
  return undefined;
};
const DISABLED = new Set(findKey(STANDARD, 'agr_disabled_cards') || []);
const ENABLED = DECK.filter((c) => !DISABLED.has(c.id));

/** The spec's own copy and verbs, verbatim. */
const SPEC_SHORT = {
  AGR_POWER_SURGE: 'Power Grid is short on supply. AGR can back-feed its grow-light reserve into POW.',
  AGR_RELIEF_CREW: 'A sector is overloaded. AGR can send one technician to assist for the rest of the round.',
  AGR_RESERVE_CACHE: 'AGR can break one sealed emergency cache to cover an immediate resource shortage.',
  AGR_WATER_RESERVE: 'WTR needs emergency supply. AGR can divert its irrigation reserve to the city water network.',
  AGR_MEDICAL_REINFORCEMENT: 'MED needs more treatment capacity. AGR can convert one bay to medicinal production.',
  AGR_LOGISTICS_BOOST: 'AGR can lend its reserved freight slot to TRN for one additional movement this round.',
  AGR_STABILISE_SECTOR: "AGR can route a sector's air through its canopy bio-filters to stabilise its systems.",
  AGR_EMERGENCY_PARTS: 'AGR can strip reserve growing racks for pumps, valves and controllers needed immediately.',
  AGR_CRISIS_RESPONSE: 'AGR can deploy its remediation crew to the sector currently in the worst condition.',
  AGR_EMERGENCY_STOCKPILE: 'AGR can open the Seed Vault contingency stores and release its emergency reserves.',
  AGR_CITY_RECOVERY: 'AGR can run its city-wide biofilter network at maximum output to stabilise every active sector.',
};
const SPEC_ACTION = {
  AGR_RELIEF_CREW: 'SEND TECHNICIAN', AGR_POWER_SURGE: 'BACK-FEED POWER', AGR_RESERVE_CACHE: 'OPEN CACHE',
  AGR_WATER_RESERVE: 'DIVERT WATER', AGR_MEDICAL_REINFORCEMENT: 'CONVERT BAY', AGR_LOGISTICS_BOOST: 'OFFER FREIGHT SLOT',
  AGR_STABILISE_SECTOR: 'START PURGE', AGR_EMERGENCY_PARTS: 'STRIP RACKS', AGR_CRISIS_RESPONSE: 'DEPLOY CREW',
  AGR_EMERGENCY_STOCKPILE: 'OPEN STORES', AGR_CITY_RECOVERY: 'START CITY FLUSH',
};

/** The approved effects, frozen at the commit before this UI change (git show 0b0eebb:lib/agr-cards.json). */
const APPROVED = {
  // Targets (2026-10-05, approved table): the two balance-watch cards and the
  // two below carry costs beyond AGR now; every gain is as it was.
  AGR_CITY_RECOVERY: { risk: 'HIGH', target: null, requires: null, effect: { type: 'health_all', delta: 10 }, consequences: [{ type: 'workers', sector: 'ALL', delta: -1 }, { type: 'integrity', sector: 'AGR', delta: -8 }, { type: 'upkeep_extra', sector: 'WTR', add: { water: 1 }, cycles: 1 }] },
  AGR_EMERGENCY_STOCKPILE: { risk: 'HIGH', target: null, requires: null, effect: { type: 'stock', sector: 'AGR', add: { power: 5, water: 5, med: 2, parts: 1 } }, consequences: [{ type: 'integrity', sector: 'AGR', delta: -6 }, { type: 'integrity', sector: 'ALL', delta: -2 }, { type: 'upkeep_extra', sector: 'AGR', add: { power: 1, water: 1 }, cycles: 1 }] },
  AGR_WORKFORCE_RECOVERY: { risk: 'LOW', target: 'worker', requires: null, effect: { type: 'workforce_recovery', sector: 'AGR', quantity: 1 }, consequences: [] },
  AGR_POWER_SURGE: { risk: 'LOW', target: null, requires: null, effect: { type: 'stock', sector: 'POW', add: { power: 3 } }, consequences: [{ type: 'upkeep_extra', sector: 'AGR', add: { power: 1 }, cycles: 1 }] },
  AGR_WATER_RESERVE: { risk: 'MEDIUM', target: null, requires: null, effect: { type: 'stock', sector: 'WTR', add: { water: 3 } }, consequences: [{ type: 'upkeep_extra', sector: 'AGR', add: { water: 1 }, cycles: 2 }] },
  AGR_MEDICAL_REINFORCEMENT: { risk: 'MEDIUM', target: null, requires: null, effect: { type: 'capacity', kind: 'med_capacity', sector: 'MED', delta: 1 }, consequences: [{ type: 'workers', sector: 'MED', delta: -1 }] },
  AGR_LOGISTICS_BOOST: { risk: 'MEDIUM', target: null, requires: 'TRN', effect: { type: 'capacity', kind: 'trn_capacity', sector: 'TRN', delta: 1 }, consequences: [{ type: 'capacity', kind: 'trn_capacity', sector: 'TRN', delta: -1, apply_at: 'round_start' }] },
  AGR_CRISIS_RESPONSE: { risk: 'HIGH', target: null, requires: null, effect: { type: 'health_lowest', delta: 20 }, consequences: [{ type: 'integrity', sector: 'AGR', delta: -10 }] },
  AGR_STABILISE_SECTOR: { risk: 'MEDIUM', target: 'sector', requires: null, effect: { type: 'health_one', delta: 15 }, consequences: [{ type: 'upkeep_extra', sector: 'AGR', add: { power: 1, water: 1 }, cycles: 1 }, { type: 'workers', sector: 'CHOSEN', delta: -1 }] },
  AGR_EMERGENCY_PARTS: { risk: 'MEDIUM', target: null, requires: null, effect: { type: 'stock', sector: 'AGR', add: { parts: 3 } }, consequences: [{ type: 'integrity', sector: 'AGR', delta: -6, apply_at: 'round_start' }] },
  AGR_RELIEF_CREW: { risk: 'LOW', target: 'sector', requires: null, effect: { type: 'relief_crew', workers: 1 }, consequences: [{ type: 'workers', sector: 'AGR', delta: -1 }] },
  AGR_RESERVE_CACHE: { risk: 'LOW', target: 'resource_type', requires: null, effect: { type: 'cache', sector: 'AGR', choices: { power: 3, water: 3, med: 2, parts: 2 } }, consequences: [{ type: 'upkeep_extra', sector: 'AGR', add: 'chosen', amount: 1, cycles: 1 }] },
};

function live() {
  const g = newGame();
  g.setPhase('ROUND_2');
  g.clock('start');
  return g;
}
/** A card as AGR's console receives it in a decision round, whatever the draw. */
function viewOf(id, g = live()) {
  g.state.agr.offered = [id, ...g.state.agr.offered.filter((x) => x !== id)].slice(0, 3);
  return forSector(g, 'AGR').agr_cards.offered.find((c) => c.id === id);
}
const agrView = (g) => forSector(g, 'AGR').agr_cards;
/** The card template, from the one summary to the end of the card; CARD_FULL from the header const. */
const CARD_END = SCRIPT.indexOf("}).join('') || '<div class=\"empty\">No cards dealt");
const CARD = SCRIPT.slice(SCRIPT.indexOf('const summary = live'), CARD_END);
const CARD_FULL = SCRIPT.slice(SCRIPT.indexOf('const head = live'), CARD_END);

test('UI-AGR-001: Gain and Trade-off are displayed only once on the main card', () => {
  // One block is built per card and every state of the card includes that one
  // block exactly once: the face, the review step, the wait on Transport.
  assert.equal((CARD.match(/agrSummary\(card/g) || []).length, 1, 'the summary is built more than once');
  assert.equal((CARD.match(/\$\{summary\}/g) || []).length, 3, 'a state of the card lacks the block, or repeats it');
  const at = [...CARD.matchAll(/\$\{summary\}/g)].map((m) => m.index);
  const review = CARD.indexOf(': confirming');
  const face = CARD.lastIndexOf('\n          : `');
  assert.ok(at[0] < review && at[1] > review && at[1] < face && at[2] > face, 'a state of the card repeats the block, or lacks it');
  assert.ok(!/agr-both|agr-terms|IMMEDIATE GAIN|CONSEQUENCE<|agr-label/.test(SCRIPT), 'the old second copy is still rendered');
  const block = SCRIPT.slice(SCRIPT.indexOf('function agrSummary'), SCRIPT.indexOf('function agrDefaultTarget'));
  assert.equal((block.match(/'GAIN'/g) || []).length, 1);
  assert.equal((block.match(/'TRADE-OFF'/g) || []).length, 1);
});

test('UI-AGR-002: the player-facing description is at most two short sentences, and the long one is kept', () => {
  for (const c of ENABLED) {
    assert.equal(c.short_description, SPEC_SHORT[c.id], `${c.id}: not the approved copy`);
    const sentences = c.short_description.split(/[.!?]+/).filter((s) => s.trim()).length;
    const words = c.short_description.trim().split(/\s+/).length;
    assert.ok(sentences <= 2, `${c.id}: ${sentences} sentences`);
    assert.ok(words >= 8 && words <= 24, `${c.id}: ${words} words`);
    assert.ok(!/[+−-]\d/.test(c.short_description), `${c.id}: the description repeats a number`);
    assert.ok(c.description && c.description.length > c.short_description.length, `${c.id}: the full description was dropped`);
  }
  const v = viewOf('AGR_RELIEF_CREW');
  assert.equal(v.short_description, SPEC_SHORT.AGR_RELIEF_CREW);
  assert.ok(/card\.short_description \|\| card\.summary/.test(CARD) || /card\.short_description \|\| card\.summary/.test(SCRIPT), 'the console still prints the long description');
  assert.ok(!/card\.description \|\| card\.summary/.test(SCRIPT), 'the console still prints the long description');
  // The teaching rounds are untouched: no short copy, no lines, the summary as before.
  const g1 = newGame(); g1.setPhase('ROUND_1');
  for (const c of agrView(g1).offered) { assert.equal(c.short_description, undefined); assert.equal(c.gain, undefined); assert.ok(c.summary); }
});

test('UI-AGR-003: the selected target appears directly in the Gain summary', () => {
  const relief = viewOf('AGR_RELIEF_CREW');
  assert.deepEqual(relief.gain.map((l) => [l.who, l.what, l.when]), [['CHOSEN', '+1 WORKER', 'THIS_ROUND']]);
  assert.equal(relief.gain[0].text, 'CHOSEN SECTOR +1 WORKER', 'the unpicked line does not say so');
  assert.equal(lineText(relief.gain[0], { sector: 'POW' }), 'POW +1 WORKER');
  assert.equal(lineText(viewOf('AGR_STABILISE_SECTOR').gain[0], { sector: 'WTR' }), 'WTR +15 HEALTH');
  const cache = DECK.find((c) => c.id === 'AGR_RESERVE_CACHE');
  const water = agrCardSummary(cache, { resource: 'water' });
  assert.equal(water.gain[0].text, 'AGR +3 WATER');
  assert.equal(water.trade_off[0].text, 'AGR +1 WATER UPKEEP');
  assert.equal(agrCardSummary(cache).gain[0].text, 'AGR ONE OF +3 POWER · +3 WATER · +2 MED · +2 PARTS');
  // The console writes the pick in: the block is built from the review's pick,
  // the selector starts on a real option, and a change re-renders the block.
  assert.ok(/agrSummary\(card, confirming \? agrPick\.target : null\)/.test(CARD));
  assert.ok(/target: agrDefaultTarget\(card\)/.test(SCRIPT), 'the review does not start on the first option');
  assert.ok(/sel\.addEventListener\('change'/.test(SCRIPT) && /line\.who === 'CHOSEN' \? \(sector \|\| WHO_LABEL\.CHOSEN\)/.test(SCRIPT));
  assert.ok(/\$\{agrTargetPicker\(card\)\}\$\{summary\}/.test(CARD), 'the block does not follow the selector');
});

test('UI-AGR-004: the primary gain and cost can be identified without reading the description', () => {
  for (const c of ENABLED) {
    const v = viewOf(c.id);
    for (const l of [...v.gain, ...v.trade_off]) {
      assert.ok(/[+−]\d+/.test(l.text), `${c.id}: "${l.text}" has no number`);
      assert.ok(/^(POW|WTR|MED|TRN|AGR|COM|CHOSEN SECTOR|LOWEST SECTOR|ALL SECTORS) /.test(l.text), `${c.id}: "${l.text}" does not lead with the sector`);
    }
    assert.ok(v.gain.length >= 1 && v.trade_off.length >= 1, `${c.id}: a column is empty`);
  }
  // The numbers carry the weight on screen: the line is the heaviest type in the block.
  assert.ok(/\.agr-sum-what \{[^}]*font-size: 12px;[^}]*font-weight: 700/.test(CSS));
  assert.ok(/\.agr-sum-when \{[^}]*font-size: 9px/.test(CSS) && /\.agr-card\.decision \.agr-summary \{[^}]*--ink-dim/.test(CSS));
});

test('UI-AGR-005: timing uses the standard short labels', () => {
  const seen = new Set();
  for (const c of ENABLED) for (const l of [...viewOf(c.id).gain, ...viewOf(c.id).trade_off]) seen.add(l.when);
  for (const key of seen) assert.ok(TIMING_LABELS[key] || /^NEXT_\d+_UPKEEPS$/.test(key), `non-standard timing key ${key}`);
  assert.deepEqual([...seen].sort(), ['NEXT_2_UPKEEPS', 'NEXT_ROUND', 'NEXT_UPKEEP', 'NOW', 'THIS_ROUND']);
  assert.deepEqual(['NOW', 'THIS_ROUND', 'NEXT_UPKEEP', 'NEXT_2_UPKEEPS', 'NEXT_ROUND'].map(timingLabel), ['NOW', 'THIS ROUND', 'NEXT UPKEEP', 'NEXT 2 UPKEEPS', 'NEXT ROUND']);
  // The console prints the same words.
  const map = SCRIPT.match(/const TIMING_LABEL = \{([^}]*)\}/)[1];
  for (const [k, v] of Object.entries(TIMING_LABELS)) assert.ok(map.includes(`${k}: '${v}'`), `the console lacks ${k}`);
  assert.ok(!/AT NEXT UPKEEP|UNTIL THE ROUND ENDS|AT THE START OF NEXT ROUND/.test(SCRIPT), 'the long timing words are back');
  // MIXED cards get one line per timing rather than a blended word.
  const city = viewOf('AGR_CITY_RECOVERY');
  assert.deepEqual(city.trade_off.map((l) => [l.text, l.when]), [['ALL SECTORS −1 WORKER', 'THIS_ROUND'], ['AGR −8 HEALTH', 'NOW'], ['WTR +1 WATER UPKEEP', 'NEXT_UPKEEP']]);
  assert.deepEqual(viewOf('AGR_WATER_RESERVE').trade_off.map((l) => [l.text, l.when]), [['AGR +1 WATER UPKEEP', 'NEXT_2_UPKEEPS']]);
  assert.deepEqual(viewOf('AGR_EMERGENCY_PARTS').trade_off.map((l) => [l.text, l.when]), [['AGR −6 HEALTH', 'NEXT_ROUND']]);
  assert.deepEqual(viewOf('AGR_LOGISTICS_BOOST').trade_off.map((l) => [l.text, l.when]), [['TRN −1 APPROVAL', 'NEXT_ROUND']]);
});

test('UI-AGR-006: all 11 enabled cards use the same information hierarchy', () => {
  assert.equal(ENABLED.length, 11);
  for (const c of ENABLED) {
    const v = viewOf(c.id);
    for (const k of ['id', 'title', 'risk', 'short_description', 'action_label', 'gain', 'trade_off', 'description', 'immediate_gain', 'consequence']) {
      assert.ok(v[k] !== undefined && v[k] !== '', `${c.id} lacks ${k}`);
    }
    assert.equal(v.action_label, SPEC_ACTION[c.id], `${c.id}: not the approved verb`);
    assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(v.risk));
    assert.ok(v.title.split('\n').length === 1 && v.title.length <= 36, `${c.id}: the title will not fit two lines`);
  }
  // The selector's word is the card's own, only where a choice exists.
  assert.equal(viewOf('AGR_RELIEF_CREW').target_label, 'SEND TO');
  assert.equal(viewOf('AGR_STABILISE_SECTOR').target_label, 'STABILISE');
  assert.equal(viewOf('AGR_CRISIS_RESPONSE').target_label, 'SUPPORT');
  assert.equal(viewOf('AGR_RESERVE_CACHE').target_label, 'RESOURCE');
  assert.equal(viewOf('AGR_POWER_SURGE').target_label, null);
  // One header, one title, one description, one block, one rule, one verb: the template renders them in that order.
  const markup = CARD_FULL.slice(CARD_FULL.indexOf('return `<div class="agr-card'));
  const order = ['${head}', 'class="agr-title"', 'class="agr-summary"', '${needs}', '${body}'];
  const at = order.map((m) => markup.indexOf(m));
  assert.ok(at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1])), `the card renders out of order: ${at}`);
  assert.ok(CARD_FULL.indexOf('AGR · OPERATIONAL DECISION') >= 0 && CARD_FULL.indexOf('AGR · OPERATIONAL DECISION') < CARD_FULL.indexOf('const summary = live'));
  assert.ok(CARD.indexOf('agrTargetPicker(card)}${summary}') < CARD.indexOf('agr-rule') && CARD.indexOf('agr-rule') < CARD.indexOf('card.action_label'));
  assert.ok(/\$\{esc\(card\.risk \|\| 'LOW'\)\} TRADE-OFF/.test(CARD_FULL), 'the risk pill does not read "<RISK> TRADE-OFF"');
});

test('UI-AGR-007: no approved card effect has changed', () => {
  assert.equal(DECK.length, 12);
  for (const c of DECK) {
    const a = APPROVED[c.id];
    assert.ok(a, `${c.id} is not an approved card`);
    assert.deepEqual({ risk: c.risk, target: c.target || null, requires: c.requires || null, effect: c.effect, consequences: c.consequences }, a, `${c.id} changed`);
  }
  // The lines are derived from those effects, never stored beside them.
  for (const c of DECK) assert.ok(Array.isArray(c.gain.effects) && !('trade_off' in c) && !('gain_text' in c) && !c.gain.text, `${c.id} stores a hand-written summary`);
  // And they still apply as before: a decision in Round 2 lands its gain and its trade-off.
  const g = live();
  viewOf('AGR_RELIEF_CREW', g);
  assert.equal(g.agrActivate('AGR_RELIEF_CREW', { by: 'AGR', target: { sector: 'POW' } }).ok, true);
  const workers = g.state.effects.filter((e) => e.kind === 'extra_workers').map((e) => [e.target, e.delta]);
  assert.deepEqual(workers, [['POW', 1], ['AGR', -1]], 'the gain and the trade-off did not both land');
});

test('UI-AGR-008: the TRN approval card still enters its existing pending approval state', () => {
  const g = live();
  viewOf('AGR_LOGISTICS_BOOST', g);
  const res = g.agrActivate('AGR_LOGISTICS_BOOST', { by: 'AGR' });
  assert.equal(res.ok, true);
  assert.ok(g.agrPendingDecision(), 'no proposal is pending');
  let v = agrView(g);
  assert.equal(v.pending && v.pending.card, 'AGR_LOGISTICS_BOOST');
  assert.ok(v.message.startsWith('PENDING TRN APPROVAL'));
  const other = () => agrView(g).offered.find((c) => c.id !== 'AGR_LOGISTICS_BOOST').id;
  assert.equal(g.agrSelect(other(), { by: 'AGR' }).reason, 'agr_decision_pending', 'another card could be reviewed');
  assert.ok(/a\.used \|\| pending \? ' disabled'/.test(SCRIPT), 'the other cards are not disabled while pending');
  assert.ok(/<b>PENDING TRN APPROVAL<\/b><span>Transport is reviewing the freight-slot arrangement\.<\/span>/.test(SCRIPT));
  assert.ok(/OFFER FREIGHT SLOT/.test(JSON.stringify(viewOf('AGR_LOGISTICS_BOOST'))));
  // Transport's card carries the same two columns.
  const trn = forSector(g, 'TRN').slot_requests.find((r) => r.card === 'AGR_LOGISTICS_BOOST');
  assert.ok(trn && trn.action_required);
  assert.deepEqual(trn.gain.map((l) => l.text), ['TRN +1 APPROVAL']);
  assert.deepEqual(trn.trade_off.map((l) => l.text), ['TRN −1 APPROVAL']);
  assert.ok(/BOTH EFFECTS APPLY IF ACCEPTED\./.test(SCRIPT) && !/BOTH EFFECTS APPLY TO TRANSPORT/.test(SCRIPT));
  // Declined: AGR is told, until it reviews another card.
  const id = g.agrPendingDecision().id;
  assert.equal(g.agrSlotRespond(id, { accept: false, by: 'TRN' }).ok, true);
  v = agrView(g);
  assert.equal(v.pending, null);
  assert.equal(v.slot_result && v.slot_result.status, 'DECLINED');
  assert.ok(v.message.startsWith('TRN DECLINED THE ARRANGEMENT'), v.message);
  assert.equal(g.agrSelect(other(), { by: 'AGR' }).ok, true);
  v = agrView(g);
  assert.equal(v.slot_result, null);
  assert.ok(v.message.startsWith('Three operational decisions'), v.message);
  // Accepted: the round's choice is spent and AGR is told that too.
  const g2 = live();
  viewOf('AGR_LOGISTICS_BOOST', g2);
  g2.agrActivate('AGR_LOGISTICS_BOOST', { by: 'AGR' });
  assert.equal(g2.agrSlotRespond(g2.agrPendingDecision().id, { accept: true, by: 'TRN' }).accepted, true);
  v = agrView(g2);
  assert.equal(v.used, true);
  assert.equal(v.slot_result && v.slot_result.status, 'ACCEPTED');
  assert.ok(v.message.startsWith('TRN APPROVED THE ARRANGEMENT'), v.message);
  // Lapsed on the paperwork timeout: told, and free.
  const g3 = live();
  g3.patchConfig({ request_timeout_s: 5 });
  viewOf('AGR_LOGISTICS_BOOST', g3);
  g3.agrActivate('AGR_LOGISTICS_BOOST', { by: 'AGR' });
  g3.tick(6000);
  v = agrView(g3);
  assert.equal(v.pending, null);
  assert.equal(v.slot_result && v.slot_result.status, 'EXPIRED');
  assert.ok(v.message.startsWith('THE FREIGHT-SLOT PROPOSAL LAPSED'), v.message);
});

test('UI-AGR-009: the layout holds at the sector-console width', () => {
  // The card lives in the 320 px right column (380 px above 1700 px): two
  // columns that fit it, stacked below it, nothing fixed wider than the card.
  assert.ok(/\.agr-sum \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(126px, 1fr\)\)/.test(CSS));
  assert.ok(/\.agr-sum-col \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere/.test(CSS));
  assert.ok(!/\.agr-sum[^{]*\{[^}]*white-space: nowrap/.test(CSS), 'a summary line refuses to wrap');
  assert.ok(!/\.agr-(sum|card|target|rule|cond|head|title|summary|btns|select)[a-z-]* \{[^}]*[^-]width: \d{3,}px/.test(CSS), 'a fixed width wider than the card');
  assert.ok(!/\.agr-[a-z-]* \{[^}]*overflow-x: (auto|scroll)/.test(CSS), 'horizontal scrolling');
  assert.ok(/\.columns \{[^}]*grid-template-columns: 300px minmax\(0, 1fr\) 320px/.test(CSS.replace(/\n/g, ' ')));
});

test('UI-AGR-010: there is no duplicate confirmation summary inside the same card', () => {
  const confirm = CARD.slice(CARD.indexOf(': confirming'));
  assert.equal((confirm.match(/\$\{summary\}/g) || []).length, 2, 'the review and face states do not each show the block once');
  assert.equal((CARD.match(/BOTH EFFECTS APPLY IF CONFIRMED\./g) || []).length, 1);
  assert.ok(!/IF AUTHORISED|AUTHORISE DECISION|BACK TO OPTIONS/.test(SCRIPT));
  assert.ok(!/IMMEDIATE GAIN|<b>CONSEQUENCE<\/b>|If authorised/.test(INDEX), 'the notice still uses the old words');
  assert.ok(/<b>GAIN<\/b><span>and<\/span><b>TRADE-OFF<\/b>/.test(INDEX) && /If confirmed, both effects apply\./.test(INDEX));
});
