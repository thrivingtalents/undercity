'use strict';
/**
 * UNDERCITY — the nine-page sector binder (compact layout, 2026-10-05).
 *
 * The same facts as the long operating manual, as an operational quick
 * reference a table can use under time pressure: nine A4 pages, no cover, no
 * contents, no role-card text (the Role Cards carry it), no worked examples,
 * no generic steps repeated inside every procedure. The Station Operations
 * Log is a separate loose sheet.
 *
 *   1  START HERE — YOUR SECTOR            sector
 *   2  RUNNING EACH ROUND                  shared frame, this sector's refresh
 *   3  YOUR SECTOR CONTROL                 sector
 *   4  WHEN A FAULT APPEARS                shared: GET VALUE → BUILD CODE → SUBMIT
 *   5  TRADING, WORKERS & HEALING          shared
 *   6  QUICK ACTIONS & COUNCIL             shared (one own-panel line)
 *   7  FAULTS & REPAIRS — PART 1           sector: P-01 to P-05 as cards
 *   8  FAULTS & REPAIRS — PART 2           sector: P-06 to P-10 as cards, ESCALATE TO
 *   9  SPECIFICATIONS, REFERENCES & AUTHORISATIONS   sector, values unchanged
 *
 * Every number is read from the scenario and the engine through
 * binder_rules.js (RULES); every fault card, value and reference comes from
 * binder_content.json, which the assembler derives from the matrix and the
 * generated decks. Nothing here is typed by hand that the engine also knows.
 */
const rules = require('./binder_rules');

const { RULES, SECTOR_JOB, GLYPH, RES_NAME, fill } = rules;

// block constructors — the same content model build_binders.js renders
const P = (text, o = {}) => ({ t: 'p', text, ...o });
const H = (text) => ({ t: 'h', text });
const STEPS = (items, o = {}) => ({ t: 'steps', items, ...o });
const TABLE = (head, rows, widths, o = {}) => ({ t: 'table', head, rows, widths, ...o });
const KV = (rows, o = {}) => ({ t: 'kv', rows, ...o });
const BOX = (kind, title, lines) => ({ t: 'box', kind, title, lines });
const FLOW = (steps, o = {}) => ({ t: 'flow', steps, ...o });

const TITLES = {
  1: 'START HERE — YOUR SECTOR',
  2: 'RUNNING EACH ROUND',
  3: 'YOUR SECTOR CONTROL',
  4: 'WHEN A FAULT APPEARS',
  5: 'TRADING, WORKERS & HEALING',
  6: 'QUICK ACTIONS & COUNCIL',
  7: 'FAULTS & REPAIRS — PART 1',
  8: 'FAULTS & REPAIRS — PART 2',
  9: 'SPECIFICATIONS, REFERENCES & AUTHORISATIONS',
};
const SECTOR_PAGE_TITLE = {
  POW: 'POWER PRODUCTION & GENERATOR',
  WTR: 'WATER PRODUCTION & GENERATOR',
  MED: 'HEALING CONTROL',
  TRN: 'TRANSFER CONTROL',
  AGR: 'INTERVENTIONS',
  COM: 'CITY INFORMATION CONTROL',
};

/** "1×Parts, 1×Water" or "2 Parts, 1 Water" → "1 🔧 Parts + 1 💧 Water", quantities untouched. */
function materials(text) {
  const key = { parts: 'parts', power: 'power', water: 'water', med: 'med', medical: 'med' };
  return String(text).split(',').map((part) => {
    const m = /(\d+)\s*[×x]?\s*([A-Za-z]+)/.exec(part.trim());
    if (!m) return part.trim();
    const k = key[m[2].toLowerCase()];
    return k ? `${m[1]} ${GLYPH[k]} ${RES_NAME[k]}` : part.trim();
  }).join(' + ');
}

// ---------------------------------------------------------------- the generator in brownout
/**
 * What the engine actually yields in brownout: economy.productionFor floors
 * output × the sector's multiplier (the per-sector override wins), at full
 * Core. Derived here so the binder prints the engine's figure, never a word
 * like "halved" or "a quarter" that the arithmetic may not match.
 */
function brownoutMultiplier(code) {
  const per = (RULES.brownout.per_sector || {})[code] || {};
  return Number(per.production_multiplier ?? RULES.brownout.production_multiplier ?? 0.5);
}
function brownoutOutput(code, output) {
  return Math.floor(Number(output) * brownoutMultiplier(code));
}
/** One sentence, identical wherever brownout is mentioned for a generator sector. */
function brownoutRule(b) {
  const gen = RULES.generator.enabled && RULES.generator.sectors.includes(b.code);
  const output = gen
    ? 'output falls to the BROWNOUT column of the generator table on p.3'
    : 'no output is affected ({CODE} generates none)';
  const own = { TRN: '; Transport keeps {BROWN_TRN} approval a round', COM: '; the telemetry feed goes dark' }[b.code] || '';
  return `Brownout: ${output}; upkeep halves to {UPKEEP_HALF}; {BROWN_WORKERS} workers are held back; Health bleeds {BROWN_DECAY} a minute${own}.`;
}

