'use strict';
/**
 * THREE-VALUE RESOLUTION CODES (2026-10-06).
 *
 * Twelve faults — every sector's P-08 reference chain and its P-09 late-shift
 * fault — resolve on three values instead of two. VALUE 3 is a row named
 * outright: the sector's own table, its own Appendix C, or another sector's
 * indexed table. Nothing in the engine changed to make that true: a code is
 * still procedure + the ordered specification values (lib/validate.js
 * re-derives it at boot, lib/resolve.js compares it at the console), so this
 * file holds the specification's acceptance tests and the shape of the
 * twelve, and leaves the mechanics to the suites that already own them.
 *
 * 3V-001 … 3V-010 are the specification's acceptance tests, in its order.
 * The complete codes below are QA references (the specification lists them);
 * nothing in content/ or spec/ holds them — the generators derive them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { newGame, loadContent } = require('./helpers');
const { submitCode } = require('../lib/resolve');
const { forSector, forBigscreen, forControl } = require('../lib/visibility');
const { validateContent } = require('../lib/validate');
const REWARDS = require('../lib/fault-rewards.json');

const ROOT = path.join(__dirname, '..');
const content = loadContent();
const SPECS = content.specs.specs;
const SECTORS = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];
const def = (code) => content.faults.faults.find((f) => f.code === code);
const specValue = (binder, table, row) => SPECS.find((s) => s.binder === binder && s.table_id === table && s.row_label === row).value;
const seg = (code) => code.split('-').slice(2);   // a code's values, as strings

/** The twelve, as the specification lists them: the expected code, and where VALUE 3 lives. */
const THREE = {
  'F-502': { sector: 'POW', procedure: 'P-08', code: 'P-08-390-183-449', third: ['POW', 'P-2', 'Emergency Bus', 'OWN_TABLE'] },
  'F-601': { sector: 'POW', procedure: 'P-09', code: 'P-09-670-730-145', third: ['COM', 'C-3', 'Core Ring', 'EXTERNAL'] },
  'F-504': { sector: 'WTR', procedure: 'P-08', code: 'P-08-915-449-524', third: ['WTR', 'App-C', 'Emergency Sluice Override', 'OWN_APPENDIX'] },
  'F-603': { sector: 'WTR', procedure: 'P-09', code: 'P-09-346-311-828', third: ['COM', 'C-3', 'Deep Sensors', 'EXTERNAL'] },
  'F-506': { sector: 'MED', procedure: 'P-08', code: 'P-08-107-261-142', third: ['WTR', 'W-4', 'Emergency Tank', 'EXTERNAL'] },
  'F-605': { sector: 'MED', procedure: 'P-09', code: 'P-09-734-931-565', third: ['MED', 'M-2', 'Surgical Suite', 'OWN_TABLE'] },
  'F-508': { sector: 'TRN', procedure: 'P-08', code: 'P-08-331-621-449', third: ['POW', 'P-2', 'Emergency Bus', 'EXTERNAL'] },
  'F-607': { sector: 'TRN', procedure: 'P-09', code: 'P-09-273-306-490', third: ['TRN', 'App-C', 'Deep-Tunnel Pressure Rating', 'OWN_APPENDIX'] },
  'F-510': { sector: 'AGR', procedure: 'P-08', code: 'P-08-390-346-606', third: ['AGR', 'App-C', 'Seed Vault Humidity Setpoint', 'OWN_APPENDIX'] },
  'F-609': { sector: 'AGR', procedure: 'P-09', code: 'P-09-617-793-990', third: ['POW', 'P-2', 'Sub-grid 1', 'EXTERNAL'] },
  'F-512': { sector: 'COM', procedure: 'P-08', code: 'P-08-911-273-243', third: ['COM', 'App-C', 'Master Uplink Reset Key', 'OWN_APPENDIX'] },
  'F-611': { sector: 'COM', procedure: 'P-09', code: 'P-09-621-819-828', third: ['COM', 'C-3', 'Deep Sensors', 'OWN_TABLE'] },
};
const CODES = Object.keys(THREE);
/** The six TIME-CRITICAL faults, and the two-value codes they had the day before. */
const ORIGINAL_P10 = {
  'F-602': 'P-10-145-911', 'F-604': 'P-10-292-828', 'F-606': 'P-10-990-911',
  'F-608': 'P-10-292-445', 'F-610': 'P-10-274-828', 'F-612': 'P-10-449-823',
};
/** What the twelve were the day before, in everything but their code: name, crew, materials, decay, reward. */
const KEPT = {
  'F-502': ['Core auxiliary feed mismatch', 3, { parts: 2, water: 1 }, 0, 'OPPORTUNITY:SECOND_CHANCE'],
  'F-504': ['Reclaim sterilisation lock', 3, { power: 1, med: 1, parts: 1 }, 0, 'OPPORTUNITY:SECOND_CHANCE'],
  'F-506': ['ICU failover routing conflict', 3, { power: 2, med: 1 }, 0, 'OPPORTUNITY:RESERVE_CREW'],
  'F-508': ['Emergency tunnel routing blackout', 3, { parts: 2, power: 1 }, 0, 'OPPORTUNITY:EMERGENCY_REPAIR_KIT'],
  'F-510': ['Seed vault climate interlock', 3, { water: 2, power: 1, med: 1 }, 0, 'OPPORTUNITY:EMERGENCY_REPAIR_KIT'],
  'F-512': ['Uplink emergency power-route conflict', 3, { power: 2, parts: 1 }, 0, 'OPPORTUNITY:STABILISER'],
  'F-601': ['Turbine manifold pressure imbalance', 2, { parts: 1, water: 1 }, 2, 'RESOURCE:parts'],
  'F-603': ['Reclaim sterilisation bypass failure', 2, { power: 1, med: 1 }, 2, 'RESOURCE:parts'],
  'F-605': ['Surgical air-pressure collapse', 2, { power: 1, med: 1 }, 2, 'RESOURCE:parts'],
  'F-607': ['Freight tunnel ventilation failure', 2, { power: 1, parts: 1 }, 2, 'RESOURCE:parts'],
  'F-609': ['Seedling-bay dosing failure', 2, { water: 1, parts: 1 }, 2, 'RESOURCE:parts'],
  'F-611': ['Deep-sensor relay drift', 2, { power: 1, parts: 1 }, 2, 'RESOURCE:parts'],
};

