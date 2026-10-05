// UNDERCITY — binder renderer.
// Reads binder_content.json (from assemble_binders.py) -> six A4 DOCX binders.
// Run: node build_binders.js [binder_content.json] [outdir]
//
// ZERO-BRIEFING EDITION (2026-10-05). Each binder is two halves. The FRONT is
// the participant operating manual — eleven sections built by binder_manual.js
// from the scenario config and the engine's own modules, identical in every
// binder — opened and closed by the one-page WHEN THIS HAPPENS → DO THIS sheet.
// The BACK is this sector's reference: fault index, procedures, specification
// tables, reference directory, Appendix C and the operations log, exactly the
// content the assembler has always produced, renumbered 12 to 15.
//
// Pages are arithmetic. Every section declares the pages it is laid out for and
// starts on a fresh page, so the contents strip on the cover can print page
// numbers without Word's help; the kit build checks with Word that no section
// overflows what it declared.

const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType, BorderStyle, HeadingLevel,
  PageBreak, Header, Footer, PageNumber, VerticalAlign,
} = require("docx");
const manual = require("./binder_manual");

const SRC = process.argv[2] || "binder_content.json";
const OUTDIR = process.argv[3] || "binders";
const data = JSON.parse(fs.readFileSync(SRC, "utf8"));

const W = 9026;                     // A4 content width in DXA (11906 - 2*1440)
const INK = "1A1A1A";
const MUTED = "6B6B6B";
const RULE = "BFBFBF";
const WARN_RED = "B00000";
const AMBER = "8A5A00";

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

/** A light tint of a sector colour, for box fills: 85 % white. */
function tint(hex, amount = 0.85) {
  const n = parseInt(hex, 16);
  const mix = (c) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, "0");
  return `${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`.toUpperCase();
}

const mono = (text, opts = {}) =>
  new TextRun({ text, font: "Courier New", size: 20, color: INK, ...opts });
const body = (text, opts = {}) =>
  new TextRun({ text, font: "Arial", size: 20, color: INK, ...opts });

/**
 * Inline markup for the manual: **bold** and `mono`. Nothing else — the
 * content model is prose with emphasis, and the renderer owns the type.
 */
function runs(text, opts = {}) {
  const out = [];
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter((s) => s.length);
  for (const part of parts) {
    if (part.startsWith("**") && part.endsWith("**")) out.push(body(part.slice(2, -2), { ...opts, bold: true }));
    else if (part.startsWith("`") && part.endsWith("`")) out.push(mono(part.slice(1, -1), { ...opts, size: opts.size || 20 }));
    else out.push(body(part, opts));
  }
  return out;
}

const p = (children, opts = {}) =>
  new Paragraph({ children: Array.isArray(children) ? children : [children], spacing: { after: 120 }, ...opts });

const rule = () => new Paragraph({
  text: "", spacing: { after: 160 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE } },
});

/**
 * A page starts here. Not a PageBreak run: a paragraph that cannot fit on a
 * page that is already full would carry its break onto the next page and
 * leave that page empty. "Page break before" on an empty 1 pt paragraph can
 * only ever start the page it is on, so no section can print a blank leaf.
 */
const pageStart = () => new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: 20 }, children: [new TextRun({ text: "", size: 2 })] });
const gap = (after = 120) => new Paragraph({ text: "", spacing: { after } });

function cell(children, { width, shade, bold, align, mono: isMono, size, color, margins } = {}) {
  const list = (Array.isArray(children) ? children : [children]).map((t) =>
    typeof t === "string" ? (isMono ? mono(t, { bold, size, color }) : body(t, { bold, size, color })) : t);
  const paras = [];
  let current = [];
  for (const r of list) {
    if (r && r.__break) { paras.push(new Paragraph({ spacing: { after: 40 }, alignment: align, children: current })); current = []; }
    else current.push(r);
  }
  paras.push(new Paragraph({ spacing: { after: 0 }, alignment: align, children: current }));
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlign.TOP,
    shading: shade ? { type: ShadingType.CLEAR, fill: shade, color: "auto" } : undefined,
    margins: margins || { top: 60, bottom: 60, left: 100, right: 100 },
    children: paras,
  });
}

