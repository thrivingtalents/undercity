'use strict';
/**
 * THE AGR DECK, read once and checked (targets, 2026-10-05).
 *
 * lib/agr-cards.json is data: twelve cards, each a GAIN and a TRADE-OFF, and
 * each half declares WHO it affects — `target_type` (SELF, SECTOR, MULTI,
 * ALL, PICK, LOWEST, RANDOM2), `target_sectors`, and `effects[]` naming a
 * sector or a token per effect. AGR owns and plays every card; the halves
 * may land anywhere in the city, with different amounts for different
 * sectors, and nothing lands on AGR merely because AGR played the card.
 *
 * This module hands the engine the same shape it has always read — `effect`
 * (the first gain effect), `consequences` (the trade-off effects) — derived
 * from the two halves, so lib/state.js applies one list of gains and one of
 * trade-offs through the effect kinds it already has. It refuses to load a
 * card whose targets or effect types it does not know: a malformed deck
 * stops the server at boot rather than a table at the console.
 */
const RAW = require('./agr-cards.json');
const { affectsOf, SECTORS } = require('./agr-copy');

const TARGET_TYPES = ['SELF', 'SECTOR', 'MULTI', 'ALL', 'PICK', 'LOWEST', 'RANDOM2'];
const TOKENS = new Set([...SECTORS, 'SELF', 'ALL', 'CHOSEN', 'LOWEST', 'RANDOM2']);
const DYNAMIC = new Set(['ALL', 'CHOSEN', 'LOWEST', 'RANDOM2']);
const GAIN_TYPES = ['stock', 'cache', 'capacity', 'health_all', 'health_lowest', 'health_one', 'relief_crew', 'workforce_recovery'];
const TRADE_TYPES = ['integrity', 'upkeep_extra', 'workers', 'capacity'];

function check(cond, msg) { if (!cond) throw new Error(`lib/agr-cards.json: ${msg}`); }

function checkHalf(card, name, half, types) {
  check(half && typeof half === 'object', `${card.id}: no ${name}`);
  check(TARGET_TYPES.includes(half.target_type), `${card.id} ${name}: target_type "${half.target_type}" is not one of ${TARGET_TYPES.join('/')}`);
  check(Array.isArray(half.target_sectors), `${card.id} ${name}: target_sectors must be a list`);
  for (const s of half.target_sectors) check(TOKENS.has(s), `${card.id} ${name}: target "${s}"`);
  check(Array.isArray(half.effects), `${card.id} ${name}: effects must be a list`);
  for (const e of half.effects) {
    check(types.includes(e.type), `${card.id} ${name}: effect type "${e.type}"`);
    check(!e.sector || TOKENS.has(e.sector), `${card.id} ${name}: effect sector "${e.sector}"`);
  }
  if (half.target_type === 'SELF') for (const e of half.effects) check(!e.sector || e.sector === 'AGR' || e.sector === 'SELF', `${card.id} ${name}: SELF names ${e.sector}`);
  if (half.target_type === 'SECTOR') check(half.target_sectors.length === 1 && !DYNAMIC.has(half.target_sectors[0]), `${card.id} ${name}: SECTOR names exactly one sector`);
  if (half.target_type === 'MULTI') check(half.target_sectors.length >= 2, `${card.id} ${name}: MULTI names two or more`);
  if (half.target_type === 'ALL') check(half.target_sectors.length === SECTORS.length, `${card.id} ${name}: ALL lists every sector`);
  const declared = new Set(half.target_sectors.map((s) => (s === 'SELF' ? 'AGR' : s === 'PICK' ? 'CHOSEN' : s)));
  if (half.target_type === 'SELF') declared.add('AGR');
  if (half.target_type === 'PICK') declared.add('CHOSEN');
  if (half.target_type === 'LOWEST') declared.add('LOWEST');
  if (half.target_type === 'RANDOM2') declared.add('RANDOM2');
  if (half.target_type !== 'ALL') {
    for (const e of half.effects) {
      const s = e.sector === 'SELF' ? 'AGR' : e.sector;
      check(!s || declared.has(s), `${card.id} ${name}: effect on ${s} is not in target_sectors`);
    }
  }
}

function sectorOf(e) { return e.sector === 'SELF' ? 'AGR' : e.sector; }

/** The card as the engine reads it: the two halves, plus the legacy single `effect` and `consequences` derived from them. */
function normalise(card) {
  check(card && card.id, 'a card has no id');
  checkHalf(card, 'gain', card.gain, GAIN_TYPES);
  checkHalf(card, 'tradeoff', card.tradeoff, TRADE_TYPES);
  check(card.gain.effects.length >= 1 || card.id === 'AGR_WORKFORCE_RECOVERY', `${card.id}: a gain with no effect`);
  const gainEffects = card.gain.effects.map((e) => ({ ...e, sector: sectorOf(e) }));
  // The first gain effect, in the shape agrResolve and the logs have always
  // read. A dynamic token (CHOSEN / LOWEST / ALL) is the engine's to resolve
  // from the pick, so it is not written into the legacy field.
  const effect = { ...(gainEffects[0] || {}) };
  if (DYNAMIC.has(effect.sector)) delete effect.sector;
  const consequences = card.tradeoff.effects.map((e) => ({ ...e, sector: sectorOf(e) || 'AGR' }));
  return {
    ...card,
    owner_sector: card.owner_sector || 'AGR',
    effect,
    gain_effects: gainEffects,
    consequences,
    affects: { gain: affectsOf(card.gain), tradeoff: affectsOf(card.tradeoff) },
  };
}

const cards = RAW.cards.map(normalise);
const ids = new Set();
for (const c of cards) { check(!ids.has(c.id), `duplicate card ${c.id}`); ids.add(c.id); }

module.exports = { cards, raw: RAW, normalise, TARGET_TYPES, GAIN_TYPES, TRADE_TYPES };
