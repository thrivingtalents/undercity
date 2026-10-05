'use strict';
/**
 * B&W KIT (2026-10-05). The print palette has two modes. Colour is what the
 * kit always printed; `--mono` prints the same documents for a monochrome
 * laser printer, into "B&W Kit" with a _BW suffix. These tests hold the
 * palette to that, and hold the generators to using it.
 *
 *   BW-001  the mono palette is black, white and neutral grey only
 *   BW-002  --mono is taken off argv, so positional arguments keep their places
 *   BW-003  output names gain _BW, in mono only
 *   BW-004  a resource glyph becomes its own run in mono, in a monochrome font
 *   BW-005  every generator asks the palette, and no colour literal is left for mono to miss
 *   BW-006  the B&W Kit, when built, holds every document of the colour kit and nothing else
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const palette = require(path.join(ROOT, 'tools', 'kit', 'palette.js'));

const grey = (hex) => hex[0] === hex[2] && hex[2] === hex[4] && hex[1] === hex[3] && hex[3] === hex[5];

test('BW-001: the mono palette is black, white and neutral grey only', () => {
  const P = palette.from(['--mono']);
  assert.equal(P.mono, true);
  for (const k of ['INK', 'MUTED', 'RULE', 'DASH', 'WARN', 'AMBER', 'GREEN', 'NAVY', 'LORE', 'WHITE']) assert.ok(grey(P[k]), `${k} = ${P[k]} is not grey`);
  for (const [k, v] of Object.entries(P.fill)) assert.ok(grey(v), `fill.${k} = ${v} is not grey`);
  for (const hex of ['E8B33A', '3A8FE8', 'E85A5A', '7A7A7A', '5AB86A', 'B07AD8']) {
    assert.equal(P.sector(hex), '000000');
    for (const amount of [0.85, 0.8, 0.78, 0.5]) assert.ok(grey(P.tint(hex, amount)), 'a tint is not grey');
  }
  const c = P.callout('E8F5E8', '2E7D32');
  assert.ok(grey(c.fill) && grey(c.edge) && grey(c.label));
  // rules and dashes are medium grey, so a photocopy keeps them
  assert.ok(parseInt(P.RULE.slice(0, 2), 16) <= 0x90 && parseInt(P.DASH.slice(0, 2), 16) <= 0x90);
});

test('BW-002: --mono is taken off argv, so positional arguments keep their places', () => {
  const argv = ['node', 'build_cards.js', 'content/faults.json', 'B&W Kit', '--mono'];
  const P = palette.from(argv);
  assert.equal(P.mono, true);
  assert.deepEqual(argv, ['node', 'build_cards.js', 'content/faults.json', 'B&W Kit']);
  const C = palette.from(['node', 'x.js', 'kit']);
  assert.equal(C.mono, false);
  assert.equal(C.sector('E8B33A'), 'E8B33A');
});

test('BW-003: output names gain _BW, in mono only', () => {
  assert.equal(palette.from(['--mono']).out('UNDERCITY_Binder_POW.docx'), 'UNDERCITY_Binder_POW_BW.docx');
  assert.equal(palette.from([]).out('UNDERCITY_Binder_POW.docx'), 'UNDERCITY_Binder_POW.docx');
});

test('BW-004: a resource glyph becomes its own run in mono, in a monochrome font', () => {
  const P = palette.from(['--mono']);
  assert.equal(P.glyphFont, 'Segoe UI Symbol');
  assert.deepEqual(P.splitGlyphs('2 ⚡ Power + 1 💧 Water'), [
    { text: '2 ', glyph: false }, { text: '⚡', glyph: true }, { text: ' Power + 1 ', glyph: false }, { text: '💧', glyph: true }, { text: ' Water', glyph: false },
  ]);
  for (const g of ['⚡', '💧', '🔧', '⚕', '👤', '⚠', '🎙']) assert.deepEqual(P.splitGlyphs(g), [{ text: g, glyph: true }]);
  const C = palette.from([]);
  assert.equal(C.glyphFont, null);
  assert.deepEqual(C.splitGlyphs('2 ⚡ Power'), [{ text: '2 ⚡ Power', glyph: false }]);
});

test('BW-005: every generator asks the palette, and no colour literal is left for mono to miss', () => {
  for (const f of ['build_binders.js', 'build_cards.js', 'build_kit.js', 'build_guidebook.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'tools', 'kit', f), 'utf8');
    assert.ok(/require\("\.\/palette"\)\.from\(process\.argv\)/.test(src), `${f} does not ask the palette`);
    // a hex literal still in the source must be a grey, white, or a sector colour the palette maps
    const sectorHex = new Set(['E8B33A', '3A8FE8', 'E85A5A', '7A7A7A', '9A9A9A', '5AB86A', 'B07AD8']);
    // callout fills and edges, and the answer key's flag: literals the palette maps through P.callout / P.mono
    const CALLOUT_LITERALS = new Set(['FFF4E5', 'E8A33A', 'E8F5E8', 'E8E8F5', 'FFE8E8', 'FFF2CC', '2E7D32']);
    const literals = [...src.matchAll(/"([0-9A-F]{6})"/g)].map((m) => m[1]);
    const stray = literals.filter((h) => !grey(h) && !sectorHex.has(h) && !CALLOUT_LITERALS.has(h));
    assert.deepEqual(stray, [], `${f} still carries colour literals the palette does not own: ${stray.join(', ')}`);
  }
  // the guidebook's own callout colours and the answer key's flag only reach the page through the palette
  const guide = fs.readFileSync(path.join(ROOT, 'tools', 'kit', 'build_guidebook.js'), 'utf8');
  assert.ok(/P\.callout\(fill, edge\)/.test(guide));
  const cards = fs.readFileSync(path.join(ROOT, 'tools', 'kit', 'build_cards.js'), 'utf8');
  assert.ok(/P\.mono \? "E6E6E6" : "FFF2CC"/.test(cards));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(/--mono/.test(pkg.scripts['kit:bw']) && /B&W Kit/.test(pkg.scripts['kit:bw']));
  assert.ok(/kit:bw/.test(pkg.scripts.kit), 'npm run kit does not build the B&W Kit');
});

test('BW-006: the B&W Kit, when built, holds every document of the colour kit and nothing else', (t) => {
  const bw = path.join(ROOT, 'B&W Kit');
  if (!fs.existsSync(bw)) { t.skip('B&W Kit not built; npm run kit:bw'); return; }
  const colour = fs.readdirSync(path.join(ROOT, 'kit')).filter((f) => f.endsWith('.docx') && !f.startsWith('~$'));
  const mono = fs.readdirSync(bw).filter((f) => f.endsWith('.docx') && !f.startsWith('~$'));
  assert.deepEqual(mono.sort(), colour.map((f) => f.replace(/\.docx$/, '_BW.docx')).sort());
  assert.ok(fs.existsSync(path.join(ROOT, 'tools', 'kit', 'check_mono.py')));
});
