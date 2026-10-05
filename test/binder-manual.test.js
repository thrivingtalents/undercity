'use strict';
/**
 * ZERO-BRIEFING BINDERS (2026-10-05).
 *
 * The participant operating manual at the front of every sector binder is
 * built by tools/kit/binder_manual.js from the scenario the kit is built for,
 * the engine's own modules and roles.json. These tests hold it to the brief:
 *
 *   ZB-001  the shared sections are the same words in all six binders
 *   ZB-002  every number the manual prints is the scenario's number
 *   ZB-003  nothing facilitator-only leaks: no code, no value, no probe
 *   ZB-004  nothing waits for a trainer to speak
 *   ZB-005  the console's own words are the manual's words
 *   ZB-006  every question on the participant knowledge checklist has a home
 *   ZB-007  the twelve sections the brief asked for exist, in order, plus 9A for TRN
 *   ZB-008  the page plan is arithmetic and the cover can print it
 *   ZB-009  the role cards and the binder print the same four roles
 *   ZB-010  the reference half is still the assembler's, reworded to the console
 *   ZB-011  the kit manifest sends every binder to its station and nothing else moves
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const manual = require(path.join(ROOT, 'tools', 'kit', 'binder_manual.js'));
const scenario = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'scenarios', 'haven9-standard.json'), 'utf8'));
const faultsAll = [
  ...JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'faults.json'), 'utf8')).faults,
  ...JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'faults.reference-chain.json'), 'utf8')).faults,
  ...JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'faults.late-shift.json'), 'utf8')).faults,
];
const specs = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'specs.json'), 'utf8'));
const SECTOR_HTML = fs.readFileSync(path.join(ROOT, 'public', 'sector', 'index.html'), 'utf8');
const SECTOR_JS = fs.readFileSync(path.join(ROOT, 'public', 'sector', 'sector.js'), 'utf8')
  + fs.readFileSync(path.join(ROOT, 'lib', 'visibility.js'), 'utf8')
  + fs.readFileSync(path.join(ROOT, 'lib', 'economy.js'), 'utf8');   // the strings the server composes for the console
const ASSEMBLER = fs.readFileSync(path.join(ROOT, 'tools', 'kit', 'assemble_binders.py'), 'utf8');
const RENDERER = fs.readFileSync(path.join(ROOT, 'tools', 'kit', 'build_binders.js'), 'utf8');
const KIT_JS = fs.readFileSync(path.join(ROOT, 'tools', 'kit', 'build_kit.js'), 'utf8');
const MANIFEST_JS = fs.readFileSync(path.join(ROOT, 'tools', 'kit', 'manifest.js'), 'utf8');

const SECTORS = {
  POW: 'Power Grid', WTR: 'Water & Filtration', MED: 'Medical Bay',
  TRN: 'Transport & Tunnels', AGR: 'Agriculture', COM: 'Comms & Sensors',
};
const binders = Object.entries(SECTORS).map(([code, name]) => ({ code, name, colour: '000000' }));

/** Every string a section carries, filled for its binder (or raw, unfilled), in reading order. */
function textOf(section, b, { raw = false } = {}) {
  const out = [];
  const push = (s) => { if (typeof s === 'string') out.push(raw ? s : manual.fill(s, b)); };
  push(section.title);
  for (const blk of section.blocks) {
    push(blk.text); push(blk.title);
    for (const x of blk.items || []) push(x);
    for (const x of blk.lines || []) push(x);
    for (const x of blk.steps || []) push(x);
    for (const r of blk.rows || []) for (const c of r) push(c);
    for (const h of blk.head || []) push(h);
    if (blk.sample) for (const v of Object.values(blk.sample)) push(v);
    if (blk.t === 'cards') for (const r of blk.items) { push(r.title); push(r.tagline); for (const l of [...r.do, ...r.dont, ...r.when]) push(l); }
  }
  return out.join('\n');
}
function manualText(b) {
  const m = manual.manualFor(b);
  return [m.front, ...m.sections, m.back].map((s) => textOf(s, b)).join('\n');
}
const TEXT = Object.fromEntries(binders.map((b) => [b.code, manualText(b)]));
const ALL = Object.values(TEXT).join('\n');

