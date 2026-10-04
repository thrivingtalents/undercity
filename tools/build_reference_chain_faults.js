'use strict';
/**
 * REFERENCE CHAIN FAULTS — the generator.
 *
 *   spec/reference_chain_faults.json   (hand-edited: structure, never numbers)
 * + content/specs.json                 (the authoritative spec values)
 * = content/faults.reference-chain.json (generated: runtime fault objects)
 *
 * Run: node tools/build_reference_chain_faults.js [--check]
 *   --check  verify the committed output is current and change nothing.
 *
 * WHY A GENERATOR AND NOT TWELVE HAND-WRITTEN FAULTS. A resolution code in
 * this game is already a pure function of its procedure and the ordered values
 * of its spec refs — lib/validate.js enforces exactly that identity on every
 * boot. So the only honest way to add a fault is to name the SPEC it depends
 * on and let the number follow. Nothing in the source file is a three-digit
 * answer; change Turbine D in the workbook, re-export specs.json, re-run this,
 * and F-507's code changes with it. There is one source of truth for a sector
 * specification value and it is content/specs.json.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'spec', 'reference_chain_faults.json');
const SPECS = path.join(ROOT, 'content', 'specs.json');
const OUT = path.join(ROOT, 'content', 'faults.reference-chain.json');
const CHECK = process.argv.includes('--check');

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const src = read(SRC);
const specs = read(SPECS).specs;

const problems = [];
const fail = (msg) => problems.push(msg);

// -- the spec index: one lookup, by the three things a reference names --------
const byKey = new Map();
for (const s of specs) byKey.set(`${s.binder}|${s.table_id}|${s.row_label}`, s);
const lookup = (t) => byKey.get(`${t.sector}|${t.table}|${t.item}`);

const SECTORS = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];

// -- 1. the reference directory ------------------------------------------------
// Every entry must point at a spec row that exists and holds a real
// three-digit value, or the chain it serves dead-ends on a player.
const refs = new Map();
for (const [owner, entries] of Object.entries(src.reference_directory)) {
  if (owner.startsWith('_')) continue;
  if (!SECTORS.includes(owner)) { fail(`reference_directory: unknown sector ${owner}`); continue; }
  for (const e of entries) {
    if (refs.has(e.id)) fail(`${e.id}: duplicate reference id`);
    const spec = lookup(e.target);
    if (!spec) {
      fail(`${e.id} "${e.reference_name}": ${e.target.sector} ${e.target.table} "${e.target.item}" is not in specs.json`);
      continue;
    }
    if (!Number.isInteger(spec.value) || spec.value < 100 || spec.value > 999) {
      fail(`${e.id}: ${spec.spec_id} is ${spec.value}, not a three-digit value`);
    }
    if (spec.binder === owner) {
      fail(`${e.id}: ${owner} holds a reference to its own table — a reference must point somewhere else`);
    }
    refs.set(e.id, {
      id: e.id,
      owner,
      reference_name: e.reference_name,
      // DERIVED, never written down: rename the spec row and every reference
      // that points at it renames with it.
      display: `${spec.row_label} [${spec.binder}]`,
      entry_type: 'REFERENCE',
      target_sector: spec.binder,
      target_table: spec.table_id,
      target_item: spec.row_label,
      spec_id: spec.spec_id,
    });
  }
}

// -- 2. the faults -------------------------------------------------------------
const PROC = src.meta.procedures;
const faults = [];
const usedRefs = new Set();

for (const f of src.faults) {
  const proc = PROC[f.procedure];
  if (!proc) { fail(`${f.code}: unknown procedure ${f.procedure}`); continue; }
  if (!SECTORS.includes(f.sector)) { fail(`${f.code}: unknown sector ${f.sector}`); continue; }
  if (f.chains.length !== proc.chains) {
    fail(`${f.code}: ${f.procedure} takes ${proc.chains} chain(s), found ${f.chains.length}`);
    continue;
  }

  const chains = [];
  const specRefs = [];
  let broken = false;
  for (const [i, c] of f.chains.entries()) {
    const ref = refs.get(c.reference);
    if (!ref) { fail(`${f.code} chain ${i + 1}: unknown reference ${c.reference}`); broken = true; continue; }
    if (ref.owner !== c.first_sector) {
      fail(`${f.code} chain ${i + 1}: ${c.reference} is held by ${ref.owner}, not ${c.first_sector}`);
      broken = true; continue;
    }
    if (c.first_sector === f.sector) {
      fail(`${f.code} chain ${i + 1}: ${f.sector} cannot be its own intermediary`);
      broken = true; continue;
    }
    usedRefs.add(ref.id);
    const spec = byKey.get(`${ref.target_sector}|${ref.target_table}|${ref.target_item}`);
    chains.push({
      first_sector: ref.owner,
      first_reference_name: ref.reference_name,
      intermediate_result: ref.display,
      final_source: { sector: spec.binder, table: spec.table_id, item: spec.row_label, spec_id: spec.spec_id },
    });
    specRefs.push({
      spec_id: spec.spec_id, binder: spec.binder, table: spec.table_id,
      row_label: spec.row_label, buried: spec.buried,
    });
  }
  if (broken) continue;

  // THE CODE. Built exactly the way lib/validate.js derives it, from the
  // ordered spec values and nothing else.
  const value = (sid) => String(specs.find((s) => s.spec_id === sid).value).padStart(3, '0');
  const code = `${f.procedure}-${specRefs.map((r) => value(r.spec_id)).join('-')}`;

  faults.push({
    code: f.code,
    // Deliberately unscheduled: activateRound deals by round, so null keeps
    // these to the facilitator's hand until they are given one.
    round: src.meta.round,
    sector: f.sector,
    name: f.name,
    flavour: f.flavour,
    severity: proc.severity,
    decay_per_min: 0,
    crew_required: f.crew_required,
    resources_required: { ...f.resources_required },
    procedure: f.procedure,
    spec_refs: specRefs,
    valid_codes: [code],
    false_alarm: false,
    deadline_s: null,
    injures_workforce: 0,
    triggered_by: null,
    facilitator_notes: `Reference chain · ${proc.label}`,
    // FACILITATOR-ONLY. lib/visibility.js never projects this to a sector or
    // to the wall; it exists so the admin console can show the whole path.
    reference_chain: chains,
  });
}

// -- 3. the invariants the mechanic rests on -----------------------------------
for (const [id, r] of refs) {
  if (!usedRefs.has(id)) fail(`${id} "${r.reference_name}" (${r.owner}) is never required by a fault`);
}
const existing = read(path.join(ROOT, 'content', 'faults.json')).faults;
for (const f of faults) {
  if (existing.some((e) => e.code === f.code)) fail(`${f.code} already exists in faults.json`);
}
for (const f of faults) {
  const clash = existing.find((e) => e.sector === f.sector && e.valid_codes.includes(f.valid_codes[0]));
  if (clash) fail(`${f.code}: code ${f.valid_codes[0]} is ambiguous with ${clash.code} in ${f.sector}`);
}
const seen = new Map();
for (const f of faults) {
  const key = `${f.sector}|${f.valid_codes[0]}`;
  if (seen.has(key)) fail(`${f.code}: code ${f.valid_codes[0]} is ambiguous with ${seen.get(key)} in ${f.sector}`);
  seen.set(key, f.code);
}
for (const p of Object.keys(PROC)) {
  if (existing.some((e) => e.procedure === p)) fail(`procedure ${p} is already used by an existing fault`);
}
// Every sector carries its share of the network, in all three roles.
const role = (pick) => {
  const n = Object.fromEntries(SECTORS.map((s) => [s, 0]));
  for (const f of faults) for (const c of f.reference_chain) n[pick(f, c)] += 1;
  return n;
};
const intermediary = role((f, c) => c.first_sector);
for (const s of SECTORS) {
  if (intermediary[s] === 0) fail(`${s} is never an intermediary — the network is not balanced`);
}

if (problems.length) {
  console.error('\nREFERENCE CHAIN BUILD ABORTED:\n');
  for (const p of problems) console.error('  ✗', p);
  console.error('');
  process.exit(1);
}

// -- 4. write ------------------------------------------------------------------
const payload = {
  meta: {
    source: 'spec/reference_chain_faults.json',
    generator: 'tools/build_reference_chain_faults.js',
    spec_source: 'content/specs.json',
    fault_count: faults.length,
    reference_count: refs.size,
    note: 'Generated. Do not hand-edit — edit spec/reference_chain_faults.json and re-run the generator. Every three-digit value here was resolved from content/specs.json.',
  },
  reference_directory: SECTORS.reduce((acc, s) => {
    acc[s] = [...refs.values()].filter((r) => r.owner === s);
    return acc;
  }, {}),
  faults,
};
const text = `${JSON.stringify(payload, null, 2)}\n`;

if (CHECK) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== text) {
    console.error(`✗ ${path.relative(ROOT, OUT)} is stale — run: node tools/build_reference_chain_faults.js`);
    process.exit(1);
  }
  console.log(`✓ ${path.relative(ROOT, OUT)} is current (${faults.length} faults, ${refs.size} references)`);
  process.exit(0);
}

fs.writeFileSync(OUT, text, 'utf8');
console.log(`✓ ${path.relative(ROOT, OUT)}  ${faults.length} faults, ${refs.size} references`);
console.log('\n  REQUESTER  ->  FIRST  ->  REFERENCE                          ->  FINAL');
for (const f of faults) {
  for (const c of f.reference_chain) {
    console.log(`  ${f.code} ${f.sector.padEnd(4)} ->  ${c.first_sector.padEnd(5)} ->  ${c.first_reference_name.padEnd(34)} ->  ${c.intermediate_result.padEnd(24)} ${f.valid_codes[0]}`);
  }
}
const finals = role((f, c) => c.final_source.sector);
console.log('\n  balance   requests / intermediary / final');
for (const s of SECTORS) {
  const req = faults.filter((f) => f.sector === s).reduce((n, f) => n + f.reference_chain.length, 0);
  console.log(`  ${s}       ${req}  /  ${intermediary[s]}  /  ${finals[s]}`);
}