// ---------------------------------------------------------------- page 1
function pageStart(b) {
  const j = SECTOR_JOB[b.code];
  return {
    num: 1, title: TITLES[1], blocks: [
      P('The surface has been uninhabitable for forty years. HAVEN-9 survives three hundred metres underground on six interdependent sector systems and a geothermal Core that began to degrade this morning.'),
      BOX('ACTION', 'YOUR OBJECTIVE', [
        'Keep **{NAME} ({CODE})** running until the shift ends: Health never at {DARK}, and the city supplied with what only you provide. Nobody will brief you. This binder and your sector console are the briefing.',
      ]),
      P(j.lore, { lore: true }),
      KV([
        ['{CODE} OPERATES', j.operates],
        ['{CODE} SUPPLIES OR CONTROLS', j.supplies],
        ['WHO DEPENDS ON {CODE}', j.relied.replace(' (§14)', ' (p.9)')],
        ['{CODE} DEPENDS ON', j.depends],
        ['IF {CODE} GOES DARK', j.fails],
        ['SPECIAL AUTHORITY', j.authority.replace('§9A is yours.', 'Page 3 is yours.')],
        ['OPENING STOCK', '{START_STOCK}'],
        ['STARTING WORKFORCE', '{START_WORKERS} 👤 workers · Health {START_HEALTH} · upkeep {UPKEEP} every round (p.2)'],
      ], { keyWidth: 2500 }),
      H('Start-up checklist'),
      STEPS([
        'TAKE the Role Cards and assign them: SECTOR CHIEF, LIAISON, SYSTEMS LEAD, ENGINEERS. The cards carry the duties.',
        'COUNT the chits and workforce tokens on the table: {START_STOCK}, {START_WORKERS} 👤.',
        'OPEN the sector console and click it once so sound is on. Header: status · Health · Current round · Round time. Left: INVENTORY · NEXT UPKEEP. Centre: ACTIVE FAULTS. Right: your own panel (p.3).',
        'MATCH the table to the console: INVENTORY and WORKERS {START_WORKERS} / {START_WORKERS}. The console is the official count; the chits mirror it.',
        'BEGIN operating. Each round: p.2. Your panel: p.3. A fault: p.4, then p.7–8. A trade: p.5. Anything else: p.6.',
      ]),
    ],
  };
}

