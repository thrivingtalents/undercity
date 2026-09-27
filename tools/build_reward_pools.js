#!/usr/bin/env node
'use strict';
/**
 * Rebuilds the per-fault case records in lib/reward-pools.json — and the
 * balance fixture the tests check them against — from the binder content.
 *
 *   node tools/build_reward_pools.js            rewrite both files
 *   node tools/build_reward_pools.js --check    exit 1 if either file is stale
 *
 * A case record is derived, never retyped: crew, materials and severity come
 * from content/faults.json; the sectors a fault depends on are the binders its
 * spec refs point at; lib/rewards.js difficultyFor() turns those into the
 * difficulty score, the RVU target and band and the per-fault refund cap; the
 * case profile and the resource-probability cap follow the v17.3 table
 * (encoded below and checked against every record that already exists). The
 * reward tier is a hand-set balance figure: a fault that already has a record
 * keeps its tier, a new fault gets the threshold default.
 *
 * Everything else in reward-pools.json — weights, profiles, the archetype
 * catalogue — is left exactly as it is, and so is the fixture's archetype
 * section. Run this after any change to the fault deck, then `npm test`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONTENT = path.join(ROOT, 'content', 'faults.json');
const POOLS_PATH = path.join(ROOT, 'lib', 'reward-pools.json');
const FIXTURE_PATH = path.join(ROOT, 'test', 'fixtures', 'fault-rewards-balance.json');

const SECTORS = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];
const CHECK = process.argv.includes('--check');

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const faults = read(CONTENT).faults;
const pools = read(POOLS_PATH);
const fixture = read(FIXTURE_PATH);
const rewards = require(path.join(ROOT, 'lib', 'rewards.js'));

/** The binders a repair has to consult, in spec order: every sector but the owner. */
function dependencies(f) {
  return [...new Set(f.spec_refs.filter((r) => r.binder !== f.sector).map((r) => r.binder))];
}

/** v17.3 case profiles, as the table assigns them. */
function profileFor(units, deps, severity) {
  if (deps.length >= 2 && severity === 3) return 'CRITICAL_INTERDEPENDENT';
  if (deps.length >= 1 && units >= 3) return 'HEAVY_COORDINATED';
  if (deps.length >= 1) return 'COORDINATED_REPAIR';
  if (units >= 2) return 'STANDARD_LOCAL';
  return 'BASIC_LOCAL';
}

/** v17.3 resource-reward probability caps: nothing when no stock may be paid at all. */
function probabilityCap(profile, maxUnits, deps) {
  if (maxUnits === 0) return 0;
  switch (profile) {
    case 'STANDARD_LOCAL': return 0.2;
    case 'COORDINATED_REPAIR': return deps.length >= 2 ? 0.3 : 0.25;
    case 'HEAVY_COORDINATED':
    case 'CRITICAL_INTERDEPENDENT': return 0.3;
    default: return 0;
  }
}

/** Default tier for a fault with no existing record. */
function tierDefault(score) {
  if (score < 2) return 1;
  if (score < 4) return 2;
  if (score < 5.5) return 3;
  return 4;
}

const previous = Object.values(pools.faults || {});
const records = {};
const drift = [];
for (const f of faults) {
  const deps = dependencies(f);
  const d = rewards.difficultyFor({
    materials: f.resources_required, minimum_crew: f.crew_required,
    external_information_dependencies: deps, severity_level: f.severity,
  });
  const profile = profileFor(d.material_units, deps, f.severity);
  const prev = previous.find((b) => b.sector === f.sector && b.title === f.name && b.repair_type === 'STANDARD');
  const record = {
    sector: f.sector,
    title: f.name,
    repair_type: 'STANDARD',
    severity_level: f.severity,
    material_units: d.material_units,
    weighted_material_burden: d.weighted_material_burden,
    minimum_crew: f.crew_required,
    external_information_dependencies: deps,
    difficulty_score: d.difficulty_score,
    reward_tier: prev ? prev.reward_tier : tierDefault(d.difficulty_score),
    reward_target_rvu: d.reward_target_rvu,
    allowed_reward_rvu: d.allowed_reward_rvu,
    case_profile: profile,
    max_resource_units_in_single_reward: d.max_resource_units_in_single_reward,
    resource_reward_probability_cap: probabilityCap(profile, d.max_resource_units_in_single_reward, deps),
  };
  if (prev) {
    for (const k of Object.keys(record)) {
      if (JSON.stringify(record[k]) !== JSON.stringify(prev[k])) drift.push(`${f.code} ${k}: was ${JSON.stringify(prev[k])}, derived ${JSON.stringify(record[k])}`);
    }
  }
  records[f.code] = record;
}
if (drift.length) {
  console.error('derived records disagree with the existing table — fix the rules, do not retype:');
  for (const line of drift) console.error('  ' + line);
  process.exit(1);
}

// sector order, then code order — the layout the file has always had
const ordered = {};
for (const s of SECTORS) {
  for (const code of Object.keys(records).filter((c) => records[c].sector === s).sort()) ordered[code] = records[code];
}

const nextPools = { ...pools, faults: ordered };
nextPools.version = '17.4';
nextPools._comment = 'Fault rewards, v17.4 (2026-09-27; v17.3 rules, 2026-09-18). Crew and materials live in content/faults.json — the binder. This file holds the balance side: one record per fault (difficulty, RVU target and band, case profile, resource caps), the archetype catalogue with its RVU and category, and the case-profile weights. The fault records are DERIVED by tools/build_reward_pools.js from the content and lib/rewards.js difficultyFor() — regenerate, never retype. RVU is a balance figure for the debrief and never reaches a player. resource_units is what an archetype adds to the city\'s stock and is what both scarcity caps count.';

const matrix = {};
const balance = {};
for (const s of SECTORS) matrix[s] = [];
for (const [code, r] of Object.entries(ordered)) {
  const f = faults.find((x) => x.code === code);
  matrix[r.sector].push({
    fault_id: code, title: r.title, crew: r.minimum_crew, materials: f.resources_required,
    reward_tier: r.reward_tier, severity_level: r.severity_level,
    external_information_dependencies: r.external_information_dependencies,
    difficulty_score: r.difficulty_score, reward_target_rvu: r.reward_target_rvu,
    allowed_reward_rvu: r.allowed_reward_rvu, case_profile: r.case_profile,
    max_resource_units_in_single_reward: r.max_resource_units_in_single_reward,
  });
  const { repair_type, reward_tier, ...rest } = r;
  balance[code] = rest;
}
const nextFixture = {
  ...fixture,
  binder_fault_matrix: matrix,
  fault_case_balance_model: { ...fixture.fault_case_balance_model, per_fault_balance: balance },
};

const render = (obj) => JSON.stringify(obj, null, 2) + '\n';
const outputs = [[POOLS_PATH, render(nextPools)], [FIXTURE_PATH, render(nextFixture)]];
let stale = 0;
for (const [p, text] of outputs) {
  const current = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  if (current === text) { console.log(`  unchanged ${path.relative(ROOT, p)}`); continue; }
  stale += 1;
  if (CHECK) { console.log(`  STALE     ${path.relative(ROOT, p)}`); continue; }
  fs.writeFileSync(p, text);
  console.log(`  wrote     ${path.relative(ROOT, p)}`);
}
const tiers = Object.values(ordered).reduce((acc, r) => { acc[r.reward_tier] = (acc[r.reward_tier] || 0) + 1; return acc; }, {});
console.log(`✓ ${Object.keys(ordered).length} fault case records (tiers ${JSON.stringify(tiers)})`);
if (CHECK && stale) process.exit(1);
