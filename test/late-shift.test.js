'use strict';
/**
 * LATE SHIFT (2026-10-05): two more faults per sector, P-09 and P-10.
 *
 * Ten playable faults per sector now, sixty in all. The twelve new ones add no
 * mechanic: a P-09 needs two values from two binders exactly as P-05 did; a
 * P-10 is the same under time pressure expressed as Integrity decay, with
 * TIME-CRITICAL printed on the card and nothing counting down. Their values
 * are resolved from the specification tables by the generator and never
 * written anywhere else, so a changed specification changes the answer.
 *
 * FX10-001 … FX10-016 are the spec's acceptance tests; A … N the approval's.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { newGame, loadContent, logEvents } = require('./helpers');
const { submitCode } = require('../lib/resolve');
const { forSector, forControl, forBigscreen } = require('../lib/visibility');
const { validateContent } = require('../lib/validate');
const REWARDS = require('../lib/fault-rewards.json');

const ROOT = path.join(__dirname, '..');
const SECTORS = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];
const CODES = ['F-601', 'F-602', 'F-603', 'F-604', 'F-605', 'F-606', 'F-607', 'F-608', 'F-609', 'F-610', 'F-611', 'F-612'];
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'late_shift_faults.json'), 'utf8'));
const LATE = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'faults.late-shift.json'), 'utf8'));
const WORKBOOK = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'faults.json'), 'utf8'));
const CHAIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'faults.reference-chain.json'), 'utf8'));
const SPECS = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'specs.json'), 'utf8')).specs;
const CARDS_SRC = fs.readFileSync(path.join(ROOT, 'tools', 'kit', 'build_cards.js'), 'utf8');
const BINDERS_SRC = fs.readFileSync(path.join(ROOT, 'tools', 'kit', 'assemble_binders.py'), 'utf8');
const CONTROL_SRC = fs.readFileSync(path.join(ROOT, 'public', 'control', 'control.js'), 'utf8');
const SECTOR_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sector', 'sector.js'), 'utf8');

const content = loadContent();
const def = (code) => content.faults.faults.find((f) => f.code === code);
const specValue = (binder, table, row) => SPECS.find((s) => s.binder === binder && s.table_id === table && s.row_label === row).value;
const APPROVED = {
  'F-601': [['WTR', 'W-4', 'Upper Reservoir'], ['POW', 'P-1', 'Turbine B']],
  'F-602': [['COM', 'C-3', 'Core Ring'], ['TRN', 'T-6', 'Emergency Line']],
  'F-603': [['MED', 'M-5', 'Scrubber Unit'], ['AGR', 'A-2', 'Bay 4']],
  'F-604': [['POW', 'P-2', 'Ring Main'], ['COM', 'C-3', 'Deep Sensors']],
  'F-605': [['WTR', 'W-4', 'Mid Reservoir'], ['COM', 'C-3', 'Grid South']],
  'F-606': [['POW', 'P-2', 'Sub-grid 1'], ['TRN', 'T-6', 'Emergency Line']],
  'F-607': [['MED', 'M-5', 'HEPA Array'], ['COM', 'C-3', 'Perimeter']],
  'F-608': [['POW', 'P-2', 'Ring Main'], ['WTR', 'W-3', 'Backup Pump']],
  'F-609': [['WTR', 'W-3', 'Pump Station 1'], ['AGR', 'A-2', 'Seedling Bay']],
  'F-610': [['MED', 'M-2', 'Isolation Wing'], ['COM', 'C-3', 'Deep Sensors']],
  'F-611': [['TRN', 'T-1', 'Tunnel D'], ['WTR', 'W-4', 'Overflow Basin']],
  'F-612': [['POW', 'P-2', 'Emergency Bus'], ['MED', 'M-2', 'Triage Bay']],
};
const TARGETS = { 'F-602': 420, 'F-604': 420, 'F-606': 360, 'F-608': 360, 'F-610': 420, 'F-612': 360 };

/** A live game in the mixed-operations round with the fault on its sector's table. */
function live(code) {
  const game = newGame();
  game.setPhase('ROUND_4');
  game.clock('start');
  const d = def(code);
  game.setInventory(d.sector, { power: 9, water: 9, parts: 9, med: 9 });
  assert.equal(game.fireFault(code, d.sector).ok, true, `${code} did not fire`);
  return game;
}
const resolve = (game, code, answer, workers) => submitCode(game, { sector: def(code).sector, fault_code: code, code: answer, workers_assigned: workers || def(code).crew_required });

