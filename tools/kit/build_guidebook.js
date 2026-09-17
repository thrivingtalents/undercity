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
C.push(p(t("UNDERCITY is a hybrid physical and digital simulation for 18 to 36 participants. Six teams run six interdependent sectors of an underground city whose power core is failing. Over four rounds the pressure rises, the sectors are forced into each other's problems, and the group has to make a decision nobody wants to make.")));
C.push(p([t("The simulation is not the product. ", { bold: true }), t("What you are selling and what the client is buying is the measurement and the debrief: every table is recorded, and each participant receives a personal report on how they behaved under pressure, followed by a chance to change it in a fifth round on the same day. The simulation exists to generate that evidence. Facilitate accordingly — a beautifully run game with a rushed debrief is a failed delivery.")]));

C.push(H2("What it measures"));
C.push(dash("Talk time, interruptions and questions asked, per person, per round."));
C.push(dash("How information moves between sectors, and how long people sit on it."));
C.push(dash("Who dominates, who withdraws, and at what level of pressure each begins."));
C.push(dash("Whether dissent is welcomed or shut down, and by whom."));
C.push(dash("The change in all of the above between the first round and the last."));

C.push(H2("The design logic in one page"));
C.push(p(t("Round 1 is deliberately easy. It is the baseline: you cannot say someone dominates under pressure unless you know how they speak when there is none. Rounds 2 and 3 raise the pressure in defined steps. The diagnostic is the difference between rounds, not the behaviour in any one of them.")));
C.push(p(t("Round 4 is the point of the day. After the debrief, participants re-enter a crisis holding one written behavioural commitment each, and you measure again. A participant seeing their own interruption count drop from fourteen to three inside one day is the most persuasive thing in this product.")));
C.push(callout("Never cut Round 4.", "If the day is running late, shorten Round 2, cut the breather after Round 3, or trim Debrief 1. Round 4 and the delta are the deliverable. Everything before them is setup."));

C.push(H2("Three deliberate design choices you will be asked about"));
C.push(H3("Nobody is ever eliminated"));
C.push(p(t("Sectors can go dark and can be placed in brownout, but no participant is ever removed from play, and no mechanic asks the group to expel a person. Sacrifice decisions target fictional populations. Participants go back to the same office on Monday, and a transcript showing who argued to cut whom would outlive the workshop.")));
C.push(H3("The software does not enforce resources"));
C.push(p(t("The console checks the resolution code and the crew, not the stock. Physical chits are the truth. If the software policed inventory, teams would argue with a screen instead of with each other, and the argument is the data.")));
C.push(H3("There is no chat function"));
C.push(p(t("Every message between sectors is spoken or walked. A chat box would move the entire diagnostic into silent text. If a participant asks for one, the answer is that the city's network is down — which it is.")));
C.push(brk());

// ---------------------------------------------------------------- 2. before the day
C.push(H1("Part 2 · Before the Day"));

