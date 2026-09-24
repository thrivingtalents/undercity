'use strict';
/**
 * BIG SCREEN SECTOR STATUS — the simplified card (2026-09-24).
 *
 * Six cards, unchanged in layout and identity. What changed inside one: the
 * dial is a bar, and under it sit the four numbers COMM last reported with
 * the ROUND it reported them in.
 *
 * The line this suite defends is the one the exercise rests on. Health is
 * live and comes off the sector. The resource row is a SNAPSHOT and comes off
 * COMM's board — it does not move when stock moves, it does not move when the
 * round moves, and the only thing that moves it is COMM filing a newer
 * report. A card reading R1 in Round 3 is not stale data; it is the finding.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { newGame } = require('./helpers');
const { forBigscreen } = require('../lib/visibility');
const B = require('../public/shared/bigscreen');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const WALL_SCRIPT = read('public/wall/wall.js');
const WALL_CSS = read('public/wall/wall.css');
const RULES = read('public/shared/bigscreen.js');
const SIX = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];

function running(round = 'ROUND_1') {
  const game = newGame();
  game.setPhase(round);
  game.clock('start');
  return game;
}
const rows = (game) => forBigscreen(game).broadcast.rows;

/** Everything the card draws, from the frame alone — exactly as wall.js does. */
function card(game, code) {
  const f = forBigscreen(game);
  const s = f.sectors[code];
  const row = f.broadcast.rows[code];
  const rep = B.reportLine(row, B.CARD_RES_ORDER);
  const tag = B.reportTag(row);
  return {
    pct: B.healthValue(s),
    bar: B.healthPercent(s),
    state: B.healthState(s),
    tag: tag.text,
    resources: rep.none ? B.AWAITING_REPORT : rep.compact,
    awaiting: rep.none,
  };
}

// -- STATUS-001: health without a report ------------------------------------------------

test('STATUS-001: full health, a full bar, AWAITING REPORT and no tag', () => {
  const game = running();
  game.setIntegrity('POW', 100);
  const c = card(game, 'POW');
  assert.equal(c.pct, '100');
  assert.equal(c.bar, 100, 'the bar is not full');
  assert.equal(c.resources, 'AWAITING REPORT');
  assert.equal(c.awaiting, true);
  assert.equal(c.tag, '', 'a sector COMM never reported carries a round tag');
  assert.equal(B.reportTag(rows(game).POW).show, false);

  // An unknown health draws an empty track rather than a fabricated full one.
  assert.equal(B.healthPercent(undefined), 0);
  assert.equal(B.healthValue(undefined), '—');
});

// -- STATUS-002: the snapshot and its tag -----------------------------------------------

test('STATUS-002: a Round 1 report shows R1 and the four figures COMM entered', () => {
  const game = running('ROUND_1');
  assert.equal(game.state.round, 'R1');
  assert.equal(game.setBroadcastRow('POW', { power: 3, water: 1, parts: 2, med: 1 }, { by: 'COM' }).ok, true);

  const c = card(game, 'POW');
  assert.equal(c.tag, 'R1');
  assert.equal(c.resources, '⚡ 3 💧 1 🔧 2 ⚕ 1', 'the card does not read power, water, parts, medical');
  // The spec's airy form is what a console can afford; a card gets the same
  // four pairs with single spaces, because it has a sixth of a panel.
  assert.equal(B.reportLine(rows(game).POW, B.CARD_RES_ORDER).text, '⚡ 3   💧 1   🔧 2   ⚕ 1');
  assert.equal(c.awaiting, false);

  // The spec fixes this order for the card; the console keeps its own.
  assert.deepEqual(B.CARD_RES_ORDER, ['power', 'water', 'parts', 'med']);
  const values = B.reportLine(rows(game).POW, B.CARD_RES_ORDER).values;
  assert.deepEqual(values.map((v) => `${v.glyph} ${v.value}`), ['⚡ 3', '💧 1', '🔧 2', '⚕ 1']);
  // Zero is a report, not an absence: it prints.
  assert.equal(game.setBroadcastRow('WTR', { power: 0, water: 0, parts: 0, med: 0 }, { by: 'COM' }).ok, true);
  assert.equal(card(game, 'WTR').resources, '⚡ 0 💧 0 🔧 0 ⚕ 0');
});

