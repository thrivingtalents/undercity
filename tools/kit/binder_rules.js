'use strict';
/**
 * UNDERCITY — the facts a sector binder prints, read from where the game keeps them.
 *
 * ZERO-BRIEFING BINDERS (2026-10-05). A binder states rules; it never owns
 * one. Every number here is read from the scenario the kit is built for
 * (config/scenarios/haven9-standard.json), every token from lib/rewards.js,
 * every card from lib/agr-deck.js. If the engine changes, the binder changes
 * with it at the next `npm run kit`; if a sentence in binder_compact.js
 * claims something the engine does not do, that sentence is the bug.
 *
 * SECTOR_JOB is the one editorial block: what each sector operates, supplies
 * and depends on, in plain words. It carries no number the engine also knows.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const SCENARIO = process.env.UNDERCITY_KIT_SCENARIO
  || path.join(ROOT, 'config', 'scenarios', 'haven9-standard.json');

const scenario = JSON.parse(fs.readFileSync(SCENARIO, 'utf8'));
const sectorsContent = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'sectors.json'), 'utf8')).sectors;
const roundsFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'rounds.json'), 'utf8'));
const rewards = require(path.join(ROOT, 'lib', 'rewards.js'));
const deck = require(path.join(ROOT, 'lib', 'agr-deck.js'));
const agrCopy = require(path.join(ROOT, 'lib', 'agr-copy.js'));

const SECTOR_CODES = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];
const GLYPH = { power: '⚡', water: '💧', parts: '🔧', med: '⚕', workers: '👤' };
const RES_NAME = { power: 'Power', water: 'Water', parts: 'Parts', med: 'Med', workers: 'Workers' };
const RES_LONG = { power: 'Power Cells', water: 'Water Units', parts: 'Spare Parts', med: 'Med Supplies', workers: 'Workers' };
const RES_ONE = { power: 'Power Cell', water: 'Water Unit', parts: 'Spare Part', med: 'Med Supply', workers: 'Worker' };

// ---------------------------------------------------------------- the rules
/** The scenario, read once, reduced to what a participant is told. */
function buildRules() {
  const d = scenario.defaults || {};
  const sc = scenario.sectors || {};
  const first = sc[SECTOR_CODES[0]] || {};
  // Every sector has the same bill in the standard scenario; a scenario that
  // differs per sector would print per sector, so we check rather than assume.
  const upkeep = { ...(first.upkeep || {}) };
  for (const code of SECTOR_CODES) {
    const u = (sc[code] || {}).upkeep || {};
    if (JSON.stringify(u) !== JSON.stringify(upkeep)) throw new Error(`binder_rules: ${code} upkeep differs from ${SECTOR_CODES[0]} — per-sector upkeep text is not implemented`);
  }
  const g = d.generator_upgrades || {};
  const rounds = (roundsFile.rounds || []).map((r) => r.id);
  const roundNo = (id) => Number(String(id).replace(/^R/, ''));
  const disabled = new Set(d.agr_disabled_cards || []);
  const cards = deck.cards.filter((c) => !disabled.has(c.id)).map((c) => {
    const s = agrCopy.agrCardSummary(c, {});
    return {
      id: c.id, title: c.title, risk: c.risk || null,
      gain: s.gain.map((l) => l.text), trade_off: s.trade_off.map((l) => l.text),
      needs_trn: c.requires === 'TRN',
    };
  });
  return {
    sectors: SECTOR_CODES,
    rounds, round_first: roundNo(rounds[0]), round_last: roundNo(rounds[rounds.length - 1]),
    upkeep,
    start_inventory: { ...(first.start_inventory || {}) },
    start_workforce: Number(first.start_workforce) || 0,
    start_integrity: Number(first.start_integrity) || 0,
    production: Object.fromEntries(SECTOR_CODES.map((c) => [c, { ...((sc[c] || {}).production || {}) }])),
    critical_below: Number(d.critical_below), degraded_below: Number(d.degraded_below), dark_at: Number(d.dark_at),
    lockout_after: Number(d.lockout_after_consecutive_invalid), lockout_s: Number(d.lockout_s),
    upkeep_penalty: Number(d.upkeep_shortfall_health_penalty),
    trn_approvals: Number(d.trn_approval_limit), med_heals: Number(d.med_healing_limit),
    recovery_per_round: Number(d.injured_recovery_per_round), recovery_cost_med: Number(d.injured_recovery_costs_med),
    require_chit: d.require_physical_transfer_chit !== false,
    deliver_on_stamp: d.deliver_on_stamp !== false,
    direct_transfers: d.allow_direct_participant_transfer === true,
    restart: {
      enabled: (d.emergency_restart || {}).enabled !== false,
      cost: { ...((d.emergency_restart || {}).cost || {}) },
      workers: Number((d.emergency_restart || {}).workers) || 0,
      health_after: Number((d.emergency_restart || {}).health_after) || 0,
    },
    generator: {
      enabled: g.enabled !== false, sectors: g.sectors || [], from_round: roundNo(g.enabled_from_round || rounds[0]),
      start_level: Number(g.start_level) || 0, levels: g.levels || [], costs: g.costs || [],
      support_labels: g.support_labels || {}, cancel_parts_lost: Number(g.cancel_parts_lost) || 0,
    },
    brownout: {
      production_multiplier: Number((d.brownout_effects || {}).production_multiplier),
      upkeep_delivery_multiplier: Number((d.brownout_effects || {}).upkeep_delivery_multiplier),
      worker_penalty: Number((d.brownout_effects || {}).worker_penalty),
      decay_per_min: Number((d.brownout_effects || {}).decay_per_min),
      per_sector: (d.brownout_effects || {}).per_sector || {},
    },
    agr: { cards_per_round: Number(d.agr_cards_per_round), consequences_from_round: Number(d.agr_consequences_from_round), cards },
    tokens: rewards.TOKENS,
    alert_full_screen_s: Number(d.alert_full_screen_s),
    core_scales_power: d.core_scales_power_production !== false,
    com_full_telemetry: !!(sectorsContent.COM || {}).full_telemetry,
  };
}
const RULES = buildRules();