function table(rows, widths, borders = thinBorders) {
  return new Table({ columnWidths: widths, width: { size: W, type: WidthType.DXA }, borders, rows });
}

// ---------------------------------------------------------------- section furniture

/** The section head: a large number in the sector colour, the title, a tab chip at the right. */
function sectionHead(num, title, colour, tab) {
  const numText = num === null || num === undefined ? "" : `${num}`;
  const left = new TableCell({
    width: { size: W - 1500, type: WidthType.DXA }, verticalAlign: VerticalAlign.BOTTOM,
    borders: { bottom: { style: BorderStyle.SINGLE, size: 12, color: colour } },
    margins: { top: 0, bottom: 80, left: 0, right: 100 },
    children: [new Paragraph({
      spacing: { after: 0 },
      children: [
        ...(numText ? [new TextRun({ text: `${numText}  `, font: "Arial", size: 56, bold: true, color: colour })] : []),
        new TextRun({ text: title, font: "Arial", size: 30, bold: true, color: INK, characterSpacing: 10 }),
      ],
    })],
  });
  const right = new TableCell({
    width: { size: 1500, type: WidthType.DXA }, verticalAlign: VerticalAlign.BOTTOM,
    borders: { bottom: { style: BorderStyle.SINGLE, size: 12, color: colour } },
    shading: tab ? { type: ShadingType.CLEAR, fill: colour, color: "auto" } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 0 },
      children: [new TextRun({ text: tab || "", font: "Arial", size: 18, bold: true, color: "FFFFFF", characterSpacing: 60 })],
    })],
  });
  return [
    new Table({ columnWidths: [W - 1500, 1500], width: { size: W, type: WidthType.DXA }, borders: noBorders, rows: [new TableRow({ children: [left, right] })] }),
    gap(140),
  ];
}

function subsectionHead(num, title, colour) {
  return new Paragraph({
    spacing: { before: 260, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: colour } },
    children: [
      new TextRun({ text: `${num}  `, font: "Arial", size: 40, bold: true, color: colour }),
      new TextRun({ text: title, font: "Arial", size: 30, bold: true, color: INK, characterSpacing: 10 }),
    ],
  });
}

const BOX_STYLE = {
  ACTION: (colour) => ({ fill: tint(colour), bar: colour, title: colour, label: "ACTION" }),
  WARNING: () => ({ fill: "FBE9E7", bar: WARN_RED, title: WARN_RED, label: "WARNING" }),
  REMEMBER: () => ({ fill: "F2F2F2", bar: MUTED, title: INK, label: "REMEMBER" }),
  NEWROUND: () => ({ fill: "FFF4D6", bar: AMBER, title: AMBER, label: "NEW ROUND" }),
};

function boxBlock(kind, title, lines, colour) {
  const st = (BOX_STYLE[kind] || BOX_STYLE.REMEMBER)(colour);
  const paras = [
    new Paragraph({
      spacing: { after: 60 },
      children: [
        new TextRun({ text: `${st.label}  `, font: "Arial", size: 14, bold: true, color: st.bar, characterSpacing: 80 }),
        new TextRun({ text: title, font: "Arial", size: kind === "NEWROUND" ? 26 : 22, bold: true, color: st.title }),
      ],
    }),
    ...lines.map((line) => new Paragraph({ spacing: { after: 60 }, children: runs(line) })),
  ];
  return new Table({
    columnWidths: [W], width: { size: W, type: WidthType.DXA },
    borders: {
      ...noBorders,
      left: { style: BorderStyle.SINGLE, size: 36, color: st.bar },
    },
    rows: [new TableRow({ children: [new TableCell({
      width: { size: W, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: st.fill, color: "auto" },
      margins: { top: 120, bottom: 100, left: 200, right: 160 },
      children: paras,
    })] })],
  });
}