// -- STATUS-003: the tag does not follow the clock --------------------------------------

test('STATUS-003: the round moves on and the card keeps saying R1', () => {
  const game = running('ROUND_1');
  game.setBroadcastRow('POW', { power: 3, water: 1, parts: 2, med: 1 }, { by: 'COM' });
  const before = card(game, 'POW');
  assert.equal(before.tag, 'R1');

  game.setPhase('ROUND_2');
  assert.equal(game.state.round, 'R2');
  assert.equal(forBigscreen(game).broadcast.round_number !== null, true, 'the frame lost the live round');

  const after = card(game, 'POW');
  assert.equal(after.tag, 'R1', 'the tag followed the game round');
  assert.equal(after.resources, before.resources, 'the reported figures moved with the round');

  // Two stamps, two questions: the row's own round is what the tag reads, and
  // the code must never reach for the round the game happens to be in.
  assert.equal(rows(game).POW.report_round, 'R1');
  assert.equal(rows(game).POW.report_round_number, 1);
  assert.ok(/B\.reportTag/.test(WALL_SCRIPT), 'the card does not use the shared tag rule');
  assert.ok(/row\.report_round_number/.test(RULES), 'the tag is not taken from the row');
  assert.ok(!/frame\.round|frame\.broadcast\.round_number/.test(
    WALL_SCRIPT.slice(WALL_SCRIPT.indexOf('function renderCards'), WALL_SCRIPT.indexOf('function routePoints'))),
  'the card reads the live round');
});

// -- STATUS-004: stock moves, the card does not ------------------------------------------

test('STATUS-004: live inventory changes under a reported row and the wall never reveals it', () => {
  const game = running('ROUND_1');
  game.setBroadcastRow('POW', { power: 3, water: 1, parts: 2, med: 1 }, { by: 'COM' });
  const before = card(game, 'POW');

  game.setInventory('POW', { power: 1, water: 0, parts: 1, med: 1 });
  assert.deepEqual(
    { power: 1, water: 0, parts: 1, med: 1 },
    { power: game.state.sectors.POW.inventory.power, water: game.state.sectors.POW.inventory.water,
      parts: game.state.sectors.POW.inventory.parts, med: game.state.sectors.POW.inventory.med },
    'the stock edit did not land',
  );

  assert.deepEqual(card(game, 'POW'), before, 'the card moved with the stock');
  assert.equal(card(game, 'POW').resources, '⚡ 3 💧 1 🔧 2 ⚕ 1');
  // The wall has no reach into a sector's stock at all: not through the frame,
  // not through the script, not through the rules.
  const frame = forBigscreen(game);
  for (const code of SIX) assert.equal(frame.sectors[code].inventory, undefined, `${code} sent its stock to the wall`);
  assert.ok(!/\.inventory/.test(WALL_SCRIPT + RULES), 'the wall reads a stock field');
});

// -- STATUS-005: a newer report replaces it ----------------------------------------------

test('STATUS-005: a Round 2 report moves the tag to R2 and swaps the figures', () => {
  const game = running('ROUND_1');
  game.setBroadcastRow('POW', { power: 3, water: 1, parts: 2, med: 1 }, { by: 'COM' });
  game.setPhase('ROUND_2');
  assert.equal(card(game, 'POW').tag, 'R1');

  assert.equal(game.setBroadcastRow('POW', { power: 6, water: 2, parts: 0, med: 4 }, { by: 'COM' }).ok, true);
  const c = card(game, 'POW');
  assert.equal(c.tag, 'R2');
  assert.equal(c.resources, '⚡ 6 💧 2 🔧 0 ⚕ 4');

  // Only POW changed: a report is one sector's, not the board's.
  assert.equal(card(game, 'WTR').awaiting, true);
});

// -- STATUS-006: health is live, the report is not --------------------------------------

