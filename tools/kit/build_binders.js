// UNDERCITY — binder renderer.
// Reads binder_content.json (from assemble_binders.py) -> six nine-page A4 DOCX
// binders, plus the Station Operations Log as loose sheets.
// Run: node build_binders.js [binder_content.json] [outdir] [--only POW,WTR]
//
// NINE-PAGE EDITION (2026-10-05). The pages are built by binder_compact.js;
// this file owns the typography. Every page starts on a fresh leaf with a
// "page break before" paragraph (a PageBreak run that does not fit on a full
// page would print an empty leaf), every table row is kept whole, and a page
// never ends on a spacing paragraph. The plan each binder was laid out to is
// written beside binder_content.json for tools/kit/check_binder_pages.py,
// which exports the DOCX to PDF with Word and verifies that every page starts
// where the binder says it does.

const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType, BorderStyle,
  Header, Footer, PageNumber, VerticalAlign,
} = require("docx");
const compact = require("./binder_compact");
const { fill } = require("./binder_rules");
const P = require("./palette").from(process.argv);   // colour, or --mono for the B&W Kit

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const positional = argv.filter((a, i) => !a.startsWith("--") && (i === 0 || !argv[i - 1].startsWith("--")));
const SRC = positional[0] || "binder_content.json";
const OUTDIR = positional[1] || "binders";
const ONLY = (flag("--only") || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const data = JSON.parse(fs.readFileSync(SRC, "utf8"));

const W = 9026;                     // A4 content width in DXA (11906 - 2*1440)
const { INK, MUTED, RULE, WARN: WARN_RED, AMBER } = P;

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

/** A light tint of a sector colour, for box fills: 85 % white (a grey of that lightness in B&W). */
const tint = P.tint;

const mono = (text, opts = {}) =>
  new TextRun({ text, font: "Courier New", size: 20, color: INK, ...opts });
const body = (text, opts = {}) =>
  new TextRun({ text, font: "Arial", size: 20, color: INK, ...opts });

/**
 * Inline markup for the pages: **bold** and `mono`. Nothing else — the
 * content model is prose with emphasis, and the renderer owns the type.
 */
function runs(text, opts = {}) {
  const out = [];
  // a glyph (⚡ 💧 🔧 ⚕ 👤 ⚠) is its own run so the B&W palette can set it in a monochrome font
  const plain = (s, o) => P.splitGlyphs(s).map((seg) => body(seg.text, seg.glyph ? { ...o, font: P.glyphFont } : o));
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter((s) => s.length);
  for (const part of parts) {
    if (part.startsWith("**") && part.endsWith("**")) out.push(...plain(part.slice(2, -2), { ...opts, bold: true }));
    else if (part.startsWith("`") && part.endsWith("`")) out.push(mono(part.slice(1, -1), { ...opts, size: opts.size || 20 }));
    else out.push(...plain(part, opts));
  }
  return out;
}

const p = (children, opts = {}) =>
  new Paragraph({ children: Array.isArray(children) ? children : [children], spacing: { after: 120 }, ...opts });

/**
 * A page starts here. Not a PageBreak run: a paragraph that cannot fit on a
 * page that is already full would carry its break onto the next page and
 * leave that page empty. "Page break before" on an empty 1 pt paragraph can
 * only ever start the page it is on, so no section can print a blank leaf.
 */
const pageStart = () => new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: 20 }, children: [new TextRun({ text: "", size: 2 })] });
/** Spacing after a block. It knows it is a gap, so a page never ends on one. */
const gap = (after = 120) => Object.assign(new Paragraph({ text: "", spacing: { after } }), { __gap: true });

