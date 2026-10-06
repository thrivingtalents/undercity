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
//
// FIELD MANUAL EDITION (2026-10-06). The same nine pages as a clean
// operations manual: wider margins, one body size, headings that are bold
// words rather than coloured capitals, thin rules where there used to be
// filled panels, and a box only where the brief allows one — an important
// action, a critical warning, a table, a time-critical card. The sector
// colour is an accent: the page number, a heading's thin rule, a step
// number, an arrow, a fault code. Nothing a participant reads is set in a
// coloured block, and nothing here changes a word the pages say.

const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType, BorderStyle,
  Header, Footer, PageNumber, VerticalAlign, TabStopType,
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

// ---------------------------------------------------------------- the system

/** Page geometry: 2.8 cm at the sides, 2.6 cm above, 2.3 cm below (A4). */
const MARGIN = { top: 1380, bottom: 1200, left: 1560, right: 1560 };
const W = 11906 - MARGIN.left - MARGIN.right;   // the content width in DXA
const { INK, MUTED, RULE, WARN: WARN_RED, AMBER } = P;
const tint = P.tint;

/** One body size, one small size, one label size, and the page title the page check reads at 15 pt. */
const SIZE = { body: 20, small: 18, label: 14, h2: 22, title: 30, num: 36, code: 26 };
/** Line spacing for running text: a little air, never a stretch. */
const LINE = 252;

const noBorders = {
  top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
  left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
  insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
};
const hairline = { style: BorderStyle.SINGLE, size: 4, color: RULE };
/** A table drawn with thin horizontal dividers only: no outer frame, no vertical lines. */
const dividers = {
  top: { style: BorderStyle.NONE }, bottom: hairline, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
  insideHorizontal: hairline, insideVertical: { style: BorderStyle.NONE },
};
const thinBorders = {
  top: hairline, bottom: hairline, left: hairline, right: hairline, insideHorizontal: hairline, insideVertical: hairline,
};

const mono = (text, opts = {}) =>
  new TextRun({ text, font: "Courier New", size: SIZE.body, color: INK, ...opts });
const body = (text, opts = {}) =>
  new TextRun({ text, font: "Arial", size: SIZE.body, color: INK, ...opts });

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
    else if (part.startsWith("`") && part.endsWith("`")) out.push(mono(part.slice(1, -1), { ...opts, size: opts.size || SIZE.body }));
    else out.push(...plain(part, opts));
  }
  return out;
}

/**
 * A step that opens with its verb in capitals (TAKE the Role Cards …) gets
 * that verb in bold, so the eye finds the action first. A step that already
 * opens with bold text is left to its own emphasis.
 */
function stepRuns(text, opts = {}) {
  const s = String(text);
  const m = /^([A-Z][A-Z]{2,}(?: [A-Z][A-Z]{2,})?)(?=[ ,.:;])/.exec(s);
  if (!m || s.startsWith("**")) return runs(s, opts);
  return [...runs(`**${m[1]}**`, opts), ...runs(s.slice(m[1].length), opts)];
}

const para = (children, { after = 120, before = 0, line = LINE, keepNext = false, keepLines = false, indent, alignment, border, tabStops } = {}) =>
  new Paragraph({ children: Array.isArray(children) ? children : [children], spacing: { before, after, line, lineRule: "auto" }, keepNext, keepLines, indent, alignment, border, tabStops });

/**
 * A page starts here. Not a PageBreak run: a paragraph that cannot fit on a
 * page that is already full would carry its break onto the next page and
 * leave that page empty. "Page break before" on an empty 1 pt paragraph can
 * only ever start the page it is on, so no section can print a blank leaf.
 */
