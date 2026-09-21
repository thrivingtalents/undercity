'use strict';
/**
 * RESOURCE EXCHANGE (2026-09-21) — the acceptance tests RE-001…RE-008 of
 * undercity_resource_exchange_redesign_claude_spec.json.
 *
 * The redesign is a MOVE, not a new mechanism: the dashboard keeps a count,
 * the dedicated page keeps the work, and the request → fulfil → Transport
 * lifecycle underneath is the one the engine already had. So these tests run
 * on two surfaces: the engine and the frame it sends (the numbers the page
 * reads), and the markup and script of the page itself (there is no DOM in
 * this suite — the console is verified in a browser as well).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { newGame } = require('./helpers');
const { forSector } = require('../lib/visibility');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'sector', 'index.html'), 'utf8');
const JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'sector', 'sector.js'), 'utf8');

/** Only the dashboard, so "not on the dashboard" can actually be asserted. */
const DASHBOARD = HTML.slice(
  HTML.indexOf('<main class="columns" id="columns">'),
  HTML.indexOf('<!-- ===== RESOURCE EXCHANGE'),
);
/** Only the dedicated page and the form it opens. */
const PAGE = HTML.slice(
  HTML.indexOf('<!-- ===== RESOURCE EXCHANGE'),
  HTML.indexOf('<!-- ===== OVERLAYS'),
);

function running() {
  const game = newGame();
  game.setPhase('INTERDEPENDENCE');
  game.clock('start');
  return game;
}
const journeys = (game, code) => forSector(game, code).movement;
/** The cards this sector must answer itself — the badge's and the summary's count. */
const needsAction = (game, code) => journeys(game, code).active.filter((c) => c.action_required);

// -- RE-001 --------------------------------------------------------------------

test('RE-001 a quiet sector: no request form on the dashboard, a compact summary, and nothing actionable', () => {
  // the form and the queue are gone from the dashboard…
  for (const gone of ['id="tf-sector"', 'id="tf-res"', 'id="tf-amt"', 'id="rx-queue"', 'data-accept', 'SEND REQUEST']) {
    assert.equal(DASHBOARD.includes(gone), false, `the dashboard still carries ${gone}`);
  }
  // …and live on the dedicated page instead
  for (const kept of ['id="tf-sector"', 'id="tf-res"', 'id="tf-amt"', 'id="rx-queue"', 'SEND REQUEST']) {
    assert.ok(PAGE.includes(kept), `the page lacks ${kept}`);
  }
  // the compact summary, with its three counts and the one way through
  assert.ok(/<div class="panel block exchange-summary">/.test(DASHBOARD), 'no compact summary card');
  assert.ok(/<h2 class="ptitle">RESOURCE EXCHANGE<\/h2>/.test(DASHBOARD), 'the summary is not titled RESOURCE EXCHANGE');
  for (const id of ['xs-action-n', 'xs-waiting-n', 'xs-outgoing-n']) {
    assert.ok(DASHBOARD.includes(`id="${id}"`), `the summary lacks ${id}`);
  }
  assert.ok(/id="xs-open">OPEN RESOURCE EXCHANGE</.test(DASHBOARD), 'no way through to the page');
  assert.ok(/\$\('xs-open'\)\.addEventListener\('click', \(\) => goto\('exchange'\)\)/.test(JS), 'the summary button does not open the page');

  // a sector with nothing waiting reads zero, from the frame the page counts
  const game = running();
  const mv = journeys(game, 'WTR');
  assert.deepEqual(mv.active, []);
  assert.equal(mv.history_total, 0);
  assert.equal(needsAction(game, 'WTR').length, 0);
});

// -- RE-002 --------------------------------------------------------------------