C.push(H2("2.1 Staffing"));
C.push(p(t("Minimum two people. One Game Master on the control panel, one Floor Facilitator moving between tables. A single facilitator can run 18 participants at a push, but will lose most of the observation data, which is the expensive part.")));
C.push(tbl([
  headRow(["ROLE", "DURING PLAY", "DURING DEBRIEF"], [2200, 4000, W - 6200]),
  row(["Game Master", "Fires injects from the runbook, manages clocks and modes, hands out fault cards, watches the big screen.", "Runs the deltas on screen. Owns timing."], [2200, 4000, W - 6200]),
  row(["Floor Facilitator", "Moves between tables. Tags observations. Answers rules questions. Does not solve problems.", "Runs the small-group trigger work. Holds the room."], [2200, 4000, W - 6200]),
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
C.push(callout("The klaxon sync, and why it matters more than it looks.", "At the start of Round 0 you will fire a klaxon. The spike appears on every recording and is how transcripts get aligned to the game log afterwards. If you forget it, or if a recorder starts late, that table's analysis becomes manual reconstruction. Confirm every recorder is rolling, then fire it. This is the single most skippable step with the largest downstream cost.", "FFE8E8", RED));

C.push(H2("2.4 Consent — non-negotiable"));
C.push(p(t("Consent forms are signed before Round 0 begins, not during a break. Walk the room and collect them. Anyone who declines a personal report still plays; note their name so they are excluded from individual analysis.")));
C.push(p([t("Say the confidentiality position out loud, in front of everyone, in plain terms: ", {}),
  t("individual reports go to the individual and nobody else; the organisation gets group patterns only.", { bold: true }),
  t(" If participants believe their transcript reaches their boss, every word becomes performance and the day measures impression management instead of behaviour.")]));

C.push(H2("2.5 Printing and assembly"));
C.push(p(t("All paper is generated from the crossref matrix. Never hand-edit a printed value or a JSON file: the moment paper and server disagree, a fault becomes unsolvable mid-session and there is no recovery in the room.")));
C.push(tbl([
  headRow(["ARTIFACT", "QUANTITY", "NOTES"], [3000, 1800, W - 4800]),
  row(["Sector binders", "6", "Two-ring binder each, sector-coloured. Log sheet loose-leaf — the only consumable page."], [3000, 1800, W - 4800]),
  row(["Fault cards", "36", "9 A4 landscape sheets, 4-up. Cut and tab by round: R0, R1, R2, R3, R4."], [3000, 1800, W - 4800]),
  row(["Answer key", "1", "Game Master only. Never leaves the control table."], [3000, 1800, W - 4800]),
  row(["Transfer chits", "~120", "40 sheets, 2-up. Overprint — teams waste them early and hoard them late."], [3000, 1800, W - 4800]),
  row(["City Charter", "1", "Two pages plus Continuity Order. Goes to COM at Round 0."], [3000, 1800, W - 4800]),
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
C.push(p(t("Teams will flounder, misread procedures, forget to send their liaison, and blame the software. Let them. The floundering is the diagnostic. Answer rules questions plainly and refuse content questions: you may say how the console works, never what the answer is or who to ask.")));
C.push(script([
  "Participant: \"We can't find this spec anywhere.\"",
  "You: \"Your binder tells you where it lives. Read the procedure again, all of it.\"",
  "Participant: \"Is it in Water's binder?\"",
  "You: \"I'm not able to tell you that. Your procedure can.\"",
]));
C.push(H3("3. Throttle to the room, not to the clock"));
C.push(p(t("The runbook is a script, not a metronome. A team coasting gets an extra fault. A table genuinely drowning — not struggling, drowning — gets a fault paused or a resource grant. You are managing a stress curve, and the target is pressure that is uncomfortable and survivable, never chaotic. Chaos produces noise, not diagnosis.")));
C.push(H3("4. Tag as you go"));
C.push(p(t("Every observation you type into the control panel is timestamped alongside the game events, and the debrief timeline assembles itself from those tags. Untagged observations are lost by lunchtime. Aim for at least twenty tags across the day.")));
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

C.push(H2("3.3 The three seeded probes"));
C.push(p(t("Three things in this simulation are not what they appear. Know all three cold; participants will challenge you on them in the debrief.")));
C.push(H3("The discrepancy — Water's reservoir pressure"));
C.push(p([t("The WTR binder prints the Lower Reservoir at "), mono("340"), t(". The big screen telemetry shows "), mono("290"),
  t(". Both are accepted by the console, so the game never punishes either. The question is purely whether anyone notices, whether they say so, and how the group treats them when they do. The binder also carries a line saying printed values take precedence over instrumentation, which gives a dissenter a basis to stand on. Tag every mention.")]));
C.push(H3("The false alarm — F-210"));
C.push(p([t("Agriculture receives a fault card for a flooded bay. There is no flood and there is no resolution code. Their index tells them to verify telemetry with Comms before committing resources. If they burn resources on it, that is the finding. Clear the fault manually from the control panel once COM confirms the ghost — or once AGR has wasted enough to make the point.")]));
C.push(H3("The buried appendices"));
C.push(p(t("Every binder holds one Appendix C value that appears in no index. Water and Agriculture need their own in Round 3; the rest are raided by other sectors in Round 4. Teams that never open the back of the binder will stall. That stall is a finding about how people behave when the documentation fights back.")));
C.push(brk());

// ---------------------------------------------------------------- 4. day shape
C.push(H1("Part 4 · Shape of the Day"));
C.push(tbl([
  headRow(["BLOCK", "TIME", "PURPOSE"], [3400, 1600, W - 5000]),
  row(["Arrival, consent, briefing", "20 min", "Consent signed. Story set. Roles assigned."], [3400, 1600, W - 5000]),
  row(["Round 0 — Orientation", "15 min", "Learn the console. Zero stakes."], [3400, 1600, W - 5000]),
  row(["Round 1 — Stable Operations", "20 min", "BASELINE CAPTURE. Comfortable on purpose."], [3400, 1600, W - 5000]),
  row(["Breather", "5 min", "Contrast. Stress needs it to register."], [3400, 1600, W - 5000]),
  row(["Round 2 — Interdependence", "30 min", "Sectors collide. Council sitting one."], [3400, 1600, W - 5000]),
  row(["Breather", "5 min", ""], [3400, 1600, W - 5000]),
  row(["Round 3 — Core Failure", "30 min", "Peak pressure. Triage decision."], [3400, 1600, W - 5000]),
  row(["Lunch", "45 min", "Transcription of Council audio runs during this."], [3400, 1600, W - 5000]),
  row(["Debrief 1", "60 min", "Personal metrics. Triggers. One written commitment each."], [3400, 1600, W - 5000]),
  row(["Round 4 — Aftershock", "25 min", "POST-MEASUREMENT. The deliverable."], [3400, 1600, W - 5000]),
  row(["Debrief 2", "45 min", "Deltas on screen. Transfer plan."], [3400, 1600, W - 5000]),
], [3400, 1600, W - 5000]));
C.push(callout("If you are running late.", "Cut in this order: the second breather, then ten minutes from Round 2, then fifteen from Debrief 1. Never Round 4, never the delta readout."));
C.push(brk());

// ---------------------------------------------------------------- 5. runbook
C.push(H1("Part 5 · The Runbook"));
C.push(p(t("Run the day from this part. The control panel mirrors these beats in order; firing a beat there marks it done and stamps the log. Times are minutes elapsed within the round.")));

C.push(H2("5.0 Briefing and Round 0 — Orientation (15 min)"));
C.push(script([
  "\"The surface has been uninhabitable for forty years. Your city, HAVEN-9, survives three hundred metres underground, kept alive by six sector systems and a geothermal core.\"",
  "\"This morning the core began to degrade. You are the sector leadership. The city does not know yet. You have one shift.\"",
  "\"Three rules. Your binder does not leave your station. Only your liaison leaves your station. And nothing moves between sectors without a signed chit stamped by Transport.\"",
]));
C.push(tbl([
  headRow(["TIME", "DO THIS", "WATCH FOR"], BW),
  beat("00:00", "Confirm all six recorders and the Council recorder are rolling. Then fire the klaxon sting.", "Nothing yet — this is the audio sync."),
  beat("00:01", "Hand each table its binder, role cards, chit pad, resource tray and tokens. Hand the City Charter to COM only.", "Whether COM tells anyone they have the Charter."),
  beat("00:03", "Two minutes to assign the four roles. Do not advise.", "How they assign. Volunteering, deferring, or the loudest person taking Chief. Tag it — this is your first data point."),
  beat("00:06", "Fire the six tutorial faults F-001 to F-006, one per sector. Hand the cards.", "Whether the Systems Lead reads the procedure aloud or silently."),
  beat("00:12", "Confirm every sector has resolved its tutorial fault. Help freely here — this is the only round where you may.", "Consoles showing the wrong sector. Fix now, not later."),
], BW));

C.push(H2("5.1 Round 1 — Stable Operations (20 min)"));
C.push(callout("This round should feel easy.", "Round 1 is the baseline measurement. If you make it hard, you have no calm-state reading and the whole delta collapses. Resist the urge to add pressure. Boring is correct.", "E8F5E8", "2E7D32"));
C.push(tbl([
  headRow(["TIME", "DO THIS", "WATCH FOR"], BW),
  beat("00:00", "Start round clock. Announce: routine shift, standard faults.", "Baseline talk patterns. Who speaks first at each table."),
  beat("02:00", "Fire F-101 (POW), F-103 (WTR).", "Procedure read aloud or not."),
  beat("06:00", "Fire F-105 (MED), F-106 (TRN).", "Crew assignment discussion, or one person deciding."),
  beat("10:00", "Fire F-102 (POW), F-107 (AGR).", "POW now has two faults. First hint of load."),
  beat("14:00", "Fire F-104 (WTR), F-108 (COM).", "Anyone finishing early and offering help to a neighbour — rare and worth tagging."),
  beat("18:00", "Let the round close. Do not extend.", "Which tables are relaxed and which are already tense at low load."),
], BW));
C.push(p([t("Breather, five minutes. ", { bold: true }), t("Toggle breather on the control panel — this pauses all decay and clocks. Do not debrief anything yet.")]));

C.push(H2("5.2 Round 2 — Interdependence (30 min)"));
C.push(p(t("The first cross-sector round. Every fault now requires a value that lives in another sector's binder. Liaisons must move; the room gets loud.")));
C.push(tbl([
  headRow(["TIME", "DO THIS", "WATCH FOR"], BW),
  beat("00:00", "Announce: \"Core output is fluctuating. Systems are coupling in ways they should not.\" Start clock.", "How long before the first liaison stands up."),
  beat("01:00", "Fire F-201 (POW) and F-203 (WTR).", "F-201 is the discrepancy fault. Watch WTR's table when POW asks for the reservoir figure."),
  beat("05:00", "Fire F-205 (MED), F-209 (AGR).", "MED's cold chain has real urgency. Do they escalate or absorb?"),
  beat("08:00", "Fire F-210 (AGR) — the false alarm.", "Do they check with COM, or spend resources on a ghost? Tag either way."),
  beat("11:00", "Fire F-207 (TRN). Move two TRN workforce tokens physically to the MED table.", "The injury is visible and physical. Watch whether TRN asks MED for them back, and how."),
  beat("14:00", "Fire F-211 (COM), F-202 (POW).", "POW now holds two and is being asked for specs by two others. Classic bottleneck. Watch for hoarding or brusqueness."),
  beat("18:00", "Set mode to COUNCIL. Five-minute clock. Chiefs and liaisons to the centre table.", "THE KEY OBSERVATION WINDOW. Who speaks, in what order, for how long. Who never speaks. Who runs the meeting without being asked."),
  beat("23:00", "Return to PLAY. Fire F-204 (WTR), F-206 (MED), F-208 (TRN), F-212 (COM).", "Whether anything agreed at Council actually changes behaviour."),
  beat("28:00", "Let the round close.", "Unresolved faults left standing. Note which sectors are below 50 integrity."),
], BW));
C.push(callout("Council sittings are your richest data.", "Whole-group, compressed, high stakes, one microphone. If you tag nothing else in the round, tag the Council."));
C.push(p([t("Breather, five minutes.", { bold: true })]));

C.push(H2("5.3 Round 3 — Core Failure (30 min)"));
C.push(p(t("The climax. Two-spec faults, fast decay, and a decision with no right answer.")));
C.push(tbl([
  headRow(["TIME", "DO THIS", "WATCH FOR"], BW),
  beat("00:00", "Announce: \"Core integrity is falling. Assume nothing is routine.\" Start clock.", ""),
  beat("01:00", "Fire F-301 (POW), F-303 (MED).", "Two specs each now. Coordination cost doubles."),
  beat("04:00", "Fire F-302 (WTR, 3.0/min decay) and F-305 (AGR).", "Both need their own buried Appendix C. Watch how long before anyone opens the back of the binder."),
  beat("05:00", "Drop Core Integrity to 60. Announce: \"Core output cannot sustain six sectors.\" Klaxon.", "The room changes here. Note who moves first — toward the problem or toward protecting their own sector."),
  beat("08:00", "Fire F-304 (TRN, 2.5/min decay), F-306 (COM).", "Health is draining fast now. Watch for panic-guessing at the console."),
  beat("15:00", "Set mode to COUNCIL. Announce the Continuity Order is due. Place the form on the centre table.", "Clause 7 says essential services take precedence and never defines essential. The argument about what essential means IS the exercise."),
  beat("20:00", "Ninety-second warning. Do not offer help or extend.", "Decision paralysis, or one voice bulldozing. Both are common. Tag both."),
  beat("20:00", "If the form is submitted: apply brownout to the two lowest-ranked sectors. If not: announce rolling blackouts across all six.", "Indecision must cost more than any decision. Do not soften this."),
  beat("22:00", "Redeploy brownout sectors as aid crews to other tables. Nobody sits out.", "How brownout participants are treated by the sectors they join."),
  beat("28:00", "Close the round. Leave the final city state on the big screen through lunch.", "Let it sit. Do not explain it yet."),
], BW));
C.push(callout("During lunch.", "Transcribe the Council audio and one nominated sector. You need only three numbers per person for Debrief 1: talk time, interruptions, questions asked. The full report can follow next morning.", "E8E8F5", NAVY));

C.push(H2("5.4 Debrief 1 (60 min)"));
C.push(p(t("Structure, not free discussion. Free discussion becomes a war story session and transfers nothing.")));
C.push(tbl([
  headRow(["TIME", "DO THIS", "WATCH FOR"], BW),
  beat("00:00", "Replay the day factually on the big screen. What failed, when, what got decided. No interpretation yet.", "Corrections from the floor — useful, and they surface disputed memories."),
  beat("10:00", "Hand out personal headline metrics. Silent reading, three minutes, no discussion.", "Faces. This is the moment the day lands or does not."),
  beat("15:00", "Pairs. \"What surprised you in your numbers?\"", "Deflection onto the game design is normal at first. Let it pass once, then redirect."),
  beat("25:00", "Trigger work in sector groups. \"Go back to the moment your behaviour changed. What was happening? What did you feel just before?\"", "Specificity. \"I get stressed\" is not a trigger. \"When two people talk at once and a clock is running\" is."),
  beat("40:00", "Name the reactive-to-creative distinction. Reactive is what the trigger does to you. Creative is what you choose next.", "Participants trying to make this abstract. Keep pulling it back to their transcript."),
  beat("48:00", "Each participant writes ONE behavioural commitment for Round 4. Observable, not aspirational. They keep it visible on the table.", "\"Be more collaborative\" is not usable. \"Ask one question before offering my answer\" is. Push until every commitment is countable."),
  beat("58:00", "Reveal the three probes only if they have not surfaced: discrepancy, false alarm, buried appendices.", "Reactions to the discrepancy tell you as much as the original moment did."),
], BW));

C.push(H2("5.5 Round 4 — Aftershock (25 min)"));
C.push(p(t("Same teams, same roles, new crisis. Every fault needs a value buried in another sector's Appendix C, so nothing can be solved from memory of Round 2. Agriculture and Comms hold no faults this round but are the most demanded spec sources — they will be busy being asked, which is its own test.")));
C.push(tbl([
  headRow(["TIME", "DO THIS", "WATCH FOR"], BW),
  beat("00:00", "Announce an aftershock. Restore brownout sectors to active. Remind everyone their commitment is on the table.", "Whether commitments are visible or already buried under paper."),
  beat("02:00", "Fire F-401 (POW), F-402 (MED).", "Both need buried appendices from other sectors. Watch the asking behaviour — it should look different from Round 2."),
  beat("07:00", "Fire F-403 (WTR), F-404 (TRN).", "TRN's is the mini-triage feed. Decay pressure returns."),
  beat("14:00", "Optional short Council if the group is coping well. Skip if they are not.", "Compare directly against the Round 2 sitting. Same people, same format, measurable difference."),
  beat("22:00", "Close. Leave the final state up.", ""),
], BW));

C.push(H2("5.6 Debrief 2 (45 min)"));
C.push(tbl([
  headRow(["TIME", "DO THIS", "WATCH FOR"], BW),
  beat("00:00", "Put the aggregate deltas on the big screen. Interruptions, talk-time balance, questions asked, Round 2 against Round 4.", "This is the product shot. Let it sit on screen while people absorb it."),
  beat("08:00", "Individual deltas handed out. \"Did your commitment hold? Where did it break?\"", "Honest reporting of failure. Reward it visibly, or the room learns to perform success."),
  beat("20:00", "Map to work. \"Which meeting next week is your Round 3?\" Name the actual meeting, the actual people.", "Vagueness. Push for a named meeting and a date."),
  beat("32:00", "Pairs commit to one specific behaviour in one specific meeting, and to a check-in date.", "Peer accountability outlasts facilitator accountability."),
  beat("40:00", "Close. Explain what arrives afterwards: full personal report to each individual, aggregate report to the organisation, nothing else.", "Restate the confidentiality position. It is the last thing they should hear."),
], BW));
C.push(brk());

// ---------------------------------------------------------------- 6. troubleshooting
C.push(H1("Part 6 · Troubleshooting"));
C.push(tbl([
  headRow(["SITUATION", "WHAT TO DO"], [4000, W - 4000]),
  row(["A console will not accept a correct code", "Check the sector on the URL first — a device open on the wrong sector is the usual cause. If genuinely stuck, resolve the fault from the control panel and tell the table their fix was accepted. Never let a paper-versus-server mismatch stall a table; note it and diagnose after."], [4000, W - 4000]),
  row(["A table is drowning, not struggling", "Pause one of their faults from the control panel. Do not announce it. If it persists, grant resources quietly. Note both in the log."], [4000, W - 4000]),
  row(["A table finishes everything early", "Fire an off-script fault from the inject library. Boredom produces no data."], [4000, W - 4000]),
  row(["Nobody sends a liaison", "Say nothing for five minutes. It is a finding. If the whole room is stuck at ten minutes, announce that station consoles cannot transmit and only people can carry information."], [4000, W - 4000]),
  row(["The room goes quiet and stays quiet", "Fire a public callout on the ticker naming a sector with unresolved faults. Public visibility restarts conversation faster than any instruction."], [4000, W - 4000]),
  row(["A participant disengages entirely", "Floor Facilitator sits beside them, quietly. Give them a concrete job: the log, the chit count. Re-entry through a task, not through a conversation about participating."], [4000, W - 4000]),
  row(["Conflict turns personal", "Call a thirty-second operational pause. Redirect to the system, not the person: \"What does your procedure require?\" If it persists after the round, handle it in the debrief with the transcript in hand, privately."], [4000, W - 4000]),
  row(["The server crashes", "It snapshots every ten seconds. Restart and reload. If it will not come back, continue on paper: you hold the answer key, and integrity can be tracked on a flipchart. The simulation survives losing the software. It does not survive losing the binders."], [4000, W - 4000]),
  row(["A recorder failed mid-round", "Use the phone backup. If both failed, tell affected participants honestly at the debrief that their personal report will cover fewer rounds. Do not fabricate metrics."], [4000, W - 4000]),
  row(["A participant asks whether their boss sees this", "Answer immediately and plainly: no. Individual reports go to individuals. Do not hedge."], [4000, W - 4000]),
], [4000, W - 4000]));
C.push(brk());

// ---------------------------------------------------------------- 7. reset
C.push(H1("Part 7 · Reset Between Cohorts"));
C.push(p(t("Target: fifteen minutes, performed by someone who did not build the game. Work down this list in order.")));
const RW = [800, W - 800];
C.push(tbl([
  headRow(["#", "STEP"], RW),
  row(["1", "Collect all six binders. Remove used log sheets, insert fresh ones. Confirm each binder still holds its Appendix C page."], RW),
  row(["2", "Collect all fault cards from tables and floor. Re-sort by round tab. Count to 36. A missing card silently breaks a cascade in the next run."], RW),
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