// ---------------------------------------------------------------- page 2
function pageRound(b) {
  const gen = RULES.generator.enabled && RULES.generator.sectors.includes(b.code);
  const res = gen ? RES_NAME[Object.keys(RULES.production[b.code])[0]].toUpperCase() : null;
  const refresh = {
    POW: 'One generator upgrade may be started again (p.3).',
    WTR: 'One generator upgrade may be started again (p.3).',
    MED: 'Your {MED_HEALS} heals are back (p.3). Requests you did not answer are still in the queue.',
    TRN: 'Your {TRN_APPROVALS} approvals are back (p.3). Transfers you did not answer are still waiting.',
    AGR: '{AGR_CARDS} new cards are dealt (p.3); a trade-off scheduled for this round has landed.',
    COM: 'Your board rows now carry last round\'s stamp: refresh what the city should see (p.3).',
  }[b.code];
  return {
    num: 2, title: TITLES[2], blocks: [
      FLOW(['New round starts', 'Read the NEXT UPKEEP result', 'Run your sector action (p.3)', 'Repair ACTIVE FAULTS (p.4)', 'Trade for shortages (p.5)', 'Prepare the next upkeep']),
      P('{ROUND_FIRST} is set-up; play runs to {ROUND_LAST}. Each round has its own clock (**Round time**). At 00:00 the clock stops and nothing else happens: faults keep bleeding until the control desk starts the next round, and **Current round** changing is the only signal that it has.'),
      BOX('ACTION', 'UPKEEP: {UPKEEP}, EVERY ROUND', [
        'Taken automatically from INVENTORY the moment the next round starts. **The whole bill or none of it:** short by one unit, nothing is taken and you lose **{PENALTY} Health** once. No upkeep clock exists; Round time is the warning. NEXT UPKEEP shows the bill, its Status (READY, or SHORTFALL and what is short) and the last result: UPKEEP PAID or UPKEEP SHORTFALL. Brownout halves the bill to {UPKEEP_HALF}; DARK pays nothing.',
      ]),
      BOX('NEWROUND', 'NEW ROUND — CHECK THESE NOW', [
        '**1 Upkeep** was taken: read the NEXT UPKEEP result line and move the chits.',
        gen ? `**2 Production** is open again: press GENERATE ${res} and add the chits (p.3). A pending generator upgrade has completed.`
          : '**2 Production**: {CODE} has none. POW and WTR are generating now: trade for Power and Water (p.5).',
        '**3 Workers**: crew held for an upgrade or a restart is released. An injured worker may have been returned by MED\'s automatic recovery. A worker you lent out stays where it is.',
        `**4 Refresh**: ${refresh}`,
        '**5 Open requests and transfers carry over.**',
      ]),
      TABLE(['STATUS', 'MEANS', 'DO'], [
        ['STABLE', 'Health {DEGR} or above.', 'Operate normally.'],
        ['DEGRADED', 'Health below {DEGR}.', 'Repair before the next fault lands.'],
        ['CRITICAL', 'Health below {CRIT}. Red wash on the console; the big screen shows you red. Every control still works.', 'Repair the fastest-bleeding fault first. Ask for a value, a part, a worker, an AGR intervention.'],
        ['BROWNOUT', 'Imposed by the Authority. ' + brownoutRule(b), 'Keep operating and pay the smaller bill.'],
        ['DARK', 'Health {DARK}. SECTOR OFFLINE: repairs lock, no output, no upkeep, no healing or approvals from you.', 'EMERGENCY RESTART (OVERVIEW page) with {RESTART_COST} and {RESTART_WORKERS} free workers: back at {RESTART_HEALTH} Health, CRITICAL, that crew held until the round ends.'],
      ], [1300, 4300, 3426], { small: true, boldFirst: true }),
      P('**Before the next round:** make sure NEXT UPKEEP reads READY. Separately, keep enough resources for any open repairs. NEEDS MY ACTION empty and WAITING chased · chits match INVENTORY and WORKERS · the log sheet current.', { small: true }),
      P('**Banners under the header:** CITY ALERT (the whole city) · NOTICE TO {CODE} (this station) · CITY ANNOUNCEMENT UPDATED (read the big screen) · CITY DECISION — AGR (an intervention changed your stock, workers or Health) · COUNCIL IN SESSION (p.6) · SIMULATION PAUSED (every clock frozen; wait).', { small: true }),
    ],
  };
}