function headingBlock(text, colour) {
  return new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text: text.toUpperCase(), font: "Arial", size: 20, bold: true, color: colour, characterSpacing: 40 })],
  });
}

function stepsBlock(items, { start = 1 } = {}) {
  return items.map((text, i) => new Paragraph({
    spacing: { after: 70 }, indent: { left: 420, hanging: 420 },
    children: [mono(`${String(i + start).padStart(2, " ")}  `, { bold: true }), ...runs(text)],
  }));
}

function checkBlock(items) {
  return items.map((text) => new Paragraph({
    spacing: { after: 70 }, indent: { left: 420, hanging: 420 },
    children: [body("☐   ", { size: 24 }), ...runs(text)],
  }));
}

function bulletsBlock(items) {
  return items.map((text) => new Paragraph({
    spacing: { after: 60 }, indent: { left: 360, hanging: 360 },
    children: [body("•   "), ...runs(text)],
  }));
}

function tableBlock(head, rows, widths, { small = false, boldFirst = false } = {}) {
  const size = small ? 18 : 20;
  const out = [new TableRow({ tableHeader: true, children: head.map((h, i) => cell(h, { width: widths[i], shade: "F2F2F2", bold: true, size: 16 })) })];
  for (const r of rows) {
    out.push(new TableRow({ cantSplit: true, children: r.map((c, i) => new TableCell({
      width: { size: widths[i], type: WidthType.DXA },
      verticalAlign: VerticalAlign.TOP,
      margins: { top: 50, bottom: 50, left: 90, right: 90 },
      children: [new Paragraph({ spacing: { after: 0 }, children: runs(c, { size, bold: boldFirst && i === 0 }) })],
    })) }));
  }
  return table(out, widths);
}

function kvBlock(rows, { keyWidth = 2600 } = {}) {
  return table(rows.map(([k, v]) => new TableRow({ cantSplit: true, children: [
    cell(k, { width: keyWidth, shade: "F2F2F2", bold: true, size: 18 }),
    new TableCell({
      width: { size: W - keyWidth, type: WidthType.DXA }, verticalAlign: VerticalAlign.TOP,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({ spacing: { after: 0 }, children: runs(v) })],
    }),
  ] })), [keyWidth, W - keyWidth]);
}

function flowBlock(steps, colour) {
  const n = steps.length;
  const arrow = 360;
  const stepW = Math.floor((W - arrow * (n - 1)) / n);
  const widths = [];
  const cells = [];
  steps.forEach((s, i) => {
    widths.push(stepW);
    cells.push(new TableCell({
      width: { size: stepW, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
      shading: { type: ShadingType.CLEAR, fill: i === 0 ? colour : tint(colour, 0.8), color: "auto" },
      margins: { top: 90, bottom: 90, left: 70, right: 70 },
      borders: thinBorders,
      children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: runs(s, { size: 16, bold: true, color: i === 0 ? "FFFFFF" : INK }) })],
    }));
    if (i < n - 1) {
      widths.push(arrow);
      cells.push(new TableCell({
        width: { size: arrow, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER, borders: noBorders,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [body("→", { size: 28, bold: true, color: colour })] })],
      }));
    }
  });
  const used = widths.reduce((a, b) => a + b, 0);
  widths[widths.length - 1] += W - used;
  return new Table({ columnWidths: widths, width: { size: W, type: WidthType.DXA }, borders: noBorders, rows: [new TableRow({ children: cells })] });
}

