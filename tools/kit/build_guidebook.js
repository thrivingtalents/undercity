// UNDERCITY — Facilitator & Administrator Guidebook renderer.
// Run: node build_guidebook.js [outdir]

const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType, BorderStyle, VerticalAlign, PageBreak,
  Header, Footer, PageNumber, HeadingLevel, TableOfContents,
} = require("docx");

const OUTDIR = process.argv[2] || "kit";
fs.mkdirSync(OUTDIR, { recursive: true });

const INK = "1A1A1A", MUTED = "6B6B6B", RULE = "BFBFBF", NAVY = "1F3864", RED = "B00000";
const A4W = 11906, A4H = 16838, M = 1134;
const W = A4W - M * 2;

const t = (x, o = {}) => new TextRun({ text: x, font: "Arial", size: 20, color: INK, ...o });
const mono = (x, o = {}) => new TextRun({ text: x, font: "Courier New", size: 19, color: INK, ...o });
const p = (runs, o = {}) => new Paragraph({
  children: Array.isArray(runs) ? runs : [runs], spacing: { after: 130 }, ...o });
const brk = () => new Paragraph({ children: [new PageBreak()] });

const H1 = (x) => new Paragraph({
  heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 200 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: NAVY } },
  children: [new TextRun({ text: x, font: "Arial", size: 34, bold: true, color: NAVY })] });
const H2 = (x) => new Paragraph({
  heading: HeadingLevel.HEADING_2, spacing: { before: 260, after: 110 },
  children: [new TextRun({ text: x, font: "Arial", size: 24, bold: true, color: INK })] });
const H3 = (x) => new Paragraph({
  heading: HeadingLevel.HEADING_3, spacing: { before: 180, after: 90 },
  children: [new TextRun({ text: x, font: "Arial", size: 21, bold: true, color: NAVY })] });

const dash = (x) => new Paragraph({
  spacing: { after: 70 }, indent: { left: 300, hanging: 300 },
  children: [mono("—  "), ...(Array.isArray(x) ? x : [t(x)])] });

const callout = (label, body, fill = "FFF4E5", edge = "E8A33A") => new Paragraph({
  spacing: { before: 140, after: 160 },
  shading: { type: ShadingType.CLEAR, fill, color: "auto" },
  border: { left: { style: BorderStyle.SINGLE, size: 18, color: edge } },
  indent: { left: 220, right: 160 },
  children: [t(label + "  ", { bold: true, color: edge === "E8A33A" ? "8A5A00" : edge }), t(body)] });

const script = (lines) => new Paragraph({
  spacing: { before: 140, after: 160 },
  shading: { type: ShadingType.CLEAR, fill: "F4F4F4", color: "auto" },
  border: { left: { style: BorderStyle.SINGLE, size: 18, color: MUTED } },
  indent: { left: 220, right: 160 },
  children: lines.flatMap((l, i) => [
    ...(i ? [new TextRun({ break: 1 })] : []),
    new TextRun({ text: l, font: "Arial", size: 20, italics: true, color: "2A2A2A" }),
  ]) });

const thin = {
  top: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  left: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  right: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: RULE } };

function cell(x, { width, shade, bold, align, size, colour } = {}) {
  const runs = (Array.isArray(x) ? x : [x]).map((c) =>
    typeof c === "string" ? t(c, { bold, size, color: colour }) : c);
  return new TableCell({
    width: { size: width, type: WidthType.DXA }, verticalAlign: VerticalAlign.TOP,
    shading: shade ? { type: ShadingType.CLEAR, fill: shade, color: "auto" } : undefined,
    margins: { top: 70, bottom: 70, left: 100, right: 100 },
    children: [new Paragraph({ spacing: { after: 0 }, alignment: align, children: runs })] });
}
const tbl = (rows, widths) => new Table({
  columnWidths: widths, width: { size: W, type: WidthType.DXA }, borders: thin, rows });
const headRow = (labels, widths) => new TableRow({
  children: labels.map((l, i) => cell(l, { width: widths[i], shade: NAVY, bold: true, colour: "FFFFFF" })) });
const row = (cells, widths, shade) => new TableRow({
  children: cells.map((c, i) => cell(c, { width: widths[i], shade })) });

// beat table helper: time | do this | watch for
const BW = [1300, 4400, W - 5700];
const beat = (time, action, watch) => row([time, action, watch], BW);

const C = [];

