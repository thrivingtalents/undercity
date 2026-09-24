'use strict';
/**
 * COMM'S CITY BOARD — the entry area, enlarged (2026-09-25).
 *
 * A stylesheet patch. The four boxes on each sector card were 95x24 with a
 * 12px glyph beside them and 12px figures inside; under time pressure that is
 * a form you aim at rather than one you type into. They are now 130x30 with
 * 15px glyphs and 15px figures, in an area that takes 68% of the card's width
 * instead of 41%, with the two columns twice as far apart and the two rows
 * twice as far apart.
 *
 * The numbers below are the measured before-and-after, so a later change that
 * quietly shrinks the form back has to argue with them. Nothing outside this
 * stylesheet moved: the same markup, the same handler, the same payload, the
 * same reducer — and this suite re-checks that too, because a "layout-only"
 * change is only layout-only if something is watching.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { newGame } = require('./helpers');
const { forBigscreen, forSector } = require('../lib/visibility');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCRIPT = read('public/sector/sector.js');
const CSS = read('public/sector/sector.css');

/** What the board looked like before the patch, to measure the change against. */
const BEFORE = {
  glyphFont: 12, inputFont: 12, inputPadY: 3, inputPadX: 5,
  areaWidth: 240, columnGap: 10, rowGap: 5, cellGap: 4,
};