function cell(children, { width, shade, bold, align, mono: isMono, size, color, margins } = {}) {
  const list = (Array.isArray(children) ? children : [children]).flatMap((t) =>
    typeof t === "string" ? (isMono || t === "" ? [(isMono ? mono : body)(t, { bold, size, color })] : runs(t, { bold, size, color })) : [t]);
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlign.TOP,
    shading: shade ? { type: ShadingType.CLEAR, fill: shade, color: "auto" } : undefined,
    margins: margins || { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ spacing: { after: 0 }, alignment: align, children: list })],
  });
}

function table(rows, widths, borders = thinBorders) {
  return new Table({ columnWidths: widths, width: { size: W, type: WidthType.DXA }, borders, rows });
}

// ---------------------------------------------------------------- page furniture

/** The page head: a large number in the sector colour, the title, a chip at the right. */
function pageHead(num, title, colour, tab) {
  const left = new TableCell({
    width: { size: W - 1500, type: WidthType.DXA }, verticalAlign: VerticalAlign.BOTTOM,
    borders: { bottom: { style: BorderStyle.SINGLE, size: 12, color: P.sector(colour) } },
    margins: { top: 0, bottom: 80, left: 0, right: 100 },
    children: [new Paragraph({
      spacing: { after: 0 },
      children: [
        ...(num === "" ? [] : [new TextRun({ text: `${num}  `, font: "Arial", size: 56, bold: true, color: P.sector(colour) })]),
        new TextRun({ text: title, font: "Arial", size: 30, bold: true, color: INK, characterSpacing: 10 }),
      ],
    })],
  });
  const right = new TableCell({
    width: { size: 1500, type: WidthType.DXA }, verticalAlign: VerticalAlign.BOTTOM,
    borders: { bottom: { style: BorderStyle.SINGLE, size: 12, color: P.sector(colour) } },
    shading: { type: ShadingType.CLEAR, fill: P.sector(colour), color: "auto" },
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 0 },
      children: [new TextRun({ text: tab, font: "Arial", size: 18, bold: true, color: "FFFFFF", characterSpacing: 60 })],
    })],
  });
  return [
    new Table({ columnWidths: [W - 1500, 1500], width: { size: W, type: WidthType.DXA }, borders: noBorders, rows: [new TableRow({ children: [left, right] })] }),
    gap(140),
  ];
}

// In colour the kind is a colour. In B&W it is a treatment: ACTION and NEW
// ROUND carry a black heading strip (NEW ROUND inside a dashed frame), WARNING
// a double frame on grey, REMEMBER a thin grey frame — so the hierarchy reads
// on a monochrome laser printer and a photocopy of it.
const BOX_STYLE = P.mono ? {
  ACTION: () => ({ fill: "FFFFFF", bar: "000000", title: "FFFFFF", strip: "000000", label: "ACTION", frame: { style: BorderStyle.SINGLE, size: 8, color: "000000" } }),
  WARNING: () => ({ fill: "E6E6E6", bar: "000000", title: "000000", strip: null, label: "WARNING", frame: { style: BorderStyle.DOUBLE, size: 4, color: "000000" } }),
  REMEMBER: () => ({ fill: "F7F7F7", bar: "808080", title: "000000", strip: null, label: "REMEMBER", frame: { style: BorderStyle.SINGLE, size: 4, color: "808080" } }),
  NEWROUND: () => ({ fill: "F2F2F2", bar: "000000", title: "FFFFFF", strip: "000000", label: "NEW ROUND", frame: { style: BorderStyle.DASHED, size: 8, color: "000000" } }),
} : {
  ACTION: (colour) => ({ fill: tint(colour), bar: colour, title: colour, label: "ACTION" }),
  WARNING: () => ({ fill: P.fill.warning, bar: WARN_RED, title: WARN_RED, label: "WARNING" }),
  REMEMBER: () => ({ fill: P.fill.light, bar: MUTED, title: INK, label: "REMEMBER" }),
  NEWROUND: () => ({ fill: P.fill.newround, bar: AMBER, title: AMBER, label: "NEW ROUND" }),
};

