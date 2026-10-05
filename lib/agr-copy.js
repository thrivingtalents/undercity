'use strict';
/**
 * AGR DECISION CARD COPY (v3, 2026-10-04; targets 2026-10-05).
 *
 * The GAIN and TRADE-OFF lines a table reads on an operational decision card
 * are DERIVED here from the card's authoritative `gain.effects` and
 * `tradeoff.effects` — never hand-written beside them in lib/agr-cards.json.
 * The engine applies those two lists; the card shows them; there is no third
 * copy to drift.
 *
 * A line is `{ who, what, when, text }`:
 *   who   — a sector code, or a token the console resolves: CHOSEN (the
 *           target selector), LOWEST (the lowest-health sector, or the tie
 *           the table breaks), ALL (every active sector), RANDOM2.
 *   what  — the number and the thing, "+1 WORKER", "−12 HEALTH",
 *           "+1 WATER UPKEEP". Two placeholders for the cache card: {CACHE}
 *           (the chosen resource and amount) and {RES} (the chosen resource).
 *   when  — one of the standard timing keys below.
 *   text  — the line with placeholders spelled out, for a surface that has
 *           no selector (Transport's card, the facilitator, a test).
 *
 * Each half of a card also AFFECTS a list of tokens — what the label above
 * its column says — read from the half's declared target and its effects.
 */

const SECTORS = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];
const RES_SHORT = { power: 'POWER', water: 'WATER', med: 'MED', parts: 'PARTS' };

/** The standard timing labels (spec v3 timing_language), keyed as the lines carry them. */
const TIMING_LABELS = {
  NOW: 'NOW',
  THIS_ROUND: 'THIS ROUND',
  UNTIL_ROUND_END: 'UNTIL ROUND END',
  NEXT_UPKEEP: 'NEXT UPKEEP',
  NEXT_2_UPKEEPS: 'NEXT 2 UPKEEPS',
  NEXT_ROUND: 'NEXT ROUND',
  MIXED: 'NOW + NEXT UPKEEP',
};

const WHO_LABELS = { CHOSEN: 'CHOSEN SECTOR', LOWEST: 'LOWEST SECTOR', ALL: 'ALL SECTORS', RANDOM2: '2 RANDOM SECTORS', SELF: 'AGR' };

function signed(n) {
  const v = Number(n) || 0;
  return `${v < 0 ? '−' : '+'}${Math.abs(v)}`;
}

function resShort(key) { return RES_SHORT[key] || String(key || '').toUpperCase(); }

/** "+5 POWER · +5 WATER · +2 MED" from { power: 5, water: 5, med: 2 }. */
function stockList(add) {
  return Object.entries(add || {})
    .filter(([, v]) => Number(v))
    .map(([k, v]) => `${signed(v)} ${resShort(k)}`)
    .join(' · ');
}

function capacityWord(kind) { return kind === 'med_capacity' ? 'HEAL CAPACITY' : 'APPROVAL'; }

function timingLabel(key) {
  if (TIMING_LABELS[key]) return TIMING_LABELS[key];
  return String(key || '').replace(/_/g, ' ');
}

/** A who token as a label: a pick or a known sector wins over the placeholder. */
function whoLabel(who, { sector = null } = {}) {
  if (who === 'CHOSEN' || who === 'LOWEST') return sector || WHO_LABELS[who];
  return WHO_LABELS[who] || who;
}

/** The what with its placeholders written out (the cache card). */
function resolvedWhat(line, { resource = null, choices = null } = {}) {
  let what = String(line.what || '');
  if (what.includes('{CACHE}')) {
    const list = choices || {};
    what = what.replace('{CACHE}', resource && list[resource] !== undefined
      ? `${signed(list[resource])} ${resShort(resource)}`
      : `ONE OF ${stockList(list)}`);
  }
  if (what.includes('{RES}')) what = what.replace('{RES}', resource ? resShort(resource) : 'CHOSEN RESOURCE');
  return what;
}

/** The line's text with every placeholder spelled out — what a surface without a selector shows. */
function lineText(line, opts = {}) {
  return `${whoLabel(line.who, opts)} ${resolvedWhat(line, opts)}`;
}

/** The effects a half carries, on a normalised card or a bare legacy one. */
function gainEffectsOf(card) {
  if (card.gain && Array.isArray(card.gain.effects) && card.gain.effects.length) return card.gain.effects;
  return card.effect ? [card.effect] : [];
}
function tradeOffEffectsOf(card) {
  if (card.tradeoff && Array.isArray(card.tradeoff.effects)) return card.tradeoff.effects;
  return card.consequences || [];
}