const pageStart = () => new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: 20 }, children: [new TextRun({ text: "", size: 2 })] });
/** Spacing after a block. It knows it is a gap, so a page never ends on one. */
const gap = (after = 120) => Object.assign(new Paragraph({ text: "", spacing: { after } }), { __gap: true });
/** A thin rule across the page, as a paragraph border: it separates, it frames nothing. */
const rule = (color = RULE, { before = 40, after = 120, size = 4 } = {}) =>
  Object.assign(new Paragraph({ spacing: { before, after, line: 20 }, border: { bottom: { style: BorderStyle.SINGLE, size, color } }, children: [new TextRun({ text: "", size: 2 })] }), { __gap: true });

function cell(children, { width, shade, bold, align, mono: isMono, size, color, margins, borders, span } = {}) {
  const list = (Array.isArray(children) ? children : [children]).flatMap((t) =>
    typeof t === "string" ? (isMono || t === "" ? [(isMono ? mono : body)(t, { bold, size, color })] : runs(t, { bold, size, color })) : [t]);
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlign.TOP,
    columnSpan: span,
    shading: shade ? { type: ShadingType.CLEAR, fill: shade, color: "auto" } : undefined,
    margins: margins || { top: 70, bottom: 70, left: 90, right: 90 },
    borders,
    children: [new Paragraph({ spacing: { after: 0, line: LINE, lineRule: "auto" }, alignment: align, children: list })],
  });
}

/** Column widths the pages declare are proportions: fitted to the content width, the last column takes the rounding. */
function fit(widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  const out = widths.map((w) => Math.floor((w * W) / total));
  out[out.length - 1] += W - out.reduce((a, b) => a + b, 0);
  return out;
}

function table(rows, widths, borders = dividers) {
  return new Table({ columnWidths: widths, width: { size: W, type: WidthType.DXA }, borders, rows });
}

// ---------------------------------------------------------------- page furniture

/** The page head: the number in the sector colour, the title in black, a small grey tab at the right, one thin rule under both. */
function pageHead(num, title, colour, tab) {
  const under = { bottom: { style: BorderStyle.SINGLE, size: 8, color: P.sector(colour) } };
  const left = new TableCell({
    width: { size: W - 1500, type: WidthType.DXA }, verticalAlign: VerticalAlign.BOTTOM,
    borders: under, margins: { top: 0, bottom: 90, left: 0, right: 100 },
    children: [new Paragraph({
      spacing: { after: 0 },
      children: [
        ...(num === "" ? [] : [new TextRun({ text: `${num}   `, font: "Arial", size: SIZE.num, bold: true, color: P.sector(colour) })]),
        new TextRun({ text: title, font: "Arial", size: SIZE.title, bold: true, color: INK }),
      ],
    })],
  });
  const right = new TableCell({
    width: { size: 1500, type: WidthType.DXA }, verticalAlign: VerticalAlign.BOTTOM,
    borders: under, margins: { top: 0, bottom: 100, left: 100, right: 0 },
    children: [new Paragraph({
      alignment: AlignmentType.RIGHT, spacing: { after: 0 },
      children: [new TextRun({ text: tab, font: "Arial", size: 15, color: MUTED, characterSpacing: 20 })],
    })],
  });
  return [
    new Table({ columnWidths: [W - 1500, 1500], width: { size: W, type: WidthType.DXA }, borders: noBorders, rows: [new TableRow({ children: [left, right] })] }),
    gap(100),
  ];
}

/** The one-line purpose under a page title. */
function leadBlock(text) {
  return para(runs(text, { size: 19, italics: true, color: MUTED }), { after: 160 });
}

/** A section heading: bold words in black, a short thin rule in the sector colour at its left. */
function headingBlock(text, colour) {
  return para(runs(text, { size: SIZE.h2, bold: true }), {
    before: 200, after: 70, keepNext: true, indent: { left: 140 },
    border: { left: { style: BorderStyle.SINGLE, size: 14, color: P.sector(colour), space: 6 } },
  });
}

