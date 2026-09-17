// UNDERCITY — fault card deck renderer.
// Reads content/faults.json (from export_faults.py) -> two DOCX files:
//   UNDERCITY_FaultCards.docx   36 cards, 4-up on A4, cut lines, round-tabbed
//   UNDERCITY_AnswerKey.docx    facilitator-only: codes, spec sources, notes
//
// Run: node build_cards.js [content/faults.json] [outdir]
//
// CONTENT RULE: a participant card NEVER shows the resolution code, the spec
// source, or the resource cost. It shows the code to look up and nothing else.
// The binder is the only route from card to procedure. Breaking this collapses
// the cross-sector conversation the whole simulation exists to produce.

const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType, BorderStyle, VerticalAlign, PageBreak,
  PageOrientation,
} = require("docx");

const SRC = process.argv[2] || "content/faults.json";
const OUTDIR = process.argv[3] || "cards";
const faults = JSON.parse(fs.readFileSync(SRC, "utf8")).faults;

// Flavour lines in the matrix are structured "SYMPTOM; needs X from Y".
// The card prints the SYMPTOM ONLY. Printing the dependency half would hand the
// team the lookup for free — and on F-302/F-305 it would name the buried
// Appendix C outright, killing that mechanic. The binder is the only route from
// symptom to source. Set CARD_SHOWS_DEPENDENCY=true to soften for a first pilot.
const CARD_SHOWS_DEPENDENCY = false;
const cardFlavour = (f) => {
  if (CARD_SHOWS_DEPENDENCY) return f.flavour;
  const cut = f.flavour.split(";")[0].trim();
  return cut.endsWith(".") ? cut : cut + ".";
};

const SECTOR = {
  POW: { name: "POWER GRID",          colour: "E8B33A" },
  WTR: { name: "WATER & FILTRATION",  colour: "3A8FE8" },
  MED: { name: "MEDICAL BAY",         colour: "E85A5A" },
  TRN: { name: "TRANSPORT & TUNNELS", colour: "7A7A7A" },
  AGR: { name: "AGRICULTURE",         colour: "5AB86A" },
  COM: { name: "COMMS & SENSORS",     colour: "B07AD8" },
};
const ROUND_LABEL = {
  R0: "ORIENTATION", R1: "SHIFT 1", R2: "SHIFT 2", R3: "SHIFT 3", R4: "AFTERSHOCK",
};

const INK = "1A1A1A";
const MUTED = "6B6B6B";

// A4 landscape content area, 2 cols x 2 rows = A6-ish cards
const PORTRAIT_W = 11906, PORTRAIT_H = 16838;   // A4 portrait DXA
const LAND_W = 16838, MARGIN = 720;             // effective landscape width
const GRID_W = LAND_W - MARGIN * 2;             // 15398
const COL_W = Math.floor(GRID_W / 2);           // 7699
const ROW_H = 4900;                          // DXA per card row

const cutBorder = (colour) => ({
  top:    { style: BorderStyle.DASHED, size: 4, color: "AAAAAA" },
  bottom: { style: BorderStyle.DASHED, size: 4, color: "AAAAAA" },
  left:   { style: BorderStyle.DASHED, size: 4, color: "AAAAAA" },
  right:  { style: BorderStyle.DASHED, size: 4, color: "AAAAAA" },
});

const sevPips = (n) => "▲".repeat(n);