// -- ZB-001 ---------------------------------------------------------------------------------------

test('ZB-001: the shared sections read identically in all six binders once the sector name is masked', () => {
  const shared = ['start', 'roles', 'shift', 'fault', 'resources', 'trade', 'council', 'quick-front', 'quick-back'];
  const ref = manual.manualFor(binders[0]);
  for (const b of binders.slice(1)) {
    const m = manual.manualFor(b);
    for (const id of shared) {
      const a = [ref.front, ...ref.sections, ref.back].find((s) => s.id === id);
      const z = [m.front, ...m.sections, m.back].find((s) => s.id === id);
      assert.ok(a && z, `${id} exists in both`);
      let ta = textOf(a, binders[0], { raw: true });
      let tz = textOf(z, b, { raw: true });
      // the two sections that carry one sector-specific line each: the production step and the idle checklist's own-panel line
      if (id === 'start' || id === 'council') {
        const strip = (t) => t.split('\n').filter((l) => !/Read the production block|Review your own panel/.test(l)).join('\n');
        ta = strip(ta); tz = strip(tz);
      }
      if (id === 'quick-front' || id === 'quick-back') {
        const strip = (t) => t.split('\n').filter((l) => !/A LIAISON HANDS YOU A SIGNED CHIT|Find the transfer in TRANSFER APPROVALS|^§9A$/.test(l)).join('\n');
        ta = strip(ta); tz = strip(tz);
      }
      assert.equal(tz, ta, `${b.code} §${id} differs from POW`);
    }
  }
});

// -- ZB-002 ---------------------------------------------------------------------------------------

test('ZB-002: every number the manual prints is the scenario\'s number', () => {
  const d = scenario.defaults;
  const r = manual.RULES;
  assert.deepEqual(r.upkeep, scenario.sectors.POW.upkeep);
  assert.equal(r.lockout_after, d.lockout_after_consecutive_invalid);
  assert.equal(r.lockout_s, d.lockout_s);
  assert.equal(r.upkeep_penalty, d.upkeep_shortfall_health_penalty);
  assert.equal(r.critical_below, d.critical_below);
  assert.equal(r.trn_approvals, d.trn_approval_limit);
  assert.equal(r.med_heals, d.med_healing_limit);
  assert.equal(r.restart.health_after, d.emergency_restart.health_after);
  assert.deepEqual(r.restart.cost, d.emergency_restart.cost);
  assert.equal(r.generator.start_level, d.generator_upgrades.start_level);
  const t = TEXT.POW;
  assert.match(t, new RegExp(`${d.lockout_after_consecutive_invalid} wrong codes in a row`, 'i'));
  assert.match(t, new RegExp(`${d.lockout_s} seconds`));
  assert.match(t, new RegExp(`lose ${d.upkeep_shortfall_health_penalty} Health`));
  assert.match(t, new RegExp(`${scenario.sectors.POW.upkeep.power} ⚡ Power \\+ ${scenario.sectors.POW.upkeep.water} 💧 Water`));
  assert.match(t, new RegExp(`Health below ${d.critical_below}`));
  assert.match(t, new RegExp(`${d.trn_approval_limit} approvals a round`));
  assert.match(t, new RegExp(`at most ${d.med_healing_limit} workers a round`));
  assert.match(t, new RegExp(`${d.emergency_restart.cost.parts} 🔧 Parts \\+ ${d.emergency_restart.cost.power} ⚡ Power \\+ ${d.emergency_restart.cost.water} 💧 Water`));
  assert.match(t, new RegExp(`return at ${d.emergency_restart.health_after} Health`));
  assert.match(t, /Round 0 to Round 7/);
  // the generator table prints every level the scenario defines, with its output
  for (const l of d.generator_upgrades.levels) assert.match(t, new RegExp(`L${l.level} ${l.name}`));
  // the AGR deck table prints every enabled card and none of the benched ones
  for (const c of r.agr.cards) assert.ok(TEXT.AGR.includes(c.title), `AGR deck lacks ${c.title}`);
  assert.ok(!TEXT.AGR.includes('WORKFORCE RECOVERY'), 'a benched card is printed');
  // the tokens come from lib/rewards.js
  for (const tok of Object.values(r.tokens)) assert.ok(t.includes(tok.label) && t.includes(tok.effect), `token ${tok.label}`);
});