function boxBlock(kind, title, lines, colour) {
  const st = (BOX_STYLE[kind] || BOX_STYLE.REMEMBER)(colour);
  const paras = [
    new Paragraph({
      spacing: { after: 60 },
      shading: st.strip ? { type: ShadingType.CLEAR, fill: st.strip, color: "auto" } : undefined,
      children: [
        new TextRun({ text: `${st.label}  `, font: "Arial", size: 14, bold: true, color: st.strip ? "FFFFFF" : st.bar, characterSpacing: 80 }),
        ...runs(title, { size: kind === "NEWROUND" ? 26 : 22, bold: true, color: st.title }),
      ],
    }),
    ...lines.map((line) => new Paragraph({ spacing: { after: 60 }, children: runs(line) })),
  ];
  const frame = st.frame ? { top: st.frame, bottom: st.frame, right: st.frame } : {};
  return new Table({
    columnWidths: [W], width: { size: W, type: WidthType.DXA },
    borders: { ...noBorders, ...frame, left: { style: BorderStyle.SINGLE, size: 36, color: st.bar } },
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
    children: [new TextRun({ text: text.toUpperCase(), font: "Arial", size: 20, bold: true, color: P.sector(colour), characterSpacing: 40 })],
  });
}

function stepsBlock(items, { start = 1 } = {}) {
  return items.map((text, i) => new Paragraph({
    spacing: { after: 70 }, indent: { left: 420, hanging: 420 },
    children: [mono(`${String(i + start).padStart(2, " ")}  `, { bold: true }), ...runs(text)],
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

/** A strip of steps joined by arrows. `big` is the three actions a repair comes down to. */
function flowBlock(steps, colour, { big = false } = {}) {
  const n = steps.length;
  const arrow = big ? 600 : 360;
  const stepW = Math.floor((W - arrow * (n - 1)) / n);
  const widths = [];
  const cells = [];
  steps.forEach((s, i) => {
    widths.push(stepW);
    cells.push(new TableCell({
      width: { size: stepW, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
      shading: { type: ShadingType.CLEAR, fill: big ? P.sector(colour) : i === 0 ? P.sector(colour) : tint(colour, 0.8), color: "auto" },
      margins: { top: big ? 120 : 90, bottom: big ? 120 : 90, left: 70, right: 70 },
      borders: thinBorders,
      children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: runs(big ? `${i + 1}  ${s}` : s, { size: big ? 30 : 16, bold: true, color: big || i === 0 ? "FFFFFF" : INK, characterSpacing: big ? 40 : 0 }) })],
    }));
    if (i < n - 1) {
      widths.push(arrow);
      cells.push(new TableCell({
        width: { size: arrow, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER, borders: noBorders,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [body("→", { size: big ? 44 : 28, bold: true, color: P.sector(colour) })] })],
      }));
    }
  });
  const used = widths.reduce((a, b) => a + b, 0);
  widths[widths.length - 1] += W - used;
  return new Table({ columnWidths: widths, width: { size: W, type: WidthType.DXA }, borders: noBorders, rows: [new TableRow({ children: cells })] });
}

/**
 * FAULTS & REPAIRS (pages 7 and 8): one card per procedure. The code is the
 * biggest thing on the page because finding it is the job; the three things a
 * team must stage, fetch and type sit on fixed cells underneath.
 */
