// UNDERCITY — fault card deck renderer.
// Reads content/faults.json (from export_faults.py) -> two DOCX files:
//   UNDERCITY_FaultCards.docx   60 cards, 15-up on four landscape A4 sheets, cut lines
//   UNDERCITY_AnswerKey.docx    facilitator-only: codes, spec sources, notes
//
// Run: node build_cards.js [content/faults.json] [outdir]
//
// CONTENT RULE: a participant card NEVER shows the resolution code, the spec
// source, or the resource cost. It shows the code to look up and nothing else.
// The binder is the only route from card to procedure. Breaking this collapses
// the cross-sector conversation the whole simulation exists to produce.
//
// FOUR SHEETS (2026-10-06). The deck is exactly four landscape A4 pages, three
// columns by five rows, fifteen cards a page, in numerical order: 8 mm page
// margins, 4 mm between columns, 3 mm between rows, every row an exact height
// so no card ever crosses a page. A card is a plain white rectangle with a thin
// light-grey cut border: the sector code and round on one small line under a
// hairline in the sector colour, the fault code as the clearest thing on it,
// the name with its severity triangles, a red TIME-CRITICAL word where the
// fault carries one, the symptom, and the lookup reminder as a small footer.

const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType, BorderStyle, VerticalAlign,
  PageOrientation,
} = require("docx");

const P = require("./palette").from(process.argv);   // colour, or --mono for the B&W Kit
const SRC = process.argv[2] || "content/faults.json";
// F-501..F-512 are generated separately (see lib/content.js) and carry round:
// null on purpose. They print, they just print in their own section.
const CHAIN_SRC = process.argv[4] || "content/faults.reference-chain.json";
const OUTDIR = process.argv[3] || "cards";
const faults = JSON.parse(fs.readFileSync(SRC, "utf8")).faults;
const chainFaults = fs.existsSync(CHAIN_SRC)
  ? JSON.parse(fs.readFileSync(CHAIN_SRC, "utf8")).faults
  : [];
// F-601..F-612 (LATE SHIFT, 2026-10-05): generated too, round: null, their own
// section after REFERENCE CHAIN. A P-10 card says TIME-CRITICAL and nothing
// more — no countdown is printed because none runs.
const LATE_SRC = process.argv[5] || "content/faults.late-shift.json";
const lateFaults = fs.existsSync(LATE_SRC)
  ? JSON.parse(fs.readFileSync(LATE_SRC, "utf8")).faults
  : [];

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
// A round is its number, on the card as everywhere (2026-10-05): the tab is
// the library's grouping, never a title the table can read a plan from.
const ROUND_LABEL = {
  R0: "ROUND 0", R1: "ROUND 1", R2: "ROUND 2", R3: "ROUND 3", R4: "ROUND 4", R5: "ROUND 5", R6: "ROUND 6", R7: "ROUND 7",
  // Unscheduled by design: the facilitator fires these by hand.
  null: "REFERENCE CHAIN",
};
// The tab line: a generated deck names its own section; everything else is its round.
const tabLabel = (f) => f.section || ROUND_LABEL[f.round] || ROUND_LABEL[null];

const { INK, MUTED } = P;

// ---------------------------------------------------------------- the sheet
// A4 landscape, in DXA (1 mm = 56.69). The grid fills the page inside 8 mm
// margins: three 91 mm columns with 4 mm between them, five rows with 3 mm
// between them. Every row is an exact height. Word draws an exact row about
// 1.2 mm taller than its figure (measured on the exported PDF), so the card
// is declared at 34.6 mm to print at 35.8: five of them and four gutters come
// to 191 mm of the 194 available, and the sheet's own paragraph marks never
// push a fifth page.
const PORTRAIT_W = 11906, PORTRAIT_H = 16838;   // A4 portrait DXA; the section turns it landscape
const MM = 56.69;
const MARGIN = Math.round(8 * MM);              // 454
const CARD_W = Math.round(91 * MM);             // 5159
const CARD_H = Math.round(34.6 * MM);           // 1961
const GUTTER_X = Math.round(4 * MM);            // 227
const GUTTER_Y = Math.round(3 * MM);            // 170
const COLS = 3, ROWS = 5, PER_PAGE = COLS * ROWS;
const GRID_W = COLS * CARD_W + (COLS - 1) * GUTTER_X;   // 15931 — the usable width is 15930, the last column takes the difference
const COL_WIDTHS = [CARD_W, GUTTER_X, CARD_W, GUTTER_X, CARD_W - (GRID_W - (PORTRAIT_H - 2 * MARGIN))];