// -- ZB-003 ---------------------------------------------------------------------------------------

test('ZB-003: nothing facilitator-only leaks into the manual', () => {
  // no resolution code, no spec value as a three-digit figure next to a table name
  for (const f of faultsAll) for (const code of f.valid_codes || []) assert.ok(!ALL.includes(code), `code ${code} printed`);
  for (const s of specs.specs || Object.values(specs)) {
    if (!s || typeof s !== 'object' || !s.row_label) continue;
    assert.ok(!ALL.includes(`${s.row_label} ${s.value}`), `${s.row_label} value printed`);
  }
  for (const bad of ['290', 'discrepanc', 'false alarm', 'Appendix C', 'answer key', 'Answer Key', 'psycholog', 'observation', 'probe',
    'runbook', 'inject', 'debrief', 'F-20', 'F-30', 'F-40', 'F-50', 'F-60', 'wave', 'tutorial']) {
    assert.ok(!ALL.includes(bad), `manual mentions "${bad}"`);
  }
  // the only F-codes allowed are the format placeholder
  assert.deepEqual([...new Set(ALL.match(/F-\d{3}/g) || [])], []);
});

// -- ZB-004 ---------------------------------------------------------------------------------------

test('ZB-004: nothing in the manual waits for a trainer, and the console no longer does either', () => {
  for (const bad of ['facilitator', 'Facilitator', 'Game Master', 'game master', 'trainer', 'briefing will', 'wait for instructions',
    'as explained', 'will explain', 'will tell you', 'ask the control', 'Ask the control']) {
    const hits = ALL.split('\n').filter((l) => l.includes(bad) && !/technical failure/.test(l));
    assert.deepEqual(hits, [], `manual depends on a trainer: "${bad}"`);
  }
  assert.match(ALL, /No briefing is coming/i);
  assert.ok(RENDERER.includes('NO BRIEFING IS COMING'), 'the cover box is gone');
  assert.ok(!SECTOR_JS.includes('ASK THE FACILITATOR'), 'the console still sends a table to the facilitator');
  assert.ok(!SECTOR_HTML.includes('Await instructions'), 'the DARK overlay still waits for instructions');
  const wall = fs.readFileSync(path.join(ROOT, 'public', 'wall', 'index.html'), 'utf8');
  assert.ok(!wall.includes('AWAIT FACILITATOR'));
});

// -- ZB-005 ---------------------------------------------------------------------------------------

