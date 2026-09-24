'use strict';
/**
 * COMM'S CITY BOARD, as six cards (2026-09-25).
 *
 * A layout change and nothing else. The board was one strip of inputs per
 * sector; it is now a two-column grid of cards, each carrying the sector's
 * nickname, its four figures two-by-two, the round its last report was filed
 * in, and PUBLISH in the same corner every time.
 *
 * Everything under the paint is the same object it was: the payload is still
 * built from BOARD_KEYS, still sent as `com_board_set {row, values}`, still
 * validated and stamped by the same reducer, and still reaches the wall as
 * the same snapshot. This suite exists to prove that — the markup assertions
 * are the layout, and the engine assertions are the promise that the layout
 * is all that moved.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { newGame } = require('./helpers');
const { forBigscreen, forSector } = require('../lib/visibility');
const B = require('../public/shared/bigscreen');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const INDEX = read('public/sector/index.html');
const SCRIPT = read('public/sector/sector.js');
const CSS = read('public/sector/sector.css');

const SIX = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];

function live(round = 'ROUND_1') {
  const game = newGame();
  game.setPhase(round);
  game.clock('start');
  return game;
}
const board = (game) => forSector(game, 'COM').broadcast;
/** The tag the card prints for a sector, by the rule renderBroadcast uses. */
function tag(game, code) {
  const n = board(game).rows[code].report_round_number;
  return n === null || n === undefined ? '--' : `R${n}`;
}
/** One card's markup template, as the script writes it — cells included. */
const CARD = (() => {
  const from = SCRIPT.indexOf('host.innerHTML = codes.map');
  return SCRIPT.slice(from, SCRIPT.indexOf('for (const btn of host.querySelectorAll', from));
})();
const rule = (sel) => (CSS.match(new RegExp(`\\${sel} \\{([^}]*)\\}`)) || [])[1] || '';

// -- LAYOUT-001: six cards, two to a row, in the given order -----------------------------

test('CITYBOARD-LAYOUT-001: six sector cards in a 2-column grid, POW/WTR, MED/TRN, AGR/COM', () => {
  const game = live();
  assert.deepEqual(Object.keys(board(game).rows).sort(), [...SIX].sort(), 'the board is not the six sectors');

  // The order is fixed in the script, not inherited from whatever order the
  // engine happens to hand its rows over in.
  assert.ok(/const BOARD_CARDS = \['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'\];/.test(SCRIPT),
    'the card order is not pinned');
  assert.ok(/function boardOrder\(rows\)/.test(SCRIPT), 'the board takes its order from the frame');
  assert.ok(/codes = boardOrder\(b\.rows\)/.test(SCRIPT), 'the render does not use the fixed order');

  const rows = rule('.bc-rows');
  assert.ok(/display: grid/.test(rows), 'the board is not a grid');
  assert.ok(/grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(rows), 'the board is not two columns');
  assert.ok(/id="bc-rows"/.test(INDEX), 'the board host is gone');
});

// -- LAYOUT-002: what one card holds -----------------------------------------------------

test('CITYBOARD-LAYOUT-002: nickname, four inputs 2x2, a compact tag, PUBLISH bottom-right', () => {
  assert.ok(/class="bc-code">\$\{U\.SECTOR_GLYPH\[code\] \|\| ''\} \$\{code\}/.test(CARD), 'the card lost its nickname');
  assert.ok(/text-align: center/.test(rule('.bc-card .bc-code')), 'the nickname is not prominent');

  // Four inputs, laid out two by two.
  assert.ok(/const BOARD_CELLS = \['power', 'water', 'parts', 'med'\];/.test(SCRIPT), 'the card cell order is not pinned');
  assert.ok(/BOARD_CELLS\.map/.test(SCRIPT), 'the card does not lay its cells out in that order');
  const cells = rule('.bc-cells');
  assert.ok(/display: grid/.test(cells) && /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(cells),
    'the four inputs are not a 2x2');
  assert.ok(/type="number"/.test(CARD) && /min="0"/.test(CARD), 'the inputs stopped being numeric and floored at zero');
  const input = rule('.bc-cells input');
  assert.ok(/width: 100%/.test(input) && /box-sizing: border-box/.test(input), 'the inputs are not one width');
  assert.ok(/\.bc-cells input:focus \{[^}]*outline/.test(CSS), 'the inputs have no focus state');
  assert.ok(/aria-label="\$\{code\} \$\{k\}"/.test(CARD), 'an input lost its label');

  // The tag and the button, in a foot pinned to the bottom of the card.
  assert.ok(/class="bc-tag"/.test(CARD) && /class="bc-save" data-save="\$\{code\}">PUBLISH</.test(CARD));
  const foot = rule('.bc-foot');
  assert.ok(/margin-top: auto/.test(foot), 'the foot floats with the content instead of sitting at the bottom');
  assert.ok(/justify-content: space-between/.test(foot), 'the tag and the button are not at opposite ends');
  assert.ok(CARD.indexOf('bc-tag') < CARD.indexOf('bc-save'), 'PUBLISH is not on the right');
  assert.ok(/display: flex; flex-direction: column/.test(rule('.bc-card')), 'the card is not a column');
});