/** Numbered steps: the number in the sector colour, the verb in bold, air between them. */
function stepsBlock(items, colour, { start = 1, tight = false } = {}) {
  return items.map((text, i) => para(
    [new TextRun({ text: `${i + start}`, font: "Arial", size: SIZE.body, bold: true, color: P.sector(colour) }), new TextRun({ text: "\t", font: "Arial", size: SIZE.body }), ...stepRuns(text)],
    { after: tight ? 60 : 100, indent: { left: 440, hanging: 440 }, tabStops: [{ type: TabStopType.LEFT, position: 440 }], keepLines: true },
  ));
}

/** Bulleted lines: a small grey dash, hanging indent. */
function listBlock(items, { tight = false, small = false } = {}) {
  return items.map((text) => para(
    [new TextRun({ text: "–", font: "Arial", size: small ? SIZE.small : SIZE.body, color: MUTED }), new TextRun({ text: "\t", font: "Arial", size: SIZE.body }), ...runs(text, small ? { size: SIZE.small } : {})],
    { after: tight ? 40 : 70, indent: { left: 300, hanging: 300 }, tabStops: [{ type: TabStopType.LEFT, position: 300 }], keepLines: true },
  ));
}

/** A table with bold headers over a black rule, thin dividers between rows, no fills and no frame. */
function tableBlock(head, rows, declared, { small = false, boldFirst = false, dense = false } = {}) {
  const widths = fit(declared);
  // dense: the one long reference table (AGR's deck) sits a size smaller with less padding, so its page stays one page
  const size = dense ? 17 : small ? SIZE.small : SIZE.body;
  const pad = dense ? 40 : 60;
  const headRule = { bottom: { style: BorderStyle.SINGLE, size: 8, color: INK } };
  const out = [new TableRow({ tableHeader: true, children: head.map((h, i) => cell(h, { width: widths[i], bold: true, size: 17, borders: headRule, margins: { top: 40, bottom: 60, left: 80, right: 80 } })) })];
  for (const r of rows) {
    out.push(new TableRow({ cantSplit: true, children: r.map((c, i) => new TableCell({
      width: { size: widths[i], type: WidthType.DXA },
      verticalAlign: VerticalAlign.TOP,
      margins: { top: pad, bottom: pad, left: 80, right: 80 },
      children: [new Paragraph({ spacing: { after: 0, line: LINE, lineRule: "auto" }, children: runs(c, { size, bold: boldFirst && i === 0 }) })],
    })) }));
  }
  return table(out, widths);
}

/** Label and text, two columns, thin dividers, nothing filled. */
function kvBlock(rows, { keyWidth = 2600 } = {}) {
  return table(rows.map(([k, v]) => new TableRow({ cantSplit: true, children: [
    cell(k, { width: keyWidth, bold: true, size: SIZE.small, margins: { top: 60, bottom: 60, left: 0, right: 100 } }),
    new TableCell({
      width: { size: W - keyWidth, type: WidthType.DXA }, verticalAlign: VerticalAlign.TOP,
      margins: { top: 60, bottom: 60, left: 100, right: 60 },
      children: [new Paragraph({ spacing: { after: 0, line: LINE, lineRule: "auto" }, children: runs(v, { size: 19 }) })],
    }),
  ] })), [keyWidth, W - keyWidth]);
}

/**
 * The one kind of box left: a thin rule at the left in the kind's colour, a
 * small label, a bold title, plain lines. An important action is ruled in
 * the sector colour; a critical warning in red, on the faintest tint. No
 * frame, no fill otherwise, and no box inside it.
 */
const BOX_STYLE = {
  ACTION: (colour) => ({ bar: P.sector(colour), label: "ACTION", fill: null }),
  WARNING: () => ({ bar: WARN_RED, label: "WARNING", fill: P.fill.warning }),
  REMEMBER: () => ({ bar: MUTED, label: "REMEMBER", fill: null }),
  NEWROUND: () => ({ bar: AMBER, label: "NEW ROUND", fill: null }),
};