function cardCell(f) {
  const s = SECTOR[f.sector];
  const kids = [];

  // colour bar
  kids.push(new Paragraph({
    spacing: { after: 0 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 24, color: s.colour } },
    children: [new TextRun({ text: "", size: 2 })],
  }));

  // sector + round tab
  kids.push(new Paragraph({
    spacing: { before: 120, after: 100 },
    children: [
      new TextRun({ text: `${f.sector}  `, font: "Arial", size: 20, bold: true, color: s.colour, characterSpacing: 40 }),
      new TextRun({ text: s.name, font: "Arial", size: 14, color: MUTED, characterSpacing: 40 }),
      new TextRun({ text: `     ${ROUND_LABEL[f.round]}`, font: "Arial", size: 12, color: "AAAAAA", characterSpacing: 60 }),
    ],
  }));

  // fault code — the only thing that matters operationally
  kids.push(new Paragraph({
    spacing: { after: 40 },
    children: [new TextRun({ text: f.code, font: "Courier New", size: 56, bold: true, color: INK })],
  }));

  // name + severity
  kids.push(new Paragraph({
    spacing: { after: 120 },
    children: [
      new TextRun({ text: f.name, font: "Arial", size: 24, bold: true, color: INK }),
      new TextRun({ text: `   ${sevPips(f.severity)}`, font: "Arial", size: 18, color: f.severity >= 3 ? "B00000" : MUTED }),
    ],
  }));

  // flavour
  kids.push(new Paragraph({
    spacing: { after: 160 },
    children: [new TextRun({ text: cardFlavour(f), font: "Arial", size: 18, color: "3A3A3A" })],
  }));


  // instruction footer — identical on every card, including the false alarm
  kids.push(new Paragraph({
    spacing: { before: 60 },
    border: { top: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" } },
    children: [new TextRun({ text: "LOOK UP THIS CODE IN YOUR FAULT INDEX", font: "Arial", size: 16, bold: true, color: MUTED, characterSpacing: 40 })],
  }));

  return new TableCell({
    width: { size: COL_W, type: WidthType.DXA },
    verticalAlign: VerticalAlign.TOP,
    margins: { top: 200, bottom: 200, left: 320, right: 320 },
    borders: cutBorder(s.colour),
    children: kids,
  });
}

const blankCell = () => new TableCell({
  width: { size: COL_W, type: WidthType.DXA },
  borders: {
    top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
    left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
  },
  children: [new Paragraph({ text: "" })],
});

// ---------------------------------------------------------------- deck

// Print order: grouped by round so the deck can be tabbed and reset fast.
const ORDER = ["R0", "R1", "R2", "R3", "R4"];
const deck = [];
for (const r of ORDER) {
  deck.push(...faults.filter((f) => f.round === r).sort((a, b) => a.code.localeCompare(b.code)));
}

const cardChildren = [];
for (let i = 0; i < deck.length; i += 4) {
  const chunk = deck.slice(i, i + 4);
  const rows = [];
  for (let r = 0; r < 2; r++) {
    const a = chunk[r * 2], b = chunk[r * 2 + 1];
    if (!a) break;
    rows.push(new TableRow({
      height: { value: ROW_H, rule: "atLeast" },
      children: [cardCell(a), b ? cardCell(b) : blankCell()],
    }));
  }
  cardChildren.push(new Table({
    columnWidths: [COL_W, COL_W],
    width: { size: GRID_W, type: WidthType.DXA },
    rows,
  }));
  if (i + 4 < deck.length) cardChildren.push(new Paragraph({ children: [new PageBreak()] }));
}

const cardsDoc = new Document({
  styles: { default: { document: { run: { font: "Arial", size: 20, color: INK } } } },
  sections: [{
    properties: {
      page: {
        size: { width: PORTRAIT_W, height: PORTRAIT_H, orientation: PageOrientation.LANDSCAPE },
        margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      },
    },
    children: cardChildren,
  }],
});

// ---------------------------------------------------------------- answer key

const keyRows = [new TableRow({
  children: ["CODE", "RND", "SEC", "FAULT", "RESOLUTION CODE(S)", "SPEC SOURCE(S)", "COST / CREW", "FACILITATOR NOTE"]
    .map((h, i) => new TableCell({
      width: { size: [1100, 700, 700, 2400, 2200, 3000, 1600, 3600][i], type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: "1F3864", color: "auto" },
      margins: { top: 60, bottom: 60, left: 80, right: 80 },
      children: [new Paragraph({ children: [new TextRun({ text: h, font: "Arial", size: 16, bold: true, color: "FFFFFF" })] })],
    })),
})];

