#!/usr/bin/env node
'use strict';
/**
 * LATE SHIFT FAULTS (2026-10-05): the generator.
 *
 *   spec/late_shift_faults.json      (hand-edited: structure, never numbers)
 *   content/specs.json               (the workbook's specification values)
 *   content/faults.json              (the workbook's thirty-six faults)
 *   content/faults.reference-chain.json  (the twelve chain faults)
 *     -> content/faults.late-shift.json  (generated, merged at load by lib/content.js)
 *
 * Run: node tools/build_late_shift_faults.js [--check]
 *   --check  verify the committed output is current and change nothing.
 *
 * Two more faults per sector, P-09 and P-10. A P-10 needs two values from
 * two specification tables; a P-09 needs three (2026-10-06) — the third from
 * the requesting sector's own table, its own Appendix C, or a third sector's
 * indexed table. The source names the ROWS; this resolves the VALUES, so a
 * changed specification changes the answer by itself and no file ever holds
 * the same number twice. Nothing the engine does is new:
 * the resolution code is procedure + ordered values, which lib/validate.js
 * re-derives at boot and lib/resolve.js compares at the console.
 *
 * It refuses to build on anything that would make a fault wrong, ambiguous,
 * or free: an unknown row, a value that is not three digits, a code already
 * taken, a procedure already used, a source that is where the requesting
 * sector's own reference chain ends (the chain would collapse into the team's
 * notes), or a row the requesting sector is already sent to by one of its
 * own faults (the answer would already be in those notes) — unless the source
 * declares that overlap by fault code, which puts the repeat on record. The
 * one Appendix C a late-shift fault may name is the requesting sector's own,
 * and only as its third value.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'spec', 'late_shift_faults.json');
const OUT = path.join(ROOT, 'content', 'faults.late-shift.json');
const CHECK = process.argv.includes('--check');

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const problems = [];
const fail = (msg) => problems.push(msg);

const src = read(SRC);
const specs = read(path.join(ROOT, 'content', 'specs.json')).specs;
const SECTORS = Object.keys(read(path.join(ROOT, 'content', 'sectors.json')).sectors);
const ROUNDS = read(path.join(ROOT, 'lib', 'rounds.json')).rounds.map((r) => r.id);
const workbook = read(path.join(ROOT, 'content', 'faults.json')).faults;
const chainPath = path.join(ROOT, 'content', 'faults.reference-chain.json');
const chain = fs.existsSync(chainPath) ? read(chainPath).faults : [];
const existing = [...workbook, ...chain];
const RESOURCES = ['power', 'water', 'parts', 'med'];
const PROC = src.procedures || {};

// -- 1. the lookups ---------------------------------------------------------------
const bySpec = new Map(specs.map((s) => [`${s.binder}|${s.table_id}|${s.row_label.toLowerCase()}`, s]));
const tables = new Set(specs.map((s) => `${s.binder}|${s.table_id}`));

// Where each sector's own reference chains END: a late-shift fault must never
// send that sector straight there.
const chainEnds = new Map(SECTORS.map((s) => [s, new Map()]));
for (const f of chain) {
  for (const c of f.reference_chain || []) {
    if (c.final_source && c.final_source.spec_id) chainEnds.get(f.sector).set(c.final_source.spec_id, f.code);
  }
}
// Every row each sector is already sent to by one of its own faults.
const visited = new Map(SECTORS.map((s) => [s, new Map()]));
for (const f of existing) {
  for (const r of f.spec_refs || []) if (!visited.get(f.sector).has(r.spec_id)) visited.get(f.sector).set(r.spec_id, f.code);
}
// Every row each LATE-SHIFT fault names, by sector, read once up front so a
// repeat inside the late shift is seen from both sides whatever the file
// order — and the overlaps the source declares, as unordered pairs, so one
// declaration (on the value that repeats) covers both faults.
const specKey = (s) => `${s.sector}|${s.table}|${String(s.row || '').toLowerCase()}`;
const pairKey = (sector, specId, a, b) => `${sector}|${specId}|${[a, b].sort().join('|')}`;
const lateRows = new Map(SECTORS.map((s) => [s, new Map()]));
const acknowledged = new Set();
for (const f of src.faults || []) {
  if (!SECTORS.includes(f.sector)) continue;
  for (const s of f.sources || []) {
    const spec = bySpec.get(specKey(s));
    if (!spec) continue;
    const rows = lateRows.get(f.sector);
    if (!rows.has(spec.spec_id)) rows.set(spec.spec_id, []);
    rows.get(spec.spec_id).push(f.code);
    if (s.overlap) acknowledged.add(pairKey(f.sector, spec.spec_id, f.code, s.overlap));
  }
}
const sourceType = (spec, sector) => (spec.binder === sector ? (spec.buried ? 'OWN_APPENDIX' : 'OWN_TABLE') : (spec.buried ? 'FOREIGN_APPENDIX' : 'EXTERNAL'));

// -- 2. the meta ------------------------------------------------------------------
if (!src.meta || !src.meta.section) fail('meta.section is missing');
if (!ROUNDS.includes(src.meta.recommended_from)) fail(`meta.recommended_from ${src.meta.recommended_from} is not a round in lib/rounds.json (${ROUNDS.join(', ')})`);
for (const [id, p] of Object.entries(PROC)) {
  if (!/^P-\d\d$/.test(id)) fail(`procedure id ${id} is malformed`);
  if (existing.some((e) => e.procedure === id)) fail(`procedure ${id} is already used by ${existing.find((e) => e.procedure === id).code}`);
  if (![1, 2, 3].includes(p.severity)) fail(`${id}: severity must be 1, 2 or 3`);
  if (!(Number(p.decay_per_min) >= 0)) fail(`${id}: decay_per_min must be a number`);
  // How many values the code carries: P-09 three (2026-10-06), P-10 two.
  if (![2, 3].includes(Number(p.values))) fail(`${id}: values must be 2 or 3 — how many values its code carries`);
}

// -- 3. the faults ----------------------------------------------------------------
const faults = [];
const seen = new Set();
for (const f of src.faults || []) {
  if (seen.has(f.code)) fail(`${f.code} is listed twice`);
  seen.add(f.code);
  if (!/^F-6\d\d$/.test(f.code)) fail(`${f.code}: late-shift codes are F-6xx`);
  if (existing.some((e) => e.code === f.code)) fail(`${f.code} already exists in the content`);
  if (!SECTORS.includes(f.sector)) fail(`${f.code}: unknown sector ${f.sector}`);
  const proc = PROC[f.procedure];
  if (!proc) { fail(`${f.code}: ${f.procedure} is not a late-shift procedure`); continue; }
  if (!f.name || !f.flavour) fail(`${f.code}: needs a name and a flavour line`);
  if (/;/.test(f.flavour || '')) fail(`${f.code}: the flavour must not carry a dependency clause after ";" — the card prints it whole`);

  if (!Number.isInteger(f.crew_required) || f.crew_required < 1 || f.crew_required > 4) fail(`${f.code}: crew_required ${f.crew_required} is not 1–4`);
  const mats = Object.entries(f.resources_required || {});
  if (!mats.length) fail(`${f.code}: stages no materials`);
  for (const [k, v] of mats) {
    if (!RESOURCES.includes(k)) fail(`${f.code}: ${k} is not a resource (${RESOURCES.join(', ')})`);
    if (!Number.isInteger(v) || v < 1) fail(`${f.code}: ${k} ${v} is not a positive whole number`);
  }

  const want = Number(proc.values);
  if (!Array.isArray(f.sources) || f.sources.length !== want) fail(`${f.code}: a ${f.procedure} fault needs exactly ${want} sources, found ${(f.sources || []).length}`);
  const refs = [];
  const values = [];
  const overlaps = [];
  for (const [i, s] of (f.sources || []).entries()) {
    const n = i + 1;
    if (!SECTORS.includes(s.sector)) { fail(`${f.code} value ${n}: source sector ${s.sector} is unknown`); continue; }
    if (!tables.has(`${s.sector}|${s.table}`)) { fail(`${f.code} value ${n}: ${s.sector} has no table ${s.table}`); continue; }
    const spec = bySpec.get(specKey(s));
    if (!spec) { fail(`${f.code} value ${n}: ${s.sector} ${s.table} has no row "${s.row}"`); continue; }
    const type = sourceType(spec, f.sector);
    // Appendix C: the requesting sector's own, as its third value, and nothing else (2026-10-06).
    if (spec.buried && (type !== 'OWN_APPENDIX' || n !== 3)) {
      fail(`${f.code} value ${n}: ${spec.spec_id} is ${type === 'OWN_APPENDIX' ? 'its own' : `${spec.binder}'s`} Appendix C — the late shift reuses indexed tables; only a third value may be the requesting sector's own Appendix C`);
    }
    if (s.source_type && s.source_type !== type) fail(`${f.code} value ${n}: declared ${s.source_type}, but ${spec.spec_id} ${spec.binder} ${spec.table_id} "${spec.row_label}" is ${type}`);
    if (!/^\d{3}$/.test(String(spec.value))) fail(`${f.code} value ${n}: ${spec.spec_id} value ${spec.value} is not three digits`);
    const endOf = chainEnds.get(f.sector).get(spec.spec_id);
    if (endOf) fail(`${f.code} value ${n}: sends ${f.sector} to ${spec.spec_id} "${spec.row_label}", where its own reference chain ${endOf} ends — the chain would collapse into the team's notes`);
    const others = (lateRows.get(f.sector).get(spec.spec_id) || []).filter((c) => c !== f.code);
    const prior = visited.get(f.sector).get(spec.spec_id) || others[0];
    if (prior && !acknowledged.has(pairKey(f.sector, spec.spec_id, f.code, prior))) {
      fail(`${f.code} value ${n}: ${f.sector} is already sent to ${spec.spec_id} "${spec.row_label}" by ${prior} — the answer would be in its notes; declare "overlap": "${prior}" on the value that repeats it if that is intended`);
    } else if (prior) {
      overlaps.push(`VALUE ${n} row is also ${prior}'s`);
    } else if (s.overlap) {
      fail(`${f.code} value ${n}: declares an overlap with ${s.overlap}, but no other ${f.sector} fault is sent to ${spec.spec_id}`);
    }
    refs.push({ spec_id: spec.spec_id, binder: spec.binder, table: spec.table_id, row_label: spec.row_label, buried: !!spec.buried });
    values.push(spec.value);
  }
  const code = `${f.procedure}-${values.map((v) => String(v).padStart(3, '0')).join('-')}`;
  const clash = existing.find((e) => e.sector === f.sector && e.valid_codes.includes(code));
  if (clash) fail(`${f.code}: code ${code} is ambiguous with ${clash.code} in ${f.sector}`);
  if (faults.some((x) => x.sector === f.sector && x.valid_codes.includes(code))) fail(`${f.code}: code ${code} is ambiguous within the late shift`);

  if (proc.time_critical) {
    if (f.time_critical !== true) fail(`${f.code}: ${f.procedure} faults are TIME-CRITICAL — say so`);
    if (!Number.isInteger(f.facilitator_target_s) || f.facilitator_target_s <= 0) fail(`${f.code}: facilitator_target_s must be a positive whole number of seconds`);
  } else if (f.time_critical || f.facilitator_target_s) {
    fail(`${f.code}: only ${Object.keys(PROC).filter((p) => PROC[p].time_critical).join('/')} faults are TIME-CRITICAL`);
  }

  faults.push({
    code: f.code,
    // Unscheduled by design: the facilitator fires these from the library's
    // LATE SHIFT section, appropriate from `recommended_from` onward.
    round: null,
    sector: f.sector,
    name: f.name,
    flavour: f.flavour,
    severity: proc.severity,
    decay_per_min: Number(proc.decay_per_min),
    crew_required: f.crew_required,
    resources_required: { ...f.resources_required },
    procedure: f.procedure,
    spec_refs: refs,
    valid_codes: [code],
    false_alarm: false,
    injures_workforce: 0,
    triggered_by: null,
    facilitator_notes: (f.facilitator_notes || `${src.meta.section} · ${f.procedure}${proc.time_critical ? ' · TIME-CRITICAL' : ''}`) + overlaps.map((o) => ` · ${o}`).join(''),
    section: src.meta.section,
    recommended_from: src.meta.recommended_from,
    late_shift: true,
    // Guidance, never a clock: nothing counts down, expires or resolves on these.
    time_critical: !!proc.time_critical,
    facilitator_target_s: proc.time_critical ? f.facilitator_target_s : null,
  });
}

// -- 4. the deck: two per sector, one of each procedure ------------------------
for (const s of SECTORS) {
  const own = faults.filter((f) => f.sector === s);
  const procs = own.map((f) => f.procedure).sort();
  if (JSON.stringify(procs) !== JSON.stringify(Object.keys(PROC).sort())) {
    fail(`${s}: the late shift must give it exactly one of each of ${Object.keys(PROC).join(', ')} — it has ${procs.join(', ') || 'nothing'}`);
  }
}

if (problems.length) {
  console.error('\nLATE SHIFT BUILD ABORTED:\n');
  for (const p of problems) console.error('  ✗', p);
  console.error('');
  process.exit(1);
}

// -- 5. write -----------------------------------------------------------------
const payload = {
  meta: {
    name: src.meta.name,
    version: src.meta.version,
    source: 'spec/late_shift_faults.json',
    generator: 'tools/build_late_shift_faults.js',
    section: src.meta.section,
    recommended_from: src.meta.recommended_from,
    fault_count: faults.length,
    procedures: Object.fromEntries(Object.entries(PROC).map(([id, p]) => [id, { severity: p.severity, decay_per_min: Number(p.decay_per_min), time_critical: !!p.time_critical, values: Number(p.values), label: p.label || null }])),
    note: 'Generated. Do not hand-edit — edit spec/late_shift_faults.json and re-run the generator. Every three-digit value here was resolved from content/specs.json.',
  },
  faults,
};
const text = `${JSON.stringify(payload, null, 2)}\n`;

if (CHECK) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== text) {
    console.error(`✗ ${path.relative(ROOT, OUT)} is out of date — run: node tools/build_late_shift_faults.js`);
    process.exit(1);
  }
  console.log(`✓ ${path.relative(ROOT, OUT)} is current (${faults.length} faults, ${Object.keys(PROC).join(' + ')})`);
} else {
  fs.writeFileSync(OUT, text);
  console.log(`✓ ${path.relative(ROOT, OUT)} — ${faults.length} faults`);
  for (const f of faults) {
    console.log(`  ${f.code} ${f.sector} ${f.procedure} ${f.valid_codes[0]}  ${f.spec_refs.map((r) => `${r.binder} ${r.table} ${r.row_label}`).join(' + ')}${f.time_critical ? `  TIME-CRITICAL ${f.facilitator_target_s}s` : ''}`);
  }
}
