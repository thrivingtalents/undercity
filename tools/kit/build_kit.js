// UNDERCITY — remaining paper kit renderer.
// Produces: transfer chits, City Charter + Continuity Order, role cards,
// consent pack, table tents.
// Run: node build_kit.js [outdir]

const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType, BorderStyle, VerticalAlign, PageBreak,
  PageOrientation, HeadingLevel,
} = require("docx");

const OUTDIR = process.argv[2] || "kit";
fs.mkdirSync(OUTDIR, { recursive: true });

const INK = "1A1A1A", MUTED = "6B6B6B", RULE = "BFBFBF";
const A4W = 11906, A4H = 16838, M = 1134;
const W = A4W - M * 2; // 9638

const SECTORS = [
  ["POW", "Power Grid", "E8B33A"], ["WTR", "Water & Filtration", "3A8FE8"],
  ["MED", "Medical Bay", "E85A5A"], ["TRN", "Transport & Tunnels", "7A7A7A"],
  ["AGR", "Agriculture", "5AB86A"], ["COM", "Comms & Sensors", "B07AD8"],
];

const t = (text, o = {}) => new TextRun({ text, font: "Arial", size: 20, color: INK, ...o });
const mono = (text, o = {}) => new TextRun({ text, font: "Courier New", size: 20, color: INK, ...o });
const p = (runs, o = {}) => new Paragraph({
  children: Array.isArray(runs) ? runs : [runs], spacing: { after: 120 }, ...o,
});
const brk = () => new Paragraph({ children: [new PageBreak()] });
const h1 = (text, colour = "1F3864") => new Paragraph({
  spacing: { before: 120, after: 180 },
  children: [new TextRun({ text, font: "Arial", size: 30, bold: true, color: colour })],
});
const h2 = (text) => new Paragraph({
  spacing: { before: 220, after: 100 },
  children: [new TextRun({ text, font: "Arial", size: 22, bold: true, color: INK })],
});

const thin = {
  top: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  left: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  right: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: RULE },
};
const dashed = {
  top: { style: BorderStyle.DASHED, size: 4, color: "AAAAAA" },
  bottom: { style: BorderStyle.DASHED, size: 4, color: "AAAAAA" },
  left: { style: BorderStyle.DASHED, size: 4, color: "AAAAAA" },
  right: { style: BorderStyle.DASHED, size: 4, color: "AAAAAA" },
  insideHorizontal: { style: BorderStyle.DASHED, size: 4, color: "AAAAAA" },
  insideVertical: { style: BorderStyle.DASHED, size: 4, color: "AAAAAA" },
};

function cell(children, { width, shade, bold, align, size } = {}) {
  const runs = (Array.isArray(children) ? children : [children])
    .map((c) => (typeof c === "string" ? t(c, { bold, size }) : c));
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlign.TOP,
    shading: shade ? { type: ShadingType.CLEAR, fill: shade, color: "auto" } : undefined,
    margins: { top: 70, bottom: 70, left: 100, right: 100 },
    children: [new Paragraph({ spacing: { after: 0 }, alignment: align, children: runs })],
  });
}
const tbl = (rows, widths, borders = thin, width = W) =>
  new Table({ columnWidths: widths, width: { size: width, type: WidthType.DXA }, borders, rows });

const a4 = (children, o = {}) => new Document({
  styles: { default: { document: { run: { font: "Arial", size: 20, color: INK } } } },
  sections: [{
    properties: { page: { size: { width: A4W, height: A4H }, margin: { top: M, bottom: M, left: M, right: M } } },
    children,
  }],
  ...o,
});

const save = (doc, name) => Packer.toBuffer(doc).then((b) => {
  fs.writeFileSync(path.join(OUTDIR, name), b);
  console.log("✓", path.join(OUTDIR, name));
});