// ---------------------------------------------------------------- cover
C.push(
  new Paragraph({ spacing: { after: 1600 }, children: [t("")] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 },
    children: [new TextRun({ text: "UNDERCITY", font: "Arial", size: 88, bold: true, color: NAVY })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 400 },
    children: [new TextRun({ text: "CRISIS LEADERSHIP SIMULATION", font: "Arial", size: 26, color: MUTED, characterSpacing: 120 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 },
    border: { top: { style: BorderStyle.SINGLE, size: 8, color: NAVY } },
    children: [new TextRun({ text: "FACILITATOR & ADMINISTRATOR GUIDEBOOK", font: "Arial", size: 32, bold: true, color: INK })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 1400 },
    children: [t("Version 1.0 · MVP · Thriving Talents", { size: 18, color: MUTED })] }),
  new Paragraph({ alignment: AlignmentType.CENTER,
    children: [t("This guidebook assumes no prior knowledge of the simulation.", { size: 20, italics: true, color: MUTED })] }),
  new Paragraph({ alignment: AlignmentType.CENTER,
    children: [t("Read Parts 1 to 3 before your first delivery. Run the day from Part 5.", { size: 20, italics: true, color: MUTED })] }),
  brk());

// ---------------------------------------------------------------- 1. what this is
C.push(H1("Part 1 · What UNDERCITY Is"));
C.push(p(t("UNDERCITY is a hybrid physical and digital simulation for 18 to 36 participants. Six teams run six interdependent sectors of an underground city whose power core is failing. They run it as ONE CONTINUOUS SHIFT: once you start the simulation it does not stop until it ends. The pressure rises in waves, the sectors are forced into each other's problems, and the group has to make a decision nobody wants to make — without ever being handed a pause to compose themselves in.")));
C.push(p([t("The simulation is not the product. ", { bold: true }), t("What you are selling and what the client is buying is the measurement and the debrief: every table is recorded, and each participant receives a personal report on how they behaved under pressure, followed by a commitment they carry into a named meeting in their own week. The simulation exists to generate that evidence. Facilitate accordingly — a beautifully run shift with a rushed debrief is a failed delivery.")]));

C.push(H2("What it measures"));
C.push(dash("Talk time, interruptions and questions asked, per person, per wave of the shift."));
C.push(dash("How information moves between sectors, and how long people sit on it."));
C.push(dash("Who dominates, who withdraws, and at what level of pressure each begins."));
C.push(dash("Whether dissent is welcomed or shut down, and by whom."));
C.push(dash("The change in all of the above between the early shift and the late shift — the same people, a full shift of rising load apart."));

C.push(H2("The design logic in one page"));
C.push(p(t("The opening stretch is deliberately easy. It is the baseline: you cannot say someone dominates under pressure unless you know how they speak when there is none. Every wave after it raises the load in a defined step, and the late shift — Rounds 4 to 7 — lands on a city the room has already half-broken. The diagnostic is the difference between the early shift and the late one, not the behaviour at any single moment.")));
C.push(p(t("The shift is continuous on purpose. Real operational pressure does not come with scheduled pauses, and a group that is handed one recomposes itself: the second half stops being a measurement of the same people under load and becomes a measurement of people who have just had a rest. Recovery in this design is earned inside the simulation — there are stretches where fewer new things break — but the clock, the faults, the transfers and the consequences never stop.")));
C.push(p(t("The debrief comes after the shift ends, not inside it. Participants read their own numbers with the whole arc behind them, and the behavioural commitment each of them writes is for a named meeting in their own week, with a named date and a named partner. That is where the change is checked — not in another round of a game.")));
C.push(callout("Never cut the late shift.", "If the day is running late, shorten the second half of Round 2 and the quiet two minutes of Round 3 — the connective stretches — or trim Debrief 1. Rounds 4 to 7 and the delta readout are the deliverable. Everything before them is setup."));

C.push(H2("Three deliberate design choices you will be asked about"));
C.push(H3("Nobody is ever eliminated"));
C.push(p(t("Sectors can go dark and can be placed in brownout, but no participant is ever removed from play, and no mechanic asks the group to expel a person. Sacrifice decisions target fictional populations. Participants go back to the same office on Monday, and a transcript showing who argued to cut whom would outlive the workshop.")));
C.push(H3("The console is the official count; the chits mirror it"));
C.push(p(t("The console refuses a repair whose materials are not in INVENTORY, deducts them when the code is accepted, takes upkeep at the round change, moves stock when Transport approves, and adds output when GENERATE is pressed. The physical chits are not a second ledger: the binder tells every team to move the chits whenever the console moves the stock, and the argument about whether the table matches the screen is still theirs to have. Nobody at the control desk adjusts a sector's inventory on request.")));
C.push(H3("There is no briefing"));
C.push(p(t("Nobody presents the rules. Each binder opens with START HERE — YOUR FIRST 5 MINUTES and ten more sections that explain the shift, the console, upkeep, faults, trading, Council and what to do when nothing is happening, all written from the engine's actual behaviour and rebuilt with the kit. A team that asks you how the game works is pointed at the section number, never answered. The Game Master stays at the control panel for the whole shift; the only reasons to leave it are a physical-safety, venue or technical problem.")));
C.push(H3("There is no chat function"));
C.push(p(t("Every message between sectors is spoken or walked. A chat box would move the entire diagnostic into silent text. If a participant asks for one, the answer is that the city's network is down — which it is.")));
C.push(brk());

// ---------------------------------------------------------------- 2. before the day
C.push(H1("Part 2 · Before the Day"));

C.push(H2("2.1 Staffing"));
C.push(p(t("Minimum two people. One Game Master on the control panel, one Floor Facilitator moving between tables. A single facilitator can run 18 participants at a push, but will lose most of the observation data, which is the expensive part.")));
C.push(tbl([
  headRow(["ROLE", "DURING PLAY", "DURING DEBRIEF"], [2200, 4000, W - 6200]),
  row(["Game Master", "Stays on the control panel: fires injects from the runbook and the library, manages clocks, Council and modes, watches the big screen. Never briefs, never explains.", "Runs the deltas on screen. Owns timing."], [2200, 4000, W - 6200]),
  row(["Floor Facilitator", "Moves between tables. Tags observations. Points a rules question at the binder section that answers it. Does not solve problems.", "Runs the small-group trigger work. Holds the room."], [2200, 4000, W - 6200]),
  row(["Client contact", "Not in the room during play if avoidable.", "Attends the aggregate readout only, never individual work."], [2200, 4000, W - 6200]),
], [2200, 4000, W - 6200]));
C.push(callout("On the client contact.", "Senior client stakeholders standing behind tables change how people speak. If a sponsor wants to observe, seat them as a participant in a sector or ask them to watch the big screen from the back. Say this in the sales conversation, not on the morning.", "E8E8F5", NAVY));

C.push(H2("2.2 Room requirements"));
C.push(dash("Six tables, seating 3 to 6 each, spaced far enough apart that a normal speaking voice does not carry between them. Distance is a game mechanic: it is what makes information sharing cost something."));
C.push(dash("One central Council table, empty, with chairs for twelve."));
C.push(dash("A projector or large screen visible from every table."));
C.push(dash("Power at every table. Six laptops or tablets, one per sector."));
C.push(dash("Room minimum roughly 12 by 10 metres for 36 people. A cramped room collapses the audio separation and the analytics with it."));
C.push(callout("Check the room before you quote the room.", "A single long boardroom table cannot run UNDERCITY. If the venue cannot give you six separated tables and a projector, the delivery does not work and the sale should be re-scoped."));

C.push(H2("2.3 Technology setup"));
C.push(tbl([
  headRow(["ITEM", "SETUP", "WHY"], [2400, 3800, W - 6200]),
  row(["Travel router", "Own router, offline LAN. Never venue wifi.", "Venue wifi is the most common cause of a failed delivery in this class of product."], [2400, 3800, W - 6200]),
  row(["Server", "One laptop runs the game server. Note its LAN address.", "Everything else connects to it."], [2400, 3800, W - 6200]),
  row(["Sector devices", "Six devices open at /sector/POW … /sector/COM. Full screen.", "One per table. Check each one shows the right sector before participants arrive."], [2400, 3800, W - 6200]),
  row(["Big screen", "Projector device open at /bigscreen. Full screen.", "Public shared fate. Do not let a taskbar show."], [2400, 3800, W - 6200]),
  row(["Control panel", "Game Master device at /control with the token.", "Never leave this screen visible to participants."], [2400, 3800, W - 6200]),
  row(["Audio", "One mic per table plus one at the Council table. Phone backup recorder per table.", "A lost table is a lost set of personal reports. Redundancy is cheap."], [2400, 3800, W - 6200]),
], [2400, 3800, W - 6200]));
C.push(callout("The klaxon sync, and why it matters more than it looks.", "At the start of orientation you will fire a klaxon. The spike appears on every recording and is how transcripts get aligned to the game log afterwards. If you forget it, or if a recorder starts late, that table's analysis becomes manual reconstruction. Confirm every recorder is rolling, then fire it. This is the single most skippable step with the largest downstream cost.", "FFE8E8", RED));

C.push(H2("2.4 Consent — non-negotiable"));
C.push(p(t("Consent forms are signed before orientation begins, not during a break. Walk the room and collect them. Anyone who declines a personal report still plays; note their name so they are excluded from individual analysis.")));
C.push(p([t("Say the confidentiality position out loud, in front of everyone, in plain terms: ", {}),
  t("individual reports go to the individual and nobody else; the organisation gets group patterns only.", { bold: true }),
  t(" If participants believe their transcript reaches their boss, every word becomes performance and the day measures impression management instead of behaviour.")]));

C.push(H2("2.5 Printing and assembly"));
C.push(p(t("All paper is generated from the crossref matrix. Never hand-edit a printed value or a JSON file: the moment paper and server disagree, a fault becomes unsolvable mid-session and there is no recovery in the room.")));
C.push(tbl([
  headRow(["ARTIFACT", "QUANTITY", "NOTES"], [3000, 1800, W - 4800]),
  row(["Sector binders", "6", "Participant-facing: one per station, that sector's and nobody else's. Sections 1–11 are the team's operating manual and replace the briefing; 12–15 are its faults, procedures, tables and log. Two-ring binder each, sector-coloured. Log sheet loose-leaf — the only consumable page."], [3000, 1800, W - 4800]),
  row(["Fault cards", "60 (optional)", "The console is the alert: a fault fired from the library appears on the sector's screen with its code, severity, decay and reward, and the binder sends the team from the screen to the index. Print the deck only if you want a prop to hand over; nothing in the binder refers to it."], [3000, 1800, W - 4800]),
  row(["Answer key", "1", "Game Master only. Never leaves the control table."], [3000, 1800, W - 4800]),
  row(["Transfer chits", "~120", "40 sheets, 2-up. Overprint — teams waste them early and hoard them late."], [3000, 1800, W - 4800]),
  row(["City Charter", "1", "Two pages plus Continuity Order. Goes to COM at orientation."], [3000, 1800, W - 4800]),
  row(["Continuity Order", "2", "One for use, one spare. Round 3 only."], [3000, 1800, W - 4800]),
  row(["Role cards", "1 set per sector", "Four cards per sector, cut."], [3000, 1800, W - 4800]),
  row(["Table tents", "6", "Fold and place before participants enter."], [3000, 1800, W - 4800]),
  row(["Consent forms", "1 per participant", "Plus five spares."], [3000, 1800, W - 4800]),
  row(["Chits, tokens", "—", "Resource chits in six trays. 48 workforce tokens plus spares. One rubber stamp for TRN."], [3000, 1800, W - 4800]),
], [3000, 1800, W - 4800]));
C.push(brk());

// ---------------------------------------------------------------- 3. facilitation stance
C.push(H1("Part 3 · How to Facilitate This"));

C.push(H2("3.1 The five principles"));
C.push(H3("1. Your eyes belong on the room, not the screen"));
C.push(p(t("The control panel is built so that every action takes at most two clicks. If you find yourself reading the screen for long stretches, you are missing the data the day exists to collect. Learn the runbook well enough to fire injects by glance.")));
C.push(H3("2. Do not rescue"));
C.push(p(t("Teams will flounder, misread procedures, forget to send their liaison, and blame the software. Let them. The floundering is the diagnostic. A rules question is answered by the binder: say the section number (faults §7, upkeep §5, trading §9, Council §10) and nothing else. Refuse content questions: never what the answer is or who to ask.")));
C.push(script([
  "Participant: \"We can't find this spec anywhere.\"",
  "You: \"Your binder tells you where it lives. Read the procedure again, all of it.\"",
  "Participant: \"Is it in Water's binder?\"",
  "You: \"I'm not able to tell you that. Your procedure can.\"",
]));
C.push(H3("3. Throttle to the room, not to the clock"));
C.push(p(t("The runbook is a script, not a metronome. A team coasting gets an extra fault. A table genuinely drowning — not struggling, drowning — gets a fault paused or a resource grant. You are managing a stress curve, and the target is pressure that is uncomfortable and survivable, never chaotic. Chaos produces noise, not diagnosis.")));
C.push(H3("4. Tag as you go"));
C.push(p(t("Every observation goes on your paper pad with the time from the wall clock — the console has no observation pad. In the debrief you lay those notes beside the exported event log, which carries the same clock, and the timeline assembles itself from the two. Untagged observations are lost by lunchtime. Aim for at least twenty tags across the day.")));
C.push(H3("5. Protect the pressure, then protect the person"));
C.push(p(t("Discomfort is the point. Distress is not. If a participant is visibly overwhelmed rather than engaged, quietly move them to a support role, tell them why in one sentence, and note it. Do not make it a moment in front of the room.")));

C.push(H2("3.2 The observation tags"));
C.push(tbl([
  headRow(["TAG", "USE WHEN", "EXAMPLE"], [2200, 3600, W - 5800]),
  row(["DOMINANCE", "One person is taking the airtime or the decisions.", "Chief answers for the sector three times without turning to the table."], [2200, 3600, W - 5800]),
  row(["WITHDRAWAL", "Someone who was engaged has gone quiet.", "Engineer stops contributing after being cut off twice."], [2200, 3600, W - 5800]),
  row(["SAFETY+", "Someone makes it easier for others to speak.", "\"Hold on, what were you about to say?\" Asking the quiet person directly."], [2200, 3600, W - 5800]),
  row(["SAFETY-", "Someone makes it harder.", "Eye-rolling, talking over, \"we don't have time for that\", dismissing a flagged concern."], [2200, 3600, W - 5800]),
  row(["DISCREPANCY-SPOTTED", "Anyone notices the 340 / 290 mismatch.", "Tag it whether or not the group listens. What happens next is the data."], [2200, 3600, W - 5800]),
], [2200, 3600, W - 5800]));

C.push(H2("3.3 Pacing a shift that never stops"));
C.push(p(t("There are no breathers and no round breaks to hide behind. The only instrument you have for easing pressure is what you inject, and how much of it: a wave where nothing new fires is a recovery window, and from the floor it reads as the city settling rather than as a break the facilitator granted. Never announce one, never name it, and never stop a clock to make one.")));
C.push(p([t("What continues during a quiet stretch: "), t("everything", { bold: true }),
  t(". The round timer, open faults and their decay, repairs, transfers, healing, generator upgrades, COM’s board, Council consequences, and the upkeep the next round will charge. A team can use the stretch to catch up on all of it. That is the recovery — operational, earned, and visible in the log.")]));
C.push(p([t("The rounds have no names — not in the console, not in the log, not in this guide. A round is its number, and what each one is for is written in Part 4 and in the runbook below as "), t("guidance to you, never as a title", { bold: true }),
  t(". Pressing NEXT ROUND changes what you may fire next and stamps the log for analysis. It changes nothing else: no clock resets, no stock, health, worker, transfer or upgrade moves, and the wall says only the new number for three seconds. If you want the room to feel a change, fire something.")]));

C.push(p([t("The waves named in Part 5 are ", { bold: true }), t("yours and the paper's. "),
  t("Every screen in the building — yours included — shows one thing: "), t("Round 0 to Round 7", { bold: true }),
  t(". A title on a console is one screenshot away from the room, and a table that can name what is coming stops behaving like a table under pressure. So this guide says what each round is for, the console counts them, and every one of them is a button.")]));
C.push(callout("The only full stop is an emergency.", "PAUSE freezes every clock and every decay for a technical failure, a safety issue or an equipment problem. It is not a pacing tool and it is not a rest. Resume continues from the exact frozen state — nothing is replenished, nothing is cleared."));

C.push(H2("3.4 The two seeded probes"));
C.push(p(t("Two things in this simulation are not what they appear. Know both cold; participants will challenge you on them in the debrief.")));
C.push(H3("The discrepancy — Water's reservoir pressure"));
C.push(p([t("The WTR binder prints the Lower Reservoir at "), mono("340"), t(". The big screen telemetry shows "), mono("290"),
  t(". Both are accepted by the console, so the game never punishes either. The question is purely whether anyone notices, whether they say so, and how the group treats them when they do. The binder also carries a line saying printed values take precedence over instrumentation, which gives a dissenter a basis to stand on. Tag every mention.")]));
C.push(H3("The buried appendices"));
C.push(p(t("Every binder holds one Appendix C value that appears in no index. Water and Agriculture need their own during Round 3; every one of the six is raided by another sector in the late shift. Teams that never open the back of the binder will stall. That stall is a finding about how people behave when the documentation fights back.")));

C.push(H3("The late shift"));
C.push(p(t("Every binder's Fault Code Index ends with two more procedures, P-09 and P-10, and the card deck has a LATE SHIFT section after REFERENCE CHAIN. They add no mechanic. A P-09 fault needs two values from two other binders, exactly as Round 3's did. A P-10 fault is the same with three crew, heavier materials and Integrity falling three points a minute while it stays open: the card says TIME-CRITICAL and nothing counts down, because nothing does — the control panel's preview shows you a target time to call out loud if the room needs the pressure, and that is all it is. They exist so Rounds 4 to 7 can mix every kind of fault the room has learned without repeating one. Fire them from the library like everything else; the preview shows you the two sources and the answer, and no table ever sees that.")));
C.push(brk());

C.push(H2("3.5 Agriculture's operational decisions"));
C.push(p(t("Agriculture's console deals it three cards at the start of every round and lets it play one. In Round 0 and Round 1 the cards are free: a gain, nothing owed, and the table learns the rhythm. From Round 2 every card is an operational decision with two halves, and the console will not let AGR take one half without the other.")));
C.push(dash([t("GAIN", { bold: true }), t(" — what the city gets the moment AGR confirms: stock to a sector, health to a sector, a worker or an approval for the round. These are the same gains the cards have always given. The line leads with the sector and the number — POW +1 WORKER, THIS ROUND.")]));
C.push(dash([t("TRADE-OFF", { bold: true }), t(" — what is paid for it, by whom, and when: an extra unit on an upkeep line, a technician gone for the round, Integrity lost now or at the start of the next round. The card says which, beside the gain, before anything is pressed — AGR −1 WORKER, THIS ROUND. Since 2026-10-05 the cost does not fall on Agriculture by default: each half of a card says who it AFFECTS. Converting a bay costs Medical a hand, not AGR; a purge costs the purged sector a worker as well as AGR's pumps; opening the contingency stores or flushing the city's filters costs every sector. Six cards still pay entirely at home. Every sector a decision touches sees a CITY DECISION notice on its own console saying what landed and why, and AGR's console keeps the whole result until the next round deals.")]));
C.push(p(t("The card reads as a situation in the bays, not a prize: two sentences, then GAIN and TRADE-OFF side by side, shown once. Where a card needs a target the selector sits above the two columns and the chosen sector is written into the gain as it is picked. The confirmation step adds one line — BOTH EFFECTS APPLY IF CONFIRMED — and the buttons are the card's own verb (SEND TECHNICIAN, OPEN CACHE, OFFER FREIGHT SLOT) and BACK. There is no way to accept the gain and refuse the cost; the only refusal is to leave the card unplayed, and the other two cards are still on the table.")));
C.push(p([t("An upkeep consequence appears on AGR's "), mono("NEXT ROUND UPKEEP"), t(" line as soon as the decision is confirmed, and is paid when the next round is activated, exactly like the rest of that line. A round whose clock was never started charges nothing, so an obligation waits for a round that was actually played. The hand is weighted by round: Round 2 deals LOW and MEDIUM trade-offs, Round 3 and 4 deal MEDIUM and HIGH. The two heaviest cards — OPEN THE CONTINGENCY STORES and ATMOSPHERIC BIOFILTER FLUSH — keep their full gains for now and are flagged for review; note how often each is dealt, and whether AGR takes it every time it appears.")]));
C.push(H3("The freight slot needs Transport's word"));
C.push(p(t("One card is a proposal rather than a decision. RELEASE THE FREIGHT SLOT lends Transport one extra approval this round and takes one back from it next round — and Agriculture cannot impose that on Transport. When AGR offers it — the button says OFFER FREIGHT SLOT — nothing happens except that a card appears on Transport's TRANSFER CONTROL page under NEEDS MY ACTION, carrying the same GAIN and TRADE-OFF columns, with ACCEPT and DECLINE. AGR's own console reads PENDING TRN APPROVAL and its other two cards lock until Transport answers. The point is the conversation: AGR has to go and make the case. If Transport declines, nothing applies, AGR's console says TRN DECLINED THE ARRANGEMENT, and AGR may choose another card. If Transport never answers, the proposal lapses — on the paperwork timeout within the round, or when the round changes — and nothing applies either. A proposal is never carried into the next round.")));
C.push(p(t("The first time the mechanic applies, AGR's screen stops on an AGRICULTURE OPERATING NOTICE that says the rules have changed and must be acknowledged. It shows once. If you see it still up two minutes into Round 2, somebody at AGR is not reading their screen — that is worth a tag before it is worth a nudge.")));
C.push(callout("Do not explain the trade-off for them.", "Every card says what it costs. A table that confirms without reading the TRADE-OFF column has told you something about how it reads under pressure; a table that argues over a one-unit water obligation for three minutes has told you something else. Both are the data. Tag, do not coach."));
C.push(brk());

// ---------------------------------------------------------------- 4. day shape
C.push(H1("Part 4 · Shape of the Day"));
C.push(p(t("Two blocks the room can feel: a shift, then a reckoning. Everything between arrival and END SIMULATION is one unbroken run of the city; everything after it is the part they take to work.")));
C.push(tbl([
  headRow(["BLOCK", "TIME", "PURPOSE"], [3400, 1600, W - 5000]),
  row(["Arrival, consent, briefing", "20 min", "Consent signed. Story set. Roles assigned."], [3400, 1600, W - 5000]),
  row(["Round 0", "20 min", "Learn the console. Zero stakes. The only calm stretch of the day — spend it."], [3400, 1600, W - 5000]),
  row(["THE SHIFT — seven timed rounds", "80 min", "One crisis, Round 1 to Round 7: three rounds that teach, four that mix everything learned under rising pressure. Each round runs on its own clock — started by you, stopped by 00:00 — and between rounds nothing is reset and nothing on any screen says pause."], [3400, 1600, W - 5000]),
  row(["Lunch", "45 min", "The simulation has ENDED and the final city state stays on the wall. Council audio is transcribed during this."], [3400, 1600, W - 5000]),
  row(["Debrief 1 — the person", "60 min", "Personal metrics. Triggers. Reactive and creative."], [3400, 1600, W - 5000]),
  row(["Debrief 2 — the delta and the transfer", "45 min", "Early shift against late shift. One commitment, one named meeting, one date."], [3400, 1600, W - 5000]),
], [3400, 1600, W - 5000]));

C.push(H2("The rounds inside the shift"));
C.push(p(t("Participants see the round number, its clock running down and faults arriving — never a name or a boundary. What each round is for is yours. Times are minutes into the round.")));
C.push(tbl([
  headRow(["ROUND", "TIME", "WHAT IT IS FOR"], [3400, 1600, W - 5000]),
  row(["Round 1", "00:00–15:00", "Baseline capture. Intra-sector faults only. Comfortable on purpose."], [3400, 1600, W - 5000]),
  row(["Round 2", "00:00–11:00", "Sectors collide. Cross-sector specs, transfers, Council sitting one, AGR's first trade-offs."], [3400, 1600, W - 5000]),
  row(["Round 2", "11:00–15:00", "Simultaneous faults and competing priorities. Off-script injects live here."], [3400, 1600, W - 5000]),
  row(["Round 3", "00:00–10:00", "Peak pressure of the learning phase. Core decline, Continuity Order, brownouts, the reference chains."], [3400, 1600, W - 5000]),
  row(["Round 3", "10:00–12:00", "Fewer NEW majors so tables can catch up operationally. NOT a break. Say nothing."], [3400, 1600, W - 5000]),
  row(["Round 4", "00:00–08:00", "The mixed phase opens: a fresh crisis onto the city they are already carrying, every learned mechanic in play, medium pressure. POST-MEASUREMENT begins."], [3400, 1600, W - 5000]),
  row(["Round 5", "00:00–10:00", "Competing priorities, medium-high pressure. Several sectors need the same limited capability or resource at once, and one of them is a bottleneck."], [3400, 1600, W - 5000]),
  row(["Round 6", "00:00–10:00", "Cascading pressure, high. Earlier trade-offs land, delayed consequences bite, and one problem makes another harder to solve."], [3400, 1600, W - 5000]),
  row(["Round 7", "00:00–10:00", "The final round, very high but controlled. City-wide prioritisation: fewer, connected, critical problems, and the discovery that not everything can be solved."], [3400, 1600, W - 5000]),
], [3400, 1600, W - 5000]));
C.push(callout("If you are running late.", "Cut from the second half of Round 2 and the quiet two minutes of Round 3 first — they are connective, not diagnostic — then trim fifteen minutes from Debrief 1. Never Rounds 4 to 7, never the delta readout. Use the − button beside ROUND TIME: one click, one minute off this round, and nothing else in the city moves."));
C.push(brk());

// ---------------------------------------------------------------- 5. runbook
C.push(H1("Part 5 · The Runbook"));
C.push(p(t("Run the day from this part. The control panel mirrors these beats in order; firing a beat there marks it done and stamps the log. Inside the shift, every time is minutes into the round: each round's clock loads at its full length when you press NEXT ROUND, runs from START, and stops at 00:00.")));

C.push(H2("5.0 Orientation (20 min, Round 0 — no briefing)"));
C.push(callout("You say nothing about the game.", "The binder's first page tells each team that no briefing is coming, what HAVEN-9 is, what the objective is, and the twelve things to do before operating. The premise, the three rules and the console are all in it. Your job in Round 0 is to hand out the materials, fire the tutorial faults, and watch how each table organises itself without being told to."));
C.push(tbl([
  headRow(["TIME", "DO THIS", "WATCH FOR"], BW),
  beat("00:00", "Confirm all six recorders and the Council recorder are rolling. Then fire the klaxon sting. Every console already shows ROUND 0.", "Nothing yet — this is the audio sync."),
  beat("00:01", "Hand each table its binder, role cards, chit pad, resource tray and workforce tokens. Hand the City Charter to COM only. Say only: \"Everything you need is in the binder. Start at page 3.\"", "Who opens the binder, and who waits to be told."),
  beat("00:03", "Watch the roles being assigned (binder §1, step 1). Do not advise.", "How they assign. Volunteering, deferring, or the loudest person taking Chief. Tag it — this is your first data point."),
  beat("00:06", "Fire the six tutorial faults F-001 to F-006 from the fault library on the control panel, one per sector. The fault lands on each console; the binder's §7 takes it from there. No card needs handing over.", "Whether the Systems Lead reads the procedure aloud or silently, and whether anyone opens §7 first."),
  beat("00:16", "Confirm every sector has resolved its tutorial fault. Help only with the console itself — a wrong sector, a dead connection. A rules question gets a section number.", "Consoles showing the wrong sector. Fix now, not later."),
  beat("00:19", "Nothing to say. Press NEXT ROUND → Round 1 and START; the consoles change by themselves and the binder's NEW ROUND box tells each table what to check.", "Nobody should be waiting for a pause that is not coming."),
], BW));

C.push(H2("5.1 The Shift — starting it (00:00)"));
C.push(callout("Every round has its own clock.", "Press NEXT ROUND to Round 1, then START. NEXT ROUND loads the round's clock at its full length, waiting, and deals nothing — every fault is yours to fire from the library; START runs the clock, and from Round 4 on it also plays that round's city broadcast. The pair is pressed seven times — Rounds 1 to 7 — and the day ends with END SIMULATION. A clock that reaches 00:00 stops on its own and moves nothing, and the city keeps bleeding until the next START, so do not dawdle between rounds. Pressing the round you are already in offers a restart: the clock reloads and that round's faults go back to active. STOP CLOCK and PAUSE are not part of the script."));
C.push(p([t("What the room sees from now on: the round number and its clock counting down, their own health and stock, and their faults. What they never see: a phase name, a debrief screen, or a screen telling them to rest. "),
  t("The round is the period", { bold: true }),
  t(": when you activate the next round the city pays the outgoing round’s upkeep — 2 Power and 1 Water from every sector, the whole bill or none of it: a table that cannot pay in full keeps its stock and loses 10 Sector Health instead, once, and its console says UPKEEP SHORTFALL — POW and WTR generate their output by button during the round, and it lands then — and Transport’s approvals, Medical’s heals and Agriculture’s intervention cards come back for the new round. Round 0 is orientation and is never charged, and no round is ever charged twice.")]));

C.push(H3("Round 1 (00:00 – 15:00)"));
C.push(callout("This stretch should feel easy.", "It is the baseline measurement. If you make it hard, you have no calm-state reading and the whole delta collapses. Resist the urge to add pressure. Boring is correct.", "E8F5E8", "2E7D32"));
C.push(tbl([
  headRow(["ROUND TIME", "DO THIS", "WATCH FOR"], BW),
  beat("00:00", "NEXT ROUND → Round 1. START the clock. Then fire the round's six faults F-101 to F-106 from the library, one per sector, as fast or as slowly as the room can take them. Announce: routine shift, standard faults.", "Baseline talk patterns. Who speaks first at each table."),
  beat("02:00", "Walk the floor. Every table holds exactly one fault.", "Procedure read aloud or not. Crew assignment discussion, or one person deciding."),
  beat("06:00", "Nothing new fires in this round.", "Six tables, one load — compare how they carry it."),
  beat("10:00", "Anyone finished? Say nothing.", "Anyone finishing early and offering help to a neighbour — rare and worth tagging."),
  beat("14:00", "Let the tables clear what they hold.", "Which tables are relaxed and which are already tense at low load."),
], BW));

C.push(H3("Round 2 (00:00 – 11:00)"));
C.push(p(t("The first cross-sector wave. Every fault now requires a value that lives in another sector’s binder. Liaisons must move; the room gets loud. Press NEXT ROUND and say nothing — the faults are the announcement.")));
C.push(tbl([
  headRow(["ROUND TIME", "DO THIS", "WATCH FOR"], BW),
  beat("00:00", "NEXT ROUND → Round 2, START, then fire the round's twelve faults from the library, two per sector — all at once for the full wave, or staggered if the room is behind. Move two TRN workforce tokens physically to the MED table (F-207’s injury). START. Announce in-world: \"Core output is fluctuating. Systems are coupling in ways they should not.\"", "How long before the first liaison stands up. Every table now needs another table’s binder."),
  beat("01:00", "Walk the floor. Say nothing.", "F-201 is the discrepancy fault: watch WTR’s table when POW asks for the reservoir figure. MED’s cold chain has real urgency — do they escalate or absorb?"),
  beat("03:00", "Watch AGR and POW.", "AGR holds two faults and needs COM for both — does the liaison batch the requests or make two trips? POW holds two and is asked for specs by two others: classic bottleneck. Hoarding or brusqueness?"),
  beat("05:00", "Glance at AGR's console. From this round its three cards carry a TRADE-OFF as well as a gain, and the screen opened on a notice saying so.", "Whether the notice was acknowledged or is still sitting there. When AGR confirms a card, does anyone at the table read the TRADE-OFF column aloud? If they play RELEASE THE FREIGHT SLOT, watch who walks to Transport and what they say — the card does nothing until TRN accepts."),
  beat("04:00", "Watch TRN.", "The injury is visible and physical. Watch whether TRN asks MED for the two workers back, and how."),
  beat("06:00", "CALL COUNCIL on the Overview. Every screen shows COUNCIL IN SESSION with the one-minute clock; +0:30 as often as the room needs it. Chiefs and liaisons to the centre table — the rest of the city keeps running.", "THE KEY OBSERVATION WINDOW. Who speaks, in what order, for how long. Who never speaks. Who runs the meeting without being asked. Also: what happens at the stations while the leaders are away."),
  beat("09:00", "CLOSE COUNCIL.", "Whether anything agreed at Council actually changes behaviour."),
], BW));
C.push(callout("Council sittings are your richest data.", "Whole-group, compressed, high stakes, one microphone. If you tag nothing else in the shift, tag the Council. Remember the pressure it creates is that the stations are running short-handed while it sits — it is not a rest for anyone."));

C.push(H3("Round 2 (11:00 – 15:00)"));
C.push(p(t("No new script: this wave is where you spend the off-script inject library on the tables that are coping, and let the ones that are behind stay behind. Competing priorities are the point.")));
C.push(tbl([
  headRow(["ROUND TIME", "DO THIS", "WATCH FOR"], BW),
  beat("11:30", "No button — this wave is inside Round 2. Nothing new is scripted; whatever of the twelve you fired is still on the tables.", "The room is now carrying unresolved work from the last wave into this one. Nobody gets a clean sheet."),
  beat("13:00", "INJURE WORKER on the busiest sector. Fire one off-script fault at any table that is clear.", "Who asks for help first, and whether anyone offers before being asked."),
  beat("14:00", "Fire one more off-script fault into the loudest sector. Say nothing to the quiet ones.", "Sectors below 50 health. Note them; Round 3 will land on them hardest."),
], BW));

C.push(H3("Round 3 (00:00 – 10:00)"));
C.push(p(t("The climax. Two-spec faults, fast decay, and a decision with no right answer — landing on a city that has had no break since the shift began.")));
C.push(tbl([
  headRow(["ROUND TIME", "DO THIS", "WATCH FOR"], BW),
  beat("00:00", "NEXT ROUND → Round 3. START, then fire its six critical faults from the library, one per sector, two specs each. Announce: \"Core integrity is falling. Assume nothing is routine.\"", ""),
  beat("01:00", "Walk the floor. Say nothing.", "Two specs each now — coordination cost doubles. WTR and AGR need their own buried Appendix C: how long before anyone opens the back of the binder? F-302 bleeds at 3.0/min and F-304 at 2.5/min — watch for panic-guessing at the console."),
  beat("01:30", "AGR's hand is MEDIUM and HIGH trade-offs from here: a sector saved for ten Integrity of their own, or every sector lifted for twelve.", "Whether AGR spends its own health to carry the city, and whether anyone asks it to. A table that will not take a HIGH card to rescue a neighbour at 20% is a finding; so is one that takes it without a word to anyone."),
  beat("02:00", "Drop Core Integrity to 60. Announce: \"Core output cannot sustain six sectors.\" Klaxon.", "The room changes here. Note who moves first — toward the problem or toward protecting their own sector."),
  beat("05:00", "CALL COUNCIL on the Overview and announce the Continuity Order is due. Place the form on the centre table. +0:30 as needed; at 00:00 the clock says COUNCIL TIME EXPIRED and nothing else happens.", "Clause 7 says essential services take precedence and never defines essential. The argument about what essential means IS the exercise."),
  beat("06:30", "Ninety-second warning. Do not offer help or extend.", "Decision paralysis, or one voice bulldozing. Both are common. Tag both."),
  beat("08:00", "If the form is submitted: put the two lowest-ranked sectors into BROWNOUT (the quick action, one sector at a time). If not: announce rolling blackouts and start ROLLING BLACKOUT from EVENTS › PRESSURE.", "Indecision must cost more than any decision. Do not soften this."),
  beat("08:30", "Redeploy brownout sectors as aid crews to other tables. Nobody sits out.", "How brownout participants are treated by the sectors they join."),
], BW));

C.push(H3("Round 3 (10:00 – 12:00)"));
C.push(callout("This is not a break, and it must never be called one.", "Fire nothing new for two minutes — no button, this wave is inside Round 3. The clock runs, faults decay, repairs and transfers continue, upkeep waits for the next round. Tables use the stretch to catch up. If you announce anything at all, announce it in-world: \"Core output is holding.\"", "E8F5E8", "2E7D32"));
C.push(tbl([
  headRow(["ROUND TIME", "DO THIS", "WATCH FOR"], BW),
  beat("11:00", "No button — still Round 3. Fire nothing.", "What a team does with slack: clear the backlog, fix the tray, help a neighbour, or stop working. All three are findings."),
  beat("11:30", "Walk the floor. Tag. Do not fix anything and do not explain anything.", "Who starts talking about the day while it is still running — that is a table that has decided it is over."),
], BW));

C.push(H3("Round 4 (00:00 – 05:00)"));
C.push(p(t("Same teams, same roles, a fresh crisis onto the city they have left. Every fault needs a value buried in another sector’s Appendix C, so nothing can be solved from memory. Nothing is restored, refilled or healed for this wave — they carry what they built and what they broke. This is where the post-measurement begins.")));
C.push(tbl([
  headRow(["ROUND TIME", "DO THIS", "WATCH FOR"], BW),
  beat("00:00", "NEXT ROUND → Round 4. START, then fire its six faults from the library, each needing another sector’s buried appendix. Announce in-world: \"Seismic activity detected.\" Restore brownout sectors to active.", "Whether anyone notices that nothing else was given back."),
  beat("01:00", "The library's LATE SHIFT section is yours from here: twelve more faults, P-09 (two values from two other binders) and P-10 (TIME-CRITICAL — Integrity falls three a minute while it stays open). Mix them with Round 4's own six and the reference chains. Keep every table at two live faults; three only as a deliberate overload. Across the late shift, make each sector somebody's dependency at least once.", "Who is asked for a value by two tables at once, and whether they queue the asks or pick a favourite."),
  beat("01:00", "Walk the floor.", "Six sectors, six raids on six appendices. The asking behaviour should look different from the early shift — that difference is the deliverable. Watch who is asked twice and how they answer the second time. TRN’s fault is the mini-triage feed; decay pressure returns onto tired people."),
  beat("03:30", "Optional short Council if the group is coping well. Skip if they are not.", "Compare directly against the first sitting. Same people, same format, measurable difference."),
], BW));

C.push(H3("Round 4 (05:00 – 08:00)"));
C.push(tbl([
  headRow(["ROUND TIME", "DO THIS", "WATCH FOR"], BW),
  beat("05:00", "No button — still Round 4. Fire into whichever two sectors are weakest.", "Triage under fatigue. Who is still asking questions and who has stopped."),
  beat("06:00", "Last two minutes. Announce the time remaining once, plainly.", "What a table chooses to spend its last minutes on."),
  beat("08:00", "NEXT ROUND → Round 5, then START. The city broadcast SYSTEM LOAD INCREASING plays on START — say nothing yourself. Nothing is reset; whatever is open stays open.", "Whether anyone reads the broadcast aloud, and whether a table that is behind notices the clock is new."),
], BW));

C.push(H3("Round 5 (00:00 – 10:00)"));
C.push(p(t("Competing priorities. The pressure here is not more faults but the same capability wanted by several tables at once: three sectors needing something only Power Grid can give while Power Grid carries its own fault, or two tables waiting on one Transport approval. Fire fewer things and connect them. Mix the families — a workbook fault, a reference chain, a P-09 — rather than repeating a type.")));
C.push(tbl([
  headRow(["ROUND TIME", "DO THIS", "WATCH FOR"], BW),
  beat("00:00", "Fire two or three faults whose values or materials all come from one sector — POW, WTR or TRN — and one fault into that sector itself.", "Who goes to the bottleneck first, and whether the bottleneck sector serves in the order asked, in the order shouted, or in the order it prefers."),
  beat("02:00", "Walk the floor. Say nothing.", "A table that waits silently for a value it has not asked for. A liaison who asks for two things in one trip."),
  beat("05:00", "One TIME-CRITICAL P-10 into a sector already carrying a fault. Let the pending AGR trade-off and the upkeep line do their work.", "Whether the table drops the old fault for the loud new one, and who decides that."),
  beat("08:00", "Last two minutes. Announce the time once.", "Whether anyone starts a transfer they cannot finish."),
  beat("10:00", "NEXT ROUND → Round 6, then START. CASCADE CONDITIONS DETECTED plays on START.", "Upkeep lands now: watch the NEXT ROUND UPKEEP lines on the consoles turn into real shortages."),
], BW));

C.push(H3("Round 6 (00:00 – 10:00)"));
C.push(p(t("Cascading pressure. The rule for this round is that one problem should make another problem harder to solve: Transport's capacity is down from a freight slot it accepted, so the movement Medical needs is late while Medical's Integrity is already falling; Agriculture is paying an extra unit at upkeep from a card it played two rounds ago. You are not adding faults so much as letting the earlier decisions arrive. Add only what connects.")));
C.push(tbl([
  headRow(["ROUND TIME", "DO THIS", "WATCH FOR"], BW),
  beat("00:00", "Fire one fault into the sector whose Integrity is lowest and one into the sector it depends on. A TIME-CRITICAL P-10 where a movement is already waiting.", "Whether the room recognises the chain — the fault, the missing resource, the sector that holds it — or treats each as separate."),
  beat("03:00", "Walk the floor. If a table is drowning rather than struggling, fire nothing more at it.", "A plan from Round 5 that no longer works, and how long before someone says so out loud."),
  beat("06:00", "A second P-10 if the room is coping; nothing if it is not. The pressure is high, not maximal.", "Who protects their own sector and who gives up a value or a unit to another."),
  beat("10:00", "NEXT ROUND → Round 7, then START. FINAL OPERATING WINDOW plays on START.", "Silence or noise at the transition: both are data."),
], BW));

C.push(H3("Round 7 (00:00 – 10:00)"));
C.push(p(t("The final round. Do not flood every sector with faults. Use a small number of strategically connected critical problems and let the city decide what matters: the point of the round is that not everything can be solved, and that choosing is the work. Call Council if the group needs a sitting to decide; otherwise let them find the conversation themselves.")));
C.push(tbl([
  headRow(["ROUND TIME", "DO THIS", "WATCH FOR"], BW),
  beat("00:00", "Fire three connected problems across the city, no more: a TIME-CRITICAL P-10 on a sector near CRITICAL, a reference chain through a sector that is busy, a late-shift fault whose values sit in two sectors that are not talking.", "Whether anyone says the word priority. Whether a table abandons a fault deliberately, and announces it, or just stops."),
  beat("03:00", "Optional Council if the group is choosing well; skip it if they are already choosing. Compare directly against the first sitting.", "Same people, same format, a measurably different conversation — or not."),
  beat("05:00", "Nothing new unless a table has gone quiet. The last five minutes belong to them.", "Coordination over completion: who stops repairing to help a neighbour hold Integrity."),
  beat("08:00", "Last two minutes. Announce the time remaining once, plainly.", "What a city chooses to spend its last minutes on."),
  beat("10:00", "END SIMULATION. Every clock stops and the final city state stays exactly as they left it.", "Silence, then talk. Do not explain anything yet."),
], BW));
C.push(callout("End it deliberately.", "END SIMULATION on the control panel stops the round timer and every decay, and leaves the city as it stands. It clears nothing and scores nothing away, and no screen in the room turns into a debrief. The wall is your lunch exhibit — leave it up."));

C.push(H2("5.2 Lunch (45 min)"));
C.push(callout("During lunch.", "Transcribe the Council audio and one nominated sector. You need only three numbers per person for Debrief 1: talk time, interruptions, questions asked. The full report can follow next morning. Leave the final city state on the big screen throughout — people will stand in front of it, and that is the debrief starting by itself.", "E8E8F5", NAVY));

C.push(H2("5.3 Debrief 1 — the person (60 min)"));
C.push(p(t("Structure, not free discussion. Free discussion becomes a war story session and transfers nothing.")));
C.push(tbl([
  headRow(["TIME", "DO THIS", "WATCH FOR"], BW),
  beat("00:00", "Replay the shift factually on the big screen. What failed, when, what got decided. No interpretation yet.", "Corrections from the floor — useful, and they surface disputed memories."),
  beat("10:00", "Hand out personal headline metrics. Silent reading, three minutes, no discussion.", "Faces. This is the moment the day lands or does not."),
  beat("15:00", "Pairs. \"What surprised you in your numbers?\"", "Deflection onto the game design is normal at first. Let it pass once, then redirect."),
  beat("25:00", "Trigger work in sector groups. \"Go back to the moment your behaviour changed. What was happening? What did you feel just before?\"", "Specificity. \"I get stressed\" is not a trigger. \"When two people talk at once and a clock is running\" is."),
  beat("40:00", "Name the reactive-to-creative distinction. Reactive is what the trigger does to you. Creative is what you choose next.", "Participants trying to make this abstract. Keep pulling it back to their transcript."),
  beat("50:00", "Reveal the two probes only if they have not surfaced: discrepancy, buried appendices.", "Reactions to the discrepancy tell you as much as the original moment did."),
  beat("55:00", "Ask the question the continuous shift earns you: \"There was no break. When did you notice that, and what did you do about it?\"", "The honest answers here are the best material in the day. Nobody was given permission to recover; some took it anyway, and some did not."),
], BW));

C.push(H2("5.4 Debrief 2 — the delta and the transfer (45 min)"));
C.push(p(t("The delta is early shift against late shift: the same people, the same format, a full shift of accumulating load apart. Because the shift ran unbroken, the comparison is clean — nothing in the middle reset the city or rested the room.")));
C.push(tbl([
  headRow(["TIME", "DO THIS", "WATCH FOR"], BW),
  beat("00:00", "Put the aggregate deltas on the big screen. Interruptions, talk-time balance, questions asked — early shift against late shift.", "This is the product shot. Let it sit on screen while people absorb it."),
  beat("08:00", "Individual deltas handed out. \"What did you do differently by the end, and was it a choice?\"", "Honest reporting of the moments it slipped. Reward it visibly, or the room learns to perform success."),
  beat("18:00", "Each participant writes ONE behavioural commitment. Observable, not aspirational.", "\"Be more collaborative\" is not usable. \"Ask one question before offering my answer\" is. Push until every commitment is countable."),
  beat("26:00", "Map to work. \"Which meeting next week is your Round 3?\" Name the actual meeting, the actual people.", "Vagueness. Push for a named meeting and a date."),
  beat("34:00", "Pairs commit to one specific behaviour in one specific meeting, and to a check-in date.", "Peer accountability outlasts facilitator accountability. This is where the change is checked — the simulation is finished."),
  beat("40:00", "Close. Explain what arrives afterwards: full personal report to each individual, aggregate report to the organisation, nothing else.", "Restate the confidentiality position. It is the last thing they should hear."),
], BW));
C.push(brk());

// ---------------------------------------------------------------- 6. troubleshooting
C.push(H1("Part 6 · Troubleshooting"));
C.push(tbl([
  headRow(["SITUATION", "WHAT TO DO"], [4000, W - 4000]),
  row(["A console will not accept a correct code", "Check the sector on the URL first — a device open on the wrong sector is the usual cause. If genuinely stuck, resolve the fault from the control panel and tell the table their fix was accepted. Never let a paper-versus-server mismatch stall a table; note it and diagnose after."], [4000, W - 4000]),
  row(["A table is drowning, not struggling", "Pause one of their faults from the control panel, or grant resources quietly. Do not announce either, and do not pause the session — the relief has to look like the city easing, not like the facilitator stopping the day."], [4000, W - 4000]),
  row(["A table finishes everything early", "Fire an off-script fault from the inject library. Boredom produces no data."], [4000, W - 4000]),
  row(["Nobody sends a liaison", "Say nothing for five minutes. It is a finding. If the whole room is stuck at ten minutes, announce that station consoles cannot transmit and only people can carry information."], [4000, W - 4000]),
  row(["The room goes quiet and stays quiet", "Fire a public callout on the ticker naming a sector with unresolved faults. Public visibility restarts conversation faster than any instruction."], [4000, W - 4000]),
  row(["A participant asks when the break is", "\"There isn't one — the city doesn't get one either.\" Say it once, plainly, and move on. Do not apologise for the design and do not invent a pause."], [4000, W - 4000]),
  row(["A round is running long or short", "Use the − and + buttons beside ROUND TIME: one click, one minute on this round's clock. The clock is the only thing that moves — no stock, health, fault, transfer or round changes. Every click is logged with a reason."], [4000, W - 4000]),
  row(["A participant disengages entirely", "Floor Facilitator sits beside them, quietly. Give them a concrete job: the log, the chit count. Re-entry through a task, not through a conversation about participating."], [4000, W - 4000]),
  row(["Conflict turns personal", "Go to the table yourself and redirect to the system, not the person: \"What does your procedure require?\" Do not stop the simulation to do it. If it persists, handle it in the debrief with the transcript in hand, privately."], [4000, W - 4000]),
  row(["The server crashes", "It snapshots every ten seconds. Restart and reload. If it will not come back, continue on paper: you hold the answer key, and integrity can be tracked on a flipchart. The simulation survives losing the software. It does not survive losing the binders."], [4000, W - 4000]),
  row(["A recorder failed mid-shift", "Use the phone backup. If both failed, tell affected participants honestly at the debrief that their personal report covers part of the shift only. Do not fabricate metrics."], [4000, W - 4000]),
  row(["A participant asks whether their boss sees this", "Answer immediately and plainly: no. Individual reports go to individuals. Do not hedge."], [4000, W - 4000]),
  row(["AGR says its cards are locked", "It has proposed the freight slot and Transport has not answered: the console says PENDING TRN APPROVAL and the other two cards wait. That is the design — send nobody; see whether AGR goes to Transport itself. If it must be cleared, the AGR block on the control panel shows the proposal with ACCEPT FOR TRN and DECLINE FOR TRN; or let it lapse, which it does on its own at the round change."], [4000, W - 4000]),
  row(["AGR took a card and now says it did not agree to the cost", "It did: the cost was on the card under TRADE-OFF, beside the gain, over the line BOTH EFFECTS APPLY IF CONFIRMED, and the log holds the confirmation. Do not reverse it. Keep it for the debrief — reading the second half of a decision is the behaviour this mechanic exists to surface."], [4000, W - 4000]),
], [4000, W - 4000]));
C.push(brk());

// ---------------------------------------------------------------- 7. reset
C.push(H1("Part 7 · Reset Between Cohorts"));
C.push(p(t("Target: fifteen minutes, performed by someone who did not build the game. Work down this list in order.")));
const RW = [800, W - 800];
C.push(tbl([
  headRow(["#", "STEP"], RW),
  row(["1", "Collect all six binders. Remove used log sheets, insert fresh ones. Confirm each binder still holds its Appendix C page."], RW),
  row(["2", "If the optional fault deck was used, collect every card from tables and floor, re-sort by section tab and count to 60."], RW),
  row(["3", "Refill resource trays to opening stock: 3 power, 3 water, 3 parts, 1 med per sector."], RW),
  row(["4", "Return workforce tokens to 8 per sector, including any left at the MED table."], RW),
  row(["5", "Collect used and unused chits. Refill each pad. Retrieve the TRN stamp — it goes missing more than anything else in the kit."], RW),
  row(["6", "Retrieve the City Charter and any Continuity Order. Insert a fresh Continuity Order form."], RW),
  row(["7", "Collect role cards, re-sort by sector."], RW),
  row(["8", "Control panel: RESET RUN with a new run ID. Confirm all six sector consoles reload to 100 integrity and zero faults."], RW),
  row(["9", "Export the run log and copy the audio files off the recorders. Label by run ID. Clear the recorders."], RW),
  row(["10", "Fresh consent forms on tables. Re-place table tents."], RW),
  row(["11", "Check the answer key is back in the control folder and not on a participant table."], RW),
], RW));
C.push(callout("The reset is a quality control gate, not housekeeping.", "On an aggregator model the largest quality risk is not the design, it is variance between associate trainers. Most of that variance enters through an incomplete reset. Someone signs this list."));

C.push(H2("After the event"));
C.push(dash("Transcribe all tables. Code against the behavioural framework. Individual reports to individuals within five working days."));
C.push(dash("Aggregate report to the client, no individual attribution."));
C.push(dash("Delete audio at 30 days, transcripts at 90, as promised on the consent form. Diarise it."));
C.push(dash([t("Log any content problem you hit — a fault that would not resolve, a procedure that read ambiguously — and fix it "), t("in the crossref matrix", { bold: true }), t(", then regenerate the paper and the server fixtures. Never patch a printed page.")]));

const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 20, color: INK } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: "Arial", size: 34, bold: true, color: NAVY } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: "Arial", size: 24, bold: true, color: INK } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: "Arial", size: 21, bold: true, color: NAVY } },
    ],
  },
  sections: [{
    properties: { page: { size: { width: A4W, height: A4H }, margin: { top: M, bottom: M, left: M, right: M } } },
    headers: { default: new Header({ children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE } },
      children: [t("UNDERCITY · FACILITATOR & ADMINISTRATOR GUIDEBOOK", { size: 14, color: MUTED })] })] }) },
    footers: { default: new Footer({ children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ children: ["Page ", PageNumber.CURRENT], font: "Arial", size: 14, color: MUTED })] })] }) },
    children: C,
  }],
});

Packer.toBuffer(doc).then((b) => {
  fs.writeFileSync(path.join(OUTDIR, "UNDERCITY_Facilitator_Guidebook.docx"), b);
  console.log("✓", path.join(OUTDIR, "UNDERCITY_Facilitator_Guidebook.docx"));
});