const CARD_W = [3000, 3000, 3026];
function faultCardBlock(c, colour) {
  const hot = P.mono && c.time_critical;            // B&W: the urgency is a black header, not a red word
  const headFill = hot ? "000000" : tint(colour, 0.78);
  const headInk = hot ? "FFFFFF" : INK;
  const codeInk = hot ? "FFFFFF" : P.sector(colour);
  const frame = P.sector(colour);
  const frameSize = hot ? 24 : 12;
  const labelled = (label, value, { monoValue = false, size = 20, extra = [] } = {}) => new TableCell({
    width: { size: CARD_W[0], type: WidthType.DXA }, verticalAlign: VerticalAlign.TOP,
    // Tightened 2026-10-06 so that page 8 still holds five cards once two of them carry a third value and an ENTER line.
    margins: { top: 25, bottom: 30, left: 110, right: 90 },
    children: [
      new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: label, font: "Arial", size: 13, bold: true, color: MUTED, characterSpacing: 60 })] }),
      new Paragraph({ spacing: { after: 0 }, children: monoValue ? [mono(value, { bold: true, size })] : runs(value, { bold: true, size }) }),
      ...extra,
    ],
  });
  const valueCell = (label, text) => {
    if (!text) return labelled(label, "—", { size: 18 });
    const [first, ...rest] = String(text).split("\n");
    return labelled(label, first, { size: 19, extra: rest.map((l) => new Paragraph({ spacing: { before: 20, after: 0 }, children: runs(l, { size: 15, italics: true, color: AMBER }) })) });
  };
  const head = new TableRow({ cantSplit: true, children: [
    new TableCell({
      width: { size: CARD_W[0], type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
      shading: { type: ShadingType.CLEAR, fill: headFill, color: "auto" },
      margins: { top: 20, bottom: 20, left: 110, right: 90 },
      children: [new Paragraph({ spacing: { after: 0 }, children: [mono(c.code, { bold: true, size: 36, color: codeInk })] })],
    }),
    new TableCell({
      width: { size: CARD_W[1] + CARD_W[2], type: WidthType.DXA }, columnSpan: 2, verticalAlign: VerticalAlign.CENTER,
      shading: { type: ShadingType.CLEAR, fill: headFill, color: "auto" },
      margins: { top: 20, bottom: 20, left: 110, right: 90 },
      children: [new Paragraph({ spacing: { after: 0 }, children: [
        body(c.name, { bold: true, size: 22, color: headInk }),
        ...(c.time_critical ? runs("   ⚠ TIME-CRITICAL", { bold: true, size: 20, color: hot ? "FFFFFF" : WARN_RED }) : []),
      ] })],
    }),
  ] });
  const facts = new TableRow({ cantSplit: true, children: [
    labelled("PROCEDURE", c.proc, { monoValue: true, size: 22 }),
    labelled("CREW", c.crew),
    labelled("MATERIALS", c.materials),
  ] });
  // Two values share their row with ENTER. Three (every sector's P-08 and
  // P-09, 2026-10-06) fill the row, and ENTER takes one line of its own under
  // them — label and format side by side, so the card grows by a line and not
  // a cell — and reads VALUE 1 → 2 → 3 → the code, the order it is built in.
  const enterLine = (format) => new TableCell({
    width: { size: W, type: WidthType.DXA }, columnSpan: 3, verticalAlign: VerticalAlign.CENTER,
    margins: { top: 20, bottom: 25, left: 110, right: 90 },
    children: [new Paragraph({ spacing: { after: 0 }, children: [
      new TextRun({ text: "ENTER    ", font: "Arial", size: 13, bold: true, color: MUTED, characterSpacing: 60 }),
      mono(format, { bold: true, size: 22 }),
    ] })],
  });
  const values = c.v3
    ? [
      new TableRow({ cantSplit: true, children: [valueCell("VALUE 1", c.v1), valueCell("VALUE 2", c.v2), valueCell("VALUE 3", c.v3)] }),
      new TableRow({ cantSplit: true, children: [enterLine(c.format)] }),
    ]
    : [new TableRow({ cantSplit: true, children: [
      valueCell("VALUE 1", c.v1),
      valueCell("VALUE 2", c.v2),
      labelled("ENTER", c.format, { monoValue: true, size: 22 }),
    ] })];
  return new Table({
    columnWidths: CARD_W, width: { size: W, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: frameSize, color: frame }, bottom: { style: BorderStyle.SINGLE, size: frameSize, color: frame },
      left: { style: BorderStyle.SINGLE, size: frameSize, color: frame }, right: { style: BorderStyle.SINGLE, size: frameSize, color: frame },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: RULE }, insideVertical: { style: BorderStyle.SINGLE, size: 4, color: RULE },
    },
    rows: [head, facts, ...values],
  });
}