function boxBlock(kind, title, lines, colour) {
  const st = (BOX_STYLE[kind] || BOX_STYLE.REMEMBER)(colour);
  const paras = [
    para([
      new TextRun({ text: `${st.label}  `, font: "Arial", size: SIZE.label, bold: true, color: st.bar, characterSpacing: 40 }),
      ...runs(title, { size: SIZE.h2, bold: true }),
    ], { after: 70, keepNext: true }),
    ...lines.map((line, i) => para(runs(line), { after: i === lines.length - 1 ? 0 : 70 })),
  ];
  return new Table({
    columnWidths: [W], width: { size: W, type: WidthType.DXA },
    borders: { ...noBorders, left: { style: BorderStyle.SINGLE, size: 18, color: st.bar } },
    rows: [new TableRow({ cantSplit: true, children: [new TableCell({
      width: { size: W, type: WidthType.DXA },
      shading: st.fill ? { type: ShadingType.CLEAR, fill: st.fill, color: "auto" } : undefined,
      margins: { top: 70, bottom: 70, left: 200, right: 140 },
      children: paras,
    })] })],
  });
}

/** One highlighted strip, one line: the lightest tint of the sector colour behind bold text. */
function stripBlock(text, colour) {
  return new Table({
    columnWidths: [W], width: { size: W, type: WidthType.DXA }, borders: noBorders,
    rows: [new TableRow({ cantSplit: true, children: [new TableCell({
      width: { size: W, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: P.mono ? "F2F2F2" : tint(colour, 0.9), color: "auto" },
      margins: { top: 60, bottom: 60, left: 160, right: 160 },
      children: [new Paragraph({ spacing: { after: 0 }, children: runs(text, { bold: true }) })],
    })] })],
  });
}

/**
 * A sequence read left to right: numbers in the sector colour, labels in
 * black, thin arrows between — nothing filled. `big` is the three actions a
 * repair comes down to, set large, each on a short rule.
 */
function flowBlock(steps, colour, { big = false } = {}) {
  const n = steps.length;
  const arrow = big ? 560 : 360;
  const stepW = Math.floor((W - arrow * (n - 1)) / n);
  const widths = [];
  const cells = [];
  steps.forEach((s, i) => {
    widths.push(stepW);
    cells.push(new TableCell({
      width: { size: stepW, type: WidthType.DXA }, verticalAlign: VerticalAlign.TOP,
      margins: { top: 40, bottom: big ? 80 : 40, left: 20, right: 40 },
      borders: big ? { bottom: { style: BorderStyle.SINGLE, size: 8, color: P.sector(colour) } } : undefined,
      children: [new Paragraph({ alignment: big ? AlignmentType.CENTER : AlignmentType.LEFT, spacing: { after: 0, line: LINE, lineRule: "auto" }, children: [
        new TextRun({ text: `${i + 1}  `, font: "Arial", size: big ? 34 : 24, bold: true, color: P.sector(colour) }),
        ...runs(s, { size: big ? 28 : 17, bold: true }),
      ] })],
    }));
    if (i < n - 1) {
      widths.push(arrow);
      cells.push(new TableCell({
        width: { size: arrow, type: WidthType.DXA }, verticalAlign: big ? VerticalAlign.CENTER : VerticalAlign.TOP, borders: noBorders,
        margins: { top: big ? 0 : 50, bottom: 0, left: 0, right: 0 },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [body("→", { size: big ? 36 : 22, color: P.sector(colour) })] })],
      }));
    }
  });
  const used = widths.reduce((a, b) => a + b, 0);
  widths[widths.length - 1] += W - used;
  return new Table({ columnWidths: widths, width: { size: W, type: WidthType.DXA }, borders: noBorders, rows: [new TableRow({ cantSplit: true, children: cells })] });
}

/**
 * FAULTS & REPAIRS (pages 7 and 8): one card per procedure, without a frame.
 * The code is the biggest thing on the page because finding it is the job;
 * under it, on one line, the three things a team must stage, then each value
 * with where it comes from, then what to enter. A thin rule separates one
 * card from the next. A TIME-CRITICAL card carries one warning sign and a
 * small red word, and in black and white the word alone.
 */