/** A live game in Round 5 — the mechanic's natural first outing — with the fault on its sector's table and a full tray. */
function live(code) {
  const d = def(code);
  const game = newGame();
  game.setPhase('ROUND_5');
  game.clock('start');
  game.setInventory(d.sector, { power: 9, water: 9, parts: 9, med: 9 });
  assert.equal(game.fireFault(code, d.sector).ok, true, `${code} did not fire`);
  return game;
}
const attempt = (game, code, answer, workers) =>
  submitCode(game, { sector: def(code).sector, fault_code: code, code: answer, workers_assigned: workers === undefined ? def(code).crew_required : workers });
// The instance on the table, resolved or not (findFault answers only for live ones).
const fault = (game, code) => game.state.sectors[def(code).sector].faults.find((f) => f.code === code);

// -- the shape of the twelve ------------------------------------------------------------------------

test('3V-000: exactly twelve faults carry three values — each sector\'s P-08 and P-09 — and no other fault does', () => {
  const three = content.faults.faults.filter((f) => f.spec_refs.length === 3);
  assert.deepEqual(three.map((f) => f.code).sort(), CODES.slice().sort());
  for (const s of SECTORS) {
    const mine = three.filter((f) => f.sector === s);
    assert.equal(mine.length, 2, `${s} has ${mine.length} three-value faults`);
    assert.deepEqual(mine.map((f) => f.procedure).sort(), ['P-08', 'P-09'], `${s}: ${mine.map((f) => f.code).join(' ')}`);
  }
  // Sixty faults, ten a sector, every code carrying one value per source — one, two or three.
  assert.equal(content.faults.faults.length, 60);
  for (const f of content.faults.faults) {
    assert.ok(f.spec_refs.length >= 1 && f.spec_refs.length <= 3, `${f.code} has ${f.spec_refs.length} sources`);
    for (const code of f.valid_codes) assert.equal(seg(code).length, f.spec_refs.length, `${f.code}: ${code} does not carry one value per source`);
  }
});