const KIND_STYLE = P.mono ? {
  value: { fill: "F2F2F2", cell: null, bar: "000000", head: "000000", text: "000000", border: BorderStyle.SINGLE, left: "ASSEMBLY", right: "RATED VALUE", tag: "VALUE" },
  reference: { fill: "D9D9D9", cell: "D9D9D9", bar: "000000", head: "000000", text: "000000", border: BorderStyle.DASHED, left: "REFERENCE NAME", right: "REFERENCE — NOT A VALUE", tag: "REFERENCE" },
  authorisation: { fill: "000000", cell: "E6E6E6", bar: "000000", head: "FFFFFF", text: "000000", border: BorderStyle.DOUBLE, left: "AUTHORISATION", right: "VALUE", tag: "AUTHORISATION" },
} : {
  value: { fill: P.fill.light, cell: null, bar: INK, head: INK, text: INK, border: BorderStyle.SINGLE, left: "ASSEMBLY", right: "RATED VALUE", tag: "VALUE" },
  reference: { fill: P.fill.reference, cell: P.fill.reference, bar: AMBER, head: AMBER, text: AMBER, border: BorderStyle.SINGLE, left: "REFERENCE NAME", right: "REFERENCE — NOT A VALUE", tag: "REFERENCE" },
  authorisation: { fill: P.fill.warning, cell: P.fill.warning, bar: WARN_RED, head: WARN_RED, text: WARN_RED, border: BorderStyle.SINGLE, left: "AUTHORISATION", right: "VALUE", tag: "AUTHORISATION" },
};
// B&W: the frame of a page-9 table says what kind it is (solid, dashed, double). Colour keeps its thin rules.
const kindBorders = (st) => (P.mono ? {
  top: { style: st.border, size: 6, color: st.bar }, bottom: { style: st.border, size: 6, color: st.bar },
  left: { style: st.border, size: 6, color: st.bar }, right: { style: st.border, size: 6, color: st.bar },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: RULE }, insideVertical: { style: BorderStyle.SINGLE, size: 4, color: RULE },
} : thinBorders);

/** Three chips: what a VALUE, a REFERENCE and an AUTHORISATION are (page 9). */
function legendBlock(items) {
  const w = Math.floor(W / items.length);
  const widths = items.map((_, i) => (i === items.length - 1 ? W - w * (items.length - 1) : w));
  return new Table({
    columnWidths: widths, width: { size: W, type: WidthType.DXA }, borders: noBorders,
    rows: [new TableRow({ children: items.map(([tag, text, kind], i) => {
      const st = KIND_STYLE[kind];
      return new TableCell({
        width: { size: widths[i], type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: st.fill, color: "auto" },
        borders: { top: { style: BorderStyle.SINGLE, size: 24, color: st.bar }, bottom: { style: st.border, size: 4, color: P.mono ? st.bar : RULE }, left: { style: st.border, size: 4, color: P.mono ? st.bar : RULE }, right: { style: st.border, size: 4, color: P.mono ? st.bar : RULE } },
        margins: { top: 80, bottom: 80, left: 110, right: 90 },
        children: [
          new Paragraph({ spacing: { after: 30 }, children: [new TextRun({ text: tag, font: "Arial", size: 20, bold: true, color: st.head, characterSpacing: 40 })] }),
          new Paragraph({ spacing: { after: 0 }, children: [body(text, { size: 17, color: P.mono ? st.head : INK })] }),
        ],
      });
    }) })],
  });
}