/** The cut border: thin, light grey, a guide for the scissors and nothing more. */
const cutBorder = () => {
  const line = { style: BorderStyle.SINGLE, size: 4, color: P.mono ? P.DASH : "CCCCCC" };
  return { top: line, bottom: line, left: line, right: line };
};
const noBorder = () => {
  const none = { style: BorderStyle.NONE };
  return { top: none, bottom: none, left: none, right: none };
};

const sevPips = (n) => "▲".repeat(n);

/** One card. Header line, code, name + severity, TIME-CRITICAL where it applies, symptom, footer. */
function cardCell(f, width) {
  const s = SECTOR[f.sector];
  const kids = [];

  // sector · name · round, on one small line, over a hairline in the sector colour
  kids.push(new Paragraph({
    spacing: { after: 50, line: 220, lineRule: "auto" },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: P.sector(s.colour), space: 2 } },
    children: [
      new TextRun({ text: f.sector, font: "Arial", size: 15, bold: true, color: P.sector(s.colour) }),
      new TextRun({ text: ` · ${s.name} · ${tabLabel(f)}`, font: "Arial", size: 15, color: P.mono ? INK : MUTED }),
    ],
  }));

  // fault code — the clearest thing on the card
  kids.push(new Paragraph({
    spacing: { before: 40, after: 10, line: 240, lineRule: "auto" },
    children: [new TextRun({ text: f.code, font: "Arial", size: 22, bold: true, color: INK })],
  }));

  // name + severity
  kids.push(new Paragraph({
    spacing: { after: 20, line: 230, lineRule: "auto" },
    children: [
      new TextRun({ text: f.name, font: "Arial", size: 18, bold: true, color: INK }),
      new TextRun({ text: `  ${sevPips(f.severity)}`, font: "Arial", size: 15, color: f.severity >= 3 ? P.WARN : MUTED }),
    ],
  }));

  // TIME-CRITICAL (late shift): the word, never a number — nothing counts down.
  if (f.time_critical) {
    kids.push(new Paragraph({
      spacing: { after: 20, line: 220, lineRule: "auto" },
      children: [new TextRun({ text: "TIME-CRITICAL", font: "Arial", size: 14, bold: true, color: P.WARN })],
    }));
  }

  // symptom
  kids.push(new Paragraph({
    spacing: { after: 40, line: 230, lineRule: "auto" },
    children: [new TextRun({ text: cardFlavour(f), font: "Arial", size: 16, color: P.LORE })],
  }));

  // instruction footer — identical on every card
  kids.push(new Paragraph({
    spacing: { after: 0, line: 220, lineRule: "auto" },
    children: [new TextRun({ text: "LOOK UP THIS CODE IN YOUR FAULT INDEX", font: "Arial", size: 14, color: MUTED })],
  }));

  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlign.TOP,
    margins: { top: 90, bottom: 70, left: 140, right: 140 },
    borders: cutBorder(),
    children: kids,
  });
}

const gutterCell = (width) => new TableCell({
  width: { size: width, type: WidthType.DXA },
  borders: noBorder(),
  margins: { top: 0, bottom: 0, left: 0, right: 0 },
  children: [new Paragraph({ spacing: { before: 0, after: 0, line: 20 }, children: [new TextRun({ text: "", size: 2 })] })],
});

const blankCell = (width) => new TableCell({
  width: { size: width, type: WidthType.DXA },
  borders: noBorder(),
  children: [new Paragraph({ spacing: { before: 0, after: 0, line: 20 }, children: [new TextRun({ text: "", size: 2 })] })],
});

// ---------------------------------------------------------------- deck

// Print order: numerical, which is also by round, so the deck can be tabbed and
// reset fast. REFERENCE CHAIN and LATE SHIFT follow the rounds — the same
// card, the same tab line, no round number, because these are not dealt by a
// round.
const ORDER = ["R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7"];
const deck = [];
for (const r of ORDER) {
  deck.push(...faults.filter((f) => f.round === r).sort((a, b) => a.code.localeCompare(b.code)));
}
deck.push(...chainFaults.slice().sort((a, b) => a.code.localeCompare(b.code)));
deck.push(...lateFaults.slice().sort((a, b) => a.code.localeCompare(b.code)));