function gainLine(e) {
  const who = (t) => (e.sector && e.sector !== 'SELF' ? e.sector : t);
  switch (e.type) {
    case 'stock':              return { who: who('AGR'), what: stockList(e.add), when: 'NOW' };
    case 'cache':              return { who: who('AGR'), what: '{CACHE}', when: 'NOW' };
    case 'capacity':           return { who: e.sector, what: `${signed(e.delta)} ${capacityWord(e.kind)}`, when: 'THIS_ROUND' };
    case 'health_all':         return { who: 'ALL', what: `${signed(e.delta)} HEALTH`, when: 'NOW' };
    case 'health_lowest':      return { who: 'LOWEST', what: `${signed(e.delta)} HEALTH`, when: 'NOW' };
    case 'health_one':         return { who: 'CHOSEN', what: `${signed(e.delta)} HEALTH`, when: 'NOW' };
    case 'relief_crew':        return { who: 'CHOSEN', what: `${signed(e.workers || 1)} WORKER`, when: 'THIS_ROUND' };
    case 'workforce_recovery': return { who: 'AGR', what: `${signed(e.quantity || 1)} WORKER RECOVERED`, when: 'NOW' };
    default:                   return null;
  }
}

function tradeOffLine(c) {
  const who = c.sector === 'SELF' || !c.sector ? 'AGR' : c.sector;
  switch (c.type) {
    case 'integrity':
      // HEALTH, the console's word, never INTEGRITY (zero-briefing edition 2026-10-05): a participant reads the binder, the card and the header and sees one word
      return { who, what: `${signed(c.delta)} HEALTH`, when: c.apply_at === 'round_start' ? 'NEXT_ROUND' : 'NOW' };
    case 'upkeep_extra': {
      const cycles = Number(c.cycles) || 1;
      const what = c.add === 'chosen' ? `+${Number(c.amount) || 1} {RES} UPKEEP` : `${stockList(c.add)} UPKEEP`;
      return { who, what, when: cycles > 1 ? `NEXT_${cycles}_UPKEEPS` : 'NEXT_UPKEEP' };
    }
    case 'workers':
      return { who, what: `${signed(c.delta)} WORKER`, when: 'THIS_ROUND' };
    case 'capacity':
      return { who, what: `${signed(c.delta)} ${capacityWord(c.kind)}`, when: c.apply_at === 'round_start' ? 'NEXT_ROUND' : 'THIS_ROUND' };
    default:
      return null;
  }
}

function gainLines(card) { return gainEffectsOf(card).map(gainLine).filter(Boolean); }
function tradeOffLines(card) { return tradeOffEffectsOf(card).map(tradeOffLine).filter(Boolean); }

/**
 * The tokens a half of a card AFFECTS — codes, ALL, CHOSEN, LOWEST, RANDOM2 —
 * from its declared target, then from any token its effects name (a MULTI
 * trade-off on AGR and the chosen sector reads "AGR · CHOSEN SECTOR").
 */
function affectsOf(half) {
  if (!half) return [];
  const t = String(half.target_type || '').toUpperCase();
  if (t === 'ALL') return ['ALL'];
  if (t === 'SELF') return (half.effects || []).length ? ['AGR'] : [];
  if (t === 'PICK') return ['CHOSEN'];
  if (t === 'LOWEST') return ['LOWEST'];
  if (t === 'RANDOM2') return ['RANDOM2'];
  const out = [];
  const push = (s) => { const tok = s === 'PICK' ? 'CHOSEN' : s === 'SELF' ? 'AGR' : s; if (tok && !out.includes(tok)) out.push(tok); };
  for (const s of half.target_sectors || []) push(s);
  for (const e of half.effects || []) push(e.sector);
  return out;
}

/** "POW · MED", "ALL SECTORS", "AGR · CHOSEN SECTOR" — or the pick, once made. */
function affectsText(tokens, opts = {}) {
  return (tokens || []).map((t) => whoLabel(t, opts)).join(' · ');
}

/**
 * The card's two columns, derived from its data. `opts` resolves placeholders
 * for the `text` of each line (a sector or resource already chosen).
 */
function agrCardSummary(card, opts = {}) {
  const first = gainEffectsOf(card)[0] || {};
  const choices = first.choices || (card.effect && card.effect.choices) || null;
  const finish = (line) => ({ ...line, text: lineText(line, { ...opts, choices }) });
  return {
    gain: gainLines(card).map(finish),
    trade_off: tradeOffLines(card).map(finish),
    affects: { gain: affectsOf(card.gain), tradeoff: affectsOf(card.tradeoff) },
  };
}

module.exports = {
  agrCardSummary, lineText, resolvedWhat, whoLabel, timingLabel, affectsOf, affectsText,
  gainEffectsOf, tradeOffEffectsOf, TIMING_LABELS, WHO_LABELS, RES_SHORT, SECTORS, signed,
};