/** A specification table, the reference directory or the appendix row (page 9), styled by kind. */
function specTableBlock(blk, colour) {
  const st = KIND_STYLE[blk.kind || "value"];
  const LEFT = 5400;
  const rows = [new TableRow({ tableHeader: true, children: [
    cell(st.left, { width: LEFT, shade: st.fill, bold: true, size: 15, color: P.mono ? st.head : undefined }),
    cell(st.right, { width: W - LEFT, shade: st.fill, bold: true, size: 15, align: AlignmentType.CENTER, color: st.head }),
  ] })];
  for (const [label, value] of blk.rows) {
    rows.push(new TableRow({ cantSplit: true, children: [
      cell(label, { width: LEFT, size: 19, margins: { top: 80, bottom: 80, left: 100, right: 100 } }),
      new TableCell({
        width: { size: W - LEFT, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
        shading: st.cell ? { type: ShadingType.CLEAR, fill: st.cell, color: "auto" } : undefined,
        margins: { top: 80, bottom: 80, left: 100, right: 100 },
        children: [new Paragraph({ spacing: { after: 0 }, alignment: AlignmentType.CENTER, children: [mono(value, { bold: true, size: blk.kind === "value" ? 24 : 20, color: st.text })] })],
      }),
    ] }));
  }
  return [
    new Paragraph({
      spacing: { before: 160, after: 60 },
      border: { left: { style: BorderStyle.SINGLE, size: 24, color: st.bar } }, indent: { left: 120 },
      children: [
        new TextRun({ text: `${st.tag}  `, font: "Arial", size: 13, bold: true, color: st.bar, characterSpacing: 80 }),
        new TextRun({ text: blk.id === "REFERENCES" || blk.id === "APPENDIX C" ? blk.id : `TABLE ${blk.id}`, font: "Courier New", size: 20, bold: true, color: P.sector(colour) }),
        new TextRun({ text: `   ${blk.name}`, font: "Arial", size: 18, bold: true, color: INK }),
      ],
    }),
    table(rows, [LEFT, W - LEFT], kindBorders(st)),
  ];
}

/** One content block -> DOCX paragraphs/tables. */
function renderBlock(blk, b) {
  const f = (t) => fill(t, b);
  switch (blk.t) {
    case "p": return [new Paragraph({
      spacing: { after: blk.small ? 90 : 120 },
      children: runs(f(blk.text), blk.muted ? { size: 16, italics: true, color: MUTED } : blk.lore ? { italics: true, color: P.LORE } : blk.small ? { size: 18 } : {}),
    })];
    case "h": return [headingBlock(f(blk.text), b.colour)];
    case "steps": return stepsBlock(blk.items.map(f), blk);
    case "table": return [tableBlock(blk.head.map(f), blk.rows.map((r) => r.map(f)), blk.widths, blk), gap(100)];
    case "kv": return [kvBlock(blk.rows.map(([k, v]) => [f(k), f(v)]), blk), gap(100)];
    case "box": return [boxBlock(blk.kind, f(blk.title), blk.lines.map(f), b.colour), gap(120)];
    case "flow": return [flowBlock(blk.steps.map(f), b.colour, blk), gap(120)];
    case "faultcards": return blk.cards.flatMap((c) => [faultCardBlock(c, b.colour), gap(24)]);
    case "legend": return [legendBlock(blk.items), gap(80)];
    case "spectable": return specTableBlock(blk, b.colour);
    case "gap": return [gap(blk.n)];
    default: throw new Error(`build_binders: unknown block ${blk.t}`);
  }
}

// ---------------------------------------------------------------- assemble

/** The nine pages: no cover, no contents, every page titled and numbered. */
function buildBinder(b) {
  const pages = compact.compactFor(b);
  const children = [];
  pages.forEach((pg, i) => {
    if (i > 0) children.push(pageStart());
    children.push(...pageHead(pg.num, fill(pg.title, b), b.colour, `${b.code} ${pg.num}/${pages.length}`));
    for (const blk of pg.blocks) children.push(...renderBlock(blk, b));
    // the spacing after a page's last table would be a paragraph that can spill onto a blank leaf
    while (children.length && children[children.length - 1].__gap) children.pop();
  });
  const plan = pages.map((pg) => ({ id: `p${pg.num}`, num: pg.num, title: fill(pg.title, b), page: pg.num, pages: 1 }));
  return {
    children, plan,
    header: `HAVEN-9 · ${b.code} ${b.name.toUpperCase()} · TECHNICAL OPERATIONS BINDER · KEEP AT STATION`,
    footer: ["Page ", PageNumber.CURRENT, ` of ${pages.length}  ·  Each round p.2  ·  Your panel p.3  ·  Faults p.4 then p.7–8  ·  Trades p.5  ·  Quick actions p.6  ·  Values p.9`],
  };
}

const docOf = ({ children, header, footer }) => new Document({
  styles: { default: { document: { run: { font: "Arial", size: 20, color: INK } } } },
  sections: [{
    properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
    headers: { default: new Header({ children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE } },
      children: [new TextRun({ text: header, font: "Arial", size: 14, color: MUTED })],
    })]}) },
    footers: footer ? { default: new Footer({ children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ children: footer, font: "Arial", size: 14, color: MUTED })],
    })]}) } : undefined,
    children,
  }],
});