// -- FX10-001 … 006: ten per sector ----------------------------------------------------------

for (const [i, s] of SECTORS.entries()) {
  test(`FX10-00${i + 1}: ${s} has exactly 10 playable faults`, () => {
    const own = content.faults.faults.filter((f) => f.sector === s);
    assert.equal(own.length, 10, own.map((f) => f.code).join(' '));
    assert.ok(own.every((f) => f.valid_codes.length >= 1 && !f.false_alarm), `${s} has an unplayable fault`);
    assert.deepEqual(own.map((f) => f.procedure).sort(), ['P-01', 'P-02', 'P-03', 'P-04', 'P-05', 'P-06', 'P-07', 'P-08', 'P-09', 'P-10'], `${s} lacks a procedure`);
    assert.equal(new Set(own.map((f) => f.procedure)).size, 10, `${s} uses a procedure twice`);
  });
}

test('A / B: the runtime holds 60 faults, 10 per sector, and no duplicate ID', () => {
  assert.equal(content.faults.faults.length, 60);
  assert.equal(content.faults.meta.fault_count, 60);
  assert.equal(new Set(content.faults.faults.map((f) => f.code)).size, 60);
  for (const s of SECTORS) assert.equal(content.faults.faults.filter((f) => f.sector === s).length, 10);
  const { errors } = validateContent(content);
  assert.deepEqual(errors, [], 'the merged content does not validate');
});

// -- FX10-007: the facilitator issues them by hand ----------------------------------------