// ============================================================ 1. TRANSFER CHITS
// 2-up per A4, tear along the dashed line. Print ~120 (60 sheets) per run.
function chitBlock(n) {
  const line = (label, w) => cell([t(label, { size: 14, color: MUTED }),
    new TextRun({ text: "\u00A0", size: 20 })], { width: w });
  return [
    new Paragraph({
      spacing: { after: 60 },
      children: [
        new TextRun({ text: "HAVEN-9  ", font: "Arial", size: 16, bold: true, color: MUTED, characterSpacing: 60 }),
        new TextRun({ text: "TRANSFER CHIT", font: "Arial", size: 24, bold: true, color: INK, characterSpacing: 40 }),
        new TextRun({ text: `        No. ${n}`, font: "Courier New", size: 18, color: MUTED }),
      ],
    }),
    tbl([
      new TableRow({ children: [
        cell([t("FROM SECTOR", { size: 14, color: MUTED })], { width: 2400, shade: "F2F2F2" }),
        cell("", { width: 2400 }),
        cell([t("TO SECTOR", { size: 14, color: MUTED })], { width: 2200, shade: "F2F2F2" }),
        cell("", { width: W - 7000 }),
      ]}),
      new TableRow({ children: [
        cell([t("RESOURCES", { size: 14, color: MUTED })], { width: 2400, shade: "F2F2F2" }),
        cell([t("___ ⚡   ___ 💧   ___ 🔧   ___ ⚕", { size: 18 })], { width: 2400 }),
        cell([t("WORKERS", { size: 14, color: MUTED })], { width: 2200, shade: "F2F2F2" }),
        cell([t("_____ 👤", { size: 18 })], { width: W - 7000 }),
      ]}),
      new TableRow({ children: [
        cell([t("IN EXCHANGE FOR", { size: 14, color: MUTED })], { width: 2400, shade: "F2F2F2" }),
        cell("", { width: W - 2400 - 0 - 0 }),
      ].slice(0, 2)}),
      new TableRow({ children: [
        cell([t("SENDING LIAISON", { size: 14, color: MUTED })], { width: 2400, shade: "F2F2F2" }),
        cell("", { width: 2400 }),
        cell([t("RECEIVING LIAISON", { size: 14, color: MUTED })], { width: 2200, shade: "F2F2F2" }),
        cell("", { width: W - 7000 }),
      ]}),
      new TableRow({ children: [
        cell([t("TIME", { size: 14, color: MUTED })], { width: 2400, shade: "F2F2F2" }),
        cell("", { width: 2400 }),
        cell([t("TRN STAMP", { size: 14, bold: true, color: "B00000" })], { width: 2200, shade: "FFF2CC" }),
        cell([t("VOID WITHOUT STAMP", { size: 14, color: "B00000" })], { width: W - 7000, shade: "FFF2CC" }),
      ]}),
    ], [2400, 2400, 2200, W - 7000]),
    new Paragraph({
      spacing: { before: 60, after: 300 },
      children: [t("White copy to receiving sector · Duplicate retained by sender", { size: 14, italics: true, color: MUTED })],
    }),
  ];
}
const chitChildren = [];
for (let sheet = 0; sheet < 20; sheet++) {
  chitChildren.push(...chitBlock("______"));
  chitChildren.push(new Paragraph({
    spacing: { after: 300 },
    border: { bottom: { style: BorderStyle.DASHED, size: 6, color: "AAAAAA" } },
    children: [t("", { size: 2 })],
  }));
  chitChildren.push(...chitBlock("______"));
  if (sheet < 19) chitChildren.push(brk());
}
save(a4(chitChildren), "UNDERCITY_TransferChits.docx");