// ---------------------------------------------------------------- page 3
function pageSector(b) {
  const g = RULES.generator;
  const code = b.code;
  const title = SECTOR_PAGE_TITLE[code];
  let blocks;
  if (g.enabled && g.sectors.includes(code)) {
    const key = Object.keys(RULES.production[code] || {})[0];
    const res = RES_NAME[key].toUpperCase();
    const other = (g.costs.find((c) => c.support_from && c.support_from[code]) || {}).support_from;
    const otherCode = other ? other[code] : null;
    const myLabel = g.support_labels[code];
    const theirLabel = otherCode ? g.support_labels[otherCode] : null;
    const rows = g.levels.map((l) => {
      const cost = g.costs.find((c) => Number(c.to_level) === Number(l.level));
      const how = Number(l.level) === g.start_level ? 'Installed at the start.'
        : Number(l.level) < g.start_level ? 'Only after damage.'
          : cost ? `${cost.parts} 🔧 Parts · ${cost.workers} 👤 workers${cost.support_from && cost.support_from[code] ? ` · ${cost.support_from[code]}'s ${myLabel}` : ''}` : '—';
      return [`L${l.level} ${l.name}`, `${l.output} ${GLYPH[key]} ${res}`, `${brownoutOutput(code, l.output)} ${GLYPH[key]} ${res}`, how];
    });
    blocks = [
      BOX('ACTION', `GENERATE ${res}: ONCE EVERY ROUND`, [
        `ROUND OUTPUT panel, right column. Press **GENERATE ${res}** once each round: your level's output lands in INVENTORY at once. Add the chits. Output not generated before the round changes is lost; after use the panel reads OUTPUT ALREADY GENERATED THIS ROUND.`,
      ]),
      H('Generator levels (output per round)'),
      TABLE(['LEVEL', 'OUTPUT', 'BROWNOUT', 'TO REACH IT'], rows, [1900, 1700, 1700, 3726], { small: true, boldFirst: true }),
      H('Upgrading'),
      STEPS([
        `From ${fill('{GEN_FROM}', b)}, press **START UPGRADE** once a round. The Parts are spent now; the workers are held until the round ends; the new level is installed when the next round starts.`,
        `**CANCEL UPGRADE** frees the crew but ${g.cancel_parts_lost} Part is lost.`,
        otherCode ? `Level 5 needs ${otherCode}'s **${myLabel}**: ${otherCode} presses CONFIRM SUPPORT in the TECHNICAL SUPPORT panel on its RESOURCE EXCHANGE page. Ask through your Liaison; it costs ${otherCode} nothing but a decision.` : null,
        otherCode ? `${otherCode} will ask you for **${theirLabel}** the same way. CONFIRM SUPPORT commits none of your stock.` : null,
      ].filter(Boolean)),
      H('Brownout and DARK'),
      P(`${brownoutRule(b)} DARK generates nothing.${code === 'POW' && RULES.core_scales_power ? ' Power output also rises and falls with the Core\'s output.' : ''}`),
      BOX('REMEMBER', 'ALLOCATION IS YOURS', [
        `You decide who gets ${RES_NAME[key]}, how much, and when. The console never forces a transfer; every sector needs ${RULES.upkeep[key]} ${GLYPH[key]} a round for upkeep and most repairs burn it. Your Specification Tables (p.9) are what other Liaisons come to you for. Give, delay or bargain: your call.`,
      ]),
    ];
  } else if (code === 'MED') {
    blocks = [
      BOX('ACTION', 'HEALING THIS ROUND: {MED_HEALS} HEALS A ROUND, CITY-WIDE', [
        'Right column. The panel shows n / {MED_HEALS} USED · n LEFT and the HEALING QUEUE: one row per injured worker any sector has asked you to heal, in the order the requests arrived.',
      ]),
      STEPS([
        '**HEAL**: that worker returns to its sector\'s AVAILABLE count at once. One of your {MED_HEALS} is used. No stock is spent.',
        '**DECLINE**: nothing happens and nothing is used. You owe nobody a reason.',
        'A row marked NO LONGER INJURED needs nothing.',
        'Your allowance refreshes when the next round starts. Requests you did not answer stay in the queue.',
      ]),
      H('Automatic recovery'),
      P('At each round change the engine returns {RECOVER_N} injured worker somewhere in the city and spends {RECOVER_MED} ⚕ from **your** INVENTORY, if you hold one. Keep a ⚕ if you want it to happen.'),
      H('Med Supplies'),
      P('Nobody in HAVEN-9 produces ⚕. Your opening stock, REPAIR REWARDS and Agriculture\'s interventions are the only sources; some repairs across the city need ⚕ as materials, and the automatic recovery spends them. Every ⚕ you trade away is one fewer recovery.'),
      H('Brownout and DARK'),
      P(`${brownoutRule(b)} DARK heals nobody.`),
      BOX('REMEMBER', 'PRIORITY IS YOURS', [
        'Only MED heals. Whom you heal first, whom you make wait and whom you decline is your decision, and every sector will say its worker is the one that matters. Transport is not involved in healing; no chit is needed.',
      ]),
    ];
  } else if (code === 'TRN') {
    blocks = [
      BOX('ACTION', 'NOTHING MOVES WITHOUT YOUR APPROVAL: {TRN_APPROVALS} A ROUND, CITY-WIDE', [
        'Your RESOURCE EXCHANGE page is titled TRANSFER CONTROL and opens on WAITING APPROVAL. TRANSFER APPROVALS shows the allowance as dots and n / {TRN_APPROVALS} USED, then PENDING APPROVALS: one card per transfer a supplier has fulfilled, with CHIT: CHECK REQUIRED.',
      ]),
      STEPS([
        'CHECK the paper chit a Liaison hands you: FROM, TO, item and quantity, **both** Liaison signatures. One signature waits.',
        'FIND the matching card. Route and item must match the paper; if not, the console is right: send the Liaison back.',
        'Press **CONFIRM CHIT** (it reads CHIT ✓ IN HAND). STAMP the paper now.',
        'Press **APPROVE**, then CONFIRM APPROVAL. Stock moves between the two INVENTORY panels at once; the card reads DELIVERED; one approval is used.',
        'Or **DECLINE**, then CONFIRM DECLINE: nothing moves, nothing is used, both sectors see TRN DECLINED.',
        'Hand the stamped paper back: white copy to the receiver, duplicate to the sender.',
      ]),
      TABLE(['CONSOLE SAYS', 'MEANS'], [
        ['CHIT REQUIRED BEFORE APPROVAL', 'You pressed APPROVE before CONFIRM CHIT. The paper comes first.'],
        ['APPROVAL CAPACITY REACHED', 'All {TRN_APPROVALS} used. Waiting transfers keep waiting until the next round.'],
        ['SUPPLIER SHORT OF STOCK — NOTHING MOVED', 'The supplier spent the stock after fulfilling. No approval used. Send the Liaison back.'],
        ['TRANSPORT DARK — CANNOT APPROVE', 'You are DARK. Nobody trades until you restart (p.2).'],
        ['A freight-slot card from AGR', 'AGR offers +1 approval this round for −1 next round. ACCEPT or DECLINE; unanswered, it lapses at the round change.'],
      ], [3400, 5626], { small: true, boldFirst: true }),
      H('Brownout and DARK'),
      P(`${brownoutRule(b)} DARK approves nothing: nobody in the city can trade until you restart.`),
      BOX('REMEMBER', 'YOUR OWN TRADES USE THE SAME QUEUE', ['Transport approves transfers it is a party to like any other: your Liaison signs the chit, you confirm and approve it, and it uses one of the {TRN_APPROVALS}.']),
    ];
  } else if (code === 'AGR') {
    blocks = [
      BOX('ACTION', 'INTERVENTIONS THIS ROUND: {AGR_CARDS} RANDOM CARDS, CONFIRM 1', [
        'Right column. Each round the panel deals {AGR_CARDS} cards: a situation in the bays, then **GAIN** and, from {AGR_FROM}, **TRADE-OFF**, each naming the sectors it affects. One decision a round; confirmed, the panel reads LOCKED UNTIL NEXT ROUND and DECISION RESULT shows what happened.',
      ]),
      STEPS([
        'SELECT a card. If it asks for a target, choose the sector or the resource first; the summary rewrites itself for your choice.',
        'READ both halves. If confirmed, both apply, where and when each says: now, this round, next round, or on your next upkeep line.',
        'Press the card\'s confirm button. The affected consoles see CITY DECISION — AGR.',
        '**RELEASE THE FREIGHT SLOT** needs TRN: it goes there as a proposal (PENDING TRN APPROVAL) and TRN accepts or declines on its console. Unanswered, it lapses at the round change; nothing is spent.',
        'The first round your cards carry a TRADE-OFF, an AGRICULTURE OPERATING NOTICE covers the console once: read it, press ACKNOWLEDGE.',
      ]),
      H('Your deck'),
      TABLE(['CARD', 'GAIN', 'TRADE-OFF (FROM {AGR_FROM})', 'RISK'], RULES.agr.cards.map((c) => [
        c.title + (c.needs_trn ? ' *' : ''), c.gain.join(' · '), c.trade_off.length ? c.trade_off.join(' · ') : 'none', c.risk || '—',
      ]), [2500, 2400, 3326, 800], { small: true, boldFirst: true }),
      P('Your three are random each round; the console prints each card\'s exact figures when dealt. * needs TRN. ' + brownoutRule(b) + ' DARK plays no cards.', { small: true }),
    ];
  } else if (code === 'COM') {
    blocks = [
      BOX('ACTION', 'YOU SEE THE CITY. THE CITY SEES WHAT YOU PUBLISH.', [
        'Every other sector sees only its own console and the big screen. You see every sector live, and you write what the big screen reports.',
      ]),
      KV([
        ['CITY FEED', 'Every sector as your sensors read it, live: Health, status, open faults. FULL TELEMETRY. A fault you see here is already on that sector\'s own console.'],
        ['CITY INTELLIGENCE', 'Readings the sensor grid files for you alone. TELEMETRY DEGRADED marks a reading you cannot trust. Private until you put it on the screen.'],
        ['CITY BIG SCREEN CONTROL', 'Your own page on the deck. Three things and no others:'],
        ['· CITY BOARD', 'The figures the big screen reports for each sector, stamped with the round you published them in. Fill a sector\'s row, press PUBLISH. The screen reads AWAITING REPORT until you do.'],
        ['· CITY BROADCAST', 'One headline (40 characters) and one message (180) for the whole city. PUBLISH or CLEAR. Every console shows CITY ANNOUNCEMENT UPDATED.'],
        ['· SECTOR FOCUS', 'Eight seconds of emphasis on one sector. It emphasises; it changes nothing.'],
        ['THE CITY CHARTER', 'The paper governance document is held at this station. Produce it on request of any Chief (p.6).'],
      ], { keyWidth: 2500 }),
      H('Brownout and DARK'),
      P(`${brownoutRule(b)} DARK: the city runs blind.`),
      BOX('REMEMBER', 'NOTHING YOU PUBLISH CHANGES A SECTOR\'S REAL STATE', [
        'The board and the broadcast are what the city is told, never what is happening. A sector\'s Health, stock, faults and brownout are the engine\'s, and the big screen insists on showing a DARK or CRITICAL sector whatever your board says. What you pass on in person, to whom, and how fast, is your decision.',
      ]),
    ];
  }
  return { num: 3, title: `${TITLES[3]}: ${title}`, blocks };
}