test('ZB-005: the manual uses the console\'s own labels, and never a word the console does not use', () => {
  const labels = ['NEXT UPKEEP', 'ACTIVE FAULTS', 'RESOURCE EXCHANGE', 'SUBMIT REPAIR', 'REQUEST MED HEALING', 'INVENTORY',
    'TACTICAL OPPORTUNITIES', 'REPAIR READINESS', 'ROUND OUTPUT', 'EMERGENCY RESTART', 'GENERATE', 'HEALING THIS ROUND',
    'INTERVENTIONS THIS ROUND', 'TRANSFER APPROVALS', 'CONFIRM CHIT', 'CITY BIG SCREEN CONTROL', 'RECENTLY RESOLVED', 'ACTIVE EFFECTS',
    'NEW REQUEST', 'SEND REQUEST', 'FULFILL', 'WITHDRAW', 'UPKEEP PAID', 'UPKEEP SHORTFALL', 'COUNCIL TIME EXPIRED',
    'RESOLUTION REJECTED', 'INSUFFICIENT CREW', 'MATERIALS NOT READY', 'CONSOLE LOCKED', 'NO MATCHING PROCEDURE', 'SIMULATION PAUSED',
    'SECTOR OFFLINE', 'CITY ANNOUNCEMENT UPDATED', 'COUNCIL IN SESSION'];
  for (const l of labels) {
    assert.ok(ALL.includes(l), `manual never says ${l}`);
    assert.ok(SECTOR_HTML.includes(l) || SECTOR_JS.includes(l), `console never says ${l}`);
  }
  // Health is the word; Integrity is the engine's field, not a thing a participant reads
  assert.ok(!/Integrity/.test(ALL), 'the manual says Integrity where the console says Health');
  assert.ok(!/INTEGRITY/.test(ALL));
  // Rounds, never cycles or waves
  assert.ok(!/\bcycle\b/i.test(ALL.replace(/The cycle, every round/g, '')));
});

// -- ZB-006 ---------------------------------------------------------------------------------------

test('ZB-006: every question on the participant knowledge checklist is answered somewhere a reader can find', () => {
  const t = TEXT.MED;
  const answers = [
    [/HAVEN-9 survives three hundred metres underground/, 'What is HAVEN-9?'],
    [/Your objective/, 'What are we trying to achieve?'],
    [/MED OPERATES/, 'What is our sector responsible for?'],
    [/MED SUPPLIES OR CONTROLS/, 'What does our sector produce or control?'],
    [/UPKEEP, EVERY ROUND/, 'What does our sector consume?'],
    [/OPENING STOCK/, 'What is our opening inventory?'],
    [/STARTING WORKFORCE/, 'How many workers do we have?'],
    [/SECTOR CHIEF[\s\S]*LIAISON[\s\S]*SYSTEMS LEAD[\s\S]*ENGINEER/, 'What does each role do?'],
    [/only member of this station permitted to leave/, 'Who may leave the sector?'],
    [/Negotiate every trade/, 'Who may negotiate?'],
    [/You hold the binder and you work the console/, 'Who handles the binder? Who enters codes?'],
    [/Sector Chief and the Liaison go to the central Council table/, 'Who goes to Council?'],
    [/Rounds and the round clock/, 'What is a round?'],
    [/What is upkeep\?/, 'What is upkeep?'],
    [/When is it taken\?/, 'When is upkeep due?'],
    [/NEW ROUND — CHECK THESE NOW/, 'What happens at the next upkeep?'],
    [/How do we prepare\?/, 'What should we do before upkeep?'],
    [/Health\n0 to 100 with a bar/, 'What is Integrity?'],
    [/CRITICAL\nHealth below 30/, 'What is CRITICAL?'],
    [/DARK\nHealth 0/, 'What is DARK?'],
    [/A fault bleeds Health at the rate on its card/, 'What is a fault?'],
    [/WHEN A FAULT APPEARS/, 'How do we resolve a fault?'],
    [/\*\*CREW\*\*: the minimum workers/, 'What do CREW and MATERIALS mean?'],
    [/each step names a table and a row/, 'How do we find specification values?'],
    [/the Liaison goes to the sector named, asks for the exact row by name/, 'What if another sector owns the information we need?'],
    [/HOW TO TRADE WITH ANOTHER SECTOR/, 'How do we trade resources?'],
    [/Signed by both Liaisons and stamped by TRN/, 'What makes a Transfer Chit valid?'],
    [/TRN has 3 approvals a round and may DECLINE/, 'What is TRN\'s role in a transfer?'],
    [/Some faults injure workers the moment they appear/, 'How do workers become injured?'],
    [/MED presses \*\*HEAL\*\*/, 'How are injured workers restored?'],
    [/Re-verify the row name and the sector/, 'What should we do if a code is rejected?'],
    [/lock the console for \*\*20 seconds\*\*/, 'What happens after three wrong code attempts?'],
    [/WHEN COUNCIL IS CALLED/, 'What do we do when Council is called?'],
    [/NO ACTIVE FAULT\? DO THIS/, 'What do we do when we have no active fault?'],
    [/STATION OPERATIONS LOG|Station Operations Log/, 'Where do we record our important decisions?'],
    [/WHEN THIS HAPPENS → DO THIS/, 'Where should we look first if confused?'],
  ];
  for (const [re, q] of answers) assert.match(t, re, `unanswered: ${q}`);
});