test('the card carries nothing the Big Screen card carries: no health, no bar, no full name', () => {
  // The markup alone — a comment about what the card does not show is not the
  // card showing it.
  const markup = CARD.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
  for (const forbidden of ['shc-pct', 'shc-bar', 'integrity', 'health', 'SECTOR_NAME']) {
    assert.ok(!markup.includes(forbidden), `the board card shows ${forbidden}`);
  }
  // The console's own health block is untouched — it is simply not on this card.
  assert.ok(/id="hdr-health"|hdr-status/.test(INDEX), "the console's own header was collateral");
});

// -- LAYOUT-003: nothing published yet ---------------------------------------------------

test('CITYBOARD-LAYOUT-003: an unpublished sector shows -- and can still publish', () => {
  const game = live();
  for (const code of SIX) {
    assert.equal(board(game).rows[code].round, null, `${code} came pre-published`);
    assert.equal(tag(game, code), '--');
  }
  // The template writes -- before any frame arrives, and nothing disables the
  // button on any card, ever.
  assert.ok(/class="bc-tag">--</.test(CARD), 'an unpublished card does not start at --');
  assert.ok(!/disabled/.test(CARD), 'a card can be born unable to publish');
  assert.ok(!/bc-save[^\n]*disabled|disabled[^\n]*bc-save/.test(SCRIPT), 'PUBLISH is disabled somewhere');
  assert.equal(game.setBroadcastRow('POW', { power: 1 }, { by: 'COM' }).ok, true);
});

// -- LAYOUT-004: publishing is the same act it was ---------------------------------------

test('CITYBOARD-LAYOUT-004: a Round 1 publish tags R1 and reaches the wall unchanged', () => {
  const game = live('ROUND_1');
  const r = game.setBroadcastRow('POW', { power: 3, water: 1, parts: 2, med: 1 }, { by: 'COM' });
  assert.equal(r.ok, true);
  assert.equal(tag(game, 'POW'), 'R1');

  // The wall's own view of that row is the one it always got: same figures,
  // same stamps, same freshness.
  const wall = forBigscreen(game).broadcast.rows.POW;
  assert.deepEqual(
    { power: wall.power, water: wall.water, parts: wall.parts, med: wall.med },
    { power: 3, water: 1, parts: 2, med: 1 },
  );
  assert.equal(wall.report_round_number, 1);
  assert.equal(wall.freshness, 'CURRENT');
  assert.equal(B.reportLine(wall, B.CARD_RES_ORDER).compact, '⚡ 3 💧 1 🔧 2 ⚕ 1');
  assert.equal(game.state.sectors.POW.integrity, 100, 'publishing moved the sector');
});

// -- LAYOUT-005: the tag does not follow the room ----------------------------------------

test('CITYBOARD-LAYOUT-005: the round advances and the card still reads R1', () => {
  const game = live('ROUND_1');
  game.setBroadcastRow('POW', { power: 3, water: 1, parts: 2, med: 1 }, { by: 'COM' });
  const before = JSON.stringify(board(game).rows.POW);

  game.setPhase('ROUND_2');
  assert.equal(forSector(game, 'COM').round_number, 2, 'the room did not move');
  assert.equal(tag(game, 'POW'), 'R1', 'the card followed the room');
  assert.equal(JSON.stringify(board(game).rows.POW), before, 'the round change moved the snapshot');

  // The header shows the room's round; the card shows its own. Two different
  // numbers from two different places, and the code says which is which.
  assert.ok(/setText\(\$\('bc-round'\), state\.round_number === undefined \? '—' : `R\$\{state\.round_number\}`\)/.test(SCRIPT),
    'the header does not read the room\'s round');
  assert.ok(/const n = row\.report_round_number;/.test(SCRIPT), 'the card does not read its own stamp');
});

// -- LAYOUT-006: the payload is untouched -------------------------------------------------

