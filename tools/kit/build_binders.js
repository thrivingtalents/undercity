// UNDERCITY — binder renderer.
// Reads binder_content.json (from assemble_binders.py) -> six A4 DOCX binders.
// Run: node build_binders.js [binder_content.json] [outdir]

const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType, BorderStyle, HeadingLevel,
  PageBreak, Header, Footer, PageNumber, VerticalAlign,
} = require("docx");

const SRC = process.argv[2] || "binder_content.json";
const OUTDIR = process.argv[3] || "binders";
const data = JSON.parse(fs.readFileSync(SRC, "utf8"));

const W = 9026;                     // A4 content width in DXA (11906 - 2*1440)
const INK = "1A1A1A";
const MUTED = "6B6B6B";
const RULE = "BFBFBF";

const noBorders = {
  top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
  left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
  insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
};
const thinBorders = {
  top: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  left: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  right: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: RULE },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: RULE },
};

const mono = (text, opts = {}) =>
  new TextRun({ text, font: "Courier New", size: 20, color: INK, ...opts });
const body = (text, opts = {}) =>
  new TextRun({ text, font: "Arial", size: 20, color: INK, ...opts });

const p = (runs, opts = {}) =>
  new Paragraph({ children: Array.isArray(runs) ? runs : [runs], spacing: { after: 120 }, ...opts });

const rule = () => new Paragraph({
  text: "", spacing: { after: 160 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE } },
});

const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

function sectionTitle(text, colour) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 120, after: 160 },
    children: [new TextRun({ text, font: "Arial", size: 28, bold: true, color: colour })],
  });
}

function cell(children, { width, shade, bold, align, mono: isMono } = {}) {
  const runs = (Array.isArray(children) ? children : [children]).map((t) =>
    typeof t === "string"
      ? (isMono ? mono(t, { bold }) : body(t, { bold }))
      : t);
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlign.TOP,
    shading: shade ? { type: ShadingType.CLEAR, fill: shade, color: "auto" } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({
      spacing: { after: 0 },
      alignment: align || AlignmentType.LEFT,
      children: runs,
    })],
  });
}

function table(rows, widths, borders = thinBorders) {
  return new Table({ columnWidths: widths, width: { size: W, type: WidthType.DXA }, borders, rows });
}

// ---------------------------------------------------------------- pages

