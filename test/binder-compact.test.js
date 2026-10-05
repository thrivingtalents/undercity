'use strict';
/**
 * NINE-PAGE BINDERS (2026-10-05).
 *
 * Every sector binder is nine pages built by tools/kit/binder_compact.js from
 * the scenario (binder_rules.js), the engine's own modules and the assembler's
 * binder_content.json. These tests hold the binder to the brief:
 *
 *   ZB-001  nine pages, in the brief's order, page 3 named for the sector
 *   ZB-002  every fault card matches the content the server runs, exactly
 *   ZB-003  every value, reference and authorisation on page 9 is the sector's own, unchanged
 *   ZB-004  every number the pages print is the scenario's number
 *   ZB-005  the BROWNOUT column is what the engine yields, by execution
 *   ZB-006  nothing facilitator-only leaks: no code, no value, no probe, no future list
 *   ZB-007  nothing waits for a trainer, and the console no longer does either
 *   ZB-008  the console's own words, and never Integrity for Health
 *   ZB-009  the shared pages are the same words in all six binders
 *   ZB-010  the kit: log sheets separate, binders participant-facing, renderer compact-only
 *   ZB-011  the role cards and page 1 agree on the four roles
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const compact = require(path.join(ROOT, 'tools', 'kit', 'binder_compact.js'));
const rules = require(path.join(ROOT, 'tools', 'kit', 'binder_rules.js'));
const economy = require(path.join(ROOT, 'lib', 'economy.js'));
const { newGame } = require('./helpers');
const scenario = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'scenarios', 'haven9-standard.json'), 'utf8'));
const faultsAll = [
  ...JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'faults.json'), 'utf8')).faults,
  ...JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'faults.reference-chain.json'), 'utf8')).faults,
  ...JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'faults.late-shift.json'), 'utf8')).faults,
];
const specs = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'specs.json'), 'utf8')).specs;
const chain = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'faults.reference-chain.json'), 'utf8'));
const SECTOR_HTML = fs.readFileSync(path.join(ROOT, 'public', 'sector', 'index.html'), 'utf8');
const SECTOR_JS = fs.readFileSync(path.join(ROOT, 'public', 'sector', 'sector.js'), 'utf8')
  + fs.readFileSync(path.join(ROOT, 'lib', 'visibility.js'), 'utf8')
  + fs.readFileSync(path.join(ROOT, 'lib', 'economy.js'), 'utf8');
const RENDERER = fs.readFileSync(path.join(ROOT, 'tools', 'kit', 'build_binders.js'), 'utf8');
const KIT_JS = fs.readFileSync(path.join(ROOT, 'tools', 'kit', 'build_kit.js'), 'utf8');
const MANIFEST_JS = fs.readFileSync(path.join(ROOT, 'tools', 'kit', 'manifest.js'), 'utf8');

// The assembler's output is the binder's reference half. The kit build writes
// it to build/; the test fixture is whatever the last build left there, so
// a checkout that never built the kit skips the data tests rather than lying.
const CONTENT_PATH = path.join(ROOT, 'build', 'binder_content.json');
const binders = fs.existsSync(CONTENT_PATH) ? JSON.parse(fs.readFileSync(CONTENT_PATH, 'utf8')).binders : null;
const SECTORS = {
  POW: 'Power Grid', WTR: 'Water & Filtration', MED: 'Medical Bay',
  TRN: 'Transport & Tunnels', AGR: 'Agriculture', COM: 'Comms & Sensors',
};
const COLOUR = { POW: 'E8B33A', WTR: '3A8FE8', MED: 'E85A5A', TRN: '9A9A9A', AGR: '5AB86A', COM: 'B07AD8' };
const binderOf = (code) => (binders ? binders[code] : null);
const RES = { parts: 'Parts', power: 'Power', water: 'Water', med: 'Med' };

/** Every string a page carries, filled for its binder (or raw), in reading order. */
function textOf(page, b, { raw = false } = {}) {
  const out = [];
  const push = (s) => { if (typeof s === 'string') out.push(raw ? s : rules.fill(s, b)); };
  push(page.title);
  for (const blk of page.blocks) {
    push(blk.text); push(blk.title); push(blk.name);
    for (const x of blk.items || []) Array.isArray(x) ? x.forEach(push) : push(x);
    for (const x of blk.lines || []) push(x);
    for (const x of blk.steps || []) push(x);
    for (const r of blk.rows || []) for (const c of r) push(c);
    for (const h of blk.head || []) push(h);
    for (const c of blk.cards || []) for (const v of Object.values(c)) push(String(v));
  }
  return out.join('\n');
}
const pagesOf = (code) => compact.compactFor(binderOf(code) || { code, name: SECTORS[code], colour: COLOUR[code], procedures: [], index_rows: [], tables: [], references: [], appendix: { row_label: '', value: '' } });
const allText = (code) => pagesOf(code).map((pg) => textOf(pg, binderOf(code) || { code, name: SECTORS[code] })).join('\n');