// -- ZB-007 ---------------------------------------------------------------------------------------

test('ZB-007: the twelve sections the brief asked for, in order, plus 9A for Transport alone', () => {
  for (const b of binders) {
    const m = manual.manualFor(b);
    const nums = m.sections.map((s) => s.num);
    const expect = b.code === 'TRN' ? [1, 2, 3, 4, 5, 6, 7, 8, 9, '9A', 10] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.deepEqual(nums, expect, `${b.code} sections`);
    assert.equal(m.sections[m.sections.length - 1].second.num, 11, 'section 11 shares the Council page');
    assert.equal(m.front.title, 'WHEN THIS HAPPENS → DO THIS');
    assert.equal(m.back.title, m.front.title, 'the quick reference is printed front and back');
    // the sector-only block exists for every sector and names its own panel
    const own = { POW: 'ROUND OUTPUT', WTR: 'ROUND OUTPUT', MED: 'HEALING THIS ROUND', TRN: 'TRANSFER APPROVALS', AGR: 'INTERVENTIONS THIS ROUND', COM: 'CITY BIG SCREEN CONTROL' }[b.code];
    assert.ok(TEXT[b.code].includes('THIS SECTOR ONLY'), `${b.code} has no THIS SECTOR ONLY block`);
    assert.ok(TEXT[b.code].includes(own), `${b.code}'s own panel ${own} is not explained`);
  }
  assert.ok(TEXT.AGR.includes('Your intervention deck'));
  assert.ok(!TEXT.POW.includes('Your intervention deck'));
  assert.ok(TEXT.COM.includes('City Charter'), 'COM is not told it holds the Charter');
});

// -- ZB-008 ---------------------------------------------------------------------------------------

test('ZB-008: the page plan is arithmetic from declared pages, and every section breaks no more than it declares', () => {
  for (const b of binders) {
    const m = manual.manualFor(b);
    for (const s of [m.front, ...m.sections, m.back]) {
      const breaks = s.blocks.filter((x) => x.t === 'break').length;
      assert.ok(breaks + 1 <= s.pages, `${b.code} §${s.num} breaks ${breaks + 1} times over ${s.pages} declared pages`);
    }
    const plan = manual.pagePlan(m, [{ id: 'index', num: 12, title: 'x', pages: 1 }, { id: 'log', num: 15, title: 'y', pages: 1 }]);
    assert.equal(plan[0].page, 3, 'the manual starts on page 3, after the cover and the quick reference');
    let cursor = 3;
    for (const entry of plan) {
      if (entry.pages === 0) { assert.equal(entry.page, cursor - plan.find((e) => e.id === entry.id.replace(/-2$/, '')).pages, `${b.code} ${entry.id} shares its page`); continue; }
      assert.equal(entry.page, cursor, `${b.code} ${entry.id} page`);
      cursor += entry.pages;
    }
  }
  // the renderer refuses a section that breaks more than it declares, and writes the plan for the Word check
  assert.ok(/breaks \$\{breaks \+ 1\} times/.test(RENDERER));
  assert.ok(/binder_pages\.json/.test(RENDERER));
  assert.ok(fs.existsSync(path.join(ROOT, 'tools', 'kit', 'check_binder_pages.py')));
});