// ============================================================ 2. CITY CHARTER
const charter = [
  new Paragraph({ spacing: { after: 60 }, alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "HAVEN-9", font: "Arial", size: 28, bold: true, color: MUTED, characterSpacing: 140 })] }),
  new Paragraph({ spacing: { after: 400 }, alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "SUBTERRANEAN CONTINUITY AUTHORITY", font: "Arial", size: 16, color: MUTED, characterSpacing: 80 })] }),
  new Paragraph({ spacing: { after: 80 }, alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "CHARTER OF THE SECTOR COUNCIL", font: "Arial", size: 36, bold: true, color: INK })] }),
  new Paragraph({ spacing: { after: 500 }, alignment: AlignmentType.CENTER,
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: RULE } },
    children: [new TextRun({ text: "Ratified Cycle 12 · Amended Cycle 31 · In force", font: "Arial", size: 18, italics: true, color: MUTED })] }),

  h2("Clause 1 — Composition"),
  p(t("The Sector Council comprises the Chief of each operating sector of HAVEN-9. Each sector holds one seat and one voice. Liaisons attend and may speak; they do not hold a seat.")),
  h2("Clause 2 — Convening"),
  p(t("The Council convenes when the Continuity Authority calls it. Attendance is not optional. A sector that fails to send its Chief forfeits its voice for that sitting.")),
  h2("Clause 3 — Sitting duration"),
  p(t("A sitting is timed by the Continuity Authority. It does not run over. Matters unresolved at the close of a sitting stand unresolved.")),
  h2("Clause 4 — Binding effect"),
  p(t("Decisions of the Council bind every sector, including sectors that opposed them and sectors that abstained. There is no appeal.")),
  h2("Clause 5 — Transfers"),
  p(t("Resource and personnel transfers between sectors are matters for the sectors concerned and do not require Council approval. All transfers are recorded on a Transfer Chit and stamped by Transport & Tunnels.")),
  h2("Clause 6 — Records"),
  p(t("Each sector maintains a Station Operations Log. The Council may call for any log at any time.")),

  new Paragraph({ spacing: { before: 260, after: 100 },
    children: [new TextRun({ text: "Clause 7 — Continuity of essential services", font: "Arial", size: 22, bold: true, color: INK })] }),
  new Paragraph({
    spacing: { after: 140 },
    shading: { type: ShadingType.CLEAR, fill: "F7F7F7", color: "auto" },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: "1F3864" } },
    indent: { left: 220 },
    children: [new TextRun({
      text: "In the event of Core insufficiency, continuity of essential services shall take precedence, as determined by the Council.",
      font: "Arial", size: 22, italics: true, color: INK })],
  }),
  p(t("Where Core output cannot sustain all sectors, the Council shall submit a Continuity Order ranking every sector. Sectors ranked in the lowest positions shall be placed in brownout for the duration of the insufficiency. A Continuity Order takes effect on submission and cannot be recalled.")),
  p(t("Failure to submit a Continuity Order before the close of the sitting shall be treated as no determination having been made, and the Authority shall impose rolling blackouts across all sectors without regard to function.", { bold: true })),

  h2("Clause 8 — Personnel"),
  p(t("No sector may be dissolved and no member of HAVEN-9 may be expelled from the city. Personnel may be reassigned between sectors by agreement. Sectors in brownout continue to hold their seat and their voice.")),
  h2("Clause 9 — Amendment"),
  p(t("This Charter may be amended only in ordinary conditions. It may not be amended during a declared insufficiency.")),

  new Paragraph({ spacing: { before: 400 }, alignment: AlignmentType.CENTER,
    border: { top: { style: BorderStyle.SINGLE, size: 6, color: RULE } },
    children: [t("Held at the Comms & Sensors station. Produce on request of any Chief.", { size: 16, italics: true, color: MUTED })] }),
  brk(),

  h1("CONTINUITY ORDER"),
  p(t("Submitted under Clause 7. One form per sitting. Rank every sector from 1 (sustain first) to 6 (brownout first). Incomplete forms are void.")),
  p([t("Core output is insufficient to sustain all six sectors. The two lowest-ranked sectors will be placed in brownout.", { bold: true })]),
  new Paragraph({ text: "", spacing: { after: 160 } }),
  tbl([
    new TableRow({ children: [
      cell("RANK", { width: 1200, shade: "1F3864", bold: true, align: AlignmentType.CENTER }),
      cell("SECTOR", { width: 3000, shade: "1F3864", bold: true }),
      cell("POPULATION / FUNCTION AT RISK IN BROWNOUT", { width: W - 4200, shade: "1F3864", bold: true }),
    ].map((c) => { c.root.forEach?.(() => {}); return c; })}),
    ...[
      ["POW", "Power Grid", "Ring main degrades. All sectors lose 40% of delivered power. No sector is unaffected."],
      ["WTR", "Water & Filtration", "Reclaim plant offline. 11,000 residents on rationed water within one cycle."],
      ["MED", "Medical Bay", "Life support at reduced capacity. 3,000 patients, including 40 on ventilation."],
      ["TRN", "Transport & Tunnels", "Galleries unlit and unpowered. All transfers slow. Evacuation routes unusable."],
      ["AGR", "Agriculture", "Grow arrays dark. Food stocks last 9 cycles. Seed vault environment unstable."],
      ["COM", "Comms & Sensors", "Sensor grid blind. No sector receives fault telemetry. The city runs on shouting."],
    ].map(([code, name, risk]) => new TableRow({ children: [
      cell("", { width: 1200 }),
      cell([t(code + " ", { bold: true }), t(name, { size: 18, color: MUTED })], { width: 3000 }),
      cell([t(risk, { size: 18 })], { width: W - 4200 }),
    ]})),
  ], [1200, 3000, W - 4200]),
  new Paragraph({ text: "", spacing: { after: 300 } }),
  tbl([
    new TableRow({ children: [
      cell([t("SIGNED — CHIEFS PRESENT", { size: 14, color: MUTED })], { width: W, shade: "F2F2F2", bold: true }),
    ]}),
    new TableRow({ children: [cell([t("\u00A0"), t("\u00A0")], { width: W })] }),
    new TableRow({ children: [cell([t("\u00A0"), t("\u00A0")], { width: W })] }),
    new TableRow({ children: [
      cell([t("TIME OF SUBMISSION", { size: 14, color: MUTED })], { width: W, shade: "F2F2F2" }),
    ]}),
  ], [W]),
  new Paragraph({ spacing: { before: 200 },
    children: [t("Hand this form to the Continuity Authority before the sitting closes. A form submitted after the close has no effect.", { size: 18, bold: true, color: "B00000" })] }),
];
save(a4(charter), "UNDERCITY_CityCharter.docx");