test('CITYBOARD-LAYOUT-006: values still travel by the same handler, in the same shape', () => {
  // The payload is built from BOARD_KEYS, which the layout never touches — so
  // rearranging a card cannot rearrange, rename or drop a value.
  assert.ok(/const BOARD_KEYS = \['power', 'water', 'med', 'parts'\];/.test(SCRIPT), 'the payload keys moved');
  const save = SCRIPT.slice(SCRIPT.indexOf('function saveBoardRow'), SCRIPT.indexOf('function publishAnnouncement'));
  assert.ok(/for \(const k of BOARD_KEYS\)/.test(save), 'the handler stopped reading BOARD_KEYS');
  assert.ok(/socket\.send\(\{ type: 'com_board_set', row: code, values \}\)/.test(save), 'the intent changed');
  assert.ok(!/BOARD_CELLS/.test(save), 'the layout order leaked into the payload');
  assert.ok(/\$\(`bc-\$\{code\}-\$\{k\}`\)/.test(save), 'the handler cannot find the inputs it reads');
  // …and the ids it reads are the ids the card writes.
  assert.ok(/id="bc-\$\{code\}-\$\{k\}"/.test(CARD), 'the card stopped naming its inputs that way');

  // The reducer is unmoved: same guard, same figures, same stamps.
  const game = live('ROUND_1');
  assert.equal(game.setBroadcastRow('POW', { power: 2 }, { by: 'WTR' }).reason, 'com_edit_forbidden');
  assert.equal(game.setBroadcastRow('POW', { power: 'x' }, { by: 'COM' }).reason, 'invalid_amount');
  assert.equal(game.setBroadcastRow('POW', { power: -4 }, { by: 'COM' }).row.power, 0, 'the floor at zero moved');
  assert.equal(game.setBroadcastRow('NOPE', { power: 1 }, { by: 'COM' }).reason, 'unknown_sector');
});

// -- LAYOUT-007: the label, and only the label --------------------------------------------

test('CITYBOARD-LAYOUT-007: the button says PUBLISH and still runs the save handler', () => {
  assert.ok(/>PUBLISH</.test(CARD), 'the button does not say PUBLISH');
  assert.ok(!/>SAVE</.test(SCRIPT), 'a SAVE label survived');
  // Same class, same data attribute, same binding, same function.
  assert.ok(/class="bc-save" data-save="\$\{code\}"/.test(CARD), 'the button lost its hook');
  assert.ok(/host\.querySelectorAll\('\[data-save\]'\)\) btn\.addEventListener\('click', \(\) => saveBoardRow\(btn\.dataset\.save\)\)/.test(SCRIPT),
    'the click no longer calls saveBoardRow');
  // The label does not change once a sector has published.
  assert.ok(!/bc-save'\)[^\n]*textContent|setText\([^\n]*bc-save/.test(SCRIPT), 'something rewrites the button label');
});

// -- LAYOUT-008: narrow screens ------------------------------------------------------------

test('CITYBOARD-LAYOUT-008: the grid collapses to one column and nothing else changes', () => {
  const mq = CSS.slice(CSS.indexOf('@media (max-width: 720px) { .bc-rows'));
  const block = mq.slice(0, mq.indexOf('}', mq.indexOf('}') + 1) + 1);
  assert.ok(/grid-template-columns: minmax\(0, 1fr\)/.test(block), 'the board does not collapse');
  assert.ok(!/display: none/.test(block), 'the narrow layout hides something');
  assert.ok(!/bc-save|bc-tag|bc-cells/.test(block), 'the narrow layout changes more than the columns');
});

// -- the header ----------------------------------------------------------------------------

test('the board head carries the room\'s round and the published count, by the wall\'s own rule', () => {
  const game = live('ROUND_1');
  assert.ok(/id="bc-round"/.test(INDEX) && /id="bc-reports"/.test(INDEX), 'the head lost a stamp');
  assert.ok(/>CITY BIG SCREEN CONTROL</.test(INDEX) && />CITY BOARD</.test(INDEX), 'a title was renamed');

  // The counter's rule and the wall's are the same rule: a row counts once it
  // carries a cycle stamp. This is what stops the two drifting apart.
  const count = () => Object.keys(board(game).rows).filter((c) => board(game).rows[c].round !== null).length;
  assert.ok(/b\.rows\[c\]\.round !== null/.test(SCRIPT), 'the counter uses a rule of its own');
  assert.equal(count(), 0);
  assert.equal(B.reportSummary(forBigscreen(game).broadcast.rows).text, `REPORTS ${count()}/6`);
  game.setBroadcastRow('POW', { power: 1 }, { by: 'COM' });
  game.setBroadcastRow('AGR', { med: 0 }, { by: 'COM' });
  assert.equal(count(), 2);
  assert.equal(B.reportSummary(forBigscreen(game).broadcast.rows).text, `REPORTS ${count()}/6`);
});