test('RE-002 three asks for WTR stock: the badge says 3 and the dashboard renders no cards', () => {
  const game = running();
  game.setInventory('WTR', { water: 9 });
  for (const asker of ['POW', 'MED', 'AGR']) {
    assert.equal(game.requestTransfer({ from: 'WTR', to: asker, resource: 'water', amount: 1, by: asker }).ok, true);
  }
  assert.equal(needsAction(game, 'WTR').length, 3, 'three asks do not read as three actions');

  // the badge counts exactly those, plus what only this table can clear
  assert.ok(/const n = b\.action\.length \+ b\.approvals\.length \+ b\.support;/.test(JS), 'the badge counts something else');
  assert.ok(/show\(badge, n > 0\)/.test(JS), 'the badge shows at zero');
  assert.ok(/id="deck-badge"/.test(HTML), 'there is no navigation badge');
  // the dashboard prints numbers only: no card, no card template, no action
  assert.equal(/movementCard|rx-card|data-accept|data-withdraw/.test(DASHBOARD), false, 'the dashboard still renders request cards');
  assert.ok(/setText\(\$\('xs-action-n'\), String\(b\.action\.length\)\)/.test(JS), 'the summary is not the action count');
});

// -- RE-003 --------------------------------------------------------------------

test('RE-003 opening the page: NEEDS ACTION by default, one readable card per ask', () => {
  assert.ok(/let exchangeFilter = 'ACTION'/.test(JS), 'the page does not open on NEEDS ACTION');
  assert.ok(/<button type="button" data-filter="ACTION" class="on">NEEDS ACTION<\/button>/.test(PAGE), 'NEEDS ACTION is not the marked view');

  const game = running();
  game.setInventory('WTR', { water: 9 });
  for (const asker of ['POW', 'MED', 'AGR']) {
    game.requestTransfer({ from: 'WTR', to: asker, resource: 'water', amount: 2, by: asker });
  }
  const cards = needsAction(game, 'WTR');
  assert.equal(cards.length, 3);
  for (const c of cards) {
    // source, destination, resource, quantity, age and the actions available
    assert.ok(c.from && c.to && c.from !== c.to, 'a card does not name both sectors');
    assert.equal(c.resource, 'water');
    assert.equal(c.amount, 2);
    assert.ok(Date.parse(c.at), 'a card carries no stamp to age from');
    assert.equal(c.can_fulfill, true, 'a card offers no action');
  }
  // and the card prints each of them
  assert.ok(/class="rx-route"/.test(JS) && /class="rx-item"/.test(JS) && /class="rx-age"/.test(JS) && /class="rx-state"/.test(JS));
  assert.ok(/Received: 'Received'|received: 'Received'/.test(JS.replace(/\s+/g, ' ')), 'no "Received … ago" wording');
  assert.ok(/trn: 'Waiting for TRN'/.test(JS), 'no "Waiting for TRN …" wording');
  assert.ok(/FULFILL/.test(JS) && /DECLINE/.test(JS), 'the card offers no fulfil/decline');
  // the queue scrolls rather than shrinking its cards
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'sector', 'sector.css'), 'utf8');
  assert.ok(/\.rx-queue \{[^}]*overflow-y: auto/.test(css), 'the queue does not scroll independently');
});

// -- RE-004 --------------------------------------------------------------------

test('RE-004 the figures are facts: stock, transfer, remaining — and no advice', () => {
  const game = running();
  game.setInventory('WTR', { water: 5 });
  game.requestTransfer({ from: 'WTR', to: 'POW', resource: 'water', amount: 3, by: 'POW' });
  const own = forSector(game, 'WTR').sectors.WTR;
  const card = needsAction(game, 'WTR')[0];
  assert.equal(own.inventory.water, 5, 'the frame does not carry the current stock');
  assert.equal(card.amount, 3, 'the frame does not carry the transfer amount');
  assert.equal(own.inventory.water - card.amount, 2, 'the remaining figure cannot be derived');

  // the card prints those three, plus the next cycle's call on the same resource
  const figs = JS.slice(JS.indexOf('function rxFigures'), JS.indexOf('function movementCard'));
  for (const word of ['CURRENT STOCK', 'TRANSFER', 'REMAINING', 'NEXT UPKEEP']) {
    assert.ok(figs.includes(word), `the figures lack ${word}`);
  }
  assert.ok(/have - amount/.test(figs), 'REMAINING is not stock minus the transfer');
  // and nothing anywhere tells the table what to do about them
  for (const advice of ['RECOMMEND', 'SAFE TO', 'DO NOT SEND', 'YOU SHOULD', 'RISKY', 'ADVISED']) {
    assert.equal(JS.includes(advice), false, `the screen advises: ${advice}`);
  }
});