// ---------------------------------------------------------------- page 4
function pageFault(b) {
  const tokenRows = Object.values(RULES.tokens).map((t) => [t.label, t.effect, `${t.use}, ${t.timing}.`]);
  return {
    num: 4, title: TITLES[4], blocks: [
      FLOW(['GET VALUE', 'BUILD CODE', 'SUBMIT'], { big: true }),
      STEPS([
        'OPEN the fault in ACTIVE FAULTS: code, name, severity, DECAY rate. Fastest bleed first; **TIME-CRITICAL** before anything.',
        'FIND the code on **p.7 or p.8**: its card is the whole procedure.',
        'STAGE crew and materials: INVENTORY must hold the materials (REPAIR READINESS reads MATERIALS ✓ READY) and WORKERS available must cover the crew.',
        '**GET VALUE.** YOUR table: p.9. Another sector\'s: the Liaison asks that station for the exact row by name and brings back three digits, written down. They may refuse, delay or bargain. An answer that is a sector\'s name, not a number, is a **REFERENCE**: follow it and ask there.',
        '**BUILD CODE.** Exactly as the card\'s ENTER line shows: procedure, then each three-digit value, joined by hyphens.',
        '**SUBMIT.** Systems Lead types the code, sets **Workers assigned** to at least the crew, presses **SUBMIT REPAIR**.',
        'ACCEPTED: green banner, the fault moves to RECENTLY RESOLVED, materials leave INVENTORY, the REPAIR REWARD is paid, the crew is free at once. Move the chits; log it.',
      ]),
      TABLE(['CONSOLE SAYS', 'DO THIS'], [
        ['RESOLUTION REJECTED', 'The code is wrong. Verify the value, the source row and the code. ATTEMPTS counts these.'],
        ['INSUFFICIENT CREW', 'Assign more workers, borrow one (p.5) or arm RESERVE CREW. Not a wrong code.'],
        ['MATERIALS NOT READY — CHECK YOUR BINDER', 'Get the materials (p.5) or arm EMERGENCY REPAIR KIT. Not a wrong code.'],
        ['CONSOLE LOCKED mm:ss', '{LOCK_N} wrong codes in a row. Use the {LOCK_S} seconds to verify the source, then resubmit.'],
        ['NO MATCHING PROCEDURE — VERIFY THIS ALERT', 'Stop entering codes. Log it, tell COM, then work the faults you can repair.'],
        ['SECTOR IS DARK', 'Emergency Restart first (p.2).'],
      ], [3400, 5626], { small: true, boldFirst: true }),
      P('A crew or materials refusal costs nothing and does not count toward the lock. Codes that belong to other sectors: the ESCALATE TO list on p.8.', { small: true }),
      H('Tactical tokens (TACTICAL OPPORTUNITIES panel): open the fault card first, then press the token. Used once.'),
      TABLE(['TOKEN', 'EFFECT', 'USE'], tokenRows, [2200, 3400, 3426], { small: true, boldFirst: true }),
    ],
  };
}