/** The four role cards, two by two, DO / DON'T / WHEN NEEDED. */
function cardsBlock(roles, colour) {
  const half = Math.floor(W / 2);
  const card = (r) => {
    const paras = [
      new Paragraph({ spacing: { after: 20 }, children: [new TextRun({ text: r.title, font: "Arial", size: 26, bold: true, color: colour })] }),
      new Paragraph({ spacing: { after: 90 }, children: [body(r.tagline, { italics: true, size: 18, color: "3A3A3A" })] }),
    ];
    const group = (label, lines, mark, col) => {
      paras.push(new Paragraph({ spacing: { before: 60, after: 30 }, children: [new TextRun({ text: label, font: "Arial", size: 15, bold: true, color: col, characterSpacing: 60 })] }));
      for (const l of lines) paras.push(new Paragraph({ spacing: { after: 30 }, indent: { left: 260, hanging: 260 }, children: [body(`${mark}  `, { bold: true, color: col, size: 18 }), ...runs(l, { size: 18 })] }));
    };
    group("DO", r.do, "✓", "2E7D32");
    group("DON'T", r.dont, "✗", WARN_RED);
    group("WHEN NEEDED", r.when, "→", AMBER);
    return new TableCell({
      width: { size: half, type: WidthType.DXA }, verticalAlign: VerticalAlign.TOP,
      margins: { top: 100, bottom: 100, left: 140, right: 140 },
      borders: { top: { style: BorderStyle.SINGLE, size: 18, color: colour }, bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE }, left: { style: BorderStyle.SINGLE, size: 4, color: RULE }, right: { style: BorderStyle.SINGLE, size: 4, color: RULE } },
      children: paras,
    });
  };
  const rows = [];
  for (let i = 0; i < roles.length; i += 2) rows.push(new TableRow({ children: [card(roles[i]), card(roles[i + 1] || roles[i])] }));
  return new Table({ columnWidths: [half, W - half], width: { size: W, type: WidthType.DXA }, borders: noBorders, rows });
}

function namesBlock(rows) {
  return table(rows.map(([k]) => new TableRow({ children: [
    cell(k, { width: 2600, shade: "F2F2F2", bold: true, size: 18 }),
    cell([body(" "), body(" ")], { width: W - 2600, margins: { top: 120, bottom: 120, left: 100, right: 100 } }),
  ] })), [2600, W - 2600]);
}

/** A completed Transfer Chit, in the chit's own layout, so the paper is recognisable. */
function chitBlock(s) {
  const lab = (t, w, shade = "F2F2F2") => cell([body(t, { size: 14, color: MUTED })], { width: w, shade });
  const val = (t, w) => cell([body(t, { size: 18, bold: true })], { width: w });
  const rows = [
    new TableRow({ children: [lab("FROM SECTOR", 2200), val(s.from, 2300), lab("TO SECTOR", 2200), val(s.to, W - 6700)] }),
    new TableRow({ children: [lab("RESOURCES", 2200), val(s.resources, 2300), lab("WORKERS", 2200), val(s.workers, W - 6700)] }),
    new TableRow({ children: [lab("IN EXCHANGE FOR", 2200), new TableCell({ width: { size: W - 2200, type: WidthType.DXA }, columnSpan: 3, margins: { top: 60, bottom: 60, left: 100, right: 100 }, children: [new Paragraph({ spacing: { after: 0 }, children: [body(s.exchange, { size: 18, bold: true })] })] })] }),
    new TableRow({ children: [lab("SENDING LIAISON", 2200), val(s.sending, 2300), lab("RECEIVING LIAISON", 2200), val(s.receiving, W - 6700)] }),
    new TableRow({ children: [lab("TIME", 2200), val(s.time, 2300), cell([body("TRN STAMP", { size: 14, bold: true, color: WARN_RED })], { width: 2200, shade: "FFF2CC" }), cell([body(s.stamp, { size: 18, bold: true, color: WARN_RED })], { width: W - 6700, shade: "FFF2CC" })] }),
  ];
  return [
    new Paragraph({
      spacing: { before: 160, after: 60 },
      children: [
        new TextRun({ text: "SAMPLE — COMPLETED TRANSFER CHIT  ", font: "Arial", size: 14, bold: true, color: MUTED, characterSpacing: 60 }),
        new TextRun({ text: `No. ${s.no}`, font: "Courier New", size: 16, color: MUTED }),
      ],
    }),
    table(rows, [2200, 2300, 2200, W - 6700]),
    new Paragraph({ spacing: { before: 40, after: 160 }, children: [body("White copy to the receiving sector · Duplicate retained by the sender · VOID WITHOUT STAMP", { size: 14, italics: true, color: MUTED })] }),
  ];
}

