'use strict';
/**
 * FAULT REWARD BALANCE (2026-10-05, docs/fault-reward-balance.md).
 *
 * The same opportunity in every sector, on a different journey: each sector's
 * ten faults pay 3 Parts, 1 Med, 1 Power, 3 Integrity and 2 tokens (one of
 * RESERVE CREW / SECOND CHANCE, one of EMERGENCY REPAIR KIT / STABILISER), and
 * its six scripted faults 2 Parts, 1 Med, 2 Integrity and 1 token. The
 * balancing score below is an internal yardstick; no participant ever sees it.
 *
 *   RB-001  one reward for every fault of every deck, none for a fault that does not exist
 *   RB-002  the full library: every sector holds the same matrix
 *   RB-003  the tokens: one of each class per sector, three of each token in the city
 *   RB-004  the city total is the approved target, and every sector's reward value is the same
 *   RB-005  the standard scripted run holds the same sub-matrix in every sector, and so does the library
 *   RB-006  timing: a Parts reward in each band, no Integrity before Round 2, Med and one token inside Rounds 0-4
 *   RB-007  comparable faults pay comparable rewards, and the library decks follow one rule
 *   RB-008  nothing is missing from the console: every fault fires carrying its reward, the screen knows every token
 *   RB-009  the documents carry the engine's token definitions and no per-fault reward, so nothing printed can drift
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { newGame, loadContent } = require('./helpers');
const rewards = require('../lib/rewards');
const { forSector } = require('../lib/visibility');
const TABLE = require('../lib/fault-rewards.json');

const ROOT = path.join(__dirname, '..');
const SECTORS = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];
const TOKENS = ['RESERVE_CREW', 'SECOND_CHANCE', 'EMERGENCY_REPAIR_KIT', 'STABILISER'];
const CLASS_A = ['RESERVE_CREW', 'SECOND_CHANCE'];
const CLASS_B = ['EMERGENCY_REPAIR_KIT', 'STABILISER'];
/** The internal balancing score: what one reward is worth, never shown. */
const VALUE = { power: 1, water: 1, parts: 2, med: 2, integrity: 2, RESERVE_CREW: 2, SECOND_CHANCE: 2, EMERGENCY_REPAIR_KIT: 3, STABILISER: 3 };
/** The approved city-wide supply (docs/fault-reward-balance.md). */
const APPROVED = { parts: 18, med: 6, power: 6, water: 0, integrity: 18, RESERVE_CREW: 3, SECOND_CHANCE: 3, EMERGENCY_REPAIR_KIT: 3, STABILISER: 3 };

const FAULTS = loadContent().faults.faults;
const byCode = Object.fromEntries(FAULTS.map((f) => [f.code, f]));
const category = (r) => (r.type === 'RESOURCE' ? r.resource : r.type === 'INTEGRITY' ? 'integrity' : r.token);
const cat = (f) => category(TABLE.rewards[f.code]);
const isToken = (c) => TOKENS.includes(c);
/** A fault with a round is on the runbook's script; a reference chain or a late-shift fault is the library's. */
const scripted = (f) => f.round != null;
/** early: Rounds 0-1. mid: Rounds 2-3, and the reference chains the runbook brings in from Round 3. late: Round 4 and the late shift. */
const band = (f) => (['R0', 'R1'].includes(f.round) ? 'early' : (['R2', 'R3'].includes(f.round) || f.reference_chain) ? 'mid' : 'late');

function counts(filter) {
  const out = {};
  for (const s of SECTORS) {
    const c = { parts: 0, med: 0, power: 0, water: 0, integrity: 0, tokens: 0, value: 0, faults: 0 };
    for (const t of TOKENS) c[t] = 0;
    for (const f of FAULTS) {
      if (f.sector !== s || !filter(f)) continue;
      const k = cat(f);
      c[k] += 1;
      if (isToken(k)) c.tokens += 1;
      c.value += VALUE[k];
      c.faults += 1;
    }
    out[s] = c;
  }
  return out;
}
const spread = (rows, key) => { const v = SECTORS.map((s) => rows[s][key]); return Math.max(...v) - Math.min(...v); };
const show = (rows) => SECTORS.map((s) => `${s} ${JSON.stringify(rows[s])}`).join('; ');

test('RB-001: one reward for every fault of every deck, none for a fault that does not exist', () => {
  assert.equal(FAULTS.length, 60);
  assert.equal(Object.keys(TABLE.rewards).length, 60);
  for (const f of FAULTS) {
    const r = TABLE.rewards[f.code];
    assert.ok(r, `${f.code} has no reward`);
    assert.equal(r.sector, f.sector, `${f.code} is paid to the wrong sector`);
    assert.ok(category(r) in VALUE, `${f.code} pays something the score does not know: ${JSON.stringify(r)}`);
    if (r.type === 'RESOURCE') assert.equal(r.amount, 1, `${f.code} pays more than one unit`);
    if (r.type === 'INTEGRITY') assert.equal(r.amount, 5, `${f.code} pays other than +5`);
    if (r.type === 'OPPORTUNITY') assert.equal(r.amount, 1, `${f.code} pays more than one token`);
  }
  for (const code of Object.keys(TABLE.rewards)) assert.ok(byCode[code], `${code} is in the table but in no deck`);
});