test('3V-001: each three-value code is its procedure and three ordered three-digit specification values, VALUE 3 the row the specification names', () => {
  for (const [code, want] of Object.entries(THREE)) {
    const d = def(code);
    assert.equal(d.sector, want.sector, code);
    assert.equal(d.procedure, want.procedure, code);
    assert.deepEqual(d.valid_codes, [want.code], code);
    assert.match(want.code, /^P-0[89]-\d{3}-\d{3}-\d{3}$/);
    // derived, not typed: every segment is the specification value of the source in that position
    d.spec_refs.forEach((r, i) => assert.equal(Number(seg(want.code)[i]), specValue(r.binder, r.table, r.row_label), `${code} value ${i + 1}`));
    const [binder, table, row, kind] = want.third;
    const r3 = d.spec_refs[2];
    assert.deepEqual([r3.binder, r3.table, r3.row_label], [binder, table, row], `${code} VALUE 3 row`);
    assert.equal(r3.buried, table === 'App-C', `${code} VALUE 3 Appendix C flag`);
    assert.equal(r3.binder === d.sector ? (r3.buried ? 'OWN_APPENDIX' : 'OWN_TABLE') : 'EXTERNAL', kind, `${code} VALUE 3 kind`);
    if (d.reference_chain) {
      // A P-08's chains are untouched: two of them, still VALUE 1 and VALUE 2; a reference is still not a value.
      assert.equal(d.reference_chain.length, 2, code);
      d.reference_chain.forEach((c, i) => assert.equal(c.final_source.spec_id, d.spec_refs[i].spec_id, `${code} chain ${i + 1} is no longer value ${i + 1}`));
      assert.deepEqual(d.direct_values.map((v) => [v.position, v.source_type, v.spec_id]), [[3, kind, r3.spec_id]], `${code} direct value`);
    } else {
      assert.equal(d.late_shift, true, code);
      assert.equal(d.time_critical, false, `${code} is TIME-CRITICAL`);
    }
  }
});

// -- 3V-001 … 3V-010: the specification's acceptance tests ----------------------------------------

test('3V-ACC-1: the correct three-value code is accepted when crew and materials are in — in its forgiving spellings too', () => {
  for (const [code, want] of Object.entries(THREE)) {
    const game = live(code);
    const res = attempt(game, code, want.code);
    assert.equal(res.accepted, true, `${code}: ${JSON.stringify(res)}`);
    assert.equal(fault(game, code).resolved, true, code);
  }
  // case, the kind of dash and spaces around a hyphen were always forgiven; nothing else is
  const [p, n, v1, v2, v3] = THREE['F-502'].code.split('-');
  assert.equal(attempt(live('F-502'), 'F-502', ` ${p.toLowerCase()}-${n} - ${v1} – ${v2} — ${v3} `).accepted, true);
  assert.equal(attempt(live('F-502'), 'F-502', `${p}-${n}-${v1}${v2}${v3}`).accepted, false, 'values without their hyphens were taken');
});

test('3V-ACC-2: the first two values alone are rejected', () => {
  for (const [code, want] of Object.entries(THREE)) {
    const game = live(code);
    const res = attempt(game, code, want.code.split('-').slice(0, 4).join('-'));
    assert.equal(res.accepted, false, code);
    assert.equal(res.reason, 'invalid_code', code);
    assert.equal(fault(game, code).attempts, 1, `${code}: a wrong code did not count`);
    assert.equal(fault(game, code).resolved, false, code);
  }
});

test('3V-ACC-3: the right three values with VALUE 2 and VALUE 3 swapped are rejected — and VALUE 1 and VALUE 2 swapped too', () => {
  for (const [code, want] of Object.entries(THREE)) {
    const [p, n, v1, v2, v3] = want.code.split('-');
    assert.ok(v1 !== v2 && v2 !== v3, `${code}: two of its values are the same figure, so a swap proves nothing`);
    const game = live(code);
    assert.equal(attempt(game, code, [p, n, v1, v3, v2].join('-')).accepted, false, `${code} took VALUE 2 and 3 swapped`);
    assert.equal(attempt(game, code, [p, n, v2, v1, v3].join('-')).accepted, false, `${code} took VALUE 1 and 2 swapped`);
    assert.equal(fault(game, code).resolved, false, code);
  }
});

test('3V-ACC-4: one wrong digit in any of the three values is rejected', () => {
  for (const [code, want] of Object.entries(THREE)) {
    const parts = want.code.split('-');
    for (let v = 2; v < 5; v += 1) {
      for (let d = 0; d < 3; d += 1) {
        const bad = parts.slice();
        bad[v] = bad[v].slice(0, d) + String((Number(bad[v][d]) + 1) % 10) + bad[v].slice(d + 1);
        const game = live(code);
        assert.equal(attempt(game, code, bad.join('-')).accepted, false, `${code} took ${bad.join('-')}`);
      }
    }
  }
});

