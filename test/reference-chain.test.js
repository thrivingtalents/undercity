'use strict';
/**
 * THE REFERENCE CHAIN MECHANIC (2026-10-04).
 *
 * Twelve faults whose answer is not in the binder the procedure sends you to.
 * TRN asks WTR for the Freight Cooling Reference; WTR's binder says "Turbine D
 * [POW]"; TRN must then go to POW for the number. The whole mechanic is a
 * sentence about where to look next, and everything below defends two halves
 * of it: the chain is real and resolvable, and no player screen ever shows
 * more than its first step.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { newGame, loadContent } = require('./helpers');
const { forSector, forBigscreen, forControl } = require('../lib/visibility');
const { submitCode } = require('../lib/resolve');

const ROOT = path.join(__dirname, '..');
const content = loadContent();
const specs = content.specs.specs;
const chain = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'faults.reference-chain.json'), 'utf8'));
const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'reference_chain_faults.json'), 'utf8'));

const SECTORS = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];
const CODES = ['F-501', 'F-502', 'F-503', 'F-504', 'F-505', 'F-506', 'F-507', 'F-508', 'F-509', 'F-510', 'F-511', 'F-512'];
const def = (code) => content.faults.faults.find((f) => f.code === code);
const specValue = (binder, table, item) =>
  (specs.find((s) => s.binder === binder && s.table_id === table && s.row_label === item) || {}).value;

function live(sector, code) {
  const game = newGame();
  game.setPhase('ROUND_2');
  game.clock('start');
  assert.equal(game.fireFault(code, sector).ok, true, `${code} did not fire`);
  return game;
}
const own = (game, sector, code) =>
  forSector(game, sector).sectors[sector].faults.find((f) => f.code === code);

// -- RC-001 / 002 / 003: the worked example, end to end ----------------------------------

test('RC-001: TRN gets F-507 and is sent to WTR, and only to WTR', () => {
  const f = def('F-507');
  assert.equal(f.sector, 'TRN');
  assert.equal(f.reference_chain.length, 1);
  const c = f.reference_chain[0];
  assert.equal(c.first_sector, 'WTR');
  assert.equal(c.first_reference_name, 'Freight Cooling Reference');
  // The procedure the binder prints names the first sector and the row, and
  // stops there. It must not name POW, which is where the answer actually is.
  const proc = procedureFor('TRN', 'P-07');
  const text = proc.steps.join(' ');
  assert.ok(/Obtain the Freight Cooling Reference from WTR/.test(text), 'TRN is not sent to WTR');
  assert.ok(!/Turbine D/.test(text), "TRN's procedure gives away the reference");
  assert.ok(!/\bPOW\b/.test(text), "TRN's procedure gives away the final sector");
});

test('RC-002: WTR holds the Freight Cooling Reference as a pointer, not a number', () => {
  const entry = chain.reference_directory.WTR.find((r) => r.reference_name === 'Freight Cooling Reference');
  assert.ok(entry, 'WTR does not hold it');
  assert.equal(entry.entry_type, 'REFERENCE');
  assert.equal(entry.display, 'Turbine D [POW]');
  assert.ok(!/\d/.test(entry.display), 'the reference shows a number');
  // And WTR's own binder tables still print no POW value — the leak rule.
  const wtrValues = specs.filter((s) => s.binder === 'WTR').map((s) => s.value);
  assert.ok(!wtrValues.includes(376), "WTR's own tables carry the POW answer");
});

test('RC-003: the answer is POW Turbine D, and only that code resolves F-507', () => {
  const turbineD = specValue('POW', 'P-1', 'Turbine D');
  assert.equal(turbineD, 376);
  assert.deepEqual(def('F-507').valid_codes, [`P-07-${turbineD}`]);

  // Each wrong code on its own console: three in a row would lock it, which
  // is RC-011's business and not this test's.
  const wrong = (code) => {
    const g = live('TRN', 'F-507');
    return submitCode(g, { sector: 'TRN', fault_code: 'F-507', code, workers_assigned: 2 }).accepted;
  };
  // The reference text is never an answer, nor is the sector that held it.
  assert.equal(wrong('P-07-Turbine D'), false);
  assert.equal(wrong('P-07-WTR'), false);
  // Nor is the turbine next to it in the same table.
  assert.equal(wrong(`P-07-${specValue('POW', 'P-1', 'Turbine C')}`), false);
  const game = live('TRN', 'F-507');
  const accepted = submitCode(game, { sector: 'TRN', fault_code: 'F-507', code: `P-07-${turbineD}`, workers_assigned: 2 });
  assert.equal(accepted.accepted, true, 'the real answer was refused');
  assert.equal(game.state.sectors.TRN.faults.find((f) => f.code === 'F-507').resolved, true);
});

// -- RC-004 / 012: who can see the path ---------------------------------------------------

test('RC-004 / RC-012: no player screen shows past the first sector; the facilitator sees all of it', () => {
  const game = live('TRN', 'F-507');
  const mine = own(game, 'TRN', 'F-507');
  assert.ok(mine, 'TRN cannot see its own fault');
  // Not the chain, not the intermediate, not the final sector, not the answer.
  assert.equal(mine.reference_chain, undefined, "the chain reached the owning sector's screen");
  assert.equal(mine.valid_codes, undefined, 'the answer reached the player');
  const asText = JSON.stringify(forSector(game, 'TRN'));
  for (const leak of ['Turbine D', 'reference_chain', 'Freight Cooling Reference', 'P-07-376']) {
    assert.ok(!asText.includes(leak), `TRN's frame leaks "${leak}"`);
  }
  // Nor any other table's frame, nor the wall.
  for (const s of SECTORS.filter((c) => c !== 'TRN')) {
    assert.ok(!JSON.stringify(forSector(game, s)).includes('reference_chain'), `${s} was sent the chain`);
  }
  assert.ok(!JSON.stringify(forBigscreen(game)).includes('reference_chain'), 'the wall was sent the chain');

  // The facilitator reads it from the content the control endpoint serves.
  const full = def('F-507').reference_chain[0];
  assert.equal(full.final_source.sector, 'POW');
  assert.equal(full.final_source.item, 'Turbine D');
  assert.equal(full.intermediate_result, 'Turbine D [POW]');
  assert.ok(/chainText/.test(fs.readFileSync(path.join(ROOT, 'public/control/control.js'), 'utf8')),
    'the admin console cannot show a chain');
  // …and the live fault the facilitator sees still carries its answer.
  assert.ok(forControl(game).sectors.TRN.faults.find((f) => f.code === 'F-507').valid_codes);
});

// -- RC-005 / 006 / 007 / 008: the shape of the twelve ------------------------------------

test('RC-005 / RC-006: two more faults for every sector, P-07 and P-08 each', () => {
  for (const s of SECTORS) {
    const mine = chain.faults.filter((f) => f.sector === s);
    assert.equal(mine.length, 2, `${s} has ${mine.length} reference-chain faults`);
    assert.deepEqual(mine.map((f) => f.procedure).sort(), ['P-07', 'P-08'], `${s} is missing a procedure`);
  }
  assert.deepEqual(chain.faults.map((f) => f.code).sort(), CODES);
});

test('RC-007 / RC-008: P-07 is one chain and one value, P-08 is two of each', () => {
  for (const f of chain.faults) {
    const n = f.procedure === 'P-07' ? 1 : 2;
    assert.equal(f.reference_chain.length, n, `${f.code} has the wrong chain count`);
    assert.equal(f.spec_refs.length, n, `${f.code} has the wrong spec count`);
    assert.equal(f.valid_codes[0].split('-').length, 2 + n, `${f.code}: ${f.valid_codes[0]}`);
    // Severity follows the existing ladder: two triangles, then three.
    assert.equal(f.severity, n === 1 ? 2 : 3, `${f.code} severity`);
    // Every value in the code is three digits and is a real spec value.
    const parts = f.valid_codes[0].split('-').slice(2);
    assert.equal(parts.length, n);
    for (const [i, v] of parts.entries()) {
      assert.match(v, /^\d{3}$/, `${f.code}: ${v} is not three digits`);
      const s = f.spec_refs[i];
      assert.equal(Number(v), specValue(s.binder, s.table, s.row_label), `${f.code} value ${i + 1} is not its spec`);
    }
  }
});

// -- RC-009: the thirty-six are untouched --------------------------------------------------

test('RC-009: every existing fault and every existing spec value is exactly as it was', () => {
  const workbook = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'faults.json'), 'utf8'));
  assert.equal(workbook.faults.length, 36, 'faults.json was edited');
  assert.ok(!workbook.faults.some((f) => CODES.includes(f.code)), 'a chain fault was written into faults.json');
  assert.ok(!workbook.faults.some((f) => ['P-07', 'P-08'].includes(f.procedure)), 'P-07/P-08 overwrote a procedure');
  for (const p of ['P-01', 'P-02', 'P-03', 'P-04', 'P-05', 'P-06']) {
    assert.ok(workbook.faults.some((f) => f.procedure === p), `${p} is gone`);
  }
  // The merged world is the 36 plus the 12, and the codes are unique in it.
  assert.equal(content.faults.faults.length, 48);
  assert.equal(content.faults.meta.fault_count, 48);
  assert.equal(new Set(content.faults.faults.map((f) => f.code)).size, 48);
  // The old path still resolves, unchanged.
  const game = live('POW', 'F-101');
  assert.equal(submitCode(game, { sector: 'POW', fault_code: 'F-101', code: def('F-101').valid_codes[0], workers_assigned: 2 }).accepted, true);
});

// -- RC-010: a reference does not look like a value ----------------------------------------

test('RC-010: every reference is an asset and a sector, and never a figure', () => {
  const all = Object.values(chain.reference_directory).flat();
  assert.equal(all.length, 18);
  for (const r of all) {
    assert.match(r.display, /^.+ \[(POW|WTR|MED|TRN|AGR|COM)\]$/, `${r.id}: ${r.display}`);
    assert.ok(!/\d{3}/.test(r.display), `${r.id} shows a three-digit value`);
    assert.notEqual(r.target_sector, r.owner, `${r.id} points at its own sector`);
    assert.equal(r.entry_type, 'REFERENCE');
  }
  // PWR is not a sector in this game; the abbreviation is POW.
  assert.ok(!JSON.stringify(chain).includes('PWR'), 'PWR crept in');
  // The binder prints the directory, and says what it is for.
  const binders = fs.readFileSync(path.join(ROOT, 'tools/kit/build_binders.js'), 'utf8');
  assert.ok(/5A · CROSS-SYSTEM REFERENCE DIRECTORY/.test(binders), 'the binder has no 5A');
  assert.ok(/are REFERENCES, not resolution values/.test(binders), 'the binder does not explain a reference');
});

// -- RC-011: the console is unchanged --------------------------------------------------------

test('RC-011: three wrong codes still lock the console, on a chain fault like any other', () => {
  const game = live('COM', 'F-512');
  const f = def('F-512');
  const go = (code) => submitCode(game, { sector: 'COM', fault_code: 'F-512', code, workers_assigned: 3 });
  assert.equal(go('P-08-111-222').accepted, false);
  assert.equal(go('P-08-333-444').accepted, false);
  const third = go('P-08-555-666');
  assert.equal(third.accepted, false);
  assert.ok(third.locked_until_s > 0, 'the third wrong code did not lock the console');
  // The lockout is the existing one, from the existing setting.
  assert.equal(third.locked_until_s, game.cfg.lockout_s);
  assert.equal(third.max_consecutive, game.cfg.lockout_after_consecutive_invalid);
  // A rejection never says what was right.
  assert.ok(!JSON.stringify(third).includes(f.valid_codes[0].split('-')[2]), 'the rejection leaked a value');
});

// -- the network ------------------------------------------------------------------------------

test('every sector asks, holds and answers: the information network is balanced', () => {
  const asks = {}; const holds = {}; const answers = {};
  for (const s of SECTORS) { asks[s] = 0; holds[s] = 0; answers[s] = 0; }
  for (const f of chain.faults) {
    for (const c of f.reference_chain) {
      asks[f.sector] += 1;
      holds[c.first_sector] += 1;
      answers[c.final_source.sector] += 1;
      assert.notEqual(c.first_sector, f.sector, `${f.code}: a sector cannot be its own intermediary`);
    }
  }
  for (const s of SECTORS) {
    assert.equal(asks[s], 3, `${s} asks ${asks[s]} times`);
    assert.equal(holds[s], 3, `${s} is an intermediary ${holds[s]} times`);
    assert.ok(answers[s] >= 2 && answers[s] <= 4, `${s} holds ${answers[s]} final values`);
  }
  // Every directory entry earns its place.
  const used = new Set(chain.faults.flatMap((f) => f.reference_chain.map((c) => `${c.first_sector}|${c.first_reference_name}`)));
  for (const r of Object.values(chain.reference_directory).flat()) {
    assert.ok(used.has(`${r.owner}|${r.reference_name}`), `${r.id} is never required by a fault`);
  }
});

// -- the generator is the only author ---------------------------------------------------------

test('the source file holds no answers, and the generated file is current', () => {
  // Nothing in the hand-edited source may be a three-digit answer. Crew counts
  // and material counts are single digits; a 100-999 integer anywhere in it
  // would mean somebody wrote a specification value down twice.
  const walk = (node) => {
    if (Number.isInteger(node)) assert.ok(node < 100, `the source carries ${node}, which looks like a spec value`);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(source.reference_directory);
  walk(source.faults);
  assert.ok(!JSON.stringify(source).includes('P-07-'), 'the source carries a resolution code');
  assert.ok(!JSON.stringify(source).includes('P-08-'), 'the source carries a resolution code');

  // And re-running the generator changes nothing: the committed output is what
  // the current specs.json produces. Change a spec value and this fails here,
  // which is the point — the codes follow the specification, not the other way.
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build_reference_chain_faults.js'), '--check'], { stdio: 'pipe' });
});

// -- the deck and the facilitator's hand -------------------------------------------------------

test('the twelve are unscheduled, printed in their own section, and facilitator-issued', () => {
  const game = newGame();
  // round:null keeps them out of every round's library group — and since
  // 2026-10-04 no activation deals anything anyway, so the facilitator's
  // hand is the only way any fault, these included, reaches a table.
  for (const f of chain.faults) assert.equal(f.round, null, `${f.code} was given a round`);
  for (const r of ['R0', 'R1', 'R2', 'R3', 'R4']) {
    const grouped = game.faultsForRound(r).map((f) => f.code);
    for (const c of CODES) assert.ok(!grouped.includes(c), `${c} is grouped under ${r}`);
    game.activateRound(r);
    assert.equal(Object.values(game.state.sectors).flatMap((s) => s.faults).length, 0, `${r} dealt a fault`);
  }
  // The facilitator can still issue any of them by hand.
  for (const f of chain.faults) {
    const g = newGame();
    g.setPhase('ROUND_2');
    assert.equal(g.fireFault(f.code, f.sector).ok, true, `${f.code} cannot be issued`);
  }
  // The printed deck carries them under an unnumbered section.
  const cards = fs.readFileSync(path.join(ROOT, 'tools/kit/build_cards.js'), 'utf8');
  assert.ok(/REFERENCE CHAIN/.test(cards), 'the deck has no REFERENCE CHAIN section');
  assert.ok(/deck\.push\(\.\.\.chainFaults/.test(cards), 'the deck does not print them');
});

/** The procedure the binder would print for a sector, rebuilt the way the assembler does. */
function procedureFor(sector, id) {
  const f = chain.faults.find((x) => x.sector === sector && x.procedure === id);
  const n = f.reference_chain.length;
  const steps = f.reference_chain.map((c) =>
    `Obtain the ${c.first_reference_name} from ${c.first_sector}.`);
  return { steps, format: `${id}-[VALUE]${n === 2 ? '-[VALUE 2]' : ''}` };
}