const needContent = (t) => { if (!binders) { t.skip('build/binder_content.json not built; run npm run kit:content'); return false; } return true; };

// -- ZB-001 ---------------------------------------------------------------------------------------

test('ZB-001: nine pages in the brief\'s order, page 3 named for the sector', (t) => {
  if (!needContent(t)) return;
  for (const code of Object.keys(SECTORS)) {
    const pages = pagesOf(code);
    assert.equal(pages.length, 9, `${code} has ${pages.length} pages`);
    assert.deepEqual(pages.map((p) => p.num), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(pages.map((p) => p.title.split(':')[0]), [
      'START HERE — YOUR SECTOR', 'RUNNING EACH ROUND', 'YOUR SECTOR CONTROL', 'WHEN A FAULT APPEARS',
      'TRADING, WORKERS & HEALING', 'QUICK ACTIONS & COUNCIL', 'FAULTS & REPAIRS — PART 1', 'FAULTS & REPAIRS — PART 2',
      'SPECIFICATIONS, REFERENCES & AUTHORISATIONS',
    ]);
    assert.ok(pages[2].title.endsWith(compact.SECTOR_PAGE_TITLE[code]), `${code} page 3 title`);
    const own = { POW: 'GENERATE POWER', WTR: 'GENERATE WATER', MED: 'HEALING THIS ROUND', TRN: 'TRANSFER CONTROL', AGR: 'INTERVENTIONS THIS ROUND', COM: 'CITY BIG SCREEN CONTROL' }[code];
    assert.ok(textOf(pages[2], binderOf(code)).includes(own), `${code} page 3 does not explain ${own}`);
  }
});

// -- ZB-002 ---------------------------------------------------------------------------------------

test('ZB-002: every fault card matches the content the server runs, exactly', (t) => {
  if (!needContent(t)) return;
  for (const code of Object.keys(SECTORS)) {
    const pages = pagesOf(code);
    const cards = [...pages[6].blocks, ...pages[7].blocks].filter((x) => x.t === 'faultcards').flatMap((x) => x.cards);
    const own = faultsAll.filter((f) => f.sector === code);
    assert.equal(cards.length, own.length, `${code}: ${cards.length} cards for ${own.length} faults`);
    assert.equal(pages[6].blocks.find((x) => x.t === 'faultcards').cards.length, 5, `${code}: page 7 carries five cards`);
    for (const f of own) {
      const c = cards.find((x) => x.code === f.code);
      assert.ok(c, `${code}: ${f.code} missing`);
      assert.equal(c.proc, f.procedure, `${f.code} procedure`);
      assert.equal(parseInt(c.crew, 10), f.crew_required, `${f.code} crew`);
      assert.equal(c.name, f.name.toUpperCase(), `${f.code} name`);
      const want = Object.entries(f.resources_required).map(([k, v]) => `${v} ${RES[k]}`).sort().join(' · ');
      const got = c.materials.replace(/[⚡💧🔧⚕]\s*/g, '').split(' + ').map((s) => s.trim()).sort().join(' · ');
      assert.equal(got, want, `${f.code} materials`);
      const n = f.reference_chain ? f.reference_chain.length : f.spec_refs.length;
      assert.equal(c.format, `${f.procedure}-[VALUE]${n === 2 ? '-[VALUE 2]' : ''}`, `${f.code} format`);
      if (f.reference_chain) {
        f.reference_chain.forEach((h, i) => assert.ok((i === 0 ? c.v1 : c.v2).includes(`ASK ${h.first_sector} → ${h.first_reference_name}`), `${f.code} chain ${i + 1}`));
      } else {
        f.spec_refs.forEach((s, i) => {
          const foreign = s.binder !== code;
          const want2 = s.buried ? `${foreign ? `${s.binder} → ` : 'YOUR '}Appendix C → ${s.row_label}` : `${foreign ? `${s.binder} → ` : 'YOUR '}Table ${s.table} → ${s.row_label}`;
          assert.equal(i === 0 ? c.v1 : c.v2, want2, `${f.code} value ${i + 1}`);
        });
        if (f.spec_refs.length === 1) assert.equal(c.v2, null, `${f.code} has a second value it should not`);
      }
      assert.equal(!!c.time_critical, !!f.time_critical, `${f.code} TIME-CRITICAL`);
    }
    // the escalate list: every code named belongs to the sector it points at
    const esc = (pages[7].blocks.find((x) => Array.isArray(x.escalate)) || {}).escalate || [];
    assert.ok(esc.length >= 1, `${code}: no escalate list`);
    for (const [c2, owner] of esc) {
      const f = faultsAll.find((x) => x.code === c2);
      assert.ok(f && f.sector === owner, `${code}: escalate ${c2} → ${owner}`);
    }
  }
});

// -- ZB-003 ---------------------------------------------------------------------------------------

test('ZB-003: page 9 prints every value, reference and authorisation of the sector, unchanged, and nobody else\'s', (t) => {
  if (!needContent(t)) return;
  for (const code of Object.keys(SECTORS)) {
    const page9 = pagesOf(code)[8].blocks.filter((x) => x.t === 'spectable');
    const printed = page9.filter((x) => x.kind !== 'reference').flatMap((x) => x.rows);
    const mine = specs.filter((s) => s.binder === code);
    for (const s of mine) assert.ok(printed.some(([l, v]) => l === s.row_label && v === String(s.value)), `${code}: ${s.spec_id} ${s.row_label}=${s.value} not printed`);
    for (const [, v] of printed) {
      const other = specs.find((s) => s.binder !== code && String(s.value) === v);
      assert.ok(!other, `${code}: prints ${v}, which belongs to ${other && other.binder}`);
    }
    const refs = page9.find((x) => x.kind === 'reference');
    const want = (chain.reference_directory[code] || []).map((r) => [r.reference_name, r.display]);
    assert.deepEqual(refs ? refs.rows : [], want, `${code} references`);
    const app = page9.find((x) => x.kind === 'authorisation');
    const buried = specs.find((s) => s.binder === code && s.buried);
    assert.deepEqual(app.rows, [[buried.row_label, String(buried.value)]], `${code} appendix`);
    const legend = pagesOf(code)[8].blocks.find((x) => x.t === 'legend');
    assert.deepEqual(legend.items.map((i) => i[0]), ['VALUE', 'REFERENCE', 'AUTHORISATION']);
  }
});

// -- ZB-004 ---------------------------------------------------------------------------------------

test('ZB-004: every number the pages print is the scenario\'s number', () => {
  const d = scenario.defaults;
  const r = rules.RULES;
  assert.deepEqual(r.upkeep, scenario.sectors.POW.upkeep);
  assert.equal(r.lockout_after, d.lockout_after_consecutive_invalid);
  assert.equal(r.lockout_s, d.lockout_s);
  assert.equal(r.upkeep_penalty, d.upkeep_shortfall_health_penalty);
  assert.equal(r.trn_approvals, d.trn_approval_limit);
  assert.equal(r.med_heals, d.med_healing_limit);
  assert.deepEqual(r.restart.cost, d.emergency_restart.cost);
  const t = allText('POW');
  assert.match(t, new RegExp(`${scenario.sectors.POW.upkeep.power} ⚡ Power \\+ ${scenario.sectors.POW.upkeep.water} 💧 Water`));
  assert.match(t, new RegExp(`lose \\*\\*${d.upkeep_shortfall_health_penalty} Health`));
  assert.match(t, new RegExp(`${d.lockout_after_consecutive_invalid} wrong codes in a row`));
  assert.match(t, new RegExp(`${d.lockout_s} seconds`));
  assert.match(t, new RegExp(`Health below ${d.critical_below}`));
  assert.match(t, new RegExp(`${d.trn_approval_limit} approvals a round`));
  assert.match(t, new RegExp(`${d.med_healing_limit} workers a round`));
  assert.match(t, new RegExp(`back at ${d.emergency_restart.health_after} Health`));
  assert.match(t, /Round 0 is set-up; play runs to Round 7/);
  for (const l of d.generator_upgrades.levels) assert.match(t, new RegExp(`L${l.level} ${l.name}`));
  for (const tok of Object.values(r.tokens)) assert.ok(t.includes(tok.label) && t.includes(tok.effect), `token ${tok.label}`);
  const agr = allText('AGR');
  for (const c of r.agr.cards) assert.ok(agr.includes(c.title), `AGR deck lacks ${c.title}`);
  assert.ok(!agr.includes('WORKFORCE RECOVERY'), 'a benched card is printed');
});

// -- ZB-005 ---------------------------------------------------------------------------------------

test('ZB-005: the BROWNOUT column is what the engine yields in brownout, level by level, by execution', () => {
  const game = newGame();
  for (const code of rules.RULES.generator.sectors) {
    const sector = game.state.sectors[code];
    const key = Object.keys(rules.RULES.production[code])[0];
    for (const level of rules.RULES.generator.levels) {
      sector.generator.level = level.level;
      game.setStatus(code, 'ACTIVE');
      const normal = economy.productionFor(game, sector)[key] || 0;
      game.setStatus(code, 'BROWNOUT');
      const brown = economy.productionFor(game, sector)[key] || 0;
      game.setStatus(code, 'ACTIVE');
      assert.equal(normal, level.output, `${code} L${level.level} normal output`);
      assert.equal(compact.brownoutOutput(code, level.output), brown, `${code} L${level.level} brownout column`);
    }
    // and the page prints exactly those figures, in the BROWNOUT column
    const tbl = pagesOf(code)[2].blocks.find((x) => x.t === 'table' && x.head[2] === 'BROWNOUT');
    for (const level of rules.RULES.generator.levels) {
      const row = tbl.rows.find((rw) => rw[0].startsWith(`L${level.level} `));
      assert.ok(row && row[2].startsWith(`${compact.brownoutOutput(code, level.output)} `), `${code} L${level.level} printed brownout`);
    }
  }
  // one sentence for brownout, identical wherever a binder mentions it
  for (const code of Object.keys(SECTORS)) {
    const b = { code, name: SECTORS[code] };
    const sentence = rules.fill(compact.brownoutRule(b), b);
    const t = allText(code);
    assert.ok(t.split(sentence).length >= 3, `${code}: the brownout rule is not printed identically on pages 2 and 3`);
    assert.ok(!/halved \(POW to a quarter\)|to a quarter/.test(t), `${code}: prose brownout arithmetic survives`);
  }
});

// -- ZB-006 ---------------------------------------------------------------------------------------

test('ZB-006: nothing facilitator-only leaks into any binder', (t) => {
  if (!needContent(t)) return;
  for (const code of Object.keys(SECTORS)) {
    const text = allText(code);
    for (const f of faultsAll) for (const vc of f.valid_codes || []) assert.ok(!text.includes(vc), `${code} prints code ${vc}`);
    for (const bad of ['290', 'discrepanc', 'false alarm', 'answer key', 'Answer Key', 'psycholog', 'observation', 'probe', 'runbook', 'inject', 'debrief', 'wave', 'tutorial', 'buried']) {
      assert.ok(!text.includes(bad), `${code} mentions "${bad}"`);
    }
    // the only fault codes on the pages are the sector's own and the ones it escalates
    const own = new Set(faultsAll.filter((f) => f.sector === code).map((f) => f.code));
    const esc = new Set(((pagesOf(code)[7].blocks.find((x) => Array.isArray(x.escalate)) || {}).escalate || []).map(([c]) => c));
    for (const m of new Set(text.match(/F-\d{3}/g) || [])) assert.ok(own.has(m) || esc.has(m), `${code} names ${m}, which is neither its own nor escalated`);
  }
});

// -- ZB-007 ---------------------------------------------------------------------------------------

test('ZB-007: nothing waits for a trainer, and the console no longer does either', (t) => {
  if (!needContent(t)) return;
  for (const code of Object.keys(SECTORS)) {
    const text = allText(code);
    for (const bad of ['facilitator', 'Facilitator', 'Game Master', 'trainer', 'briefing will', 'wait for instructions', 'as explained', 'will explain', 'will tell you', 'ask the control']) {
      const hits = text.split('\n').filter((l) => l.includes(bad) && !/technical failure/.test(l));
      assert.deepEqual(hits, [], `${code} depends on a trainer: "${bad}"`);
    }
    assert.match(text, /Nobody will brief you/);
  }
  assert.ok(!SECTOR_JS.includes('ASK THE FACILITATOR'));
  assert.ok(!SECTOR_HTML.includes('Await instructions'));
  assert.ok(!fs.readFileSync(path.join(ROOT, 'public', 'wall', 'index.html'), 'utf8').includes('AWAIT FACILITATOR'));
});

// -- ZB-008 ---------------------------------------------------------------------------------------

test('ZB-008: the console\'s own labels, and never Integrity for Health', (t) => {
  if (!needContent(t)) return;
  const text = Object.keys(SECTORS).map(allText).join('\n');
  for (const l of ['NEXT UPKEEP', 'ACTIVE FAULTS', 'RESOURCE EXCHANGE', 'SUBMIT REPAIR', 'REQUEST MED HEALING', 'INVENTORY',
    'TACTICAL OPPORTUNITIES', 'REPAIR READINESS', 'ROUND OUTPUT', 'EMERGENCY RESTART', 'GENERATE POWER', 'GENERATE WATER', 'HEALING THIS ROUND',
    'INTERVENTIONS THIS ROUND', 'TRANSFER APPROVALS', 'CONFIRM CHIT', 'CITY BIG SCREEN CONTROL', 'RECENTLY RESOLVED',
    'NEW REQUEST', 'SEND REQUEST', 'FULFILL', 'WITHDRAW', 'UPKEEP PAID', 'UPKEEP SHORTFALL', 'COUNCIL TIME EXPIRED',
    'RESOLUTION REJECTED', 'INSUFFICIENT CREW', 'MATERIALS NOT READY', 'CONSOLE LOCKED', 'NO MATCHING PROCEDURE', 'SIMULATION PAUSED',
    'SECTOR OFFLINE', 'CITY ANNOUNCEMENT UPDATED', 'COUNCIL IN SESSION']) {
    assert.ok(text.includes(l), `binders never say ${l}`);
    // the console composes GENERATE POWER / GENERATE WATER from one template
    const onConsole = /^GENERATE (POWER|WATER)$/.test(l) ? SECTOR_JS.includes('`GENERATE ${resName}`') : SECTOR_HTML.includes(l) || SECTOR_JS.includes(l);
    assert.ok(onConsole, `console never says ${l}`);
  }
  assert.ok(!/Integrity|INTEGRITY/.test(text), 'a binder says Integrity where the console says Health');
  // the operating pages never say cycle; a matrix table may be named one (AGR's Grow-lamp Cycle Codes)
  const operating = Object.keys(SECTORS).map((code) => pagesOf(code).slice(0, 6).map((pg) => textOf(pg, binderOf(code))).join('\n')).join('\n');
  assert.ok(!/\bcycle\b/i.test(operating));
  // the three corrections of 2026-10-05, verbatim
  assert.ok(text.includes('make sure NEXT UPKEEP reads READY. Separately, keep enough resources for any open repairs.'));
  assert.ok(text.includes('Stop entering codes. Log it, tell COM, then work the faults you can repair.'));
  assert.ok(text.includes('At 00:00, unresolved matters remain unresolved'));
});

// -- ZB-009 ---------------------------------------------------------------------------------------

test('ZB-009: the shared pages read identically in all six binders', (t) => {
  if (!needContent(t)) return;
  const raw = (code, i) => textOf(pagesOf(code)[i], binderOf(code), { raw: true });
  for (const code of Object.keys(SECTORS).slice(1)) {
    for (const i of [3, 4]) assert.equal(raw(code, i), raw('POW', i), `${code} page ${i + 1} differs from POW`);
    // page 2 differs in one refresh line and the brownout sentence; page 6 in the own-panel line
    const strip2 = (s) => s.split('\n').filter((l) => !/\*\*4 Refresh\*\*|\*\*2 Production|^Imposed by the Authority/.test(l)).join('\n');
    assert.equal(strip2(raw(code, 1)), strip2(raw('POW', 1)), `${code} page 2 differs from POW beyond its own lines`);
    const strip6 = (s) => s.split('\n').filter((l) => !/^CHECK NEXT UPKEEP, open requests/.test(l)).join('\n');
    assert.equal(strip6(raw(code, 5)), strip6(raw('POW', 5)), `${code} page 6 differs from POW beyond its own line`);
  }
});

// -- ZB-010 ---------------------------------------------------------------------------------------

test('ZB-010: the kit — log sheets are separate, binders go to their stations, the renderer is the nine-page one', () => {
  assert.ok(/UNDERCITY_StationLog\.docx/.test(RENDERER), 'the renderer no longer writes the loose log sheets');
  assert.ok(!/coverPage|function indexPages|function procedurePages|Station Operations Log",? /.test(RENDERER.replace(/STATION OPERATIONS LOG/g, '')), 'the long layout survives in the renderer');
  assert.ok(!fs.existsSync(path.join(ROOT, 'tools', 'kit', 'binder_manual.js')), 'binder_manual.js should be gone');
  const only = /const FACILITATOR_ONLY = new Set\(\[([\s\S]*?)\]\);/.exec(MANIFEST_JS)[1];
  assert.deepEqual([...only.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(), ['UNDERCITY_AnswerKey.docx', 'UNDERCITY_Facilitator_Guidebook.docx']);
  assert.ok(/UNDERCITY_StationLog\.docx/.test(MANIFEST_JS), 'the manifest does not know the log sheets');
  assert.ok(fs.existsSync(path.join(ROOT, 'tools', 'kit', 'check_binder_pages.py')));
  assert.ok(/binder_pages\.json/.test(RENDERER));
});

// -- ZB-011 ---------------------------------------------------------------------------------------

test('ZB-011: page 1 names the four roles the Role Cards carry, and prints none of their text', (t) => {
  if (!needContent(t)) return;
  const roles = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'kit', 'roles.json'), 'utf8')).roles;
  assert.ok(/roles\.json/.test(KIT_JS));
  const page1 = textOf(pagesOf('POW')[0], binderOf('POW'));
  for (const r of roles) {
    const label = r.title === 'ENGINEER' ? 'ENGINEERS' : r.title;
    assert.ok(page1.includes(label), `page 1 lacks ${label}`);
    for (const line of r.do) assert.ok(!page1.includes(line), 'page 1 repeats a role card');
  }
  assert.ok(page1.includes('The cards carry the duties.'));
});