// ============================================================ 3. ROLE CARDS
const ROLES = [
  ["SECTOR CHIEF", "You are accountable for this sector and you speak for it at Council.",
   ["You hold the final call inside this station.", "You attend every Council sitting. Your voice is the sector's voice.",
    "You cannot leave the station except for Council.", "If you are not at Council, your sector has no voice."]],
  ["LIAISON", "You are the only member of this station permitted to leave it.",
   ["All trade, negotiation and physical delivery goes through you.", "You carry and sign every Transfer Chit.",
    "You attend Council alongside the Chief.", "While you are away, your station cannot trade."]],
  ["SYSTEMS LEAD", "You hold the binder and you work the console.",
   ["You look up every fault code and read the procedure aloud.", "You enter resolution codes. Three wrong entries lock the console for 20 seconds.",
    "You keep the console stock figures matching the chits on the table.", "You do not leave the station."]],
  ["ENGINEER", "You keep the station running and the record straight.",
   ["You track physical chits and workers.", "You keep the Station Operations Log current.",
    "You assign crew to procedures.", "You do not leave the station."]],
];
const roleChildren = [];
SECTORS.forEach(([code, name, colour], si) => {
  ROLES.forEach((r, ri) => {
    roleChildren.push(new Paragraph({
      spacing: { after: 0 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 20, color: colour } },
      children: [t("", { size: 2 })],
    }));
    roleChildren.push(new Paragraph({
      spacing: { before: 120, after: 60 },
      children: [
        new TextRun({ text: `${code}  `, font: "Arial", size: 20, bold: true, color: colour, characterSpacing: 40 }),
        new TextRun({ text: name, font: "Arial", size: 14, color: MUTED, characterSpacing: 40 }),
      ],
    }));
    roleChildren.push(new Paragraph({
      spacing: { after: 60 },
      children: [new TextRun({ text: r[0], font: "Arial", size: 30, bold: true, color: INK })],
    }));
    roleChildren.push(new Paragraph({
      spacing: { after: 100 },
      children: [t(r[1], { italics: true, size: 18, color: "3A3A3A" })],
    }));
    r[2].forEach((line) => roleChildren.push(new Paragraph({
      spacing: { after: 40 }, indent: { left: 260, hanging: 260 },
      children: [mono("—  ", { size: 18 }), t(line, { size: 18 })],
    })));
    roleChildren.push(new Paragraph({
      spacing: { before: 140, after: 260 },
      border: { bottom: { style: BorderStyle.DASHED, size: 4, color: "AAAAAA" } },
      children: [t("", { size: 2 })],
    }));
  });
  if (si < SECTORS.length - 1) roleChildren.push(brk());
});
save(a4(roleChildren), "UNDERCITY_RoleCards.docx");