test('3V-ACC-5: four values are rejected — and the console field is long enough to let a wrong fourth reach the server', () => {
  for (const [code, want] of Object.entries(THREE)) {
    const game = live(code);
    assert.equal(attempt(game, code, `${want.code}-${seg(want.code)[0]}`).accepted, false, code);
    assert.equal(attempt(game, code, `${want.code}-000`).accepted, false, code);
    assert.equal(fault(game, code).resolved, false, code);
  }
  const html = fs.readFileSync(path.join(ROOT, 'public', 'sector', 'index.html'), 'utf8');
  const input = html.match(/<input[^>]*id="code-input"[^>]*>/)[0];
  assert.ok(Number(input.match(/maxlength="(\d+)"/)[1]) >= 20, `the field truncates a four-value code: ${input}`);
  // one text field, as before — never three boxes
  assert.equal((html.match(/id="code-input"/g) || []).length, 1, 'the console grew a second code field');
});

test('3V-ACC-6: the right code with too few workers is INSUFFICIENT CREW, exactly as before, and counts no code attempt', () => {
  for (const [code, want] of Object.entries(THREE)) {
    const game = live(code);
    const res = attempt(game, code, want.code, def(code).crew_required - 1);
    assert.equal(res.accepted, false, code);
    assert.equal(res.reason, 'insufficient_crew', code);
    assert.equal(fault(game, code).attempts, 0, `${code}: a crew shortfall counted as a code attempt`);
    assert.equal(fault(game, code).resolved, false, code);
    // the same code with the crew is then accepted: the crew check never looked at the code
    assert.equal(attempt(game, code, want.code).accepted, true, code);
  }
});

test('3V-ACC-7: the right code with an empty tray is MATERIALS NOT READY, exactly as before, and the refusal names no number', () => {
  for (const [code, want] of Object.entries(THREE)) {
    const game = live(code);
    game.setInventory(want.sector, { power: 0, water: 0, parts: 0, med: 0 });
    const res = attempt(game, code, want.code);
    assert.equal(res.accepted, false, code);
    assert.equal(res.reason, 'insufficient_resources', code);
    assert.equal(res.short, undefined, `${code}: the refusal carried the shortfall to the table`);
    assert.equal(fault(game, code).attempts, 0, `${code}: a short tray counted as a code attempt`);
    assert.equal(fault(game, code).resolved, false, code);
  }
});

test('3V-ACC-8: three wrong codes in a row lock the console for the configured 20 seconds, as on every other fault', () => {
  for (const [code, want] of Object.entries(THREE)) {
    const game = live(code);
    const wrong = `${want.code.slice(0, -3)}000`;   // the right first two values, a wrong third
    let last;
    for (let i = 0; i < 3; i += 1) last = attempt(game, code, wrong);
    assert.equal(last.accepted, false, code);
    assert.equal(game.cfg.lockout_s, 20);
    assert.equal(last.locked_until_s, game.cfg.lockout_s, `${code}: the third wrong code did not lock the console`);
    assert.equal(last.max_consecutive, game.cfg.lockout_after_consecutive_invalid, code);
    assert.ok(fault(game, code).locked_until_s > 0, code);
    assert.equal(attempt(game, code, want.code).reason, 'locked', `${code}: the lock did not hold against the right code`);
    // a rejection never says what was right
    assert.ok(!JSON.stringify(last).includes(seg(want.code)[2]), `${code}: the rejection leaked VALUE 3`);
  }
});

test('3V-ACC-9: every one- and two-value fault resolves exactly as before', () => {
  for (const d of content.faults.faults) {
    if (CODES.includes(d.code)) continue;
    assert.ok(d.spec_refs.length <= 2, `${d.code} grew a value`);
    const game = live(d.code);
    const res = attempt(game, d.code, d.valid_codes[0]);
    assert.equal(res.accepted, true, `${d.code}: ${JSON.stringify(res)}`);
    assert.equal(fault(game, d.code).resolved, true, d.code);
  }
  // the seeded discrepancy still has its two codes
  assert.deepEqual(def('F-201').valid_codes, ['P-03-340', 'P-03-290']);
});

test('3V-ACC-10: every P-10 TIME-CRITICAL fault still expects its original two-value code', () => {
  for (const [code, want] of Object.entries(ORIGINAL_P10)) {
    const d = def(code);
    assert.deepEqual(d.valid_codes, [want], code);
    assert.equal(d.spec_refs.length, 2, code);
    assert.equal(d.procedure, 'P-10');
    assert.equal(d.time_critical, true);
    assert.equal(d.decay_per_min, 3);
    const game = live(code);
    assert.equal(attempt(game, code, `${want}-000`).accepted, false, `${code} took a third value`);
    assert.equal(attempt(game, code, want).accepted, true, code);
  }
  assert.equal(content.late_shift_meta.procedures['P-10'].values, 2);
  assert.equal(content.late_shift_meta.procedures['P-09'].values, 3);
});