// -- ZB-009 ---------------------------------------------------------------------------------------

test('ZB-009: the role cards and section 3 print the same four roles from roles.json', () => {
  assert.ok(/roles\.json/.test(KIT_JS), 'build_kit.js no longer reads roles.json');
  assert.deepEqual(manual.ROLES.map((r) => r.title), ['SECTOR CHIEF', 'LIAISON', 'SYSTEMS LEAD', 'ENGINEER']);
  for (const r of manual.ROLES) {
    assert.ok(r.do.length >= 3 && r.dont.length >= 1 && r.when.length >= 1, `${r.title} is not a full card`);
    for (const l of [...r.do, ...r.dont, ...r.when]) assert.ok(!/facilitator|game master/i.test(l), `${r.title} waits for a trainer`);
  }
  assert.ok(TEXT.POW.includes('You are the only member of this station permitted to leave it.'));
});

// -- ZB-010 ---------------------------------------------------------------------------------------

test('ZB-010: the reference half is the assembler\'s, sent to the console instead of a card', () => {
  assert.ok(ASSEMBLER.includes('Confirm the fault code on your console matches'), 'procedures still confirm a card');
  assert.ok(!ASSEMBLER.includes('alert card'), 'the assembler still speaks of an alert card');
  assert.ok(ASSEMBLER.includes("Binder, Table"), 'another sector\'s table is in its Binder, by that name');
  assert.ok(!ASSEMBLER.includes('Manual, Table'));
  assert.ok(!ASSEMBLER.includes('"mission"') && !ASSEMBLER.includes('"produces"'), 'the assembler still writes editorial sector text');
  for (const title of ['12 ·', '13 ·', '14 ·', '15 ·']) assert.ok(!RENDERER.includes(`"${title}`), 'old numbered title style');
  assert.ok(/sectionHead\(12, manual\.TITLES\[12\]/.test(RENDERER));
  assert.ok(/14A · CROSS-SYSTEM REFERENCE DIRECTORY/.test(RENDERER) || /sectionHead\("14A"/.test(RENDERER));
  assert.ok(/APPENDIX C · NON-ROUTINE AUTHORISATIONS/.test(RENDERER), 'Appendix C is still printed');
  assert.ok(!/Appendix C/.test(ALL), 'the manual points at Appendix C');
});

// -- ZB-012 ---------------------------------------------------------------------------------------

test('ZB-012: a DARK console still offers the restart the binder tells it to press', () => {
  // the SECTOR OFFLINE curtain swallows no clicks, and the EMERGENCY SHUTDOWN panel rises above it
  const css = fs.readFileSync(path.join(ROOT, 'public', 'sector', 'sector.css'), 'utf8');
  assert.match(css, /\.dark-overlay \{[^}]*pointer-events: none/, 'the offline curtain still eats clicks');
  assert.match(css, /body\.is-dark #restart-panel \{[^}]*z-index: 5[1-9]/, 'the restart panel is not lifted above the curtain');
  assert.ok(!/body\.is-dark \.columns, body\.is-dark \.exchange \{/.test(css), 'the whole column is still greyed as one stacking context');
  assert.ok(TEXT.POW.includes('above the SECTOR OFFLINE screen'));
});

// -- ZB-011 ---------------------------------------------------------------------------------------

test('ZB-011: the manifest sends every binder to its station; the answer key and the guidebook stay at the desk', () => {
  const only = /const FACILITATOR_ONLY = new Set\(\[([\s\S]*?)\]\);/.exec(MANIFEST_JS)[1];
  const names = [...only.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(names.sort(), ['UNDERCITY_AnswerKey.docx', 'UNDERCITY_Facilitator_Guidebook.docx']);
});