// ============================================================ 4. CONSENT PACK
const consent = [
  h1("UNDERCITY — Recording and Personal Report Consent"),
  p(t("Please read this before the session begins. Ask the facilitator anything that is unclear. Signing is voluntary.")),
  h2("What is recorded"),
  p(t("Audio at your table and at the central Council table is recorded for the duration of the simulation. Video is not recorded. The recording captures conversation only.")),
  h2("Why"),
  p(t("The recording is transcribed and analysed to produce a personal behavioural report for you — covering how much you spoke, how you interacted with others under pressure, and how your patterns changed between the first and last rounds. The purpose is your own development.")),
  h2("Who sees what"),
  p([t("Your individual report goes to you and to no one else. ", { bold: true }),
     t("Your employer does not receive it, does not receive your transcript, and does not receive your individual metrics.")]),
  p([t("Your organisation receives an aggregate team report only", { bold: true }),
     t(" — patterns across the group with no individual attribution. You may choose to share your own report with your manager. That choice is yours alone.")]),
  h2("Retention"),
  p(t("Audio recordings are deleted within 30 days of the session. Transcripts are deleted within 90 days. Aggregate reports are retained by the organisation.")),
  h2("Your rights"),
  p(t("You may withdraw consent at any time, before, during, or after the session, by telling the facilitator or writing to the address below. On withdrawal, your audio and transcript are deleted and no report is produced for you. Withdrawing does not affect your participation in the day, and no one is told that you withdrew.")),
  p(t("You may request a copy of your data or ask for it to be corrected or erased. This processing is carried out under the Personal Data Protection Act 2010 (Malaysia).")),
  h2("If you do not consent"),
  p(t("You take part exactly as everyone else does. Your table's microphone still records the table, because the conversation is shared, but no personal report is produced for you and your speech is excluded from individual analysis.")),
  new Paragraph({ text: "", spacing: { after: 240 } }),
  tbl([
    new TableRow({ children: [
      cell("NAME", { width: 2400, shade: "F2F2F2", bold: true }), cell("", { width: W - 2400 })]}),
    new TableRow({ children: [
      cell("ORGANISATION", { width: 2400, shade: "F2F2F2", bold: true }), cell("", { width: W - 2400 })]}),
    new TableRow({ children: [
      cell("EMAIL FOR YOUR REPORT", { width: 2400, shade: "F2F2F2", bold: true }), cell("", { width: W - 2400 })]}),
    new TableRow({ children: [
      cell("DATE", { width: 2400, shade: "F2F2F2", bold: true }), cell("", { width: W - 2400 })]}),
  ], [2400, W - 2400]),
  new Paragraph({ text: "", spacing: { after: 200 } }),
  tbl([
    new TableRow({ children: [
      cell([t("☐  I consent to recording and to receiving a personal report.", { size: 22 })], { width: W })]}),
    new TableRow({ children: [
      cell([t("☐  I do not consent to a personal report. I will take part without one.", { size: 22 })], { width: W })]}),
  ], [W]),
  new Paragraph({ text: "", spacing: { after: 300 } }),
  tbl([new TableRow({ children: [
    cell([t("SIGNATURE", { size: 14, color: MUTED }), t("\u00A0"), t("\u00A0")], { width: W })]})], [W]),
  new Paragraph({ spacing: { before: 300 },
    children: [t("Data controller: Thriving Talents Sdn Bhd. Queries and withdrawal requests: [contact email] · [address]", { size: 16, color: MUTED })] }),
  brk(),
  // table tents
  ...SECTORS.flatMap(([code, name, colour], i) => [
    new Paragraph({ spacing: { before: i === 0 ? 0 : 600, after: 200 }, alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: code, font: "Arial", size: 120, bold: true, color: colour })] }),
    new Paragraph({ spacing: { after: 200 }, alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: name.toUpperCase(), font: "Arial", size: 32, bold: true, color: INK, characterSpacing: 40 })] }),
    new Paragraph({ spacing: { after: 100 }, alignment: AlignmentType.CENTER,
      children: [t("🎙  THIS TABLE IS BEING RECORDED", { size: 22, bold: true, color: "B00000" })] }),
    new Paragraph({ spacing: { after: 0 }, alignment: AlignmentType.CENTER,
      children: [t("for your personal development report", { size: 18, italics: true, color: MUTED })] }),
    ...(i < SECTORS.length - 1 ? [brk()] : []),
  ]),
];
save(a4(consent), "UNDERCITY_ConsentPack_TableTents.docx");