// ---------------------------------------------------------------- page 5
function pageTrade(b) {
  return {
    num: 5, title: TITLES[5], blocks: [
      FLOW(['Liaisons negotiate in person', 'REQUEST on the console', 'Supplier FULFILLS', 'Both Liaisons sign the chit', 'Chit to TRN', 'TRN confirms, stamps, APPROVES', 'DELIVERED: move the stock']),
      STEPS([
        'Liaisons agree the deal face to face. Only the Liaison leaves the station.',
        'The receiving sector: RESOURCE EXCHANGE → **+ NEW REQUEST** → REQUEST FROM (sector), RESOURCE (⚡ 💧 🔧 ⚕ or 👤 WORKERS), QUANTITY → **SEND REQUEST**. The card reads WAITING FOR SUPPLIER.',
        'The supplier: banner VIEW or NEEDS MY ACTION → **FULFILL** (possible only while it holds the stock) or DECLINE. The card reads WAITING FOR TRN.',
        'Both Liaisons fill in one paper Transfer Chit and sign it. The chit\'s fields are the record; nothing on it is optional.',
        'A Liaison carries the chit to Transport.',
        'TRN checks it, presses CONFIRM CHIT, stamps the paper, presses APPROVE. TRN has {TRN_APPROVALS} approvals a round and may DECLINE.',
        'Both consoles read **DELIVERED**. Now, and only now, the chits and tokens change hands. White copy to the receiver, duplicate to the sender.',
      ]),
      BOX('WARNING', 'NOTHING HAS MOVED WITHOUT ALL THREE', [
        'A console request fulfilled by the supplier + a Transfer Chit signed by both Liaisons + TRN\'s approval and stamp. An unstamped chit is void. A swap is two transfers, one each way, and costs TRN two approvals. WITHDRAW your own request while it reads WAITING FOR SUPPLIER; once fulfilled, only the supplier can withdraw it or TRN decline it. Open requests carry over a round change.',
      ]),
      H('Workers'),
      P('**Workers assigned** on a repair is a count: the crew is free again the moment the code is accepted. Workers are held, and shown unavailable, by a generator upgrade or an emergency restart (until the round ends), a brownout ({BROWN_WORKERS}), an AGR trade-off that takes one for the round, and a loan. A worker is lent exactly like a resource: RESOURCE 👤 WORKERS, the same chit, the same TRN approval; the token changes hands at DELIVERED and the console shows LOANED OUT or BORROWED. **A borrowed worker never returns by itself**: send one back the same way.'),
      H('Injuries and healing'),
      STEPS([
        'Some faults injure workers the moment they appear: WORKERS available drops and the INJURED WORKERS panel appears. The token stays at your station, face down.',
        'Press **REQUEST MED HEALING** for each injured worker. The request joins MED\'s HEALING THIS ROUND queue. No chit, no Transport.',
        'MED presses HEAL: the worker returns to AVAILABLE at once. MED heals at most {MED_HEALS} workers a round across the city and may DECLINE.',
        'At each round change MED\'s automatic recovery returns {RECOVER_N} injured worker in the city if MED holds a ⚕.',
      ]),
    ],
  };
}