function coverPage(b) {
  return [
    new Paragraph({ text: "", spacing: { after: 1400 } }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 60 },
      children: [new TextRun({ text: "HAVEN-9", font: "Arial", size: 24, bold: true, characterSpacing: 120, color: MUTED })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 320 },
      children: [new TextRun({ text: "SUBTERRANEAN CONTINUITY AUTHORITY", font: "Arial", size: 16, color: MUTED, characterSpacing: 60 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 40 },
      children: [new TextRun({ text: b.code, font: "Arial", size: 96, bold: true, color: b.colour })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 200 },
      children: [new TextRun({ text: b.name.toUpperCase(), font: "Arial", size: 32, bold: true, color: INK, characterSpacing: 40 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 900 },
      children: [new TextRun({ text: b.motto, font: "Arial", size: 20, italics: true, color: MUTED })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 80 },
      children: [new TextRun({ text: "TECHNICAL OPERATIONS BINDER", font: "Arial", size: 22, bold: true, color: INK, characterSpacing: 40 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 1000 },
      children: [new TextRun({ text: "Revision 9.4 · Retain at sector station at all times", font: "Arial", size: 16, color: MUTED })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      border: { top: { style: BorderStyle.SINGLE, size: 6, color: b.colour } },
      spacing: { before: 200, after: 60 },
      children: [new TextRun({ text: `RESTRICTED — ${b.code} PERSONNEL`, font: "Arial", size: 20, bold: true, color: b.colour, characterSpacing: 60 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "This binder does not leave the sector station. Information in it may be shared verbally at your discretion.", font: "Arial", size: 16, italics: true, color: MUTED })],
    }),
    pageBreak(),
  ];
}

function overviewPage(b) {
  return [
    sectionTitle("1 · Sector Overview", b.colour),
    p(body(b.mission)),
    rule(),
    table([
      new TableRow({ children: [
        cell("PRODUCES", { width: 2400, shade: "F2F2F2", bold: true }),
        cell(b.produces, { width: W - 2400 }),
      ]}),
      new TableRow({ children: [
        cell("UPKEEP DUE", { width: 2400, shade: "F2F2F2", bold: true }),
        cell(b.upkeep, { width: W - 2400 }),
      ]}),
      new TableRow({ children: [
        cell("OPENING STOCK", { width: 2400, shade: "F2F2F2", bold: true }),
        cell(b.start_inventory, { width: W - 2400 }),
      ]}),
      new TableRow({ children: [
        cell("WORKFORCE", { width: 2400, shade: "F2F2F2", bold: true }),
        cell("8 workers. Injured workers report to MED and cannot be assigned until released.", { width: W - 2400 }),
      ]}),
    ], [2400, W - 2400]),
    new Paragraph({ text: "", spacing: { after: 200 } }),
    sectionTitle("Station roles", b.colour),
    p(body("Assign these before the shift begins. Write the names on this page.")),
    table([
      new TableRow({ children: [
        cell("SECTOR CHIEF", { width: 2600, shade: "F2F2F2", bold: true }),
        cell("Accountable voice of the sector. Speaks for it at Council.", { width: 3600 }),
        cell("", { width: W - 6200 }),
      ]}),
      new TableRow({ children: [
        cell("LIAISON", { width: 2600, shade: "F2F2F2", bold: true }),
        cell("The ONLY member permitted to leave the station. All physical trade and negotiation goes through this person.", { width: 3600 }),
        cell("", { width: W - 6200 }),
      ]}),
      new TableRow({ children: [
        cell("SYSTEMS LEAD", { width: 2600, shade: "F2F2F2", bold: true }),
        cell("Holds this binder. Reads procedures aloud. Enters resolution codes.", { width: 3600 }),
        cell("", { width: W - 6200 }),
      ]}),
      new TableRow({ children: [
        cell("ENGINEERS", { width: 2600, shade: "F2F2F2", bold: true }),
        cell("Everyone else. Track stock, keep the log, assign crew.", { width: 3600 }),
        cell("", { width: W - 6200 }),
      ]}),
    ], [2600, 3600, W - 6200]),
    pageBreak(),
  ];
}

function schematicPage(b) {
  const inRows = [
    ["INPUTS", "What this sector consumes to stay alive", "F2F2F2"],
    ["Upkeep", b.upkeep, null],
    ["Repair materials", "Spare Parts, and resources named in each procedure", null],
    ["Crew", "Workers assigned per procedure; injured crew unavailable", null],
    ["OUTPUTS", "What the rest of HAVEN-9 draws from this sector", "F2F2F2"],
    ["Production", b.produces, null],
    ["Specifications", "Values in Section 5 that other sectors require to close their faults", null],
    ["CONSTRAINTS", "", "F2F2F2"],
    ["Transfers", "No resource or worker moves without a signed Transfer Chit stamped by TRN", null],
    ["Integrity", "Unresolved faults decay sector Integrity. Below 30 the sector is CRITICAL and visible city-wide. At 0 it goes DARK.", null],
  ];
  return [
    sectionTitle("2 · System Dependency Map", b.colour),
    p(body("This sector does not operate alone. Read this page before the shift starts, not during it.")),
    table(inRows.map(([k, v, shade]) => new TableRow({ children: [
      cell(k, { width: 2400, shade: shade || undefined, bold: !!shade }),
      cell(v, { width: W - 2400, shade: shade || undefined, bold: !!shade }),
    ]})), [2400, W - 2400]),
    new Paragraph({ text: "", spacing: { after: 200 } }),
    p([body("Note. ", { bold: true }), body("Illustrated plant schematic to be inserted at Revision 9.5. Until then this dependency map is the controlling reference.")], { spacing: { after: 0 } }),
    pageBreak(),
  ];
}

function indexPages(b) {
  const rows = [new TableRow({ children: [
    cell("FAULT CODE", { width: 1800, shade: "F2F2F2", bold: true }),
    cell("DESCRIPTION", { width: 4200, shade: "F2F2F2", bold: true }),
    cell("ACTION", { width: W - 6000, shade: "F2F2F2", bold: true }),
  ]})];
  for (const r of b.index_rows) {
    const actionRuns = r.own
      ? (r.no_procedure
          ? [body(r.action, { bold: true })]
          : [mono(r.action)])
      : [body(r.action, { bold: true, color: "8A5A00" })];
    rows.push(new TableRow({ children: [
      cell(r.code, { width: 1800, mono: true, bold: r.own }),
      cell(r.own ? r.name : r.name, { width: 4200 }),
      new TableCell({
        width: { size: W - 6000, type: WidthType.DXA },
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        shading: r.own ? undefined : { type: ShadingType.CLEAR, fill: "FFF6E5", color: "auto" },
        children: [new Paragraph({ spacing: { after: 0 }, children: actionRuns })],
      }),
    ]}));
  }
  return [
    sectionTitle("3 · Fault Code Index", b.colour),
    p(body("When an alert card reaches this station, find its code here first. Codes not listed on this page are not this sector's systems — do not attempt a repair, and do not sit on the card.")),
    table(rows, [1800, 4200, W - 6000]),
    new Paragraph({ text: "", spacing: { after: 160 } }),
    p([body("Shaded entries", { bold: true }), body(" belong to another sector. Getting that card to the right station is this sector's responsibility.")]),
    pageBreak(),
  ];
}

function procedurePages(b) {
  const out = [sectionTitle("4 · Repair Procedures", b.colour),
    p(body("Procedures are written to be read aloud. The console will not accept a partial code.")),
  ];
  b.procedures.forEach((proc, i) => {
    out.push(new Paragraph({
      spacing: { before: 240, after: 100 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: b.colour } },
      children: [
        new TextRun({ text: `PROCEDURE ${proc.id}`, font: "Courier New", size: 24, bold: true, color: b.colour }),
        new TextRun({ text: `   ${proc.title}`, font: "Arial", size: 24, bold: true, color: INK }),
      ],
    }));
    out.push(table([
      new TableRow({ children: [
        cell("APPLIES TO", { width: 1900, shade: "F2F2F2", bold: true }),
        cell(proc.fault_code, { width: 1700, mono: true }),
        cell("CREW", { width: 1200, shade: "F2F2F2", bold: true }),
        cell(String(proc.crew), { width: 900 }),
        cell("MATERIALS", { width: 1700, shade: "F2F2F2", bold: true }),
        cell(proc.resources, { width: W - 7400 }),
      ]}),
    ], [1900, 1700, 1200, 900, 1700, W - 7400]));
    proc.steps.forEach((s, n) => {
      out.push(new Paragraph({
        spacing: { after: 60 }, indent: { left: 340, hanging: 340 },
        children: [mono(`${n + 1}.  `), body(s)],
      }));
    });
    out.push(new Paragraph({
      spacing: { before: 100, after: 120 },
      shading: { type: ShadingType.CLEAR, fill: "F2F2F2", color: "auto" },
      children: [body("CODE FORMAT:  ", { bold: true }), mono(proc.format, { bold: true })],
    }));
    if (i === 3) out.push(pageBreak());
  });
  out.push(pageBreak());
  return out;
}

function tablePages(b) {
  const out = [sectionTitle("5 · Specification Tables", b.colour),
    p(body("These values are held by this sector. Other stations will ask for them during the shift. Whether you give them, and how quickly, is your call.")),
  ];
  for (const t of b.tables) {
    out.push(new Paragraph({
      spacing: { before: 220, after: 100 },
      children: [
        new TextRun({ text: `TABLE ${t.id}`, font: "Courier New", size: 22, bold: true, color: b.colour }),
        new TextRun({ text: `   ${t.name}`, font: "Arial", size: 22, bold: true, color: INK }),
      ],
    }));
    const rows = [new TableRow({ children: [
      cell("ASSEMBLY", { width: 5000, shade: "F2F2F2", bold: true }),
      cell("RATED VALUE", { width: W - 5000, shade: "F2F2F2", bold: true, align: AlignmentType.CENTER }),
    ]})];
    for (const r of t.rows) {
      rows.push(new TableRow({ children: [
        cell(r.label, { width: 5000 }),
        cell(String(r.value), { width: W - 5000, mono: true, bold: true, align: AlignmentType.CENTER }),
      ]}));
    }
    out.push(table(rows, [5000, W - 5000]));
  }
  out.push(new Paragraph({ text: "", spacing: { after: 200 } }));
  out.push(p([body("Values are as-built and take precedence over station instrumentation.", { italics: true, color: MUTED })]));
  out.push(pageBreak());
  return out;
}

function appendixPage(b) {
  return [
    sectionTitle("Appendix C · Non-Routine Authorisations", b.colour),
    p(body("Retained for audit. Not part of the standard fault index. Applies only where a procedure directs the operator to this appendix or where no indexed procedure exists.")),
    new Paragraph({ text: "", spacing: { after: 200 } }),
    p(body("C.1  Scope")),
    p(body("The authorisation below was issued under emergency powers and has not been revoked. It remains valid for the current operating period.", { color: MUTED })),
    new Paragraph({ text: "", spacing: { after: 200 } }),
    table([
      new TableRow({ children: [
        cell("AUTHORISATION", { width: 5000, shade: "F2F2F2", bold: true }),
        cell("VALUE", { width: W - 5000, shade: "F2F2F2", bold: true, align: AlignmentType.CENTER }),
      ]}),
      new TableRow({ children: [
        cell(b.appendix.row_label, { width: 5000 }),
        cell(String(b.appendix.value), { width: W - 5000, mono: true, bold: true, align: AlignmentType.CENTER }),
      ]}),
    ], [5000, W - 5000]),
    new Paragraph({ text: "", spacing: { after: 240 } }),
    p(body("C.2  Records retention")),
    p(body("Superseded revisions of this appendix were destroyed in the Cycle 31 records purge. No further entries follow.", { color: MUTED })),
    pageBreak(),
  ];
}

function logPage(b) {
  const rows = [new TableRow({ children: [
    cell("TIME", { width: 1200, shade: "F2F2F2", bold: true }),
    cell("EVENT / FAULT", { width: 2600, shade: "F2F2F2", bold: true }),
    cell("DECISION TAKEN", { width: 3200, shade: "F2F2F2", bold: true }),
    cell("WHO AGREED", { width: W - 7000, shade: "F2F2F2", bold: true }),
  ]})];
  for (let i = 0; i < 16; i++) {
    rows.push(new TableRow({ children: [
      cell("", { width: 1200 }), cell("", { width: 2600 }),
      cell("", { width: 3200 }), cell("", { width: W - 7000 }),
    ]}));
  }
  return [
    sectionTitle("6 · Station Operations Log", b.colour),
    p(body("Keep this current. It is the sector's record of what was decided and who agreed to it.")),
    table(rows, [1200, 2600, 3200, W - 7000]),
    pageBreak(),
  ];
}

function quickRefPage(b) {
  const items = [
    ["Transfers", "Nothing moves without a Transfer Chit signed by BOTH liaisons and stamped by TRN. Unstamped chits are void."],
    ["Liaison rule", "Only the Liaison leaves the station. If the Liaison is away, the station cannot trade."],
    ["Council", "When COUNCIL is called, the Chief and Liaison attend the centre table. Five minutes, hard stop."],
    ["Console rejects", "Three consecutive wrong codes lock the console for 20 seconds. Verify the source table before resubmitting."],
    ["Crew", "A procedure cannot be entered without its minimum crew assigned. Injured crew are at MED until released."],
    ["Stock", "Physical chits are the true count. Keep the console figure matching what is on the table."],
    ["Escalation", "A fault code that is not in your index is not yours. Move it."],
    ["Integrity", "Below 30 the station shows CRITICAL city-wide. At 0 it goes DARK and the console locks."],
  ];
  return [
    sectionTitle("7 · Standing Orders — Quick Reference", b.colour),
    table(items.map(([k, v]) => new TableRow({ children: [
      cell(k, { width: 2200, shade: "F2F2F2", bold: true }),
      cell(v, { width: W - 2200 }),
    ]})), [2200, W - 2200]),
    new Paragraph({ text: "", spacing: { after: 300 } }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      border: { top: { style: BorderStyle.SINGLE, size: 6, color: b.colour } },
      spacing: { before: 200 },
      children: [new TextRun({ text: "HAVEN-9 SUBTERRANEAN CONTINUITY AUTHORITY", font: "Arial", size: 16, color: MUTED, characterSpacing: 60 })],
    }),
  ];
}

// ---------------------------------------------------------------- assemble

fs.mkdirSync(OUTDIR, { recursive: true });

for (const code of Object.keys(data.binders)) {
  const b = data.binders[code];
  const doc = new Document({
    styles: { default: { document: { run: { font: "Arial", size: 20, color: INK } } } },
    sections: [{
      properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      headers: { default: new Header({ children: [new Paragraph({
        alignment: AlignmentType.RIGHT,
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE } },
        children: [new TextRun({ text: `HAVEN-9 · ${b.code} TECHNICAL OPERATIONS BINDER · RESTRICTED`, font: "Arial", size: 14, color: MUTED })],
      })]}) },
      footers: { default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ children: ["Page ", PageNumber.CURRENT], font: "Arial", size: 14, color: MUTED })],
      })]}) },
      children: [
        ...coverPage(b), ...overviewPage(b), ...schematicPage(b), ...indexPages(b),
        ...procedurePages(b), ...tablePages(b), ...appendixPage(b), ...logPage(b),
        ...quickRefPage(b),
      ],
    }],
  });
  const file = path.join(OUTDIR, `UNDERCITY_Binder_${b.code}.docx`);
  Packer.toBuffer(doc).then((buf) => {
    fs.writeFileSync(file, buf);
    console.log("✓", file);
  });
}