// -- what the room sees, and what it never sees -------------------------------------------------

test('3V-011: no player screen carries a value, a source row or the answer — the facilitator\'s does', () => {
  for (const [code, want] of Object.entries(THREE)) {
    const game = live(code);
    const mine = forSector(game, want.sector).sectors[want.sector].faults.find((f) => f.code === code);
    assert.ok(mine, `${code} is not on ${want.sector}'s screen`);
    for (const k of ['valid_codes', 'spec_refs', 'direct_values', 'reference_chain', 'procedure']) assert.equal(mine[k], undefined, `${code}: ${k} reached the table`);
    const [, , row] = want.third;
    for (const s of SECTORS) {
      const text = JSON.stringify(forSector(game, s));
      assert.ok(!text.includes(want.code), `${s} was sent the answer to ${code}`);
      assert.ok(!text.includes(row), `${s} was sent VALUE 3's row of ${code}`);
      assert.ok(!text.includes('spec_refs') && !text.includes('direct_values'), `${s} was sent the sources of ${code}`);
    }
    const wall = JSON.stringify(forBigscreen(game));
    assert.ok(!wall.includes(want.code) && !wall.includes('spec_refs') && !wall.includes(row), `the wall shows ${code}'s answer`);
    // the facilitator's live answer key
    assert.deepEqual(forControl(game).sectors[want.sector].faults.find((f) => f.code === code).valid_codes, [want.code]);
  }
});

test('3V-012: the content validates at boot, both generators are current, and neither structural source holds a value', () => {
  assert.deepEqual(validateContent(content).errors, []);
  for (const tool of ['build_reference_chain_faults.js', 'build_late_shift_faults.js']) {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', tool), '--check'], { cwd: ROOT, stdio: 'pipe' });
  }
  const chainSrc = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'reference_chain_faults.json'), 'utf8'));
  const lateSrc = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'late_shift_faults.json'), 'utf8'));
  assert.equal(chainSrc.meta.procedures['P-07'].direct_values, 0);
  assert.equal(chainSrc.meta.procedures['P-08'].direct_values, 1);
  for (const f of chainSrc.faults) {
    assert.equal((f.direct_values || []).length, f.procedure === 'P-08' ? 1 : 0, `${f.code}: direct values`);
    for (const d of f.direct_values || []) {
      assert.ok(['OWN_TABLE', 'OWN_APPENDIX', 'EXTERNAL'].includes(d.source_type), `${f.code}: ${d.source_type}`);
      assert.ok(!('value' in d) && !/\d{3}/.test(JSON.stringify(d).replace(/F-\d{3}/g, '')), `${f.code}: the source carries a value`);
    }
  }
  assert.equal(lateSrc.procedures['P-09'].values, 3);
  assert.equal(lateSrc.procedures['P-10'].values, 2);
  for (const f of lateSrc.faults) {
    assert.equal(f.sources.length, f.procedure === 'P-09' ? 3 : 2, `${f.code}: sources`);
    assert.ok(f.sources.every((s) => !('value' in s)), `${f.code}: a source carries a value`);
  }
  // an overlap the sources declare is real, and every real one is declared: the generator refused otherwise, so the output records it
  for (const code of ['F-504', 'F-510']) assert.ok(/VALUE 3 row is also F-3\d\d's/.test(def(code).facilitator_notes), `${code}: ${def(code).facilitator_notes}`);
  for (const code of ['F-601', 'F-603']) assert.ok(/VALUE 3 row is also F-6\d\d's/.test(def(code).facilitator_notes), `${code}: ${def(code).facilitator_notes}`);
  for (const code of ['F-502', 'F-506', 'F-508', 'F-512', 'F-605', 'F-607', 'F-609', 'F-611']) assert.ok(!/also/.test(def(code).facilitator_notes), `${code} declares an overlap it does not have`);
});