// ---------------------------------------------------------------- page 6
function pageQuick(b) {
  const own = {
    POW: 'GENERATE POWER pressed? Upgrade worth starting?', WTR: 'GENERATE WATER pressed? Upgrade worth starting?',
    MED: 'Anyone in the HEALING QUEUE? A ⚕ kept for the automatic recovery?', TRN: 'Anything in PENDING APPROVALS? Approvals left?',
    AGR: 'Which card is worth its trade-off, and for whom?', COM: 'Board rows stale? A broadcast due?',
  }[b.code];
  const rows = [
    ['A FAULT APPEARS', 'Open it. p.4, then its card on p.7–8.'],
    ['A CODE YOU ARE TOLD IS NOT YOURS', 'ESCALATE TO table, p.8: tell that sector\'s station. Enter nothing.'],
    ['NEED ANOTHER SECTOR\'S VALUE', 'SEND the Liaison to ask for the exact named row. A REFERENCE answer: follow it.'],
    ['NEED RESOURCES OR A WORKER', 'Negotiate, then the transfer flow on p.5.'],
    ['ANOTHER SECTOR REQUESTS FROM YOU', 'RESOURCE EXCHANGE → NEEDS MY ACTION → FULFILL or DECLINE.'],
    ['ROUND TIME IS LOW', 'Make NEXT UPKEEP read READY: {UPKEEP} in INVENTORY.'],
    ['UPKEEP SHORTFALL SHOWN', 'You lost {PENALTY} Health; stock untouched. Trade for Power and Water now.'],
    ['A WORKER IS INJURED', 'Turn the token face down. REQUEST MED HEALING.'],
    ['RESOLUTION REJECTED', 'Verify value, source and code before trying again. {LOCK_N} wrong in a row locks the console {LOCK_S} s.'],
    ['HEALTH BELOW {CRIT}', 'CRITICAL. Controls still work. Prioritise the fastest-decaying fault.'],
    ['SECTOR IS DARK', 'EMERGENCY RESTART when you can pay {RESTART_COST} and {RESTART_WORKERS} workers (p.2).'],
    ['COUNCIL IS CALLED', 'Chief and Liaison go immediately. Everyone else keeps operating.'],
    ['NO ACTIVE FAULT', `CHECK NEXT UPKEEP, open requests, chits against INVENTORY, injured workers, and your panel: ${own}`],
    ['CONSOLE SAYS RECONNECTING', 'Keep working on paper. If it stays down for minutes, that is a technical failure: tell the control desk.'],
  ];
  return {
    num: 6, title: TITLES[6], blocks: [
      TABLE(['WHEN THIS HAPPENS', 'DO THIS'], rows, [3000, 6026], { small: true, boldFirst: true }),
      BOX('ACTION', 'COUNCIL IN SESSION — CHIEF + LIAISON REPORT TO CENTRAL COUNCIL', [
        'When that banner shows, the **Sector Chief and the Liaison go to the central Council table immediately**. Everyone else stays and keeps operating; faults keep bleeding and the round clock keeps running.',
        'The Chief holds the sector\'s seat and voice; a sector whose Chief is absent has no voice for that sitting. The Liaison may speak and holds no seat.',
        'The sitting is timed by the Continuity Authority. **Watch the Council clock** on the banner. **At 00:00, unresolved matters remain unresolved** (COUNCIL TIME EXPIRED).',
        'Council decisions bind every sector. Transfers never need Council approval; they still need the chit and TRN (p.5).',
        'If Core insufficiency is declared, the Council completes the Continuity Order in the City Charter, held at the COM station, before the sitting closes. Any Chief may ask for the Charter. Do not go to Council unless it is called.',
      ]),
    ],
  };
}