test('RB-002: the full library — every sector holds the same matrix: 3 Parts, 1 Med, 1 Power, 0 Water, 3 Integrity, 2 tokens', () => {
  assert.deepEqual(TABLE.balance.per_sector, { parts: 3, med: 1, power: 1, water: 0, integrity: 3, tokens: 2 }, 'the table declares another matrix than the approved one');
  const rows = counts(() => true);
  for (const s of SECTORS) {
    const c = rows[s];
    assert.equal(c.faults, 10, `${s} has ${c.faults} faults`);
    assert.deepEqual({ parts: c.parts, med: c.med, power: c.power, water: c.water, integrity: c.integrity, tokens: c.tokens }, TABLE.balance.per_sector, `${s}: ${JSON.stringify(c)}`);
  }
});

test('RB-003: the tokens — one of RESERVE CREW / SECOND CHANCE and one of EMERGENCY REPAIR KIT / STABILISER per sector, three of each in the city', () => {
  const rows = counts(() => true);
  const city = Object.fromEntries(TOKENS.map((t) => [t, 0]));
  for (const s of SECTORS) {
    const a = CLASS_A.reduce((n, t) => n + rows[s][t], 0);
    const b = CLASS_B.reduce((n, t) => n + rows[s][t], 0);
    assert.equal(a, 1, `${s} holds ${a} of RESERVE CREW / SECOND CHANCE`);
    assert.equal(b, 1, `${s} holds ${b} of EMERGENCY REPAIR KIT / STABILISER`);
    for (const t of TOKENS) city[t] += rows[s][t];
  }
  assert.deepEqual(city, { RESERVE_CREW: 3, SECOND_CHANCE: 3, EMERGENCY_REPAIR_KIT: 3, STABILISER: 3 });
  // token quality: every sector's pair scores the same on the yardstick
  const quality = SECTORS.map((s) => TOKENS.reduce((v, t) => v + rows[s][t] * VALUE[t], 0));
  assert.equal(new Set(quality).size, 1, `token quality ${quality.join(' ')}`);
});

test("RB-004: the city total is the approved target, and every sector's reward value is the same", () => {
  const rows = counts(() => true);
  const city = {};
  for (const k of Object.keys(APPROVED)) city[k] = SECTORS.reduce((n, s) => n + rows[s][k], 0);
  assert.deepEqual(city, APPROVED);
  assert.deepEqual(TABLE.balance.city, APPROVED, 'the table declares a different city total than the approved one');
  assert.equal(city.parts + city.med + city.power + city.water, 30, 'the resource units in the city moved');
  const values = SECTORS.map((s) => rows[s].value);
  assert.equal(new Set(values).size, 1, `reward value per sector ${values.join(' ')}`);
  assert.equal(values[0], 20);
});

test('RB-005: the standard scripted run holds the same sub-matrix in every sector, and so does the library', () => {
  assert.deepEqual(TABLE.balance.scripted_per_sector, { parts: 2, med: 1, integrity: 2, tokens: 1 });
  assert.deepEqual(TABLE.balance.library_per_sector, { parts: 1, power: 1, integrity: 1, tokens: 1 });
  const run = counts(scripted);
  const lib = counts((f) => !scripted(f));
  for (const s of SECTORS) {
    assert.equal(run[s].faults, 6, `${s} has ${run[s].faults} scripted faults`);
    assert.deepEqual({ parts: run[s].parts, med: run[s].med, integrity: run[s].integrity, tokens: run[s].tokens }, TABLE.balance.scripted_per_sector, `${s} scripted: ${JSON.stringify(run[s])}`);
    assert.equal(run[s].power + run[s].water, 0, `${s} pays a utility inside the scripted run`);
    assert.equal(lib[s].faults, 4, `${s} has ${lib[s].faults} library faults`);
    assert.deepEqual({ parts: lib[s].parts, power: lib[s].power, integrity: lib[s].integrity, tokens: lib[s].tokens }, TABLE.balance.library_per_sector, `${s} library: ${JSON.stringify(lib[s])}`);
    assert.equal(lib[s].med + lib[s].water, 0, `${s} pays Med or Water from the library`);
  }
  // the tolerance: the scripted token differs in class, so the value may differ by one unit and no more
  assert.ok(spread(run, 'value') <= 1, `scripted value: ${show(run)}`);
  assert.ok(spread(lib, 'value') <= 1, `library value: ${show(lib)}`);
});