/** The Station Operations Log as a loose sheet, one page per sector, printed as needed. */
function stationLog(binders) {
  const children = [];
  binders.forEach((b, i) => {
    if (i > 0) children.push(pageStart());
    children.push(...pageHead("", "STATION OPERATIONS LOG", b.colour, b.code));
    children.push(p(body("Loose sheet. Keep it current: it is the sector's record of what was decided and who agreed to it, and the Council may call for it at any time. Ask for a fresh sheet when it is full.")));
    const rows = [new TableRow({ children: [
      cell("TIME", { width: 1200, shade: "F2F2F2", bold: true }),
      cell("EVENT / FAULT", { width: 2600, shade: "F2F2F2", bold: true }),
      cell("DECISION TAKEN", { width: 3200, shade: "F2F2F2", bold: true }),
      cell("WHO AGREED", { width: W - 7000, shade: "F2F2F2", bold: true }),
    ] })];
    for (let n = 0; n < 18; n += 1) {
      rows.push(new TableRow({ children: [cell("", { width: 1200 }), cell("", { width: 2600 }), cell("", { width: 3200 }), cell("", { width: W - 7000 })] }));
    }
    children.push(table(rows, [1200, 2600, 3200, W - 7000]));
  });
  return { children, header: "HAVEN-9 · STATION OPERATIONS LOG · LOOSE SHEET", footer: null };
}

fs.mkdirSync(OUTDIR, { recursive: true });
const plans = {};
const codes = Object.keys(data.binders).filter((c) => !ONLY.length || ONLY.includes(c));

for (const code of codes) {
  const b = data.binders[code];
  const built = buildBinder(b);
  plans[code] = built.plan;
  const file = path.join(OUTDIR, P.out(`UNDERCITY_Binder_${b.code}.docx`));
  Packer.toBuffer(docOf(built)).then((buf) => {
    fs.writeFileSync(file, buf);
    console.log("✓", file, `(${built.plan.length} pages)`);
  });
}

const logFile = path.join(OUTDIR, P.out("UNDERCITY_StationLog.docx"));
Packer.toBuffer(docOf(stationLog(codes.map((c) => data.binders[c])))).then((buf) => {
  fs.writeFileSync(logFile, buf);
  console.log("✓", logFile, `(${codes.length} loose sheets)`);
});

// The plan each binder was laid out to, beside binder_content.json: the page
// check (tools/kit/check_binder_pages.py) reads it back and compares.
fs.writeFileSync(path.join(path.dirname(SRC), P.mono ? "binder_pages.bw.json" : "binder_pages.json"), `${JSON.stringify(plans, null, 2)}\n`);