test('FX10-007 / N: all 12 can be issued by the facilitator, and only by the facilitator — nothing deals them', () => {
  for (const code of CODES) {
    const game = newGame();
    game.setPhase('ROUND_4');
    const d = def(code);
    assert.equal(d.round, null, `${code} was given a round`);
    assert.equal(d.section, 'LATE SHIFT');
    assert.equal(d.recommended_from, 'R4');
    const res = game.fireFault(code, d.sector);
    assert.equal(res.ok, true, `${code}: ${res.reason}`);
    assert.ok(game.findFault(d.sector, code), `${code} is not on ${d.sector}'s table`);
    assert.equal(game.fireFault(code, d.sector).reason, 'already_active');
  }
  // No round, timeline or clock puts one on a table.
  const game = newGame();
  for (const r of ['R0', 'R1', 'R2', 'R3', 'R4']) {
    game.activateRound(r);
    assert.ok(!game.faultsForRound(r).some((f) => CODES.includes(f.code)), `${r} groups a late-shift fault`);
  }
  game.clock('start'); game.tick(60000);
  assert.equal(Object.values(game.state.sectors).flatMap((s) => s.faults).length, 0, 'something dealt a fault');
  // The library carries them, with their group, their procedure and the word.
  assert.ok(/value="late">LATE SHIFT</.test(CONTROL_SRC) && /f\.late_shift \? 'LATE'/.test(CONTROL_SRC));
  assert.ok(/f-proc/.test(CONTROL_SRC) && /tag timed">TIME-CRITICAL/.test(CONTROL_SRC) && /tag late/.test(CONTROL_SRC));
});

// -- FX10-008: complete procedures ------------------------------------------------------------

test('FX10-008: every new fault has a complete P-09 or P-10 procedure — crew, materials, two sources, a two-value format', () => {
  for (const code of CODES) {
    const d = def(code);
    assert.ok(['P-09', 'P-10'].includes(d.procedure), `${code}: ${d.procedure}`);
    assert.ok(Number.isInteger(d.crew_required) && d.crew_required >= 2, `${code}: crew`);
    assert.ok(Object.keys(d.resources_required).length >= 2, `${code}: materials`);
    assert.equal(d.spec_refs.length, 2, `${code}: sources`);
    assert.ok(d.name && d.flavour && !d.flavour.includes(';'), `${code}: card copy`);
    assert.equal(d.severity, d.procedure === 'P-10' ? 3 : 2);
  }
  // The binder prints them in the P-01..P-06 voice: confirm, crew, materials, obtain, obtain, enter, re-check.
  for (const line of ['Confirm the fault code on your console matches', 'Assign crew:', 'Stage materials:', 'value from', 'Enter the resolution code on the sector console in the format', 're-verify the source table']) {
    assert.ok(BINDERS_SRC.includes(line), `the binder lacks "${line}"`);
  }
  assert.ok(/late_by_sector/.test(BINDERS_SRC) && /-\[VALUE\]-\[VALUE 2\]/.test(BINDERS_SRC));
  assert.ok(/TIME-CRITICAL: Integrity falls fast while this fault stays open/.test(BINDERS_SRC), 'P-10 is not labelled in the binder');
});

// -- FX10-009 / 010 / C / D / E: the codes --------------------------------------------------------

test('FX10-009 / FX10-010: P-09 and P-10 validate two three-digit values, resolved from the specification tables', () => {
  for (const code of CODES) {
    const d = def(code);
    assert.equal(d.valid_codes.length, 1);
    const m = d.valid_codes[0].match(/^(P-09|P-10)-(\d{3})-(\d{3})$/);
    assert.ok(m, `${code}: ${d.valid_codes[0]}`);
    assert.equal(m[1], d.procedure);
    const [a, b] = APPROVED[code];
    assert.equal(Number(m[2]), specValue(...a), `${code} value 1 is not ${a.join(' ')}`);
    assert.equal(Number(m[3]), specValue(...b), `${code} value 2 is not ${b.join(' ')}`);
    assert.deepEqual(d.spec_refs.map((r) => [r.binder, r.table, r.row_label]), APPROVED[code], `${code} sources`);
  }
});

test('C / D / E: F-604 resolves on 292 + 828, F-606 on 990 + 911, F-611 on 621 + 819 — and nothing else', () => {
  for (const [code, answer, wrong] of [['F-604', 'P-10-292-828', 'P-10-449-828'], ['F-606', 'P-10-990-911', 'P-10-990-807'], ['F-611', 'P-09-621-819', 'P-09-621-340']]) {
    assert.deepEqual(def(code).valid_codes, [answer]);
    const game = live(code);
    assert.equal(resolve(game, code, wrong).accepted, false, `${code} took the substituted row's old value`);
    const ok = resolve(game, code, answer);
    assert.equal(ok.accepted, true, `${code}: ${JSON.stringify(ok)}`);
    assert.equal(game.state.sectors[def(code).sector].faults.find((f) => f.code === code).resolved, true);
  }
});

test('all 12 resolve on their derived code, through the existing console path: crew, materials, lockout, reward', () => {
  for (const code of CODES) {
    const d = def(code);
    const game = live(code);
    // too few hands, then the right code
    assert.equal(resolve(game, code, d.valid_codes[0], d.crew_required - 1).accepted, false, `${code} resolved short-handed`);
    const ok = resolve(game, code, d.valid_codes[0]);
    assert.equal(ok.accepted, true, `${code}: ${JSON.stringify(ok)}`);
    assert.equal(game.state.sectors[d.sector].faults.find((f) => f.code === code).resolved, true, `${code} is not resolved`);
    const logged = game.log.readAll().trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.ev === 'repair_completed' && JSON.stringify(e).includes(code));
    assert.ok(logged.length >= 1, `${code} resolution was not logged`);
  }
  // three wrong codes lock the console, as on every other fault
  const game = live('F-602');
  for (let i = 0; i < 3; i += 1) assert.equal(resolve(game, 'F-602', 'P-10-000-000').accepted, false);
  assert.ok(game.findFault('POW', 'F-602').locked_until_s > 0, 'the lockout did not engage');
});