test('RB-006: timing — a Parts reward in each band, no Integrity before Round 2, Med and one token inside Rounds 0-4, one token in the library', () => {
  for (const s of SECTORS) {
    const mine = FAULTS.filter((f) => f.sector === s);
    for (const b of ['early', 'mid', 'late']) {
      assert.equal(mine.filter((f) => band(f) === b && cat(f) === 'parts').length, 1, `${s}: Parts rewards in the ${b} band`);
    }
    // a sector starts at 100 and nothing in Round 0 decays: +5 there is paid at the maximum
    assert.equal(mine.filter((f) => band(f) === 'early' && cat(f) === 'integrity').length, 0, `${s} pays Integrity before Round 2`);
    assert.equal(mine.filter((f) => scripted(f) && cat(f) === 'med').length, 1, `${s} earns its Med outside Rounds 0-4`);
    assert.equal(mine.filter((f) => scripted(f) && isToken(cat(f))).length, 1, `${s}: tokens inside Rounds 0-4`);
    assert.equal(mine.filter((f) => !scripted(f) && isToken(cat(f))).length, 1, `${s}: tokens in the library`);
    assert.ok(mine.some((f) => f.round === 'R4' && cat(f) !== 'parts'), `${s}: Round 4 pays Parts, so the late band is only Parts`);
  }
});

test('RB-007: comparable faults pay comparable rewards — within a procedure the values differ by at most one unit, and the library decks follow one rule', () => {
  const byProc = {};
  for (const f of FAULTS) (byProc[f.procedure] = byProc[f.procedure] || []).push(f);
  assert.equal(Object.keys(byProc).length, 10);
  for (const [proc, list] of Object.entries(byProc)) {
    assert.equal(list.length, 6, `${proc} is not one fault per sector`);
    const v = list.map((f) => VALUE[cat(f)]);
    assert.ok(Math.max(...v) - Math.min(...v) <= 1, `${proc}: ${list.map((f) => `${f.code} ${cat(f)}`).join(', ')}`);
  }
  // the library rule: a single chain pays Power, a double chain the token, a P-09 Parts, a TIME-CRITICAL P-10 Integrity
  for (const f of FAULTS.filter((x) => !scripted(x))) {
    if (f.procedure === 'P-07') assert.equal(cat(f), 'power', `${f.code} (single chain) pays ${cat(f)}`);
    else if (f.procedure === 'P-08') assert.ok(isToken(cat(f)), `${f.code} (double chain) pays ${cat(f)}`);
    else if (f.procedure === 'P-09') assert.equal(cat(f), 'parts', `${f.code} (late shift) pays ${cat(f)}`);
    else assert.equal(cat(f), 'integrity', `${f.code} (TIME-CRITICAL) pays ${cat(f)}`);
  }
  // the cheapest reward on the score sits only on two-crew faults
  for (const f of FAULTS) if (cat(f) === 'power') assert.ok(f.crew_required <= 2, `${f.code} needs ${f.crew_required} crew and pays only Power`);
});

test('RB-008: nothing is missing from the console — every fault fires carrying its reward text, and the screen knows every token', () => {
  const script = fs.readFileSync(path.join(ROOT, 'public', 'sector', 'sector.js'), 'utf8');
  const index = fs.readFileSync(path.join(ROOT, 'public', 'sector', 'index.html'), 'utf8');
  for (const t of TOKENS) assert.ok(new RegExp(`${t}:`).test(script), `the console cannot use ${t}`);
  assert.ok(/id="card-reward-text"/.test(index) && /id="tokens-block"/.test(index), 'the card or the token panel is gone');
  for (const f of FAULTS) {
    const game = newGame({ runId: `rb-${f.code}` });
    game.setPhase('ROUND_4');
    assert.equal(game.fireFault(f.code, f.sector).ok, true, `${f.code} did not fire`);
    const seen = forSector(game, f.sector).sectors[f.sector].faults.find((x) => x.code === f.code);
    const expect = rewards.tableReward(game, f.code);
    assert.ok(expect, `${f.code}: the engine has no reward for it`);
    assert.ok(seen && seen.reward, `${f.code}: no reward on the console`);
    assert.equal(seen.reward.text, expect.text, `${f.code}: the console says ${seen && seen.reward && seen.reward.text}`);
    assert.equal(seen.reward.display, `REPAIR REWARD: ${expect.text}`);
    assert.equal(seen.reward.claimed, false);
  }
});

test("RB-009: the documents carry the engine's token definitions and no per-fault reward, so nothing printed can drift from the table", () => {
  const { RULES } = require('../tools/kit/binder_rules');
  assert.deepEqual(RULES.tokens, rewards.TOKENS, 'the binder prints other token definitions than the engine uses');
  const generators = ['assemble_binders.py', 'binder_rules.js', 'binder_compact.js', 'build_binders.js', 'build_cards.js', 'build_kit.js', 'build_guidebook.js', 'manifest.js'];
  for (const g of generators) {
    const src = fs.readFileSync(path.join(ROOT, 'tools', 'kit', g), 'utf8');
    assert.ok(!/fault-rewards/.test(src), `${g} reads the reward table: a printed reward would go stale the day the table moves`);
    assert.ok(!/F-\d{3}[^\n]{0,60}(\+1 PARTS|\+1 MEDICAL|\+1 POWER|\+5 INTEGRITY|RESERVE CREW|SECOND CHANCE|REPAIR KIT|STABILISER)/.test(src), `${g} names a fault's reward`);
  }
  // the guidebook says where the reward is: on the console, never on paper
  const guide = fs.readFileSync(path.join(ROOT, 'tools', 'kit', 'build_guidebook.js'), 'utf8');
  assert.ok(/severity, decay and reward/.test(guide));
});