test('STATUS-006: MED falls to 42 and only the figure and the bar move', () => {
  const game = running('ROUND_1');
  game.setBroadcastRow('MED', { power: 2, water: 2, parts: 2, med: 9 }, { by: 'COM' });
  game.setIntegrity('MED', 100);
  const before = card(game, 'MED');
  assert.equal(before.pct, '100');

  game.setIntegrity('MED', 42);
  const after = card(game, 'MED');
  assert.equal(after.pct, '42');
  assert.equal(after.bar, 42, 'the bar does not follow the figure');
  assert.equal(after.tag, before.tag, 'a health change moved the report tag');
  assert.equal(after.resources, before.resources, 'a health change moved the reported figures');
  assert.equal(after.resources, '⚡ 2 💧 2 🔧 2 ⚕ 9');

  // The bar takes its colour from the card's state, which is the server's
  // word — the one place the state is decided — so the bar and the status
  // word beside it can never disagree.
  assert.equal(after.state, 'degraded');
  assert.ok(/\.shc-bar-fill \{[^}]*background: var\(--bar\)/s.test(WALL_CSS), 'the bar has no state colour');
  for (const state of ['degraded', 'critical', 'dark']) {
    assert.ok(new RegExp(`\\.shc\\[data-state="${state}"\\][^{]*\\{[^}]*--bar:`).test(WALL_CSS), `${state} does not colour the bar`);
  }
});

// -- STATUS-007: a reload restores all of it ---------------------------------------------

test('STATUS-007: the Big Screen reloads and finds the same snapshots, tags and live health', () => {
  const game = running('ROUND_1');
  game.setBroadcastRow('POW', { power: 3, water: 1, parts: 2, med: 1 }, { by: 'COM' });
  game.setPhase('ROUND_2');
  game.setBroadcastRow('MED', { power: 0, water: 5, parts: 1, med: 2 }, { by: 'COM' });
  game.setIntegrity('MED', 42);
  const before = { POW: card(game, 'POW'), MED: card(game, 'MED'), WTR: card(game, 'WTR') };

  // A reload is the frame built again from the snapshot the server holds.
  const snapshot = JSON.parse(JSON.stringify({ state: game.state, scenario: game.scenario }));
  const fresh = newGame();
  assert.equal(fresh.restore(snapshot), true, 'the snapshot was refused');

  assert.deepEqual({ POW: card(fresh, 'POW'), MED: card(fresh, 'MED'), WTR: card(fresh, 'WTR') }, before,
    'a reload changed what the cards say');
  assert.equal(card(fresh, 'POW').tag, 'R1');
  assert.equal(card(fresh, 'MED').tag, 'R2');
  assert.equal(card(fresh, 'MED').pct, '42');
  assert.equal(card(fresh, 'WTR').awaiting, true);
});

// -- the card itself ----------------------------------------------------------------------

test('the dial is gone and a bar stands in its place, at the size a projector needs', () => {
  assert.ok(!/ring-arc|ring-track|stroke-dasharray|RING\b/.test(WALL_SCRIPT), 'the card still draws a ring');
  assert.ok(!/\.ring/.test(WALL_CSS), 'the ring is still styled');
  assert.ok(!/shc-gauge/.test(WALL_SCRIPT + WALL_CSS), 'the gauge box is still here');
  assert.ok(!/>SYSTEM HEALTH</.test(WALL_SCRIPT), 'the label inside the ring survived the ring');

  assert.ok(/class="shc-bar"[^>]*role="progressbar"/.test(WALL_SCRIPT), 'the bar is not a progressbar');
  assert.ok(/shc-bar-fill/.test(WALL_SCRIPT));
  // 70-85% of the card, and thick enough to read across a room.
  const bar = WALL_CSS.match(/\.shc-bar \{([^}]*)\}/);
  assert.ok(bar, 'the bar has no rule');
  const width = Number((bar[1].match(/width: (\d+)%/) || [])[1]);
  assert.ok(width >= 70 && width <= 85, `the bar is ${width}% of the card`);
  const height = Number((bar[1].match(/height: clamp\(\d+px, ([\d.]+)vh/) || [])[1]);
  assert.ok(height >= 1, `the bar is ${height}vh tall`);
  assert.ok(/background: rgba\(255, 255, 255, 0\.0\d\)/.test(bar[1]), 'the track is not a dark neutral');

  // A short transition when the value changes, and nothing that flashes.
  assert.ok(/\.shc-bar-fill \{[^}]*transition: width/s.test(WALL_CSS), 'the bar jumps');
  assert.ok(!/\.shc-bar-fill \{[^}]*animation/s.test(WALL_CSS), 'the bar animates on its own');
});