// -- FX10-011 / H / I: time pressure without a timer ---------------------------------------------

test('FX10-011 / H: P-10 faults carry decay 3.0 a minute and the existing decay system, not a timer', () => {
  for (const code of CODES) {
    const d = def(code);
    if (d.procedure === 'P-10') {
      assert.equal(d.decay_per_min, 3.0, `${code} decay`);
      assert.equal(d.time_critical, true);
      assert.equal(d.facilitator_target_s, TARGETS[code], `${code} target`);
    } else {
      assert.equal(d.time_critical, false);
      assert.equal(d.facilitator_target_s, null);
    }
    assert.ok(!('deadline_s' in d), `${code} carries the ignored deadline_s field`);
  }
  // Decay is what moves: one minute open costs Integrity at 3/min, and nothing expires or resolves on its own.
  const game = live('F-602');
  const before = game.state.sectors.POW.integrity;
  game.tick(60000);
  assert.ok(game.state.sectors.POW.integrity <= before - 2.5, `decay did not run (${before} → ${game.state.sectors.POW.integrity})`);
  game.tick(420000);
  const f = game.findFault('POW', 'F-602');
  assert.equal(f.resolved, false, 'the fault expired or resolved on a clock');
  assert.equal(f.status, 'ACTIVE');
  assert.ok(!('deadline_s' in f) || f.deadline_s == null);
  // The word reaches the table; the target never does.
  const view = forSector(game, 'POW').sectors.POW.faults.find((x) => x.code === 'F-602');
  assert.equal(view.time_critical, true);
  assert.ok(!('facilitator_target_s' in view) && !('deadline_s' in view) && !('procedure' in view));
  assert.ok(!JSON.stringify(forSector(game, 'POW')).includes('420'), 'the facilitator target reached a table');
  assert.ok(!JSON.stringify(forBigscreen(game)).includes('TIME-CRITICAL') && !JSON.stringify(forBigscreen(game)).includes('facilitator_target'));
  assert.ok(JSON.stringify(forControl(game)).includes('"time_critical":true'));
});

test('I: TIME-CRITICAL is printed on P-10 cards as a word, never a countdown', () => {
  assert.ok(/f\.time_critical/.test(CARDS_SRC) && /text: "TIME-CRITICAL"/.test(CARDS_SRC), 'the card builder does not print the word');
  assert.ok(!/facilitator_target_s/.test(CARDS_SRC), 'the card builder reads the facilitator target');
  assert.ok(/lateFaults/.test(CARDS_SRC) && /section \|\| ROUND_LABEL/.test(CARDS_SRC), 'no LATE SHIFT section');
  // The console says the word too, and only the word.
  assert.ok(/fr-tc">TIME-CRITICAL/.test(SECTOR_SRC));
  assert.ok(!/facilitator_target_s/.test(SECTOR_SRC));
});

// -- FX10-012 / 013 / F / L / M: nothing existing moved --------------------------------------------

test('FX10-012 / FX10-013: no new specification table, no changed value, every source an indexed row', () => {
  assert.equal(SPECS.length, 66);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'specs.json'), 'utf8')).meta.spec_count, 66);
  for (const code of CODES) {
    for (const r of def(code).spec_refs) {
      const s = SPECS.find((x) => x.spec_id === r.spec_id);
      assert.ok(s, `${code}: ${r.spec_id} is not a specification`);
      assert.equal(s.buried, false, `${code}: ${r.spec_id} is an Appendix C value`);
      assert.equal(s.row_label, r.row_label);
      assert.ok(/^\d{3}$/.test(String(s.value)));
    }
  }
  // The structural source holds no three-digit value, and the generated file is current.
  const text = fs.readFileSync(path.join(ROOT, 'spec', 'late_shift_faults.json'), 'utf8');
  // Fault codes (F-601) and the facilitator targets (360 / 420 s) are the only three-digit numbers allowed in it.
  assert.ok(!/\b\d{3}\b/.test(text.replace(/F-\d{3}/g, '').replace(/\b(360|420)\b/g, '')), 'spec/late_shift_faults.json holds a three-digit value');
  assert.ok(SPEC.faults.every((f) => !f.valid_codes && !f.spec_refs && f.sources.every((s) => !('value' in s))));
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build_late_shift_faults.js'), '--check'], { cwd: ROOT, stdio: 'pipe' });
});