const CARD_W = [2300, 2000, W - 4300];
function faultCardBlock(c, colour) {
  const label = (text) => new TextRun({ text, font: "Arial", size: 13, bold: true, color: MUTED, characterSpacing: 40 });
  const fact = (lab, value, { monoValue = false, width } = {}) => new TableCell({
    width: { size: width, type: WidthType.DXA }, verticalAlign: VerticalAlign.TOP, borders: noBorders,
    margins: { top: 20, bottom: 20, left: 0, right: 80 },
    children: [
      new Paragraph({ spacing: { after: 0 }, children: [label(lab)] }),
      new Paragraph({ spacing: { after: 0 }, children: monoValue ? [mono(value, { bold: true, size: 21 })] : runs(value, { bold: true, size: 19 }) }),
    ],
  });
  const valueLine = (lab, text) => {
    const [first, ...rest] = String(text || "—").split("\n");
    return [
      para([label(lab), new TextRun({ text: "\t", size: SIZE.body }), ...runs(first, { size: 19 })], { after: rest.length ? 0 : 30, indent: { left: 1000, hanging: 1000 }, tabStops: [{ type: TabStopType.LEFT, position: 1000 }], keepNext: true, keepLines: true }),
      ...rest.map((l) => para(runs(l, { size: 15, italics: true, color: AMBER }), { after: 30, indent: { left: 1000 }, keepNext: true })),
    ];
  };
  const head = para([
    mono(c.code, { bold: true, size: SIZE.code, color: P.sector(colour) }),
    body("   "),
    body(c.name, { bold: true, size: 21 }),
    ...(c.time_critical ? [body("   "), ...runs("⚠ TIME-CRITICAL", { bold: true, size: 16, color: WARN_RED })] : []),
  ], { after: 40, keepNext: true, keepLines: true });
  const facts = new Table({
    columnWidths: CARD_W, width: { size: W, type: WidthType.DXA }, borders: noBorders,
    rows: [new TableRow({ cantSplit: true, children: [
      fact("PROCEDURE", c.proc, { monoValue: true, width: CARD_W[0] }),
      fact("CREW", c.crew, { width: CARD_W[1] }),
      fact("MATERIALS", c.materials, { width: CARD_W[2] }),
    ] })],
  });
  const values = [
    ...valueLine("VALUE 1", c.v1),
    ...(c.v2 ? valueLine("VALUE 2", c.v2) : []),
    ...(c.v3 ? valueLine("VALUE 3", c.v3) : []),
  ];
  const enter = para([label("ENTER"), new TextRun({ text: "\t", size: SIZE.body }), mono(c.format, { bold: true, size: 21 })], { after: 0, indent: { left: 1000, hanging: 1000 }, tabStops: [{ type: TabStopType.LEFT, position: 1000 }], keepLines: true });
  return [head, facts, gap(20), ...values, enter, rule(RULE, { before: 70, after: 110 })];
}