/** One sheet: fifteen cards in a 3 x 5 grid with gutter rows and columns between them. */
function sheet(cards) {
  const rows = [];
  for (let r = 0; r < ROWS; r += 1) {
    const cells = [];
    for (let c = 0; c < COLS; c += 1) {
      const f = cards[r * COLS + c];
      cells.push(f ? cardCell(f, COL_WIDTHS[c * 2]) : blankCell(COL_WIDTHS[c * 2]));
      if (c < COLS - 1) cells.push(gutterCell(COL_WIDTHS[c * 2 + 1]));
    }
    rows.push(new TableRow({ height: { value: CARD_H, rule: "exact" }, cantSplit: true, children: cells }));
    if (r < ROWS - 1) {
      rows.push(new TableRow({
        height: { value: GUTTER_Y, rule: "exact" }, cantSplit: true,
        children: COL_WIDTHS.map((w) => gutterCell(w)),
      }));
    }
  }
  return new Table({
    columnWidths: COL_WIDTHS,
    width: { size: COL_WIDTHS.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    borders: noBorder(),
    rows,
  });
}

const cardChildren = [];
const sheets = Math.ceil(deck.length / PER_PAGE);
for (let i = 0; i < deck.length; i += PER_PAGE) {
  // a page starts here: a 1 pt paragraph that breaks before itself can never print an empty leaf
  if (i > 0) cardChildren.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: 20 }, children: [new TextRun({ text: "", size: 2 })] }));
  cardChildren.push(sheet(deck.slice(i, i + PER_PAGE)));
}
// the body's closing paragraph mark, kept to a point so it never asks for a fifth page
cardChildren.push(new Paragraph({ spacing: { before: 0, after: 0, line: 20 }, children: [new TextRun({ text: "", size: 2 })] }));

const cardsDoc = new Document({
  styles: { default: { document: { run: { font: "Arial", size: 15, color: INK } } } },
  sections: [{
    properties: {
      page: {
        size: { width: PORTRAIT_W, height: PORTRAIT_H, orientation: PageOrientation.LANDSCAPE },
        margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN, header: 0, footer: 0 },
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
      shading: { type: ShadingType.CLEAR, fill: P.NAVY, color: "auto" },
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
  const vals = [f.code, f.round || (f.section ? "LATE" : "CHAIN"), f.sector, f.name, codes, src, cost, note || "—"];
  keyRows.push(new TableRow({
    children: vals.map((v, i) => new TableCell({
      width: { size: [1100, 700, 700, 2400, 2200, 3000, 1600, 3600][i], type: WidthType.DXA },
      shading: flag ? { type: ShadingType.CLEAR, fill: P.mono ? "E6E6E6" : "FFF2CC", color: "auto" } : undefined,
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
        children: [new TextRun({ text: "UNDERCITY — FACILITATOR ANSWER KEY", font: "Arial", size: 32, bold: true, color: P.NAVY })],
      }),
      new Paragraph({
        spacing: { after: 200 },
        children: [new TextRun({
          text: "THIS SHEET NEVER ENTERS THE ROOM. Generated from the crossref matrix — do not annotate by hand; edit the matrix and regenerate.",
          font: "Arial", size: 18, bold: true, color: P.WARN,
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
          text: "The shaded row is the one structural exception: F-201 accepts either 340 (WTR binder) or 290 (big screen telemetry) — never reconcile these.",
          font: "Arial", size: 16, italics: true, color: MUTED,
        })],
      }),
    ],
  }],
});

// ---------------------------------------------------------------- write

fs.mkdirSync(OUTDIR, { recursive: true });
const cardPath = path.join(OUTDIR, P.out("UNDERCITY_FaultCards.docx"));
const keyPath = path.join(OUTDIR, P.out("UNDERCITY_AnswerKey.docx"));

Packer.toBuffer(cardsDoc).then((b) => {
  fs.writeFileSync(cardPath, b);
  console.log(`✓ ${cardPath}  (${deck.length} cards, ${sheets} landscape A4 sheets, ${PER_PAGE}-up)`);
});
Packer.toBuffer(keyDoc).then((b) => {
  fs.writeFileSync(keyPath, b);
  console.log(`✓ ${keyPath}`);
});

const byRound = {};
deck.forEach((f) => { byRound[f.round] = (byRound[f.round] || 0) + 1; });
console.log("  deck order:", ORDER.map((r) => `${r} ${byRound[r] || 0}`).join(" · ")
  + (chainFaults.length ? ` · REFERENCE CHAIN ${chainFaults.length} (unscheduled)` : "")
  + (lateFaults.length ? ` · LATE SHIFT ${lateFaults.length} (unscheduled)` : ""));
console.log("  no-code cards:", deck.filter((f) => f.false_alarm).map((f) => f.code).join(", ") || "none");
console.log("  multi-code cards:", deck.filter((f) => f.valid_codes.length > 1).map((f) => f.code).join(", ") || "none");