// ---------------------------------------------------------------- helpers
const fmtStock = (obj, sep = ' + ') => Object.entries(obj).filter(([, v]) => v > 0)
  .map(([k, v]) => `${v} ${GLYPH[k]} ${RES_NAME[k]}`).join(sep);
const fmtStockLong = (obj, sep = ' · ') => Object.entries(obj).filter(([, v]) => v > 0)
  .map(([k, v]) => `${v} ${GLYPH[k]} ${v === 1 ? RES_ONE[k] : RES_LONG[k]}`).join(sep);
const upkeepText = fmtStock(RULES.upkeep);                    // "2 ⚡ Power + 1 💧 Water"
const upkeepHalf = fmtStock(Object.fromEntries(Object.entries(RULES.upkeep)
  .map(([k, v]) => [k, Math.floor(v * RULES.brownout.upkeep_delivery_multiplier)])));
const restartCost = fmtStock(RULES.restart.cost);
const roundWord = (n) => `Round ${n}`;

// ---------------------------------------------------------------- sector editorial
/**
 * What only this sector can say about itself. Lore is three sentences and
 * carries no rule; the rows are facts the engine enforces, in plain words.
 */
const SECTOR_JOB = {
  POW: {
    lore: "Power Grid runs HAVEN-9's five geothermal turbines, the ring main and three sub-grids. Every other sector draws from you, and the ring main is the single point of failure for the whole city. Power cannot be made faster than the turbines allow, so every commitment to another sector is taken from somewhere else.",
    operates: 'Five geothermal turbines, the ring main, three sub-grids.',
    supplies: '⚡ Power Cells. You are the only sector that generates them: ROUND OUTPUT → GENERATE POWER, once a round.',
    relied: 'Every sector burns Power for upkeep every round, and most repairs burn Power. Your Specification Tables (p.9) hold values other sectors need to close their faults.',
    depends: '💧 Water from WTR for your own upkeep and turbine cooling. 🔧 Parts for repairs and generator upgrades. WTR\'s support to reach generator Level 5.',
    fails: 'A DARK Power Grid generates nothing. New Power stops for the whole city and every sector\'s next upkeep is at risk.',
    authority: 'You decide who gets Power, how much, and when. The console never forces a transfer; you may refuse, delay or set a price. Your output also rises and falls with the Core\'s output.',
  },
  WTR: {
    lore: 'Water & Filtration draws from the deep aquifer, runs four pump stations and operates the grey-water reclaim plant that makes a closed city possible. You also supply turbine coolant to Power Grid, which makes you and POW mutual hostages. A filtration failure is invisible to everyone else until you report it.',
    operates: 'Deep aquifer intake, four pump stations, the grey-water reclaim plant.',
    supplies: '💧 Water Units. You are the only sector that generates them: ROUND OUTPUT → GENERATE WATER, once a round.',
    relied: 'Every sector burns Water for upkeep every round, and many repairs burn Water. Your Specification Tables (p.9) hold values other sectors need to close their faults.',
    depends: '⚡ Power from POW for the pumps and your own upkeep. 🔧 Parts for repairs and generator upgrades. POW\'s support to reach generator Level 5.',
    fails: 'A DARK Water sector generates nothing. Within a round or two no sector can pay its upkeep.',
    authority: 'You decide who gets Water, how much, and when. Nothing is taken from you automatically except your own upkeep.',
  },
  MED: {
    lore: "Medical Bay runs three wards, an isolation wing, a triage bay and the surgical suite, and holds the city's only cold-chain store. Every injured worker in HAVEN-9 passes through you. You have the strongest moral claim in any argument and the weakest ability to produce what you need.",
    operates: 'Three wards, the isolation wing, the triage bay, the surgical suite, the cold-chain store.',
    supplies: 'Healing. An injured worker anywhere in HAVEN-9 returns to duty only through your HEALING THIS ROUND queue, or through your automatic recovery at each round change.',
    relied: 'Any sector with an injured worker sends you a healing request. Some repairs across the city need ⚕ Med Supplies, which nobody produces. Your Specification Tables (p.9) hold values other sectors need.',
    depends: '⚡ Power and 💧 Water for upkeep, from POW and WTR. 🔧 Parts for repairs. You generate no stock of your own.',
    fails: 'A DARK Medical Bay heals nobody. Injured workers stay injured city-wide and every repair that needs crew slows down.',
    authority: 'Only MED heals. You choose whom to heal first and whom to decline, up to {MED_HEALS} heals a round.',
  },
  TRN: {
    lore: 'Transport & Tunnels maintains four galleries, the freight spur, the rail network and every blast door in HAVEN-9. You produce nothing, and nothing reaches anyone without you. That makes you the quietest form of power in the city and the easiest to resent.',
    operates: 'Four galleries, the freight spur, the rail network, every blast door.',
    supplies: 'Transfer capacity. Every movement of resources or workers between two sectors is approved on your console and stamped on its paper chit by you.',
    relied: 'Nothing moves between any two sectors without your approval: {TRN_APPROVALS} approvals a round for the whole city. Your Specification Tables (p.9) hold values other sectors need.',
    depends: '⚡ Power and 💧 Water for upkeep, from POW and WTR. 🔧 Parts for repairs. You generate no stock of your own.',
    fails: 'A DARK Transport sector approves nothing. Trade in HAVEN-9 stops.',
    authority: 'You alone approve or decline transfers, and you decide the order. An unstamped chit is void. Page 3 is yours.',
  },
  AGR: {
    lore: "Agriculture runs four hydroponic bays, the seedling bay and the seed vault, HAVEN-9's only path to a future beyond this generation. Your failures look the least urgent and cost the most, long after louder emergencies have been settled without you. Prepare your argument for resources before you need it.",
    operates: 'Four hydroponic bays, the seedling bay, the seed vault.',
    supplies: 'Interventions. Each round the bays can run one emergency initiative: INTERVENTIONS THIS ROUND deals you {AGR_CARDS} cards and you confirm 1. A card can move stock, workers or Health to any sector in the city.',
    relied: 'Other sectors benefit from your interventions: emergency Power, Water, Parts or Med, a technician for a round, a freight slot for TRN, Health for a sector in trouble. Your Specification Tables (p.9) hold values other sectors need.',
    depends: '⚡ Power and 💧 Water for upkeep and the bays. 🔧 Parts for repairs. You generate no stock: opening stock, repair rewards, your own cards and trades are all you have.',
    fails: 'A DARK Agriculture sector plays no cards and holds no reserves. The city loses its only flexible emergency capacity.',
    authority: 'From {AGR_FROM} every card carries a TRADE-OFF as well as a GAIN, and both apply when you confirm. One card needs TRN\'s agreement.',
  },
  COM: {
    lore: 'Comms & Sensors operates the sensor grid, the relay network and the uplink. Your telemetry covers every sector, so you routinely see a fault before the sector suffering it does. What you pass on, to whom, and how fast, is your call.',
    operates: 'The sensor grid, the relay network, the uplink.',
    supplies: "Telemetry and the city's picture of itself. You see every sector's Health, status and open faults live. The other sectors see only their own console, the big screen, and what you publish there.",
    relied: 'Every sector reads the big screen. Its board of sector figures and its broadcast are written by you. You hold the City Charter and produce it on request of any Chief.',
    depends: '⚡ Power and 💧 Water for upkeep, from POW and WTR. 🔧 Parts for repairs. You generate no stock of your own.',
    fails: 'A DARK Comms sector loses its feed. The city runs blind, on shouting.',
    authority: 'What you publish, and when, is your decision. Nothing on your CITY BIG SCREEN CONTROL page changes any sector\'s real state.',
  },
};