const KIND_STYLE = P.mono ? {
  value: { bar: "000000", text: "000000", border: BorderStyle.SINGLE, left: "ASSEMBLY", right: "RATED VALUE", tag: "VALUE" },
  reference: { bar: "000000", text: "000000", border: BorderStyle.DASHED, left: "REFERENCE NAME", right: "REFERENCE — NOT A VALUE", tag: "REFERENCE" },
  authorisation: { bar: "000000", text: "000000", border: BorderStyle.DOUBLE, left: "AUTHORISATION", right: "VALUE", tag: "AUTHORISATION" },
} : {
  value: { bar: INK, text: INK, border: BorderStyle.SINGLE, left: "ASSEMBLY", right: "RATED VALUE", tag: "VALUE" },
  reference: { bar: AMBER, text: AMBER, border: BorderStyle.SINGLE, left: "REFERENCE NAME", right: "REFERENCE — NOT A VALUE", tag: "REFERENCE" },
  authorisation: { bar: WARN_RED, text: WARN_RED, border: BorderStyle.SINGLE, left: "AUTHORISATION", right: "VALUE", tag: "AUTHORISATION" },
};
// B&W: the frame of a page-9 table says what kind it is (solid, dashed, double). Colour keeps its thin dividers.
const kindBorders = (st) => (P.mono ? {
  top: { style: st.border, size: 6, color: st.bar }, bottom: { style: st.border, size: 6, color: st.bar },
  left: { style: st.border, size: 6, color: st.bar }, right: { style: st.border, size: 6, color: st.bar },
  insideHorizontal: hairline, insideVertical: { style: BorderStyle.NONE },
} : dividers);

/** What a VALUE, a REFERENCE and an AUTHORISATION are (page 9): three lines, the word in its colour. */
function legendBlock(items) {
  return items.map(([tag, text, kind]) => {
    const st = KIND_STYLE[kind];
    return para([
      new TextRun({ text: tag, font: "Arial", size: 19, bold: true, color: st.bar }),
      new TextRun({ text: "\t", size: SIZE.body }),
      ...runs(text, { size: SIZE.small }),
    ], { after: 50, indent: { left: 1900, hanging: 1900 }, tabStops: [{ type: TabStopType.LEFT, position: 1900 }] });
  });
}

/** A specification table, the reference directory or the appendix row (page 9), styled by kind. */
function specTableBlock(blk, colour) {
  const st = KIND_STYLE[blk.kind || "value"];
  const LEFT = 5200;
  const headRule = { bottom: { style: BorderStyle.SINGLE, size: 8, color: INK } };
  const rows = [new TableRow({ tableHeader: true, children: [
    cell(st.left, { width: LEFT, bold: true, size: 15, borders: headRule, margins: { top: 30, bottom: 50, left: 80, right: 80 } }),
    cell(st.right, { width: W - LEFT, bold: true, size: 15, align: AlignmentType.CENTER, color: st.bar, borders: headRule, margins: { top: 30, bottom: 50, left: 80, right: 80 } }),
  ] })];
  for (const [label, value] of blk.rows) {
    rows.push(new TableRow({ cantSplit: true, children: [
      cell(label, { width: LEFT, size: 19, margins: { top: 70, bottom: 70, left: 80, right: 80 } }),
      new TableCell({
        width: { size: W - LEFT, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
        margins: { top: 70, bottom: 70, left: 80, right: 80 },
        children: [new Paragraph({ spacing: { after: 0 }, alignment: AlignmentType.CENTER, children: [mono(value, { bold: true, size: blk.kind === "value" ? 24 : 20, color: st.text })] })],
      }),
    ] }));
  }
  return [
    para([
      new TextRun({ text: `${st.tag}  `, font: "Arial", size: SIZE.label, bold: true, color: st.bar, characterSpacing: 40 }),
      new TextRun({ text: blk.id === "REFERENCES" || blk.id === "APPENDIX C" ? blk.id : `TABLE ${blk.id}`, font: "Courier New", size: 20, bold: true, color: P.sector(colour) }),
      new TextRun({ text: `   ${blk.name}`, font: "Arial", size: SIZE.small, bold: true, color: INK }),
    ], { before: 200, after: 60, keepNext: true, indent: { left: 140 }, border: { left: { style: BorderStyle.SINGLE, size: 14, color: st.bar, space: 6 } } }),
    table(rows, [LEFT, W - LEFT], kindBorders(st)),
  ];
}

/** One content block -> DOCX paragraphs/tables. */
function renderBlock(blk, b) {
  const f = (t) => fill(t, b);
  switch (blk.t) {
    case "p": return [para(
      runs(f(blk.text), blk.muted ? { size: 16, italics: true, color: MUTED } : blk.lore ? { size: 19, italics: true, color: P.LORE } : blk.lead ? { size: 19, italics: true, color: MUTED } : blk.small ? { size: SIZE.small } : {}),
      { after: blk.small ? 80 : blk.lead ? 160 : 110 },
    )];
    case "h": return [headingBlock(f(blk.text), b.colour)];
    case "steps": return stepsBlock(blk.items.map(f), b.colour, blk);
    case "list": return listBlock(blk.items.map(f), blk);
    case "strip": return [stripBlock(f(blk.text), b.colour), gap(80)];
    case "table": return [tableBlock(blk.head.map(f), blk.rows.map((r) => r.map(f)), blk.widths, blk), gap(120)];
    case "kv": return [kvBlock(blk.rows.map(([k, v]) => [f(k), f(v)]), blk), gap(120)];
    case "box": return [boxBlock(blk.kind, f(blk.title), blk.lines.map(f), b.colour), gap(140)];
    case "flow": return [flowBlock(blk.steps.map(f), b.colour, blk), gap(blk.big ? 160 : 120)];
    case "faultcards": return blk.cards.flatMap((c) => faultCardBlock(c, b.colour));
    case "legend": return [...legendBlock(blk.items), gap(80)];
    case "spectable": return specTableBlock(blk, b.colour);
    case "rule": return [rule(RULE, { before: 60, after: 140 })];
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
    children.push(...pageHead(pg.num, fill(pg.title, b), b.colour, `${b.code}  ${pg.num} / ${pages.length}`));
    if (pg.lead) children.push(leadBlock(fill(pg.lead, b)));
    for (const blk of pg.blocks) children.push(...renderBlock(blk, b));
    // the spacing after a page's last table would be a paragraph that can spill onto a blank leaf
    while (children.length && children[children.length - 1].__gap) children.pop();
  });
  const plan = pages.map((pg) => ({ id: `p${pg.num}`, num: pg.num, title: fill(pg.title, b), page: pg.num, pages: 1 }));
  return {
    children, plan,
    header: `HAVEN-9 · ${b.code} ${b.name.toUpperCase()} · TECHNICAL OPERATIONS BINDER · KEEP AT STATION`,
    footer: ["Page ", PageNumber.CURRENT, ` of ${pages.length}     Each round p.2 · Sector control p.3 · Faults p.4 / p.7–8 · Trades p.5 · Quick actions p.6 · Values p.9`],
  };
}

