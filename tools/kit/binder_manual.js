'use strict';
/**
 * UNDERCITY — the participant operating manual that opens every sector binder.
 *
 * ZERO-BRIEFING EDITION (2026-10-05). A table receives its binder, its console
 * and its chits, and nobody explains anything: the eleven sections built here
 * are the explanation. They are written once, in one voice, and rendered into
 * all six binders by build_binders.js, so the shared rules are identical word
 * for word in every binder and only the sector pages differ.
 *
 * NOTHING HERE IS A RULE OF ITS OWN. Every number is read from the scenario
 * the kit is built for (config/scenarios/haven9-standard.json), every token
 * from lib/rewards.js, every card from lib/agr-deck.js, every role from
 * roles.json. If the engine changes, the binder changes with it at the next
 * `npm run kit`; if a sentence here claims something the engine does not do,
 * that sentence is the bug.
 *
 * WHAT MUST NEVER APPEAR: a resolution code, a spec value, the seeded
 * discrepancy, Appendix C by name as a place to look, a fault list for a
 * future round, any facilitator rationale, and any instruction that waits for
 * a trainer to speak. test/binder-manual.test.js checks the lot.
 *
 * The blocks are a small content model, not DOCX: build_binders.js owns the
 * typography. `{CODE}` and `{NAME}` are substituted per sector at render.
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
const ROLES = JSON.parse(fs.readFileSync(path.join(__dirname, 'roles.json'), 'utf8')).roles;

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
    if (JSON.stringify(u) !== JSON.stringify(upkeep)) throw new Error(`binder_manual: ${code} upkeep differs from ${SECTOR_CODES[0]} — per-sector upkeep text is not implemented`);
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

// block constructors — the content model build_binders.js renders
const P = (text, o = {}) => ({ t: 'p', text, ...o });
const H = (text) => ({ t: 'h', text });
const STEPS = (items, o = {}) => ({ t: 'steps', items, ...o });
const CHECK = (items) => ({ t: 'check', items });
const BUL = (items) => ({ t: 'bullets', items });
const TABLE = (head, rows, widths, o = {}) => ({ t: 'table', head, rows, widths, ...o });
const KV = (rows, o = {}) => ({ t: 'kv', rows, ...o });
const BOX = (kind, title, lines) => ({ t: 'box', kind, title, lines });
const FLOW = (steps) => ({ t: 'flow', steps });
const CARDS = (items) => ({ t: 'cards', items });
const NAMES = (rows) => ({ t: 'names', rows });
const CHIT = (sample) => ({ t: 'chit', sample });
const GAP = (n = 120) => ({ t: 'gap', n });
const BREAK = () => ({ t: 'break' });
const SEE = (num, title) => `→ §${num} ${title}`;

// section titles, used for cross references and the contents strip
const T = {
  1: 'START HERE — YOUR FIRST 5 MINUTES',
  2: "YOUR SECTOR'S JOB",
  3: 'WHO DOES WHAT',
  4: 'HOW YOUR SHIFT WORKS',
  5: 'UPKEEP, PRODUCTION & THE NEXT ROUND',
  6: 'READING YOUR SECTOR CONSOLE',
  7: 'WHEN A FAULT APPEARS',
  8: 'RESOURCES & WORKFORCE',
  9: 'HOW TO TRADE WITH ANOTHER SECTOR',
  '9A': 'YOU ARE THE STAMP',
  10: 'WHEN COUNCIL IS CALLED',
  11: 'NO ACTIVE FAULT? DO THIS',
  12: 'FAULT CODE INDEX',
  13: 'REPAIR PROCEDURES',
  14: 'SPECIFICATION TABLES',
  15: 'STATION OPERATIONS LOG',
};
const QUICK_TITLE = 'WHEN THIS HAPPENS → DO THIS';

// ---------------------------------------------------------------- sector editorial
/**
 * What only this sector can say about itself. Lore is three sentences and
 * carries no rule; the rows are facts the engine enforces, in plain words.
 */