test('F / L / M: the 36, the 12 chains and the F-201 discrepancy are exactly as they were', () => {
  assert.equal(WORKBOOK.faults.length, 36, 'faults.json was edited');
  assert.ok(!WORKBOOK.faults.some((f) => CODES.includes(f.code) || ['P-09', 'P-10'].includes(f.procedure)));
  assert.equal(CHAIN.faults.length, 12);
  assert.ok(!CHAIN.faults.some((f) => CODES.includes(f.code) || ['P-09', 'P-10'].includes(f.procedure)));
  assert.deepEqual(def('F-201').valid_codes, ['P-03-340', 'P-03-290'], 'the seeded discrepancy changed');
  assert.deepEqual(def('F-201').spec_refs.map((r) => r.row_label), ['Lower Reservoir']);
  assert.equal(specValue('WTR', 'W-4', 'Lower Reservoir'), 340);
  // F-201 still takes either answer; F-611 was moved off that row.
  for (const answer of ['P-03-340', 'P-03-290']) {
    const game = newGame(); game.setPhase('ROUND_2'); game.clock('start');
    game.setInventory('POW', { power: 9, water: 9, parts: 9, med: 9 });
    game.fireFault('F-201', 'POW');
    assert.equal(submitCode(game, { sector: 'POW', fault_code: 'F-201', code: answer, workers_assigned: 2 }).accepted, true, answer);
  }
  assert.ok(!def('F-611').spec_refs.some((r) => r.row_label === 'Lower Reservoir'));
  // Every older fault still resolves on its own code, P-01 to P-08.
  for (const d of [...WORKBOOK.faults, ...CHAIN.faults]) {
    const game = newGame(); game.setPhase('ROUND_4'); game.clock('start');
    game.setInventory(d.sector, { power: 9, water: 9, parts: 9, med: 9 });
    assert.equal(game.fireFault(d.code, d.sector).ok, true, d.code);
    assert.equal(submitCode(game, { sector: d.sector, fault_code: d.code, code: d.valid_codes[0], workers_assigned: d.crew_required }).accepted, true, `${d.code} no longer resolves`);
  }
});

// -- FX10-014 / 015: the rounds -----------------------------------------------------------------