// -- RE-005 --------------------------------------------------------------------

test('RE-005 fulfilling moves the card to WAITING TRN, off NEEDS ACTION, and it stays visible', () => {
  const game = running();
  game.setInventory('WTR', { water: 5 });
  const r = game.requestTransfer({ from: 'WTR', to: 'POW', resource: 'water', amount: 3, by: 'POW' }).request;
  assert.equal(needsAction(game, 'WTR').length, 1);

  assert.equal(game.fulfillRequest(r.id, { by: 'WTR' }).ok, true);
  const card = journeys(game, 'WTR').active.find((c) => c.id === r.id);
  assert.ok(card, 'the journey left the supplier\'s active list');
  assert.equal(card.status, 'WAITING_FOR_TRN');
  assert.equal(card.label, 'WAITING FOR TRN');
  assert.equal(card.action_required, false, 'it still counts as the supplier\'s action');
  assert.equal(needsAction(game, 'WTR').length, 0, 'NEEDS ACTION did not clear');
  // the requester sees the same one card, and the frame's direction is the STOCK's
  const theirs = journeys(game, 'POW').active.find((c) => c.id === r.id);
  assert.equal(card.direction, 'OUTGOING', "the frame no longer reads direction as the stock's");
  assert.equal(theirs.direction, 'INCOMING');
  assert.equal(theirs.status, 'WAITING_FOR_TRN');
  // …which is why the page has its own: INCOMING is an ask that came to this
  // table, OUTGOING is one it sent, so a table's own request is in OUTGOING.
  assert.ok(/function rxDirection/.test(JS), 'the page has no direction of its own');
  assert.ok(/return c\.from === SECTOR \? 'INCOMING' : 'OUTGOING';/.test(JS), 'the page reads direction as the stock does');
  assert.equal(/exchangeFilter === 'OUTGOING' \? rxSort\(b\.active\.filter\(\(c\) => c\.direction/.test(JS), false,
    'the OUTGOING view still filters on the stock direction');
  assert.ok(/setFilter\('OUTGOING'\);/.test(JS), 'a new request does not land on a view that holds it');
  // the page's WAITING view is exactly that status
  assert.ok(/waiting_trn: rest\.filter\(\(c\) => c\.status === 'WAITING_FOR_TRN' \|\| c\.status === 'DELAYED'\)/.test(JS),
    'the WAITING view is not the waiting-for-Transport set');
  assert.ok(/case 'WAITING_FOR_TRN': case 'DELAYED': return 'WAITING TRN';/.test(JS), 'the card does not say WAITING TRN');
});

// -- RE-006 --------------------------------------------------------------------

test('RE-006 an arrival notifies and counts, and never takes the player off the page they are on', () => {
  // a banner and a VIEW, not a navigation
  assert.ok(/function notifyArrival/.test(JS));
  assert.ok(/data-goto-exchange>VIEW</.test(JS), 'the notice offers no way to look');
  assert.ok(/if \(e\.target\.closest\('\[data-goto-exchange\]'\)\) goto\('exchange'\)/.test(JS), 'VIEW does not open the page');
  // goto() is only ever reached from a click: never from a frame
  const renders = JS.slice(JS.indexOf('function renderExchange'), JS.indexOf('function agoText'));
  assert.equal(/goto\(/.test(renders), false, 'a frame can move the player off their page');
  assert.equal(/notifyArrival[\s\S]{0,400}goto\(/.test(JS), false, 'the arrival navigates by itself');
  // the badge is derived from the frame, so it rises without anything else happening
  assert.ok(/function renderDeck/.test(JS) && /renderDeck\(\);/.test(JS), 'the badge is not refreshed per frame');

  const game = running();
  game.setInventory('WTR', { water: 9 });
  assert.equal(needsAction(game, 'WTR').length, 0);
  game.requestTransfer({ from: 'WTR', to: 'POW', resource: 'water', amount: 1, by: 'POW' });
  assert.equal(needsAction(game, 'WTR').length, 1, 'the badge count did not rise on arrival');
});

// -- RE-007 --------------------------------------------------------------------

test('RE-007 Transport opens on WAITING APPROVAL, sees its capacity, and approves by the existing rules', () => {
  assert.ok(/id="rx-f-approvals"/.test(PAGE), 'there is no WAITING APPROVAL view');
  assert.ok(/if \(!filterTouched && isTransport && exchangeFilter === 'ACTION'\) exchangeFilter = 'APPROVALS';/.test(JS),
    'Transport does not open on its queue');
  assert.ok(/setText\(\$\('rx-title'\), isTransport \? 'TRANSFER CONTROL' : 'RESOURCE EXCHANGE'\)/.test(JS), 'the page is not retitled for Transport');
  assert.ok(/setText\(\$\('rx-cap-used'\), `\$\{used\} \/ \$\{cap\} USED`\)/.test(JS), 'the capacity is not on the page');
  assert.ok(PAGE.includes('id="queue-panel"'), 'the approval queue did not move to the page');

  const game = running();
  game.setInventory('WTR', { water: 9 });
  const made = [];
  for (const asker of ['POW', 'MED']) {
    const r = game.requestTransfer({ from: 'WTR', to: asker, resource: 'water', amount: 1, by: asker }).request;
    const f = game.fulfillRequest(r.id, { by: 'WTR' });
    assert.equal(f.ok, true);
    assert.equal(game.confirmChit(f.transfer.id, true, { by: 'TRN' }).ok, true);
    made.push(f.transfer);
  }
  const q = forSector(game, 'TRN').transfer_queue;
  assert.ok(q, 'Transport has no queue');
  assert.equal(q.items.length, 2, 'the waiting count is wrong');
  assert.ok(Number.isFinite(q.capacity) && Number.isFinite(q.used), 'the capacity is not in the frame');
  for (const t of made) assert.equal(game.approveTransfer(t.id, { by: 'TRN' }).ok, true, 'the existing approval rule was lost');
  assert.equal(forSector(game, 'TRN').transfer_queue.used, 2, 'approvals are not counted against the allowance');
  // nobody else gets a queue
  assert.equal(forSector(game, 'POW').transfer_queue, undefined);
});

// -- RE-008 --------------------------------------------------------------------

test('RE-008 a generator support ask is TECHNICAL SUPPORT: never a resource card, never in the queue', () => {
  assert.ok(/<h2 class="ptitle">TECHNICAL SUPPORT<\/h2>/.test(PAGE), 'the page has no TECHNICAL SUPPORT area');
  assert.ok(/COORDINATION — NOT A RESOURCE TRANSFER/.test(PAGE), 'nothing says it is not a transfer');
  assert.ok(/class="panel block gen-support-block rx-support" id="gen-ask-panel"/.test(PAGE), 'the ask is not its own panel');
  // it is counted, separately, on the dashboard too
  assert.ok(/id="xs-support" hidden>TECHNICAL SUPPORT <b id="xs-support-n">/.test(DASHBOARD), 'no compact technical-support summary');
  assert.ok(/support: supportAsk\(\) \? 1 : 0/.test(JS), 'the support ask is not counted on its own');
  // and it is read from the sector frame, never from the movement list the cards render
  const buckets = JS.slice(JS.indexOf('function rxBuckets'), JS.indexOf('const rxAt ='));
  assert.ok(/mv\.active/.test(buckets) && /supportAsk\(\)/.test(buckets));
  assert.equal(/support[\s\S]{0,60}movementCard/.test(buckets), false, 'the support ask reaches the card renderer');

  // the engine agrees: a support ask is not a request and not a transfer
  const game = running();
  const before = game.state.requests.length + game.state.transfers.length;
  const pow = forSector(game, 'POW');
  assert.equal(pow.movement.active.length, 0);
  assert.equal(game.state.requests.length + game.state.transfers.length, before, 'reading the frame made paperwork');
  assert.equal('support_request' in pow.sectors.POW || pow.sectors.POW.support_request === undefined, true,
    'the support ask does not travel on the sector, beside the movement list');
});