const rule = (sel) => (CSS.match(new RegExp(`\\${sel} \\{([^}]*)\\}`, 's')) || [])[1] || '';
const px = (body, prop) => {
  const m = body.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*(-?[\\d.]+)px`));
  return m ? Number(m[1]) : null;
};
/** `gap: <row> <column>` — the shorthand the board writes. */
function gaps(body) {
  const m = body.match(/gap: ([\d.]+)px ([\d.]+)px/);
  return m ? { row: Number(m[1]), column: Number(m[2]) } : {};
}
const grew = (now, was, lo, hi) => now >= was * lo && now <= was * hi;

// -- SIZE-001: the grids are the grids they were -----------------------------------------

test('RESOURCE-SIZE-001: six cards still 2 columns by 3 rows, each with a 2x2 entry grid', () => {
  const game = newGame();
  assert.equal(Object.keys(forSector(game, 'COM').broadcast.rows).length, 6);
  assert.ok(/const BOARD_CARDS = \['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'\];/.test(SCRIPT), 'the card order moved');
  assert.ok(/const BOARD_CELLS = \['power', 'water', 'parts', 'med'\];/.test(SCRIPT), 'the cell order moved');

  assert.ok(/grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(rule('.bc-rows')), 'the board is no longer 2 columns');
  assert.ok(/grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(rule('.bc-cells')), 'the entry grid is no longer 2 columns');
  // Four cells in a two-column grid is two rows; the template writes four.
  const card = SCRIPT.slice(SCRIPT.indexOf('host.innerHTML = codes.map'), SCRIPT.indexOf('for (const btn of host.querySelectorAll'));
  assert.equal((card.match(/class="bc-cell"/g) || []).length, 1, 'the cell template was duplicated instead of mapped');
  assert.ok(/BOARD_CELLS\.map/.test(card), 'the four cells are no longer one mapped template');
});

// -- SIZE-002: bigger icons, bigger boxes, bigger figures ---------------------------------

test('RESOURCE-SIZE-002: icons +25%, inputs wider and taller, figures easier to read', () => {
  const glyph = px(rule('.bc-glyph'), 'font-size');
  assert.ok(grew(glyph, BEFORE.glyphFont, 1.2, 1.3), `the icon is ${glyph}px, not 20-30% up from ${BEFORE.glyphFont}px`);

  const input = rule('.bc-cells input');
  const font = px(input, 'font-size');
  assert.ok(font > BEFORE.inputFont, `the figures are ${font}px, no larger than ${BEFORE.inputFont}px`);
  assert.ok(grew(font, BEFORE.inputFont, 1.2, 1.3), 'the figures grew by an odd amount');

  // Height comes from the vertical padding and the figure; both went up, and
  // the measured box went 24 -> 30, which is the 15-25% the patch asks for.
  const pad = input.match(/padding: ([\d.]+)px ([\d.]+)px/);
  assert.ok(pad, 'the input lost its padding');
  assert.ok(Number(pad[1]) > BEFORE.inputPadY, 'the vertical padding did not grow');
  assert.ok(Number(pad[2]) > BEFORE.inputPadX, 'the horizontal padding did not grow — the figures still feel cramped');

  // Width: a ceiling of 130 against a measured 95 before, which is +37%.
  const max = px(input, 'max-width');
  assert.ok(grew(max, 95, 1.25, 1.4), `the box tops out at ${max}px, not 25-40% up from 95px`);
  assert.ok(/width: 100%/.test(input), 'the box stopped filling its column');
  assert.ok(/tabular-nums/.test(input), 'the figures are not tabular');
});

// -- SIZE-003: room between the four -------------------------------------------------------

test('RESOURCE-SIZE-003: the area is wider, the columns and rows further apart, focus still clear', () => {
  const cells = rule('.bc-cells');
  const area = px(cells, 'max-width');
  assert.ok(area > BEFORE.areaWidth, `the entry area is ${area}px, no wider than ${BEFORE.areaWidth}px`);
  // 400 across a 585px card interior is 68% of it; it was 41%.
  assert.ok(area >= BEFORE.areaWidth * 1.5, 'the entry area barely grew');

  const g = gaps(cells);
  assert.ok(g.column > BEFORE.columnGap, `the columns are ${g.column}px apart, no more than ${BEFORE.columnGap}px`);
  assert.ok(g.row > BEFORE.rowGap, `the rows are ${g.row}px apart, no more than ${BEFORE.rowGap}px`);
  assert.ok(px(rule('.bc-cell'), 'gap') > BEFORE.cellGap, 'the icon still crowds its box');

  // The box has a ceiling and the area does not, so the extra width lands
  // between the columns rather than inside a field.
  assert.ok(px(rule('.bc-cells input'), 'max-width') < area / 2, 'the area grew by inflating the boxes');

  // A glyph box of one width, or the four boxes end up four widths: the
  // medical sign renders as text where the other three render as emoji.
  assert.ok(px(rule('.bc-glyph'), 'width'), 'the icon has no fixed box — the four inputs will differ in width');
  assert.ok(/text-align: center/.test(rule('.bc-glyph')), 'the icon is not centred in its box');

  const focus = CSS.match(/\.bc-cells input:focus \{([^}]*)\}/);
  assert.ok(focus, 'the focus state is gone');
  assert.ok(px(focus[1], 'outline') >= 1, 'the focus outline has no width');
  assert.ok(/var\(--accent-bright\)/.test(focus[1]), 'the focus outline lost its colour');
});

// -- SIZE-004: publishing is untouched -----------------------------------------------------

test('RESOURCE-SIZE-004: entering values and publishing behaves exactly as before', () => {
  // The stylesheet cannot reach any of this, and this is the proof that the
  // patch did not wander out of the stylesheet.
  const save = SCRIPT.slice(SCRIPT.indexOf('function saveBoardRow'), SCRIPT.indexOf('function publishAnnouncement'));
  assert.ok(/for \(const k of BOARD_KEYS\)/.test(save), 'the handler stopped reading BOARD_KEYS');
  assert.ok(/socket\.send\(\{ type: 'com_board_set', row: code, values \}\)/.test(save), 'the intent changed');
  assert.ok(/host\.querySelectorAll\('\[data-save\]'\)\) btn\.addEventListener\('click', \(\) => saveBoardRow\(btn\.dataset\.save\)\)/.test(SCRIPT),
    'the click no longer calls saveBoardRow');
  assert.ok(/type="number"/.test(SCRIPT) && /min="0"/.test(SCRIPT), 'the inputs stopped being numeric and floored at zero');

  const game = newGame();
  game.setPhase('ROUND_1');
  game.clock('start');
  const r = game.setBroadcastRow('POW', { power: 3, water: 1, parts: 22, med: 5 }, { by: 'COM' });
  assert.equal(r.ok, true);
  const wall = forBigscreen(game).broadcast.rows.POW;
  assert.deepEqual({ p: wall.power, w: wall.water, pa: wall.parts, m: wall.med }, { p: 3, w: 1, pa: 22, m: 5 });
  assert.equal(wall.report_round_number, 1, 'the report round logic moved');
  assert.equal(game.setBroadcastRow('POW', { power: 1 }, { by: 'WTR' }).reason, 'com_edit_forbidden', 'permissions moved');
  assert.equal(game.setBroadcastRow('POW', { power: 'x' }, { by: 'COM' }).reason, 'invalid_amount', 'validation moved');
  assert.equal(game.state.sectors.POW.integrity, 100, 'publishing moved the sector');
});

// -- SIZE-005: the six agree --------------------------------------------------------------

test('RESOURCE-SIZE-005: one icon size, one box size, one alignment, and the foot where it was', () => {
  // Every card renders from one template and takes one stylesheet, so there
  // is no per-sector sizing anywhere to drift.
  assert.ok(!/\.bc-card\[data-code/.test(CSS), 'a sector card is styled on its own');
  assert.ok(!/data-code="\$\{code\}"[^>]*style=/.test(SCRIPT), 'a card is sized inline');
  assert.ok(/display: flex; flex-direction: column/.test(rule('.bc-card')), 'the card stopped being a column');

  // The foot is still pinned to the bottom with the tag left and the button
  // right, and the entry area sits above it rather than inside it.
  const foot = rule('.bc-foot');
  assert.ok(/margin-top: auto/.test(foot) && /justify-content: space-between/.test(foot), 'the foot moved');
  const card = SCRIPT.slice(SCRIPT.indexOf('host.innerHTML = codes.map'), SCRIPT.indexOf('for (const btn of host.querySelectorAll'));
  assert.ok(card.indexOf('bc-cells') < card.indexOf('bc-foot'), 'the entry area fell below the foot');
  assert.ok(card.indexOf('bc-tag') < card.indexOf('bc-save'), 'PUBLISH is no longer on the right');
  assert.ok(!/bc-save/.test(card.slice(card.indexOf('bc-cells'), card.indexOf('bc-foot'))), 'PUBLISH moved into the entry grid');

  // The status stayed small: it must not start competing with the figures.
  assert.ok(px(rule('.bc-tag'), 'font-size') < px(rule('.bc-cells input'), 'font-size'), 'the status outgrew the figures');
});

// -- the narrow case -----------------------------------------------------------------------

test('a narrow console stacks the cards and keeps the enlarged fields', () => {
  const mq = CSS.slice(CSS.indexOf('@media (max-width: 720px) { .bc-rows'));
  const block = mq.slice(0, mq.indexOf('}', mq.indexOf('}') + 1) + 1);
  assert.ok(/grid-template-columns: minmax\(0, 1fr\)/.test(block), 'the board does not stack');
  // Nothing in the narrow case touches the entry area, so the fields a
  // desktop gets are the fields a stacked layout gets.
  assert.ok(!/bc-cells|bc-glyph|input|font-size/.test(block), 'the narrow layout shrinks the fields back');
  assert.ok(!/@media[^{]*\{[^}]*\.bc-cells input/.test(CSS), 'a media query resizes the fields somewhere else');
});