/** One content block -> DOCX paragraphs/tables. */
function renderBlock(blk, b) {
  const f = (t) => manual.fill(t, b);
  switch (blk.t) {
    case "p": return [new Paragraph({
      spacing: { after: 120 },
      children: runs(f(blk.text), blk.muted ? { size: 16, italics: true, color: MUTED } : blk.lore ? { italics: true, color: "3A3A3A" } : {}),
    })];
    case "h": return [headingBlock(f(blk.text), b.colour)];
    case "steps": return stepsBlock(blk.items.map(f), blk);
    case "check": return checkBlock(blk.items.map(f));
    case "bullets": return bulletsBlock(blk.items.map(f));
    case "table": return [tableBlock(blk.head.map(f), blk.rows.map((r) => r.map(f)), blk.widths, blk), gap(100)];
    case "kv": return [kvBlock(blk.rows.map(([k, v]) => [f(k), f(v)]), blk), gap(100)];
    case "box": return [boxBlock(blk.kind, f(blk.title), blk.lines.map(f), b.colour), gap(120)];
    case "flow": return [flowBlock(blk.steps.map(f), b.colour), gap(120)];
    case "cards": return [cardsBlock(blk.items, b.colour)];
    case "names": return [namesBlock(blk.rows), gap(120)];
    case "chit": return chitBlock(blk.sample);
    case "subsection": return [subsectionHead(blk.num, f(blk.title), b.colour)];
    case "gap": return [gap(blk.n)];
    case "break": return [pageStart()];
    default: throw new Error(`build_binders: unknown block ${blk.t}`);
  }
}

function renderSection(sec, b) {
  const breaks = sec.blocks.filter((x) => x.t === "break").length;
  // A section may flow across more pages than it breaks explicitly; it may
  // never break more often than it declares, or the cover's arithmetic lies.
  if (breaks + 1 > sec.pages) throw new Error(`build_binders: ${b.code} §${sec.num} declares ${sec.pages} pages but breaks ${breaks + 1} times`);
  const out = [pageStart(), ...sectionHead(sec.num, manual.fill(sec.title, b), b.colour, sec.tab)];
  for (const blk of sec.blocks) out.push(...renderBlock(blk, b));
  return out;
}

// ---------------------------------------------------------------- cover