const SECTOR_JOB = {
  POW: {
    lore: "Power Grid runs HAVEN-9's five geothermal turbines, the ring main and three sub-grids. Every other sector draws from you, and the ring main is the single point of failure for the whole city. Power cannot be made faster than the turbines allow, so every commitment to another sector is taken from somewhere else.",
    operates: 'Five geothermal turbines, the ring main, three sub-grids.',
    supplies: '⚡ Power Cells. You are the only sector that generates them: ROUND OUTPUT → GENERATE, once a round.',
    relied: 'Every sector burns Power for upkeep every round, and most repairs burn Power. Your Specification Tables (§14) hold values other sectors need to close their faults.',
    depends: '💧 Water from WTR for your own upkeep and turbine cooling. 🔧 Parts for repairs and generator upgrades. WTR\'s support to reach generator Level 5.',
    fails: 'A DARK Power Grid generates nothing. New Power stops for the whole city and every sector\'s next upkeep is at risk.',
    authority: 'You decide who gets Power, how much, and when. The console never forces a transfer; you may refuse, delay or set a price. Your output also rises and falls with the Core\'s output.',
  },
  WTR: {
    lore: 'Water & Filtration draws from the deep aquifer, runs four pump stations and operates the grey-water reclaim plant that makes a closed city possible. You also supply turbine coolant to Power Grid, which makes you and POW mutual hostages. A filtration failure is invisible to everyone else until you report it.',
    operates: 'Deep aquifer intake, four pump stations, the grey-water reclaim plant.',
    supplies: '💧 Water Units. You are the only sector that generates them: ROUND OUTPUT → GENERATE, once a round.',
    relied: 'Every sector burns Water for upkeep every round, and many repairs burn Water. Your Specification Tables (§14) hold values other sectors need to close their faults.',
    depends: '⚡ Power from POW for the pumps and your own upkeep. 🔧 Parts for repairs and generator upgrades. POW\'s support to reach generator Level 5.',
    fails: 'A DARK Water sector generates nothing. Within a round or two no sector can pay its upkeep.',
    authority: 'You decide who gets Water, how much, and when. Nothing is taken from you automatically except your own upkeep.',
  },
  MED: {
    lore: "Medical Bay runs three wards, an isolation wing, a triage bay and the surgical suite, and holds the city's only cold-chain store. Every injured worker in HAVEN-9 passes through you. You have the strongest moral claim in any argument and the weakest ability to produce what you need.",
    operates: 'Three wards, the isolation wing, the triage bay, the surgical suite, the cold-chain store.',
    supplies: 'Healing. An injured worker anywhere in HAVEN-9 returns to duty only through your HEALING THIS ROUND queue, or through your automatic recovery at each round change.',
    relied: 'Any sector with an injured worker sends you a healing request. Some repairs across the city need ⚕ Med Supplies, which nobody produces. Your Specification Tables (§14) hold values other sectors need.',
    depends: '⚡ Power and 💧 Water for upkeep, from POW and WTR. 🔧 Parts for repairs. You generate no stock of your own.',
    fails: 'A DARK Medical Bay heals nobody. Injured workers stay injured city-wide and every repair that needs crew slows down.',
    authority: 'Only MED heals. You choose whom to heal first and whom to decline, up to {MED_HEALS} heals a round.',
  },
  TRN: {
    lore: 'Transport & Tunnels maintains four galleries, the freight spur, the rail network and every blast door in HAVEN-9. You produce nothing, and nothing reaches anyone without you. That makes you the quietest form of power in the city and the easiest to resent.',
    operates: 'Four galleries, the freight spur, the rail network, every blast door.',
    supplies: 'Transfer capacity. Every movement of resources or workers between two sectors is approved on your console and stamped on its paper chit by you.',
    relied: 'Nothing moves between any two sectors without your approval: {TRN_APPROVALS} approvals a round for the whole city. Your Specification Tables (§14) hold values other sectors need.',
    depends: '⚡ Power and 💧 Water for upkeep, from POW and WTR. 🔧 Parts for repairs. You generate no stock of your own.',
    fails: 'A DARK Transport sector approves nothing. Trade in HAVEN-9 stops.',
    authority: 'You alone approve or decline transfers, and you decide the order. An unstamped chit is void. §9A is yours.',
  },
  AGR: {
    lore: "Agriculture runs four hydroponic bays, the seedling bay and the seed vault, HAVEN-9's only path to a future beyond this generation. Your failures look the least urgent and cost the most, long after louder emergencies have been settled without you. Prepare your argument for resources before you need it.",
    operates: 'Four hydroponic bays, the seedling bay, the seed vault.',
    supplies: 'Interventions. Each round the bays can run one emergency initiative: INTERVENTIONS THIS ROUND deals you {AGR_CARDS} cards and you confirm 1. A card can move stock, workers or Health to any sector in the city.',
    relied: 'Other sectors benefit from your interventions: emergency Power, Water, Parts or Med, a technician for a round, a freight slot for TRN, Health for a sector in trouble. Your Specification Tables (§14) hold values other sectors need.',
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

// ---------------------------------------------------------------- sections
function quickReferenceRows(b) {
  const rows = [
    ['A FAULT APPEARS ON YOUR CONSOLE', 'Click it. Find its code in §12. Follow its procedure in §13. Repairs are the only thing that stops Health falling.', '§7'],
    ['A CODE YOU ARE TOLD IS NOT IN YOUR INDEX', 'It is not yours. The shaded rows in §12 say which sector owns it: send it there. A fault on your own console is always yours.', '§7'],
    ['YOUR PROCEDURE NEEDS ANOTHER SECTOR\'S VALUE', 'Liaison goes to that station and asks for the exact row named. They read it from their binder. Bring back three digits, written down.', '§7'],
    ['YOU NEED RESOURCES OR A WORKER', 'Liaison negotiates. Send a REQUEST in RESOURCE EXCHANGE. Fill a Transfer Chit. TRN approves. Then move the chits.', '§9'],
    ['ANOTHER SECTOR REQUESTS FROM YOU', 'A banner shows. Open RESOURCE EXCHANGE → NEEDS MY ACTION → FULFILL or DECLINE. Nothing moves until TRN approves.', '§9'],
    ['ROUND TIME IS LOW', 'Secure {UPKEEP} now. Upkeep is taken the moment the next round starts.', '§5'],
    ['A NEW ROUND HAS STARTED', 'Run the NEW ROUND — CHECK THESE NOW box. Read the NEXT UPKEEP result. Generate output if you have any. Check workers, allowances, cards.', '§5'],
    ['UPKEEP SHORTFALL ON THE CONSOLE', 'You lost {PENALTY} Health. Your stock was left untouched. Trade for Power and Water before the next round starts.', '§5'],
    ['A WORKER IS INJURED', 'INJURED WORKERS panel appears. Press REQUEST MED HEALING. Only MED heals, up to {MED_HEALS} a round. Turn the token face down.', '§8'],
    ['RESOLUTION REJECTED', 'The code is wrong. Re-check the table or the sector that gave the value. Do not guess.', '§7'],
    ['{LOCK_N} WRONG CODES IN A ROW', 'CONSOLE LOCKED for {LOCK_S} seconds. Verify the source while you wait, then resubmit.', '§7'],
    ['COUNCIL IN SESSION BANNER', 'Chief and Liaison go to the central Council table now. Everyone else stays and keeps operating. The sitting ends when the Council clock on the console reaches 00:00.', '§10'],
    ['HEALTH BELOW {CRIT}', 'CRITICAL. The console turns red but every control still works. Repair the faults that are bleeding you.', '§4'],
    ['HEALTH AT {DARK}', 'DARK. Repairs lock, no output, no upkeep. EMERGENCY RESTART when you can pay {RESTART_COST} and {RESTART_WORKERS} workers.', '§4'],
    ['SECTOR BROWNOUT BANNER', 'Output and upkeep halved, {BROWN_WORKERS} workers held back, Health bleeds slowly. Keep operating; it is not DARK.', '§4'],
    ['CITY ANNOUNCEMENT UPDATED', 'Read the big screen. COM has published a broadcast to the whole city.', '§4'],
    ['SIMULATION PAUSED', 'Every clock is frozen. Nothing is lost. Wait for the clocks to restart.', '§4'],
    ['NO ACTIVE FAULT', 'Do not wait for anyone. Run the checklist.', '§11'],
    ['CONSOLE SAYS RECONNECTING', 'Keep working on paper. It reconnects by itself. If it stays down for minutes, that is a technical failure: tell the control desk.', '§6'],
  ];
  if (b.code === 'TRN') rows.splice(5, 0, ['A LIAISON HANDS YOU A SIGNED CHIT', 'Find the transfer in TRANSFER APPROVALS. CONFIRM CHIT, stamp the paper, APPROVE. Stock moves at once.', '§9A']);
  return rows.map((r) => r.map((c) => fill(c, b)));
}

function quickReferencePage(b, { back = false } = {}) {
  return {
    id: back ? 'quick-back' : 'quick-front', num: null, title: QUICK_TITLE, tab: 'QUICK', pages: 1,
    blocks: [
      P(back ? 'Back-cover copy of the inside-front-cover sheet. Same rows, same answers.' : 'Tear nothing out. This page is also printed inside the back cover.', { muted: true }),
      TABLE(['WHEN THIS HAPPENS', 'DO THIS', 'SEE'], quickReferenceRows(b), [2900, 5300, 826], { small: true, boldFirst: true }),
    ],
  };
}

function sectionStart(b) {
  const generator = RULES.generator.enabled && RULES.generator.sectors.includes(b.code);
  return {
    id: 'start', num: 1, title: T[1], tab: 'START', pages: 1,
    blocks: [
      P('**No briefing is coming.** This binder and your sector console contain everything you need to operate your station. Nobody will present the rules; start with the checklist below.'),
      H('HAVEN-9 in three sentences'),
      P('The surface has been uninhabitable for forty years. HAVEN-9 survives three hundred metres underground, kept alive by six interdependent sector systems and a geothermal Core. This morning the Core began to degrade, and you are the leadership of **{NAME} ({CODE})**.'),
      H('Your objective'),
      P('Keep {CODE} running until the shift ends: your Health must never reach {DARK}, and the city needs what you supply. No sector can do this alone. Most repairs need a value, a part or a worker that another station holds, and every sector needs Power and Water every round.'),
      H('Do these now, in order'),
      STEPS([
        'Assign the four roles: **SECTOR CHIEF**, **LIAISON**, **SYSTEMS LEAD**, and everyone else an **ENGINEER**. Read §3 if you are unsure who does what. Write the names in the boxes below.',
        'Count the chits on your table. Opening stock is **{START_STOCK}**.',
        'Count your workforce tokens: **{START_WORKERS} 👤 workers**.',
        'Open the sector console and click anywhere on it once, so sound is enabled. Check **INVENTORY** matches your chits and **WORKERS** shows {START_WORKERS} / {START_WORKERS} AVAILABLE. The console is the official count: if they differ, adjust the chits.',
        'Find on the console: **System status**, **Health**, **Current round**, **Round time**, **NEXT UPKEEP**, **ACTIVE FAULTS**, and the banner strip under the header where alerts appear. §6 explains every item.',
        'Read §2: what {CODE} operates, supplies and depends on.',
        'Read §5. Your upkeep is **{UPKEEP}**, taken automatically each time a new round starts. Decide now how you will always have it.',
        generator
          ? 'Read the production block in §5. Your output does not arrive by itself: press **GENERATE** in ROUND OUTPUT once every round.'
          : 'Read the production block in §5. {CODE} generates no stock. Every Power Cell and Water Unit you will ever hold comes from your opening stock, repair rewards, interventions or trades.',
        'Read §7 once, now, before your first fault: how a repair works and what the console will say.',
        'Systems Lead: open §12 and §13 and see your own fault codes and procedures. Liaison: find the other five stations and the central Council table.',
        'Begin operating. Watch the console. A fault: §7. Nothing happening: §11.',
      ]),
      NAMES([['SECTOR CHIEF', ''], ['LIAISON', ''], ['SYSTEMS LEAD', ''], ['ENGINEERS', '']]),
      BOX('ACTION', 'YOU ARE NOW OPERATIONAL', ['Watch your dashboard and run your sector.']),
    ],
  };
}

function sectionJob(b) {
  const j = SECTOR_JOB[b.code];
  return {
    id: 'job', num: 2, title: T[2], tab: 'JOB', pages: 1,
    blocks: [
      P(j.lore, { lore: true }),
      KV([
        ['{CODE} OPERATES', j.operates],
        ['{CODE} SUPPLIES OR CONTROLS', j.supplies],
        ['OTHER SECTORS RELY ON YOU FOR', j.relied],
        ['YOU DEPEND ON', j.depends],
        ['IF {CODE} FAILS', j.fails],
        ['YOUR SPECIAL AUTHORITY', j.authority],
        ['OPENING STOCK', '{START_STOCK}'],
        ['STARTING WORKFORCE', '{START_WORKERS} 👤 workers, Health {START_HEALTH}.'],
        ['UPKEEP, EVERY ROUND', '{UPKEEP}, taken automatically when the next round starts. ' + SEE(5, T[5])],
      ], { keyWidth: 2700 }),
      BOX('REMEMBER', 'THIS BINDER STAYS AT THIS STATION', [
        'Your Specification Tables in §14 are what other sectors come to you for. Whether you give a value, and how quickly, is your decision. Only your Liaison leaves the station, and only {CODE} may read this binder.',
      ]),
    ],
  };
}

function sectionRoles() {
  return {
    id: 'roles', num: 3, title: T[3], tab: 'ROLES', pages: 1,
    blocks: [
      P('Four roles, assigned by you, before anything else. One role card per person is in your kit; the same rules are printed here in full. A team of three has no Engineers: the Systems Lead counts stock and the Chief keeps the log.'),
      CARDS(ROLES),
    ],
  };
}

function sectionShift(b) {
  const g = RULES.generator.enabled && RULES.generator.sectors.includes(b.code);
  return {
    id: 'shift', num: 4, title: T[4], tab: 'SHIFT', pages: 1,
    blocks: [
      H('Rounds and the round clock'),
      P('The shift is played in rounds, from {ROUND_FIRST} to {ROUND_LAST}; {ROUND_FIRST} is for setting up. The console shows **Current round** and **Round time**: each round has its own clock, started from the control desk, counting down to 00:00, where it stops. Faults keep bleeding Health until the next round is started; the clock protects nobody.'),
      P('A round has changed when **Current round** changes and the clock reloads. At that moment upkeep is taken, every allowance refreshes and new cards are dealt: run the NEW ROUND box in §5. Between round changes, normal operations are: repair every fault in ACTIVE FAULTS (§7), keep {UPKEEP} in INVENTORY (§5), trade for what you lack and answer requests (§9), keep the log (§15), and when nothing is happening run §11.'),
      H('Alerts, notices and announcements'),
      KV([
        ['CITY ALERT', 'Fills the console for a few seconds, then stays as a banner at the top. Addressed to every sector: the city\'s condition has changed.'],
        ['NOTICE TO {CODE}', 'A banner for this station only, from the Continuity Authority. Do what it says.'],
        ['CITY ANNOUNCEMENT UPDATED', 'COM has published a broadcast: read it on the big screen, which also shows every sector\'s Health and status, the latest city events and the round clock.'],
        ['CITY DECISION — AGR', 'An Agriculture intervention has changed your stock, workers or Health. The banner says what.'],
        ['SIMULATION PAUSED', 'Every clock is frozen, fault decay included. Nothing is lost; the console resumes by itself.'],
      ], { keyWidth: 2900 }),
      H('Faults and Health'),
      P('A fault bleeds Health at the rate on its card, **DECAY −x HEALTH / MIN**, until it is repaired. Health never recovers by itself; a repair stops the bleed, and some repairs pay **+5 HEALTH**. Later faults need values from other sectors, and some are **TIME-CRITICAL**: they bleed faster and are worked first.'),
      TABLE(['STATUS WORD', 'WHAT IT MEANS', 'WHAT YOU DO'], [
        ['STABLE', 'Health {DEGR} or above.', 'Operate normally.'],
        ['DEGRADED', 'Health below {DEGR}.', 'Repair faults now, before the next one lands.'],
        ['CRITICAL', 'Health below {CRIT}. A red wash covers the console and the big screen shows you red. Every control still works.', 'Repair the fault that bleeds fastest. Ask for help: a value, a part, a worker, an AGR intervention.'],
        ['BROWNOUT', 'Imposed by the Authority. Output halved ({CODE}: §5), upkeep halved to {UPKEEP_HALF}, {BROWN_WORKERS} workers held back, Health bleeds {BROWN_DECAY} a minute on top of any fault.', 'Keep operating. Pay the smaller upkeep. Repairs still work.'],
        ['DARK', 'Health {DARK}. SECTOR OFFLINE covers the console: repairs lock, no output, no upkeep, no healing or approvals from you.', 'EMERGENCY SHUTDOWN panel: with {RESTART_COST} in INVENTORY and {RESTART_WORKERS} workers free, press EMERGENCY RESTART. You return at {RESTART_HEALTH} Health, CRITICAL, that crew busy until the round ends.'],
      ], [1600, 4200, 3226], { small: true, boldFirst: true }),
    ],
  };
}

function productionBlocks(b) {
  const g = RULES.generator;
  const code = b.code;
  const prod = RULES.production[code] || {};
  const key = Object.keys(prod)[0];
  if (g.enabled && g.sectors.includes(code) && key) {
    const other = (g.costs.find((c) => c.support_from && c.support_from[code]) || {}).support_from;
    const otherCode = other ? other[code] : null;
    const label = g.support_labels[code] || 'SUPPORT';
    const levelRows = g.levels.map((l) => {
      const cost = g.costs.find((c) => Number(c.to_level) === Number(l.level));
      const how = Number(l.level) === g.start_level ? 'Installed at the start.'
        : Number(l.level) < g.start_level ? 'Only after damage. Repairs and upgrades bring you back up.'
          : cost ? `${cost.parts} 🔧 Parts + ${cost.workers} 👤 workers${cost.support_from && cost.support_from[code] ? `, and ${cost.support_from[code]}'s ${label}` : ''}.` : '—';
      return [`L${l.level} ${l.name}`, `${l.output} ${GLYPH[key]} ${RES_NAME[key]} a round`, how];
    });
    return [
      BOX('ACTION', `PRESS GENERATE ${RES_NAME[key].toUpperCase()} ONCE EVERY ROUND`, [
        `ROUND OUTPUT panel, right column. Press **GENERATE ${RES_NAME[key].toUpperCase()}** once each round: ${prod[key]} ${GLYPH[key]} ${RES_NAME[key]} (at Level ${g.start_level}) land in INVENTORY at once. Add the chits to the table. Output not generated before the round changes is lost; after use the panel says OUTPUT ALREADY GENERATED THIS ROUND.`,
      ]),
      P(`Brownout halves your output${code === 'POW' && (RULES.brownout.per_sector.POW || {}).production_multiplier ? ` (Power Grid to a quarter)` : ''}. DARK generates nothing.${code === 'POW' && RULES.core_scales_power ? ' Power output also scales with the Core: if the Core\'s output falls, so does yours.' : ''}`),
      H('Your generator'),
      P(`The GENERATOR panel shows your installed level and what the next level costs. From ${roundWord(g.from_round)} you may **START UPGRADE** once a round: the Parts are spent now, the workers are held until the round ends, and the new level is installed when the next round starts. **CANCEL UPGRADE** frees the crew but ${g.cancel_parts_lost} Part is lost.${otherCode ? ` Level 5 cannot start until ${otherCode} presses **CONFIRM SUPPORT** on its own console (TECHNICAL SUPPORT panel on its RESOURCE EXCHANGE page). Ask through your Liaison; it costs ${otherCode} nothing but a decision.` : ''}`),
      TABLE(['LEVEL', 'OUTPUT', 'TO REACH IT'], levelRows, [2100, 2900, 4026], { small: true, boldFirst: true }),
      otherCode ? P(`${otherCode} will ask the same of you. Its request appears in your TECHNICAL SUPPORT panel: **CONFIRM SUPPORT** commits none of your stock, only your word.`) : null,
    ].filter(Boolean);
  }
  const extra = {
    MED: 'Med Supplies are finite. Nobody in HAVEN-9 produces them: your opening stock, repair rewards and Agriculture\'s interventions are the only sources, and your automatic recovery spends {RECOVER_MED} ⚕ at each round change.',
    TRN: 'Your leverage is not stock: it is the stamp. Every trade in the city, including the ones that bring you Power and Water, passes through §9A.',
    AGR: 'Your reserves are your cards. An intervention can put Power, Water, Parts or Med into INVENTORY, and from {AGR_FROM} it costs something in return.',
    COM: 'Your leverage is information: what you see, what you pass on in person, and what you publish on the big screen.',
  };
  return [
    BOX('REMEMBER', '{CODE} GENERATES NO STOCK', [
      'There is no ROUND OUTPUT panel on your console. Every Power Cell and Water Unit you will hold comes from your opening stock, REPAIR REWARDS, Agriculture\'s interventions, or trades with POW and WTR (§9). Plan every round\'s upkeep as a purchase, and plan it early: TRN approves only {TRN_APPROVALS} transfers a round for the whole city.',
    ]),
    P(extra[b.code] || ''),
  ];
}

function sectionUpkeep(b) {
  return {
    id: 'upkeep', num: 5, title: T[5], tab: 'UPKEEP', pages: 2,
    blocks: [
      BOX('ACTION', 'YOUR UPKEEP: {UPKEEP}, EVERY ROUND', [
        'Taken automatically from INVENTORY the moment the next round starts. The whole bill or none of it. Short by even one unit: nothing is taken and you lose {PENALTY} Health.',
      ]),
      TABLE(['QUESTION', 'ANSWER'], [
        ['What is upkeep?', 'The Power and Water {CODE} burns to stay alive for one round.'],
        ['How much?', '{UPKEEP}. The NEXT UPKEEP panel on the console shows the exact bill, including anything an Agriculture trade-off has added to it. In brownout the bill is halved to {UPKEEP_HALF}.'],
        ['When is it taken?', 'When the next round is started from the control desk, for the round that just ended. The first bill can come as early as the start of Round 1.'],
        ['Is there an upkeep countdown?', 'No. There is no separate upkeep clock. **Round time** is your only warning: when it is low, the next bill is near. Upkeep is not taken when the clock reaches 00:00; it is taken when the next round actually starts.'],
        ['Automatic, or do we submit it?', 'Automatic. Nobody declares, delivers or submits anything. The console takes it and tells you what happened.'],
        ['If we have enough', 'Exactly {UPKEEP} leave INVENTORY. The panel shows **UPKEEP PAID — Sector stable.** Move those chits off the table.'],
        ['If we do not have enough', 'Nothing is taken. The panel shows **UPKEEP SHORTFALL — -{PENALTY} SECTOR HEALTH.** Your stock is unchanged and your Health is {PENALTY} lower, once for that round. Status shows **SHORTFALL** in advance, with what is missing.'],
        ['Who looks after it?', 'Engineers count the stock and say when it is short. The Liaison trades for it. The Chief decides whether to pay in stock or in Health. The Systems Lead reads the result after every round change.'],
        ['What if we are DARK?', 'A DARK sector pays no upkeep and generates nothing. Pay the restart instead (§4).'],
        ['How do we prepare?', 'Before the round clock is low: {UPKEEP} in INVENTORY, plus whatever your open repairs need. Trade early; TRN has {TRN_APPROVALS} approvals a round for the whole city, and a request takes two other sectors to complete.'],
      ], [2600, 6426], { small: true, boldFirst: true }),
      H('The cycle, every round'),
      FLOW(['NOW: operate', 'Round time low: secure {UPKEEP}', 'Next round starts: upkeep taken', 'Read the NEXT UPKEEP result', 'Reconcile chits with INVENTORY', 'Continue']),
      BREAK(),
      H('Production'),
      ...productionBlocks(b),
      H('Where stock appears'),
      P('Everything that enters or leaves {CODE} shows in INVENTORY on the console: generated output, repair materials spent, rewards paid, upkeep taken, transfers delivered. The console is the official count. The chits on the table mirror it: after every repair, trade, GENERATE and round change, move the chits so the table matches the screen.'),
      BOX('NEWROUND', 'NEW ROUND — CHECK THESE NOW', [
        '**1. Upkeep was taken automatically.** Read the result line under NEXT UPKEEP: PAID, or SHORTFALL and −{PENALTY} Health. Move the chits.',
        RULES.generator.sectors.includes(b.code)
          ? '**2. Production is available again.** Press GENERATE in ROUND OUTPUT and add the chits. A pending generator upgrade has just completed and its crew is back.'
          : '**2. Production.** {CODE} has none. POW and WTR are generating now: this is the moment to trade for Power and Water.',
        '**3. Workers.** Crew held for an upgrade or an emergency restart is released. MED\'s automatic recovery may have returned {RECOVER_N} injured worker somewhere in the city. A worker you lent out does not come back by itself.',
        '**4. Abilities refresh.** TRN has {TRN_APPROVALS} approvals again, MED has {MED_HEALS} heals, AGR has {AGR_CARDS} new cards, POW and WTR may start one upgrade.',
        '**5. Trading carries over.** Requests and transfers still open stay open; the round change cancels nothing. Only an unanswered freight-slot offer from AGR to TRN lapses.',
        '**6. Check now:** Health and status; ACTIVE FAULTS, which are still bleeding; INVENTORY against the chits; any CITY DECISION, NOTICE or alert banner; the big screen.',
      ]),
    ],
  };
}

function consoleSectorRows(b) {
  const code = b.code;
  const rows = {
    POW: [
      ['ROUND OUTPUT', 'Your generated Power this round, and GENERATE POWER.', 'Press it once a round. §5.'],
      ['GENERATOR', 'Installed level, output, the next level\'s cost, SUPPORT needed.', 'START UPGRADE when you can pay it; CANCEL UPGRADE loses 1 Part. §5.'],
      ['TECHNICAL SUPPORT (RESOURCE EXCHANGE page)', 'WTR is asking for your PUMP LOAD SUPPORT for its Level 5.', 'CONFIRM SUPPORT if you agree. It costs you nothing but a decision.'],
    ],
    WTR: [
      ['ROUND OUTPUT', 'Your generated Water this round, and GENERATE WATER.', 'Press it once a round. §5.'],
      ['GENERATOR', 'Installed level, output, the next level\'s cost, SUPPORT needed.', 'START UPGRADE when you can pay it; CANCEL UPGRADE loses 1 Part. §5.'],
      ['TECHNICAL SUPPORT (RESOURCE EXCHANGE page)', 'POW is asking for your COOLING CALIBRATION SUPPORT for its Level 5.', 'CONFIRM SUPPORT if you agree. It costs you nothing but a decision.'],
    ],
    MED: [
      ['HEALING THIS ROUND', 'Your allowance: n / {MED_HEALS} USED · n LEFT, and the HEALING QUEUE: one row per injured worker any sector has asked you to heal.', 'HEAL returns that worker to its sector at once. DECLINE refuses; it costs nothing. Rows marked NO LONGER INJURED need nothing.'],
      ['Automatic recovery', 'Not a panel: at each round change the engine returns {RECOVER_N} injured worker in the city and spends {RECOVER_MED} ⚕ from your INVENTORY, if you have one.', 'Keep at least one ⚕ if you want it to happen.'],
    ],
    TRN: [
      ['TRANSFER CONTROL (your RESOURCE EXCHANGE page)', 'Same page as everyone else\'s, plus TRANSFER APPROVALS: the allowance dots, n / {TRN_APPROVALS} USED, and PENDING APPROVALS, one card per transfer waiting for you.', 'CONFIRM CHIT, then APPROVE or DECLINE. §9A.'],
      ['Freight-slot proposal from AGR', 'A card in NEEDS MY ACTION: AGR offers you +1 approval this round against −1 next round.', 'ACCEPT or DECLINE. Unanswered, it lapses when the round changes.'],
    ],
    AGR: [
      ['INTERVENTIONS THIS ROUND', '{AGR_CARDS} RANDOM CARDS · CHOOSE 1. Each card: a situation, then GAIN and, from {AGR_FROM}, TRADE-OFF, with who it affects. Some cards ask you to choose a sector or a resource first.', 'Select a card, choose its target if it asks, press its confirm button. One decision a round; it is then LOCKED UNTIL NEXT ROUND. The DECISION RESULT block shows what happened.'],
      ['RELEASE THE FREIGHT SLOT', 'The one card that needs another sector: TRN answers on its own console.', 'Confirm it, then wait. PENDING TRN APPROVAL until TRN accepts or declines; if TRN never answers, the offer lapses at the round change and nothing is spent.'],
      ['AGRICULTURE OPERATING NOTICE', 'A notice that covers the console once, the first round your cards carry a TRADE-OFF.', 'Read it, press ACKNOWLEDGE.'],
    ],
    COM: [
      ['CITY FEED', 'Every sector as your sensors read it, live: Health, status, open faults. FULL TELEMETRY. No other sector sees this.', 'Decide what to pass on in person and what to publish. A fault you see on another sector\'s feed is already on that sector\'s own console.'],
      ['CITY INTELLIGENCE', 'Readings the sensor grid files for you alone. TELEMETRY DEGRADED marks a reading you cannot trust.', 'Private until you put it on the big screen. In brownout the feed goes dark.'],
      ['CITY BIG SCREEN CONTROL (own page)', 'CITY BOARD: the figures the big screen reports for each sector, stamped with the round you published them in. CITY BROADCAST: one headline and message for the whole city. SECTOR FOCUS: eight seconds of emphasis on one sector.', 'Fill a sector\'s row and PUBLISH it; write a broadcast and PUBLISH, or CLEAR. Nothing here changes any sector\'s real state. The other sectors\' consoles show CITY ANNOUNCEMENT UPDATED when you publish.'],
      ['The City Charter', 'The paper governance document, held at this station.', 'Produce it on request of any Chief. §10.'],
    ],
  };
  return (rows[code] || []).map((r) => r.map((c) => fill(c, b)));
}

function agrDeckBlocks() {
  const rows = RULES.agr.cards.map((c) => [
    c.title + (c.needs_trn ? ' *' : ''),
    c.gain.join(' · '),
    c.trade_off.length ? c.trade_off.join(' · ') : 'none',
    c.risk || '—',
  ]);
  return [
    H('Your intervention deck'),
    P(`Every card you can be dealt, with the GAIN and the TRADE-OFF it carries from {AGR_FROM} (before that, the GAIN alone). Which three you hold each round is random. The console prints each card's exact figures when it is dealt; this table is for planning. * needs TRN's agreement.`),
    TABLE(['CARD', 'GAIN', 'TRADE-OFF (FROM {AGR_FROM})', 'RISK'], rows, [2600, 2500, 3126, 800], { small: true, boldFirst: true }),
  ];
}

function sectionConsole(b) {
  const sectorRows = consoleSectorRows(b);
  const extraPages = b.code === 'AGR' ? 1 : 0;   // the deck table
  return {
    id: 'console', num: 6, title: T[6], tab: 'CONSOLE', pages: 2 + extraPages,
    blocks: [
      P('One console per station, three columns under a header. Left: what you have. Centre: what is broken. Right: what only {CODE} does. The deck under the header switches pages: **OVERVIEW** and **RESOURCE EXCHANGE**' + (b.code === 'TRN' ? ' (called TRANSFER CONTROL on your console)' : '') + (b.code === 'COM' ? ', and **CITY BIG SCREEN CONTROL**' : '') + '. The badge on a page counts what needs your answer.'),
      TABLE(['SCREEN ITEM', 'WHAT IT MEANS', 'WHAT YOU DO'], [
        ['System status', 'STABLE, DEGRADED, CRITICAL, BROWNOUT or DARK. §4 explains each.', 'Read it after every round change and every fault.'],
        ['Health', '0 to 100 with a bar. Your sector\'s condition. Faults lower it; repairs stop the fall.', 'Keep it above {CRIT}. At {DARK} you are DARK.'],
        ['Current round', 'The round number. It changes only when the control desk starts the next round.', 'When it changes, run the NEW ROUND box in §5.'],
        ['Round time', 'This round\'s clock, counting down. Turns amber under two minutes and red under thirty seconds. Stops at 00:00.', 'Use it to pace trades and upkeep. Nothing happens at 00:00 by itself.'],
        ['Connection dot', 'LIVE, DELAYED or RECONNECTING.', 'If RECONNECTING persists for minutes, tell the control desk.'],
        ['Banner strip', 'Alerts, NOTICE TO {CODE}, CITY ANNOUNCEMENT UPDATED, COUNCIL IN SESSION with its clock, SECTOR BROWNOUT, requests needing your answer (VIEW), repair results.', 'Read every banner. §4.'],
        ['INVENTORY', 'Your official stock: ⚡ 💧 🔧 ⚕ counters, then WORKERS available / total with notes such as INJURED, LOANED OUT, BORROWED, HELD BACK (BROWNOUT).', 'Keep the chits and tokens on the table matching these numbers. You cannot edit them here.'],
        ['INJURED WORKERS', 'Appears when a worker is hurt: how many, and how many are NOT YET WITH MEDICAL.', 'Press REQUEST MED HEALING for each. §8.'],
        ['TACTICAL OPPORTUNITIES', 'Appears when you hold a token earned as a REPAIR REWARD: RESERVE CREW, SECOND CHANCE, EMERGENCY REPAIR KIT, STABILISER.', 'Open the fault card it is for, then press the token\'s button. §8.'],
        ['NEXT UPKEEP', 'The bill the next round change will take, its Status (READY or SHORTFALL and what is short), and the last result line.', 'Make Status read READY before the round clock is low. §5.'],
        ['ACTIVE FAULTS', 'One row per open fault: code, name, severity pips, decay. NO ACTIVE FAULTS — systems nominal when clear.', 'Click a row to open its card. §7.'],
        ['The fault card', 'Code, name, what the sensors report, ▲ INCIDENT / ▲▲ EMERGENCY / ▲▲▲ CRISIS, TIME-CRITICAL where it applies, DECAY −x HEALTH / MIN, REPAIR REWARD.', 'Everything about how to fix it is in this binder, never on the screen.'],
        ['REPAIR READINESS', 'MATERIALS ✓ READY or ⚠ NOT READY against the procedure\'s materials; WORKERS ✓ ASSIGNED or ⚠ NONE ASSIGNED.', 'Both green before you submit. The card never says which materials: that is §13.'],
        ['Resolution code · Workers assigned · SUBMIT REPAIR', 'Where the repair is entered: the code in the procedure\'s CODE FORMAT, the crew count (0 to your available workers), one button.', 'Systems Lead types, chooses, submits. §7.'],
        ['Console message · ATTEMPTS', 'The console\'s answer (ACCEPTED, RESOLUTION REJECTED, INSUFFICIENT CREW, MATERIALS NOT READY — CHECK YOUR BINDER, CONSOLE LOCKED mm:ss) and the count of wrong codes on this fault.', '§7 lists every message and what to do.'],
      ], [2500, 3800, 2726], { small: true, boldFirst: true }),
      TABLE(['SCREEN ITEM', 'WHAT IT MEANS', 'WHAT YOU DO'], [
        ['ACTIVE EFFECTS', 'Temporary conditions on {CODE}: NO ROUND OUTPUT, WORKER ON LOAN, EXTRA WORKER, TRANSPORT CAPACITY REDUCED, TELEMETRY OFFLINE, and how long each lasts.', 'Plan around them; they end by themselves.'],
        ['RECENTLY RESOLVED', 'Your last repairs, with the reward each paid.', 'Log them.'],
        ['EMERGENCY SHUTDOWN', 'OVERVIEW page, only while you are DARK, above the SECTOR OFFLINE screen: the restart\'s cost, crew, and what you have.', 'EMERGENCY RESTART when you can pay. §4.'],
        ['RESOURCE EXCHANGE page', 'Tiles: NEEDS MY ACTION, WAITING, OUTGOING, HISTORY. One card per request, following it from WAITING FOR SUPPLIER through SUPPLIER ACCEPTED and WAITING FOR TRN to APPROVED BY TRN and DELIVERED, or DECLINED, TRN DECLINED, CANCELLED.', '+ NEW REQUEST to ask another sector. FULFILL or DECLINE what is asked of you. WITHDRAW your own request while it is still waiting for the supplier. §9.'],
        ['NEW REQUEST form', 'REQUEST FROM (sector), RESOURCE (⚡ POWER, 💧 WATER, 🔧 PARTS, ⚕ MEDICAL, 👤 WORKERS), QUANTITY, SEND REQUEST.', 'Send only what the Liaison has agreed in person; the supplier still has to accept.'],
        ['Full-screen overlays', 'A city alert for a few seconds; a red wash while CRITICAL; SECTOR OFFLINE while DARK; SIMULATION PAUSED while every clock is frozen.', 'Only DARK locks anything. §4.'],
      ], [2500, 3800, 2726], { small: true, boldFirst: true }),
      H('THIS SECTOR ONLY: {CODE}\'s own panels'),
      TABLE(['PANEL', 'WHAT IT MEANS', 'WHAT YOU DO'], sectorRows, [2500, 3800, 2726], { small: true, boldFirst: true }),
      ...(b.code === 'AGR' ? agrDeckBlocks() : []),
    ],
  };
}

function sectionFault(b) {
  return {
    id: 'fault', num: 7, title: T[7], tab: 'FAULT', pages: 2,
    blocks: [
      STEPS([
        'A new row appears in **ACTIVE FAULTS** and the console sounds an alert. Click it. Read the code (F-nnn), the name, the severity and the **DECAY** rate. The fastest bleed is worked first.',
        'Systems Lead: find the code in **§12 FAULT CODE INDEX**. A fault on your own console is always yours.',
        'A code you are told or shown that sits in a **shaded ESCALATE TO** row is not yours: the Liaison tells that sector\'s station the code. Enter nothing.',
        'Your row names a **Procedure P-nn**. Open it in **§13** and read it aloud, all of it.',
        '**CREW**: the minimum workers. Check WORKERS available in INVENTORY. Short? Borrow one (§9) or arm a RESERVE CREW token (§8).',
        '**MATERIALS**: INVENTORY must hold them. Stage the chits on the table. REPAIR READINESS shows MATERIALS ✓ READY when the console agrees.',
        '**Values**: each step names a table and a row. "YOUR Table" is in your §14.',
        'A value "not held in this binder": the Liaison goes to the sector named, asks for the exact row by name, and brings back the three digits written down. That sector may refuse, delay or bargain; that is their call. If they answer with another sector\'s name instead of a number, that is a REFERENCE: follow it to the sector named and ask there.',
        'Engineers stage the workers and materials. Nothing is spent until the code is accepted.',
        'Build the code exactly as **CODE FORMAT** shows: the procedure, then each three-digit value, joined by hyphens.',
        'On the console: type the code, set **Workers assigned** to at least CREW, press **SUBMIT REPAIR**.',
        '**Accepted**: a green banner, the fault moves to RECENTLY RESOLVED, the materials leave INVENTORY, the REPAIR REWARD is paid, the workers are free again at once. Move the chits off the table. Log it.',
        '**Rejected**: read the message in the table below. Re-verify the source before trying again. Never guess.',
        '**{LOCK_N} wrong codes in a row** lock the console for **{LOCK_S} seconds**. A refusal for crew or materials does not count. A SECOND CHANCE token forgives one rejection.',
        'Afterwards: reconcile INVENTORY with the table, and write the fault, the decision and who agreed in §15.',
      ]),
      BREAK(),
      H('What the console says, and what to do'),
      TABLE(['CONSOLE SAYS', 'IT MEANS', 'DO THIS'], [
        ['RESOLUTION REJECTED', 'The code is wrong: a wrong value, a wrong table, a typo, or a value another sector misread.', 'Re-verify the row name and the sector. Resubmit once you are sure. ATTEMPTS counts these.'],
        ['INSUFFICIENT CREW', 'Workers assigned is below the procedure\'s CREW.', 'Assign more, borrow, or arm RESERVE CREW. Not counted as a wrong code.'],
        ['MATERIALS NOT READY — CHECK YOUR BINDER', 'INVENTORY lacks something the procedure lists.', 'Trade for it (§9) or arm EMERGENCY REPAIR KIT. Not counted as a wrong code.'],
        ['WORKER ASSIGNMENT INVALID', 'The count is not a valid number of available workers.', 'Choose again from the list.'],
        ['CONSOLE LOCKED mm:ss', '{LOCK_N} wrong codes in a row.', 'Use the {LOCK_S} seconds to verify the source. Then resubmit.'],
        ['NO MATCHING PROCEDURE — VERIFY THIS ALERT', 'The console holds no repair for this alert.', 'Stop entering codes. Log it, tell COM, and work the faults you can repair.'],
        ['SECTOR IS DARK', 'Health is {DARK}. Repairs are locked.', 'EMERGENCY RESTART first (§4).'],
      ], [2700, 3200, 3126], { small: true, boldFirst: true }),
      BOX('REMEMBER', 'REPAIR REWARD', ['Every fault card names its reward: a resource unit, +5 HEALTH, or a tactical token. It is paid once, when the code is accepted, never before. A reward can never fund the repair that earns it.']),
      BOX('WARNING', 'TIME-CRITICAL', ['A fault marked TIME-CRITICAL bleeds Health faster than any other on the board. Nothing counts down; it simply costs more every minute it stays open. Work it ahead of anything that can wait.']),
    ],
  };
}

function sectionResources(b) {
  const tokenRows = Object.values(RULES.tokens).map((t) => [t.label, t.effect, `${t.use}, ${t.timing}.`]);
  return {
    id: 'resources', num: 8, title: T[8], tab: 'STOCK', pages: 2,
    blocks: [
      TABLE(['RESOURCE', 'WHAT IT IS', 'WHERE IT COMES FROM'], [
        ['⚡ Power Cells', 'Upkeep every round, and most repairs.', 'Generated by POW only. Rewards, AGR interventions, trades.'],
        ['💧 Water Units', 'Upkeep every round, and many repairs.', 'Generated by WTR only. Rewards, AGR interventions, trades.'],
        ['🔧 Spare Parts', 'Repairs, generator upgrades, the emergency restart.', 'Nobody generates them. Opening stock, rewards, AGR interventions, trades. The city\'s scarcest resource.'],
        ['⚕ Med Supplies', 'Some repairs. MED\'s automatic recovery spends {RECOVER_MED} per worker returned.', 'Nobody generates them. Opening stock, rewards, AGR interventions, trades.'],
        ['👤 Workers', 'Crew for repairs, upgrades and the restart. {START_WORKERS} per sector at the start.', 'Injured by some faults; healed by MED; lent between sectors by Transfer Chit.'],
      ], [2000, 3400, 3626], { small: true, boldFirst: true }),
      BOX('REMEMBER', 'THE CONSOLE IS THE OFFICIAL COUNT', ['The chits and tokens on your table mirror INVENTORY; they are not a second ledger. After every repair, trade, GENERATE and round change, move the chits so the table matches the screen. You cannot edit INVENTORY; if the two disagree, the console wins.']),
      H('Spending'),
      P('Repair materials leave INVENTORY only when a code is accepted; a rejected code costs nothing. Upkeep is taken at the round change. A generator upgrade and an emergency restart are paid when you press their button. A transfer leaves you when TRN approves it.'),
      H('Workers'),
      P('**Workers assigned** on a repair is a count, chosen when you submit. The crew is free again the moment the repair is accepted; nobody is held afterwards. Workers are held, and shown as unavailable, by: a generator upgrade and an emergency restart (until the round ends), a brownout ({BROWN_WORKERS} held back), an Agriculture trade-off that takes a worker for the round, and a loan to another sector.'),
      H('Injuries and healing'),
      STEPS([
        'Some faults injure workers the moment they appear. WORKERS available drops, the INJURED WORKERS panel appears, and the console says how many are NOT YET WITH MEDICAL. The tokens stay at your station: turn them face down.',
        'Press **REQUEST MED HEALING** for each injured worker. The request goes to MED\'s HEALING THIS ROUND queue. No chit, no Transport.',
        'MED presses **HEAL**: the worker returns to AVAILABLE at once. MED heals at most {MED_HEALS} workers a round across the whole city and may DECLINE.',
        'At each round change MED\'s automatic recovery returns {RECOVER_N} injured worker somewhere in the city, if MED holds a ⚕ to spend on it.',
      ]),
      BREAK(),
      H('Borrowing a worker'),
      P('A worker moves between sectors exactly like a resource: a request with RESOURCE 👤 WORKERS, the supplier\'s FULFILL, a signed Transfer Chit, TRN\'s approval (§9). The token changes hands when the console shows DELIVERED. The console then shows LOANED OUT or BORROWED. A borrowed worker never returns by itself: send one back the same way.'),
      H('Tactical tokens'),
      TABLE(['TOKEN', 'EFFECT', 'HOW TO USE IT'], tokenRows, [2300, 3400, 3326], { small: true, boldFirst: true }),
    ],
  };
}

function sectionTrade(b) {
  const sample = {
    no: '0417', from: 'WTR', to: 'AGR', resources: '2 💧', workers: '—', exchange: '1 🔧 Part (separate request, AGR → WTR)',
    sending: 'R. Halim (WTR)', receiving: 'T. Wong (AGR)', time: '00:42 · Round 2', stamp: 'TRN ✓',
  };
  return {
    id: 'trade', num: 9, title: T[9], tab: 'TRADE', pages: 2,
    blocks: [
      BOX('ACTION', 'EVERY TRANSFER NEEDS ALL THREE', [
        '**1** A request on the console, fulfilled by the supplier. **2** A paper Transfer Chit signed by both Liaisons. **3** Transport\'s approval and stamp. Without any one of them nothing has moved, whatever anyone agreed. Only the Liaison leaves the station to do this.',
      ]),
      H('Worked example: AGR needs 2 💧 Water from WTR and offers 1 🔧 Part'),
      STEPS([
        'AGR\'s Liaison walks to WTR and agrees the deal with WTR\'s Liaison: 2 Water for 1 Part.',
        'AGR console: **RESOURCE EXCHANGE → + NEW REQUEST**. REQUEST FROM: WTR. RESOURCE: 💧 WATER. QUANTITY: 2. **SEND REQUEST**. The card reads WAITING FOR SUPPLIER.',
        'WTR console: a banner with VIEW. **NEEDS MY ACTION → FULFILL** (only possible while WTR holds 2 Water) or DECLINE. The card reads SUPPLIER ACCEPTED, then WAITING FOR TRN.',
        'The two Liaisons fill in one Transfer Chit: FROM WTR, TO AGR, RESOURCES 2 💧, IN EXCHANGE FOR 1 🔧, both signatures, the time.',
        'A Liaison carries the chit to Transport.',
        'TRN: in TRANSFER APPROVALS, finds the card WTR → AGR, presses **CONFIRM CHIT** with the signed paper in hand, stamps the paper, presses **APPROVE**. TRN has {TRN_APPROVALS} approvals a round and may DECLINE.',
        'Both consoles: APPROVED BY TRN, then **DELIVERED**. 2 Water have left WTR\'s INVENTORY and arrived in AGR\'s. Now, and only now, the 2 💧 chits move from WTR\'s table to AGR\'s.',
        'The return leg is its own transfer: WTR requests 1 🔧 from AGR, AGR fulfils, the same chit goes back to TRN for a second CONFIRM CHIT and APPROVE. A swap costs two of TRN\'s approvals.',
        'Copies: the white copy goes to the receiving sector, the duplicate stays with the sender. TRN keeps nothing but the count.',
        'Both sectors check INVENTORY against the table and write the deal in §15.',
      ]),
      BREAK(),
      CHIT(sample),
      TABLE(['RULE', 'DETAIL'], [
        ['Who may negotiate', 'The Liaison, in person. The console sends and answers requests; it never carries a conversation.'],
        ['When a chit is valid', 'Signed by both Liaisons and stamped by TRN. Unstamped chits are void: tear them up.'],
        ['When chits move', 'When the console shows DELIVERED, never before. The console moves the stock; the paper follows it.'],
        ['Withdrawing', 'WITHDRAW your own request while it reads WAITING FOR SUPPLIER. Once fulfilled, only the supplier can withdraw it or TRN decline it.'],
        ['Stock', 'A supplier cannot fulfil what it does not hold, and TRN cannot approve a transfer the supplier can no longer cover: SUPPLIER SHORT OF STOCK — NOTHING MOVED.'],
        ['Round changes', 'Open requests and transfers carry over. TRN\'s approvals refresh to {TRN_APPROVALS}.'],
        ['Workers', 'Lent exactly the same way, RESOURCE 👤 WORKERS. The token changes hands at DELIVERED. §8.'],
      ], [2300, 6726], { small: true, boldFirst: true }),
    ],
  };
}

function sectionStamp(b) {
  if (b.code !== 'TRN') return null;
  return {
    id: 'stamp', num: '9A', title: T['9A'], tab: 'STAMP', pages: 1,
    blocks: [
      BOX('ACTION', 'NOTHING MOVES IN HAVEN-9 WITHOUT YOUR APPROVAL', [
        'Every transfer between any two sectors, including the ones that bring Transport its own Power and Water, waits in your TRANSFER APPROVALS until you act. {TRN_APPROVALS} approvals a round for the whole city. The rubber stamp is yours; VOID WITHOUT STAMP is printed on every chit.',
      ]),
      H('Your TRANSFER CONTROL page'),
      P('Your RESOURCE EXCHANGE page is titled TRANSFER CONTROL and opens on WAITING APPROVAL. **TRANSFER APPROVALS** shows the allowance as dots and as n / {TRN_APPROVALS} USED, then PENDING APPROVALS: one card per transfer a supplier has fulfilled, with the route, the item, and CHIT: CHECK REQUIRED.'),
      STEPS([
        'A Liaison hands you the paper chit. Check it: FROM, TO, the item and quantity, **both** Liaison signatures. A chit with one signature waits.',
        'Find the matching card. The route and item on the card must match the paper. If they do not, the console is right: send the Liaison back.',
        'Press **CONFIRM CHIT**. The button reads CHIT ✓ IN HAND. Stamp the paper chit now.',
        'Press **APPROVE**, then CONFIRM APPROVAL. The stock moves between the two INVENTORY panels at once and the card reads DELIVERED. One approval is used.',
        'Or press **DECLINE**, then CONFIRM DECLINE. Nothing moves, no approval is used, both sectors see TRN DECLINED. You owe nobody a reason.',
        'Hand the stamped paper back. White copy to the receiver, duplicate to the sender.',
      ]),
      TABLE(['CONSOLE SAYS', 'IT MEANS'], [
        ['CHIT REQUIRED BEFORE APPROVAL', 'You pressed APPROVE without CONFIRM CHIT. The paper comes first.'],
        ['APPROVAL CAPACITY REACHED — NEW APPROVALS AVAILABLE NEXT ROUND', 'All {TRN_APPROVALS} approvals are used. Waiting transfers keep waiting; they are not lost.'],
        ['SUPPLIER SHORT OF STOCK — NOTHING MOVED', 'The supplier spent the stock after fulfilling. Nothing moved, no approval used. Send the Liaison back to the supplier.'],
        ['TRANSPORT DARK — CANNOT APPROVE', 'You are DARK. Nobody in the city can trade until you restart (§4).'],
        ['A freight-slot card from AGR in NEEDS MY ACTION', 'AGR offers +1 approval this round for −1 next round. ACCEPT or DECLINE; unanswered, it lapses at the round change.'],
      ], [4000, 5026], { small: true, boldFirst: true }),
      BOX('WARNING', 'IN BROWNOUT YOU HAVE {BROWN_TRN} APPROVAL A ROUND', ['Choose it carefully. Every sector will say theirs is the one that matters.']),
      BOX('REMEMBER', 'YOUR OWN TRADES PASS THROUGH THE SAME QUEUE', ['Transport approves transfers it is a party to like any other. Your Liaison still signs the chit; you still confirm and approve it; it still uses one of the {TRN_APPROVALS}.']),
    ],
  };
}

function sectionCouncilAndIdle(b) {
  return {
    id: 'council', num: 10, title: T[10], tab: 'COUNCIL', pages: 1, second: { num: 11, title: T[11] },
    blocks: [
      BOX('ACTION', 'COUNCIL IN SESSION — CHIEF + LIAISON REPORT TO CENTRAL COUNCIL', [
        'When that banner shows on the console, the **Sector Chief and the Liaison go to the central Council table immediately**. Everyone else stays at the station and keeps operating: faults keep bleeding and the round clock keeps running.',
        'Watch the **Council clock** on the console banner. **The sitting ends when it reaches 00:00** and the banner reads COUNCIL TIME EXPIRED. Matters unresolved at the close stand unresolved.',
        'Do not go to Council unless it is called. Do not send anyone else.',
      ]),
      KV([
        ['Seats and voices', 'One seat and one voice per sector, held by its Chief. A sector whose Chief is absent has no voice for that sitting. Liaisons attend and may speak; they hold no seat.'],
        ['Decisions', 'Bind every sector, including sectors that opposed or abstained. There is no appeal.'],
        ['Transfers', 'Never need Council approval. They need the ordinary chit, the console request and TRN\'s stamp (§9), before, during and after a sitting.'],
        ['Core insufficiency', 'If the Authority declares the Core cannot sustain every sector, the Council completes a Continuity Order ranking all six and hands it in before the sitting closes. The lowest-ranked go to brownout and keep playing; no order before the close means rolling blackouts for everyone. The City Charter, held at the COM station, has the form; any Chief may ask for it.'],
        ['Records', 'The Council may call for any sector\'s Station Operations Log at any time. Keep §15 current.'],
      ], { keyWidth: 2400 }),
      { t: 'subsection', num: 11, title: T[11] },
      CHECK([
        'Check NEXT UPKEEP. Status must read READY before the round clock is low.',
        'Check whether you hold {UPKEEP} plus what your open repairs need. If not, start a trade now.',
        'Count the chits and tokens against INVENTORY and WORKERS. Fix the table.',
        'Check WORKERS available and injured. Request healing for anyone still NOT YET WITH MEDICAL.',
        'Open RESOURCE EXCHANGE: answer anything in NEEDS MY ACTION, chase anything in WAITING.',
        'Ask the Liaison what other sectors have asked for: a value from §14, a part, a worker. Decide what you will give.',
        'Write up the last fault, decision and trade in §15.',
        'Plan the trades you will need next round and send the Liaison early. TRN\'s approvals run out.',
        'Review your own panel: ' + ({ POW: 'GENERATE POWER pressed this round? Upgrade worth starting?', WTR: 'GENERATE WATER pressed this round? Upgrade worth starting?', MED: 'anyone in the HEALING QUEUE? Enough ⚕ for the automatic recovery?', TRN: 'anything in PENDING APPROVALS? Approvals left this round?', AGR: 'which card is worth its trade-off this round, and for whom?', COM: 'anything the city should know? Board rows stale? A broadcast due?' }[b.code] || ''),
        'Watch the banner strip and the big screen.',
      ]),
    ],
  };
}

// ---------------------------------------------------------------- assembly
function manualFor(b) {
  const sections = [
    sectionStart(b), sectionJob(b), sectionRoles(), sectionShift(b), sectionUpkeep(b),
    sectionConsole(b), sectionFault(b), sectionResources(b), sectionTrade(b), sectionStamp(b),
    sectionCouncilAndIdle(b),
  ].filter(Boolean);
  return { front: quickReferencePage(b), sections, back: quickReferencePage(b, { back: true }) };
}

/**
 * The page each section starts on. The cover is page 1 and the quick reference
 * page 2; every section declares the pages it is laid out for and starts on a
 * fresh page, so the numbers are arithmetic, not a guess, as long as nothing
 * overflows its declared pages — which the kit build checks with Word.
 */
function pagePlan(manual, reference) {
  let page = 3;
  const plan = [];
  for (const s of manual.sections) {
    plan.push({ id: s.id, num: s.num, title: s.title, page, pages: s.pages });
    if (s.second) plan.push({ id: `${s.id}-2`, num: s.second.num, title: s.second.title, page, pages: 0 });
    page += s.pages;
  }
  for (const r of reference || []) {
    plan.push({ id: r.id, num: r.num, title: r.title, page, pages: r.pages });
    page += r.pages;
  }
  plan.push({ id: 'quick-back', num: null, title: QUICK_TITLE, page, pages: 1 });
  return plan;
}

module.exports = {
  RULES, SECTOR_JOB, ROLES, TITLES: T, QUICK_TITLE, GLYPH, RES_NAME, RES_LONG, RES_ONE,
  fill, manualFor, pagePlan, quickReferenceRows, SEE,
};