const docOf = ({ children, header, footer }) => new Document({
  styles: { default: { document: { run: { font: "Arial", size: SIZE.body, color: INK } } } },
  sections: [{
    properties: { page: { margin: { top: MARGIN.top, bottom: MARGIN.bottom, left: MARGIN.left, right: MARGIN.right, header: 600, footer: 600 } } },
    headers: { default: new Header({ children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE } },
      children: [new TextRun({ text: header, font: "Arial", size: 13, color: MUTED })],
    })]}) },
    footers: footer ? { default: new Footer({ children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ children: footer, font: "Arial", size: 13, color: MUTED })],
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
    children.push(para(runs("Loose sheet. Keep it current: it is the sector's record of what was decided and who agreed to it, and the Council may call for it at any time. Ask for a fresh sheet when it is full."), { after: 160 }));
    const widths = [1200, 2500, 3100, W - 6800];
    const headRule = { bottom: { style: BorderStyle.SINGLE, size: 8, color: INK } };
    const rows = [new TableRow({ children: ["TIME", "EVENT / FAULT", "DECISION TAKEN", "WHO AGREED"].map((h, j) => cell(h, { width: widths[j], bold: true, size: 17, borders: headRule })) })];
    for (let n = 0; n < 18; n += 1) {
      rows.push(new TableRow({ children: widths.map((w) => cell("", { width: w, margins: { top: 150, bottom: 150, left: 90, right: 90 } })) }));
    }
    children.push(table(rows, widths));
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