test('FX10-014 / FX10-015: Rounds 0–3 never issue P-09/P-10 on their own; from Round 4 the library mixes every kind', () => {
  // No activation deals anything, so no teaching round can issue one; the
  // grouping that remains puts them in no round's set.
  const game = newGame();
  for (const r of ['R0', 'R1', 'R2', 'R3']) {
    game.activateRound(r);
    assert.ok(game.faultsForRound(r).every((f) => !['P-09', 'P-10'].includes(f.procedure)), `${r} groups a late-shift fault`);
    assert.equal(Object.values(game.state.sectors).flatMap((s) => s.faults).length, 0);
  }
  // From Round 4 the facilitator may put old, chain and late-shift faults on one table at once.
  game.activateRound('R4'); game.clock('start');
  for (const code of ['F-401', 'F-501', 'F-601', 'F-602']) assert.equal(game.fireFault(code, 'POW').ok, true, code);
  assert.deepEqual(game.state.sectors.POW.faults.map((f) => f.procedure).sort(), ['P-06', 'P-07', 'P-09', 'P-10']);
  // Appropriate from Round 4 ONWARD, never Round 4 only: nothing in the data or the engine ties them to one round.
  assert.equal(LATE.meta.recommended_from, 'R4');
  assert.ok(!/R4/.test(fs.readFileSync(path.join(ROOT, 'lib', 'state.js'), 'utf8').split('late_shift').slice(1).join('')), 'the engine hardcodes a round for the late shift');
  const g3 = newGame(); g3.setPhase('ROUND_3'); g3.clock('start');
  assert.equal(g3.fireFault('F-601', 'POW').ok, true, 'the facilitator could not override the recommendation');
});

// -- FX10-016 / G / J / K: the kit and the wage -------------------------------------------------------

test('FX10-016: the generated deck, the runtime content and the kit read one file', () => {
  const { CONTENT_FILES } = require('../lib/kit');
  assert.ok(CONTENT_FILES.includes('faults.late-shift.json'));
  const { LATE_FILE } = require('../lib/content');
  assert.equal(LATE_FILE, 'faults.late-shift.json');
  assert.ok(/faults\.late-shift\.json/.test(CARDS_SRC) && /faults\.late-shift\.json/.test(BINDERS_SRC));
  assert.equal(content.late_shift_meta.fault_count, 12);
  assert.deepEqual(LATE.faults.map((f) => f.code), CODES);
});

test('G / J / K: twelve rewards from the existing types — P-09 +1 of its first staged material, P-10 +5 Integrity, no new token', () => {
  const types = new Set(Object.values(REWARDS.rewards).map((r) => r.type));
  assert.deepEqual([...types].sort(), ['INTEGRITY', 'OPPORTUNITY', 'RESOURCE']);
  assert.deepEqual(Object.keys(REWARDS.tokens).sort(), ['EMERGENCY_REPAIR_KIT', 'RESERVE_CREW', 'SECOND_CHANCE', 'STABILISER'].sort(), 'the token list changed');
  for (const code of CODES) {
    const d = def(code);
    const r = REWARDS.rewards[code];
    assert.ok(r, `${code} has no reward`);
    assert.equal(r.sector, d.sector);
    if (d.procedure === 'P-09') {
      const first = Object.keys(d.resources_required)[0];
      assert.deepEqual(r, { sector: d.sector, type: 'RESOURCE', resource: first, amount: 1 }, `${code} does not pay its first staged material`);
    } else {
      assert.deepEqual(r, { sector: d.sector, type: 'INTEGRITY', amount: 5 }, `${code} does not pay +5 Integrity`);
    }
  }
  // Paid by the completion, through the existing pathways, under the cap.
  const g = live('F-601');
  const parts = g.state.sectors.POW.inventory.parts;
  assert.equal(resolve(g, 'F-601', def('F-601').valid_codes[0]).accepted, true);
  assert.equal(g.state.sectors.POW.inventory.parts, parts - 1 + 1, 'F-601 did not pay +1 parts after its material');
  const g2 = live('F-602');
  g2.setIntegrity('POW', 80);
  assert.equal(resolve(g2, 'F-602', def('F-602').valid_codes[0]).accepted, true);
  assert.equal(g2.state.sectors.POW.integrity, 85, 'F-602 did not pay +5 Integrity');
  const g3 = live('F-602');
  g3.setIntegrity('POW', 98);
  assert.equal(resolve(g3, 'F-602', def('F-602').valid_codes[0]).accepted, true);
  assert.equal(g3.state.sectors.POW.integrity, 100, 'the Integrity cap was not respected');
});