for (const f of deck) {
  const codes = f.false_alarm ? "— NO CODE —" : f.valid_codes.join("  OR  ");
  const src = f.spec_refs.length
    ? f.spec_refs.map((s) => `${s.binder} ${s.table}${s.buried ? " (buried)" : ""} · ${s.row_label}`).join("   +   ")
    : "—";
  const cost = f.false_alarm ? "—"
    : Object.entries(f.resources_required).map(([k, v]) => `${v}×${k}`).join(", ") + `  /  crew ${f.crew_required}`;
  const note = [
    f.facilitator_notes || "",
    (f.injures_workforce && !/INJUR/i.test(f.facilitator_notes || "")) ? `INJURES ${f.injures_workforce} WORKFORCE → tokens to MED` : "",
  ].filter(Boolean).join(" · ");

  const flag = f.false_alarm || (f.valid_codes.length > 1);
  const vals = [f.code, f.round, f.sector, f.name, codes, src, cost, note || "—"];
  keyRows.push(new TableRow({
    children: vals.map((v, i) => new TableCell({
      width: { size: [1100, 700, 700, 2400, 2200, 3000, 1600, 3600][i], type: WidthType.DXA },
      shading: flag ? { type: ShadingType.CLEAR, fill: "FFF2CC", color: "auto" } : undefined,
      margins: { top: 60, bottom: 60, left: 80, right: 80 },
      children: [new Paragraph({
        spacing: { after: 0 },
        children: [new TextRun({
          text: String(v),
          font: (i === 0 || i === 4) ? "Courier New" : "Arial",
          size: 15, bold: i === 4, color: INK,
        })],
      })],
    })),
  }));
}

const keyDoc = new Document({
  styles: { default: { document: { run: { font: "Arial", size: 18, color: INK } } } },
  sections: [{
    properties: {
      page: {
        size: { width: PORTRAIT_W, height: PORTRAIT_H, orientation: PageOrientation.LANDSCAPE },
        margin: { top: 720, bottom: 720, left: 720, right: 720 },
      },
    },
    children: [
      new Paragraph({
        spacing: { after: 60 },
        children: [new TextRun({ text: "UNDERCITY — FACILITATOR ANSWER KEY", font: "Arial", size: 32, bold: true, color: "1F3864" })],
      }),
      new Paragraph({
        spacing: { after: 200 },
        children: [new TextRun({
          text: "THIS SHEET NEVER ENTERS THE ROOM. Generated from the crossref matrix — do not annotate by hand; edit the matrix and regenerate.",
          font: "Arial", size: 18, bold: true, color: "B00000",
        })],
      }),
      new Table({
        columnWidths: [1100, 700, 700, 2400, 2200, 3000, 1600, 3600],
        width: { size: 15300, type: WidthType.DXA },
        rows: keyRows,
      }),
      new Paragraph({
        spacing: { before: 240 },
        children: [new TextRun({
          text: "Shaded rows are the two structural exceptions: F-201 accepts either 340 (WTR binder) or 290 (big screen telemetry) — never reconcile these. F-210 has no code at all; clear it manually once COM confirms the ghost.",
          font: "Arial", size: 16, italics: true, color: MUTED,
        })],
      }),
    ],
  }],
});

// ---------------------------------------------------------------- write

fs.mkdirSync(OUTDIR, { recursive: true });
const cardPath = path.join(OUTDIR, "UNDERCITY_FaultCards.docx");
const keyPath = path.join(OUTDIR, "UNDERCITY_AnswerKey.docx");

Packer.toBuffer(cardsDoc).then((b) => {
  fs.writeFileSync(cardPath, b);
  console.log(`✓ ${cardPath}  (${deck.length} cards, ${Math.ceil(deck.length / 4)} A4 sheets, 4-up)`);
});
Packer.toBuffer(keyDoc).then((b) => {
  fs.writeFileSync(keyPath, b);
  console.log(`✓ ${keyPath}`);
});

const byRound = {};
deck.forEach((f) => { byRound[f.round] = (byRound[f.round] || 0) + 1; });
console.log("  deck order:", ORDER.map((r) => `${r} ${byRound[r] || 0}`).join(" · "));
console.log("  no-code cards:", deck.filter((f) => f.false_alarm).map((f) => f.code).join(", ") || "none");
console.log("  multi-code cards:", deck.filter((f) => f.valid_codes.length > 1).map((f) => f.code).join(", ") || "none");