test('3V-013: the facilitator\'s tools carry the third value — library tag, trigger preview, answer key — and the binder prints its row with [VALUE 3], never its number', () => {
  const control = fs.readFileSync(path.join(ROOT, 'public', 'control', 'control.js'), 'utf8');
  assert.ok(/tag values">3 VALUES/.test(control), 'the library has no 3 VALUES tag');
  assert.ok(/sourceText\(f, f\.reference_chain\.length\)/.test(control), 'the trigger preview stops at the chains');
  const py = fs.readFileSync(path.join(ROOT, 'tools', 'kit', 'assemble_binders.py'), 'utf8');
  assert.ok(/def code_format/.test(py) && /\[VALUE 3\]/.test(py), 'the assembler has no three-value format');
  const compact = fs.readFileSync(path.join(ROOT, 'tools', 'kit', 'binder_compact.js'), 'utf8');
  assert.ok(/v3: values\[2\]/.test(compact), 'the compact card has no VALUE 3 cell');
  const renderer = fs.readFileSync(path.join(ROOT, 'tools', 'kit', 'build_binders.js'), 'utf8');
  assert.ok(/"VALUE 3"/.test(renderer), 'the renderer prints no VALUE 3');
  const cards = fs.readFileSync(path.join(ROOT, 'tools', 'kit', 'build_cards.js'), 'utf8');
  assert.ok(/f\.spec_refs\.map/.test(cards), 'the answer key does not print every source');
  // The binder content, when built, names VALUE 3's row and the format on each of the twelve cards — and no value.
  const built = path.join(ROOT, 'build', 'binder_content.json');
  if (!fs.existsSync(built)) return;
  const binders = JSON.parse(fs.readFileSync(built, 'utf8')).binders;
  for (const [code, want] of Object.entries(THREE)) {
    const proc = binders[want.sector].procedures.find((p) => p.fault_code === code);
    assert.ok(proc, `${code} is not in ${want.sector}'s binder`);
    assert.equal(proc.format, `${want.procedure}-[VALUE]-[VALUE 2]-[VALUE 3]`, code);
    const [binder, table, row] = want.third;
    const src = proc.sources[proc.sources.length - 1];
    assert.deepEqual([src.binder, src.table_id, src.row_label, src.foreign, src.buried], [binder, table, row, binder !== want.sector, table === 'App-C'], `${code} VALUE 3 on the card`);
    assert.equal(proc.sources.length + (proc.reference_chain || []).length, 3, `${code}: the card does not show three sources`);
    assert.ok(!JSON.stringify(proc).includes(seg(want.code)[2]), `${code}'s card prints VALUE 3`);
  }
  for (const [code] of Object.entries(ORIGINAL_P10)) {
    const proc = binders[def(code).sector].procedures.find((p) => p.fault_code === code);
    assert.equal(proc.format, 'P-10-[VALUE]-[VALUE 2]', code);
    assert.equal(proc.sources.length, 2, code);
  }
});

test('3V-014: the twelve keep their name, sector, crew, materials, decay and reward — only the code grew', () => {
  for (const [code, [name, crew, mats, decay, reward]] of Object.entries(KEPT)) {
    const d = def(code);
    assert.equal(d.name, name, code);
    assert.equal(d.sector, THREE[code].sector, code);
    assert.equal(d.crew_required, crew, code);
    assert.deepEqual(d.resources_required, mats, code);
    assert.equal(d.decay_per_min, decay, code);
    assert.equal(d.severity, d.procedure === 'P-08' ? 3 : 2, code);
    const r = REWARDS.rewards[code];
    assert.equal(`${r.type}:${r.token || r.resource}`, reward, code);
    assert.equal(r.sector, THREE[code].sector, code);
  }
});

test('3V-015: a three-value fault survives a save and restore with its code, and a reset clears it like any other', () => {
  const game = live('F-512');
  const snap = JSON.parse(JSON.stringify(game.serialise()));
  const back = newGame({ runId: 'three-value-restore' });
  back.restore(snap);
  assert.equal(back.state.sectors.COM.faults.length, 1);
  assert.deepEqual(back.findFault('COM', 'F-512').valid_codes, [THREE['F-512'].code]);
  assert.equal(submitCode(back, { sector: 'COM', fault_code: 'F-512', code: THREE['F-512'].code, workers_assigned: 3 }).accepted, true);
  // reset: nothing on any table, and the next firing carries the current code
  const g2 = live('F-611');
  g2.reset('three-value-reset');
  assert.equal(Object.values(g2.state.sectors).flatMap((s) => s.faults).length, 0, 'a reset left a fault behind');
  g2.setPhase('ROUND_5');
  assert.equal(g2.fireFault('F-611', 'COM').ok, true);
  assert.deepEqual(g2.findFault('COM', 'F-611').valid_codes, [THREE['F-611'].code]);
});