// ---------------------------------------------------------------- pages 7–9 (data from the assembler)
/** "WTR → Table W-4 → Emergency Tank", "YOUR Table P-1 → Turbine A", "COM → Appendix C → Master Uplink Reset Key" */
function sourceCell(s) {
  const where = s.buried ? 'Appendix C' : `Table ${s.table_id}`;
  return s.foreign ? `${s.binder} → ${where} → ${s.row_label}` : `YOUR ${where} → ${s.row_label}`;
}
/** "ASK WTR → Core Coolant Route Reference", with the chain rule on a second line. */
function chainCell(c) {
  return `ASK ${c.first_sector} → ${c.first_reference_name}\na REFERENCE — may name another sector: follow it`;
}

function faultCard(p) {
  const values = p.reference_chain && p.reference_chain.length
    ? p.reference_chain.map(chainCell)
    : (p.sources || []).map(sourceCell);
  return {
    code: p.fault_code,
    name: p.title.replace(/\s*—\s*TIME-CRITICAL$/, '').toUpperCase(),
    time_critical: !!p.time_critical,
    proc: p.id,
    crew: `${p.crew} worker${Number(p.crew) === 1 ? '' : 's'}`,
    materials: materials(p.resources),
    v1: values[0] || '—',
    v2: values[1] || null,
    format: p.format,
  };
}

function pageFaults(b, part) {
  const procs = b.procedures.slice().sort((x, y) => x.id.localeCompare(y.id));
  const half = Math.ceil(procs.length / 2);
  const mine = part === 1 ? procs.slice(0, half) : procs.slice(half);
  const cards = mine.map(faultCard);
  const escalate = b.index_rows.filter((r) => !r.own).map((r) => [r.code, r.action.replace(/^ESCALATE TO\s+/, '')]);
  const blocks = [
    part === 1
      ? P('One card is one whole procedure. The steps are on p.4; your own tables are on p.9. "YOUR Table" is in this binder; "WTR → Table W-4" is in Water\'s binder, fetched by your Liaison by row name.', { small: true })
      : P('Later faults: two values, other sectors, a REFERENCE that points on, or TIME-CRITICAL. "ASK MED → …": the Liaison asks Medical for that reference; the answer is a number or a sector\'s name to follow.', { small: true }),
    { t: 'faultcards', cards },
  ];
  if (part === 2) {
    blocks.push(P('**ESCALATE TO — codes that belong to another sector:**   ' + escalate.map(([code, owner]) => `**${code} → ${owner}**`).join('   ·   ') + '.   A fault on your own console is always yours; told or shown one of these, tell that sector\'s station and enter nothing.', { small: true, escalate }));
  }
  return { num: part === 1 ? 7 : 8, title: TITLES[part === 1 ? 7 : 8], blocks };
}

function pageSpecs(b) {
  const blocks = [
    { t: 'legend', items: [
      ['VALUE', 'Three digits. Closes a repair. Give it by row name.', 'value'],
      ['REFERENCE', 'A pointer, not a number: relay the asset and sector shown.', 'reference'],
      ['AUTHORISATION', 'Appendix C. Used only when a card sends you here.', 'authorisation'],
    ] },
    P('These are what other Liaisons come to you for, by row name. Whether you give one, and how quickly, is your call.', { small: true }),
  ];
  for (const t of b.tables) {
    blocks.push({ t: 'spectable', kind: 'value', id: t.id, name: t.name, rows: t.rows.map((r) => [r.label, String(r.value)]) });
  }
  if (b.references && b.references.length) {
    blocks.push({ t: 'spectable', kind: 'reference', id: 'REFERENCES', name: 'Cross-System Reference Directory', rows: b.references.map((r) => [r.name, r.display]) });
  }
  blocks.push({ t: 'spectable', kind: 'authorisation', id: 'APPENDIX C', name: 'Non-Routine Authorisation — issued under emergency powers, not revoked, valid for the current operating period', rows: [[b.appendix.row_label, String(b.appendix.value)]] });
  return { num: 9, title: TITLES[9], blocks };
}

function compactFor(b) {
  return [pageStart(b), pageRound(b), pageSector(b), pageFault(b), pageTrade(b), pageQuick(b), pageFaults(b, 1), pageFaults(b, 2), pageSpecs(b)];
}

module.exports = { compactFor, TITLES, SECTOR_PAGE_TITLE, materials, sourceCell, chainCell, faultCard, brownoutOutput, brownoutMultiplier, brownoutRule, fill };
