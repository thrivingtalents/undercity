'use strict';
/**
 * AGR DECISION CARD COPY (v3, 2026-10-04).
 *
 * The GAIN and TRADE-OFF lines a table reads on an operational decision card
 * are DERIVED here from the card's authoritative `effect` and `consequences`
 * — never hand-written beside them in lib/agr-cards.json. The engine applies
 * those two fields; the card shows them; there is no third copy to drift.
 *
 * A line is `{ who, what, when, text }`:
 *   who   — a sector code, or a placeholder the console resolves once the
 *           table has chosen: CHOSEN (the target selector), LOWEST (the
 *           lowest-health sector, or the tie the table breaks), ALL.
 *   what  — the number and the thing, "+1 WORKER", "−12 INTEGRITY",
 *           "+1 WATER UPKEEP". Two placeholders for the cache card: {CACHE}
 *           (the chosen resource and amount) and {RES} (the chosen resource).
 *   when  — one of the standard timing keys below.
 *   text  — the line with placeholders spelled out, for a surface that has
 *           no selector (Transport's card, the facilitator, a test).
 */

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

const WHO_LABELS = { CHOSEN: 'CHOSEN SECTOR', LOWEST: 'LOWEST SECTOR', ALL: 'ALL SECTORS' };

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

/** The lines' text with every placeholder spelled out — what a surface without a selector shows. */
function lineText(line, { sector = null, resource = null, choices = null } = {}) {
  const who = line.who === 'CHOSEN' ? (sector || WHO_LABELS.CHOSEN)
    : line.who === 'LOWEST' ? (sector || WHO_LABELS.LOWEST)
      : WHO_LABELS[line.who] || line.who;
  let what = line.what;
  if (what.includes('{CACHE}')) {
    const list = choices || {};
    what = what.replace('{CACHE}', resource && list[resource] !== undefined
      ? `${signed(list[resource])} ${resShort(resource)}`
      : `ONE OF ${stockList(list)}`);
  }
  if (what.includes('{RES}')) what = what.replace('{RES}', resource ? resShort(resource) : 'CHOSEN RESOURCE');
  return `${who} ${what}`;
}

function gainLines(card) {
  const e = card.effect || {};
  switch (e.type) {
    case 'stock':              return [{ who: e.sector || 'AGR', what: stockList(e.add), when: 'NOW' }];
    case 'cache':              return [{ who: e.sector || 'AGR', what: '{CACHE}', when: 'NOW' }];
    case 'capacity':           return [{ who: e.sector, what: `${signed(e.delta)} ${capacityWord(e.kind)}`, when: 'THIS_ROUND' }];
    case 'health_all':         return [{ who: 'ALL', what: `${signed(e.delta)} HEALTH`, when: 'NOW' }];
    case 'health_lowest':      return [{ who: 'LOWEST', what: `${signed(e.delta)} HEALTH`, when: 'NOW' }];
    case 'health_one':         return [{ who: 'CHOSEN', what: `${signed(e.delta)} HEALTH`, when: 'NOW' }];
    case 'relief_crew':        return [{ who: 'CHOSEN', what: `${signed(e.workers || 1)} WORKER`, when: 'THIS_ROUND' }];
    case 'workforce_recovery': return [{ who: 'AGR', what: `${signed(e.quantity || 1)} WORKER RECOVERED`, when: 'NOW' }];
    default:                   return [];
  }
}

function tradeOffLines(card) {
  return (card.consequences || []).map((c) => {
    switch (c.type) {
      case 'integrity':
        return { who: c.sector, what: `${signed(c.delta)} INTEGRITY`, when: c.apply_at === 'round_start' ? 'NEXT_ROUND' : 'NOW' };
      case 'upkeep_extra': {
        const cycles = Number(c.cycles) || 1;
        const what = c.add === 'chosen' ? `+${Number(c.amount) || 1} {RES} UPKEEP` : `${stockList(c.add)} UPKEEP`;
        return { who: c.sector, what, when: cycles > 1 ? `NEXT_${cycles}_UPKEEPS` : 'NEXT_UPKEEP' };
      }
      case 'workers':
        return { who: c.sector, what: `${signed(c.delta)} WORKER`, when: 'THIS_ROUND' };
      case 'capacity':
        return { who: c.sector, what: `${signed(c.delta)} ${capacityWord(c.kind)}`, when: c.apply_at === 'round_start' ? 'NEXT_ROUND' : 'THIS_ROUND' };
      default:
        return null;
    }
  }).filter(Boolean);
}

/**
 * The card's two columns, derived from its data. `opts` resolves placeholders
 * for the `text` of each line (a sector or resource already chosen).
 */
function agrCardSummary(card, opts = {}) {
  const choices = (card.effect && card.effect.choices) || null;
  const finish = (line) => ({ ...line, text: lineText(line, { ...opts, choices }) });
  return {
    gain: gainLines(card).map(finish),
    trade_off: tradeOffLines(card).map(finish),
  };
}

module.exports = { agrCardSummary, lineText, timingLabel, TIMING_LABELS, WHO_LABELS, RES_SHORT, signed };