function coverPage(b, plan) {
  const glyph = { POW: "⚡", WTR: "💧", MED: "⚕", TRN: "🚇", AGR: "🌱", COM: "📡" }[b.code] || "";
  const line = (entry) => new TableRow({ children: [
    new TableCell({ width: { size: 1100, type: WidthType.DXA }, borders: noBorders, margins: { top: 30, bottom: 30, left: 60, right: 60 },
      children: [new Paragraph({ spacing: { after: 0 }, children: [body(entry.num === null || entry.num === undefined ? "" : `§${entry.num}`, { bold: true, size: 16, color: b.colour })] })] }),
    new TableCell({ width: { size: 2900, type: WidthType.DXA }, borders: noBorders, margins: { top: 30, bottom: 30, left: 60, right: 60 },
      children: [new Paragraph({ spacing: { after: 0 }, children: [body(entry.title, { size: 16 })] })] }),
    new TableCell({ width: { size: 513, type: WidthType.DXA }, borders: noBorders, margins: { top: 30, bottom: 30, left: 60, right: 60 },
      children: [new Paragraph({ spacing: { after: 0 }, alignment: AlignmentType.RIGHT, children: [body(String(entry.page), { size: 16, bold: true })] })] }),
  ] });
  const half = Math.ceil(plan.length / 2);
  const col = (entries) => new TableCell({
    width: { size: W / 2, type: WidthType.DXA }, borders: noBorders, margins: { top: 0, bottom: 0, left: 0, right: 0 },
    children: [new Table({ columnWidths: [1100, 2900, 513], width: { size: W / 2, type: WidthType.DXA }, borders: noBorders, rows: entries.map(line) })],
  });
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 400, after: 80 },
      children: [new TextRun({ text: "HAVEN-9", font: "Arial", size: 36, bold: true, color: MUTED, characterSpacing: 200 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 500 },
      children: [new TextRun({ text: "SUBTERRANEAN CONTINUITY AUTHORITY", font: "Arial", size: 16, color: MUTED, characterSpacing: 80 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 100 },
      children: [new TextRun({ text: glyph, font: "Segoe UI Emoji", size: 96 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 40 },
      children: [new TextRun({ text: b.code, font: "Arial", size: 96, bold: true, color: b.colour })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 60 },
      children: [new TextRun({ text: b.name.toUpperCase(), font: "Arial", size: 32, bold: true, color: INK, characterSpacing: 40 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 360 },
      children: [new TextRun({ text: b.motto, font: "Arial", size: 20, italics: true, color: MUTED })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 60 },
      children: [new TextRun({ text: "TECHNICAL OPERATIONS BINDER", font: "Arial", size: 22, bold: true, color: INK, characterSpacing: 40 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 300 },
      children: [new TextRun({ text: "Revision 10 · Self-guided edition · Keep at the sector station", font: "Arial", size: 16, color: MUTED })],
    }),
    boxBlock("ACTION", "NO BRIEFING IS COMING", [
      "This binder and your sector console contain everything you need to operate your station. Nobody will present the rules. **Turn to page 3 and begin.** Pages 3 to 7 are enough to start; the rest is reference for when you need it.",
    ], b.colour),
    gap(200),
    new Paragraph({
      spacing: { after: 80 },
      children: [new TextRun({ text: "CONTENTS", font: "Arial", size: 16, bold: true, color: MUTED, characterSpacing: 80 })],
    }),
    new Table({ columnWidths: [W / 2, W / 2], width: { size: W, type: WidthType.DXA }, borders: noBorders, rows: [new TableRow({ children: [col(plan.slice(0, half)), col(plan.slice(half))] })] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      border: { top: { style: BorderStyle.SINGLE, size: 6, color: b.colour } },
      spacing: { before: 300, after: 60 },
      children: [new TextRun({ text: `${b.code} PERSONNEL ONLY`, font: "Arial", size: 18, bold: true, color: b.colour, characterSpacing: 60 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "This binder does not leave the sector station. What it says may be shared out loud, at your discretion. Only your Liaison leaves the station.", font: "Arial", size: 16, italics: true, color: MUTED })],
    }),
  ];
}

// ---------------------------------------------------------------- the reference half (from the assembler)

function indexPages(b) {
  const rows = [new TableRow({ tableHeader: true, children: [
    cell("FAULT CODE", { width: 1800, shade: "F2F2F2", bold: true }),
    cell("DESCRIPTION", { width: 4200, shade: "F2F2F2", bold: true }),
    cell("ACTION", { width: W - 6000, shade: "F2F2F2", bold: true }),
  ]})];
  for (const r of b.index_rows) {
    const actionRuns = r.own
      ? (r.no_procedure
          ? [body(r.action, { bold: true })]
          : [mono(r.action)])
      : [body(r.action, { bold: true, color: AMBER })];
    rows.push(new TableRow({ children: [
      cell(r.code, { width: 1800, mono: true, bold: r.own }),
      cell(r.name, { width: 4200 }),
      new TableCell({
        width: { size: W - 6000, type: WidthType.DXA },
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        shading: r.own ? undefined : { type: ShadingType.CLEAR, fill: "FFF6E5", color: "auto" },
        children: [new Paragraph({ spacing: { after: 0 }, children: actionRuns })],
      }),
    ]}));
  }
  return [
    pageStart(),
    ...sectionHead(12, manual.TITLES[12], b.colour, "INDEX"),
    p(runs("When a fault appears on your console, find its code here first. A fault on your own console is always yours: its row names the procedure to open in §13. **Shaded rows are codes that belong to another sector.** If you are told or shown one of those, send it to the sector named; do not attempt a repair. The flow is §7.")),
    table(rows, [1800, 4200, W - 6000]),
    gap(160),
    p([body("TIME-CRITICAL", { bold: true }), body(" marks a fault that bleeds Health faster than any other. Work it first.")]),
  ];
}

/**
 * 14A · CROSS-SYSTEM REFERENCE DIRECTORY.
 *
 * The rows that do not answer. Where §14 prints a figure, this prints another
 * sector's asset — and the whole mechanic rests on an operator being able to
 * tell the two apart at a glance under pressure, so the reference is set in
 * the same mono face as a value but bracketed with its sector, and the
 * standing order above the table says in one line what it is for.
 */
function referencePages(b) {
  if (!b.references || !b.references.length) return [];
  const LEFT = 4600;
  const rows = [new TableRow({ tableHeader: true, children: [
    cell("REFERENCE NAME", { width: LEFT, shade: "F2F2F2", bold: true }),
    cell("REFERENCE", { width: W - LEFT, shade: "F2F2F2", bold: true, align: AlignmentType.CENTER }),
  ]})];
  for (const r of b.references) {
    rows.push(new TableRow({ children: [
      cell(r.name, { width: LEFT }),
      cell(r.display, { width: W - LEFT, mono: true, bold: true, align: AlignmentType.CENTER }),
    ]}));
  }
  return [
    pageStart(),
    ...sectionHead("14A", "CROSS-SYSTEM REFERENCE DIRECTORY", b.colour, "REFS"),
    p(body("Entries ending with a sector code in square brackets are REFERENCES, not resolution values. "
      + "Relay the exact reference name and sector shown to the requesting team. The named sector holds "
      + "the authoritative numeric value. Do not invent or infer a number.")),
    gap(160),
    table(rows, [LEFT, W - LEFT]),
  ];
}

const PROCS_PER_PAGE = 3;

function procedurePages(b) {
  const out = [pageStart(), ...sectionHead(13, manual.TITLES[13], b.colour, "REPAIR"),
    p(runs("Procedures are written to be read aloud, by the Systems Lead, all the way through. The console will not accept a partial code. **§7 is the flow; this is the content.** A value \"not held in this binder\" is fetched in person by the Liaison, by row name, from the sector named.")),
  ];
  b.procedures.forEach((proc, i) => {
    out.push(new Paragraph({
      pageBreakBefore: i > 0 && i % PROCS_PER_PAGE === 0,
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
  });
  return out;
}

function tablePages(b) {
  const out = [pageStart(), ...sectionHead(14, manual.TITLES[14], b.colour, "SPECS"),
    p(body("These values are held by this sector. Other stations will send their Liaison to ask for them, by row name, during the shift. Whether you give them, and how quickly, is your call.")),
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
  out.push(gap(200));
  out.push(p([body("Values are as-built and take precedence over station instrumentation.", { italics: true, color: MUTED })]));
  return out;
}

function appendixPage(b) {
  return [
    pageStart(),
    ...sectionHead(null, "APPENDIX C · NON-ROUTINE AUTHORISATIONS", b.colour, "APP C"),
    p(body("Retained for audit. Not part of the standard fault index. Applies only where a procedure directs the operator to this appendix or where no indexed procedure exists.")),
    gap(200),
    p(body("C.1  Scope")),
    p(body("The authorisation below was issued under emergency powers and has not been revoked. It remains valid for the current operating period.", { color: MUTED })),
    gap(200),
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
    gap(240),
    p(body("C.2  Records retention")),
    p(body("Superseded revisions of this appendix were destroyed in the Cycle 31 records purge. No further entries follow.", { color: MUTED })),
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
    pageStart(),
    ...sectionHead(15, manual.TITLES[15], b.colour, "LOG"),
    p(body("Keep this current. It is the sector's record of what was decided and who agreed to it, and the Council may call for it at any time. Loose-leaf: ask for a fresh sheet when it is full.")),
    table(rows, [1200, 2600, 3200, W - 7000]),
  ];
}

/** The reference half's page plan, from the content it will print. */
function referencePlan(b) {
  const plan = [
    { id: "index", num: 12, title: manual.TITLES[12], pages: 1 },
    { id: "procedures", num: 13, title: manual.TITLES[13], pages: Math.max(1, Math.ceil(b.procedures.length / PROCS_PER_PAGE)) },
    { id: "tables", num: 14, title: manual.TITLES[14], pages: 1 },
  ];
  if (b.references && b.references.length) plan.push({ id: "references", num: "14A", title: "CROSS-SYSTEM REFERENCE DIRECTORY", pages: 1 });
  plan.push({ id: "appendix", num: null, title: "APPENDIX C · NON-ROUTINE AUTHORISATIONS", pages: 1 });
  plan.push({ id: "log", num: 15, title: manual.TITLES[15], pages: 1 });
  return plan;
}

// ---------------------------------------------------------------- assemble

fs.mkdirSync(OUTDIR, { recursive: true });
const plans = {};

for (const code of Object.keys(data.binders)) {
  const b = data.binders[code];
  const man = manual.manualFor(b);
  const refPlan = referencePlan(b);
  const plan = manual.pagePlan(man, refPlan);
  plans[code] = plan;
  const front = [{ num: null, title: manual.QUICK_TITLE, page: 2 }, ...plan];
  const children = [
    ...coverPage(b, front),
    ...renderSection(man.front, b),
    ...man.sections.flatMap((s) => renderSection(s, b)),
    ...indexPages(b), ...procedurePages(b), ...tablePages(b), ...referencePages(b), ...appendixPage(b), ...logPage(b),
  ];
  // the back page: the quick reference again
  children.push(...renderSection(man.back, b));

  const doc = new Document({
    styles: { default: { document: { run: { font: "Arial", size: 20, color: INK } } } },
    sections: [{
      properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      headers: { default: new Header({ children: [new Paragraph({
        alignment: AlignmentType.RIGHT,
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE } },
        children: [new TextRun({ text: `HAVEN-9 · ${b.code} TECHNICAL OPERATIONS BINDER · ${b.name.toUpperCase()} · KEEP AT STATION`, font: "Arial", size: 14, color: MUTED })],
      })]}) },
      footers: { default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ children: ["Page ", PageNumber.CURRENT, "  ·  Quick reference: page 2 and the back page  ·  Faults §7  ·  Upkeep §5  ·  Trading §9"], font: "Arial", size: 14, color: MUTED })],
      })]}) },
      children,
    }],
  });
  const file = path.join(OUTDIR, `UNDERCITY_Binder_${b.code}.docx`);
  Packer.toBuffer(doc).then((buf) => {
    fs.writeFileSync(file, buf);
    console.log("✓", file, `(${plan[plan.length - 1].page} pages planned)`);
  });
}

// The plan each binder was laid out to, beside binder_content.json: the page
// check (tools/kit/check_binder_pages.py) reads it back and compares.
fs.writeFileSync(path.join(path.dirname(SRC), "binder_pages.json"), `${JSON.stringify(plans, null, 2)}\n`);