test('the six cards keep their layout, their icons and their identity colours', () => {
  assert.deepEqual(B.SECTOR_ORDER, SIX);
  assert.deepEqual(B.SECTOR_COLOUR, { POW: '#FFB31A', WTR: '#22C7F2', MED: '#FF4148', TRN: '#E7EDF2', AGR: '#66D72E', COM: '#A855F7' });
  assert.ok(/icon-\$\{code\}\.png/.test(WALL_SCRIPT), 'the card lost its icon');
  assert.ok(/class="shc-code">\$\{code\}/.test(WALL_SCRIPT), 'the card lost its nickname');
  assert.ok(/class="shc-name">\$\{d\.name\}/.test(WALL_SCRIPT), 'the card lost its full name');
  assert.ok(/repeat\(2, minmax\(0, 1fr\)\); grid-template-rows: repeat\(3, minmax\(0, 1fr\)\)/.test(WALL_CSS), 'the six-card grid changed');
  assert.ok(/\.shc \{[^}]*border-left: \dpx solid var\(--accent\)/s.test(WALL_CSS), 'the identity edge is gone');

  // The resource row is secondary to the figure: legible across a room, and
  // never in competition with the health it sits under.
  const vh = (sel) => {
    const m = WALL_CSS.match(new RegExp(`\\${sel} \\{[^}]*font-size: clamp\\(\\d+px, ([\\d.]+)vh`));
    return m && Number(m[1]);
  };
  const vals = vh('.res-vals');
  const pct = vh('.shc-pct');
  assert.ok(vals >= 1.35, 'the reported figures are too small to read across a room');
  assert.ok(pct && vals < pct / 2, 'the reported figures compete with the health figure');
});

test('the card carries one stamp, and it is the round — freshness keeps only its word', () => {
  const game = running('ROUND_1');
  game.setBroadcastRow('POW', { power: 1 }, { by: 'COM' });
  assert.deepEqual(B.freshnessShort(rows(game).POW), { level: 'CURRENT', text: '' });
  game.cycleControl('process');
  assert.deepEqual(B.freshnessShort(rows(game).POW), { level: 'STALE', text: 'STALE' });
  game.cycleControl('process');
  assert.deepEqual(B.freshnessShort(rows(game).POW), { level: 'OUTDATED', text: 'OUTDATED' });
  assert.deepEqual(B.freshnessShort(rows(game).WTR), { level: 'NOT UPDATED', text: '' });
  // No cycle number anywhere on the card: R1 answers "when", the word answers
  // "still good?", and a projector never shows two different clocks at once.
  assert.ok(!/C\$\{row\.round_number\}/.test(RULES), 'the card still stamps a cycle');
  assert.ok(/\.res-tag/.test(WALL_CSS) && /\.rep-fresh:empty \{ display: none; \}/.test(WALL_CSS));
  // One line, one width: the card joins the pairs with a single space so the
  // tag and four figures fit a sixth of a panel without an ellipsis.
  assert.ok(/rep\.compact/.test(WALL_SCRIPT), 'the card uses the wide spacing');
});

test('a run saved before the round stamp keeps its figures and simply has no tag', () => {
  const game = running('ROUND_1');
  game.setBroadcastRow('POW', { power: 3, water: 1, parts: 2, med: 1 }, { by: 'COM' });
  const snapshot = JSON.parse(JSON.stringify({ state: game.state, scenario: game.scenario }));
  for (const row of Object.values(snapshot.state.broadcast.rows)) delete row.report_round;

  const old = newGame();
  assert.equal(old.restore(snapshot), true, 'the snapshot was refused');
  assert.equal(old.state.broadcast.rows.POW.report_round, null, 'the migration left the field undefined');
  const c = card(old, 'POW');
  assert.equal(c.resources, '⚡ 3 💧 1 🔧 2 ⚕ 1', 'the figures were lost with the stamp');
  assert.equal(c.tag, '', 'a round was invented for a row that never carried one');
  assert.equal(c.awaiting, false, 'a reported row was demoted to AWAITING');
});