// ---------------------------------------------------------------- substitution
function fill(text, b) {
  const g = RULES.generator;
  const map = {
    CODE: b.code, NAME: b.name,
    UPKEEP: upkeepText, UPKEEP_HALF: upkeepHalf || 'nothing',
    PENALTY: String(RULES.upkeep_penalty),
    LOCK_N: String(RULES.lockout_after), LOCK_S: String(RULES.lockout_s),
    CRIT: String(RULES.critical_below), DEGR: String(RULES.degraded_below), DARK: String(RULES.dark_at),
    TRN_APPROVALS: String(RULES.trn_approvals), MED_HEALS: String(RULES.med_heals),
    RECOVER_N: String(RULES.recovery_per_round), RECOVER_MED: String(RULES.recovery_cost_med),
    START_STOCK: fmtStockLong(RULES.start_inventory), START_WORKERS: String(RULES.start_workforce),
    START_HEALTH: String(RULES.start_integrity),
    RESTART_COST: restartCost, RESTART_WORKERS: String(RULES.restart.workers), RESTART_HEALTH: String(RULES.restart.health_after),
    AGR_CARDS: String(RULES.agr.cards_per_round), AGR_FROM: roundWord(RULES.agr.consequences_from_round),
    GEN_FROM: roundWord(g.from_round), GEN_START: String(g.start_level),
    BROWN_WORKERS: String(RULES.brownout.worker_penalty), BROWN_DECAY: String(RULES.brownout.decay_per_min),
    BROWN_TRN: String(((RULES.brownout.per_sector || {}).TRN || {}).transfer_capacity ?? RULES.trn_approvals),
    ROUND_FIRST: roundWord(RULES.round_first), ROUND_LAST: roundWord(RULES.round_last), ROUND_COUNT: String(RULES.rounds.length),
    ALERT_S: String(RULES.alert_full_screen_s),
  };
  return String(text).replace(/\{([A-Z_]+)\}/g, (m, k) => (k in map ? map[k] : m));
}

module.exports = { RULES, SECTOR_JOB, GLYPH, RES_NAME, RES_LONG, RES_ONE, fill, SECTOR_CODES };
