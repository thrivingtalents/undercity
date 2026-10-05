'use strict';
/**
 * UNDERCITY — the print palette, in colour or in black and white.
 *
 * B&W KIT (2026-10-05). Every kit generator asks this module for its colours
 * instead of naming them. In colour mode the answers are the colours the kit
 * has always printed. With `--mono` on the command line (or
 * UNDERCITY_PRINT_MODE=bw) the answers are black, white and neutral greys, the
 * resource glyphs are set in Segoe UI Symbol (which Word renders in
 * monochrome; Arial and Segoe UI fall back to the colour emoji font), and
 * output names gain a _BW suffix so the two kits coexist.
 *
 * This is not desaturation: a generator that needs a border weight, a
 * pattern or a black heading strip where colour used to carry the meaning
 * asks `P.mono` and draws the monochrome treatment itself.
 */

// The glyphs the kit prints inside running text. Word renders these from the
// colour emoji font unless the run names a monochrome font that has them.
const GLYPHS = /([⚡💧🔧⚕👤⚠🎙])/u;

/** A light tint of a colour: `amount` of the way to white. */
function mixWhite(hex, amount) {
  const n = parseInt(hex, 16);
  const mix = (c) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0');
  return `${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`.toUpperCase();
}

const COLOUR = {
  mono: false,
  suffix: '',
  INK: '1A1A1A', MUTED: '6B6B6B', RULE: 'BFBFBF', DASH: 'AAAAAA',
  WARN: 'B00000', AMBER: '8A5A00', GREEN: '2E7D32', NAVY: '1F3864', LORE: '3A3A3A', WHITE: 'FFFFFF',
  fill: { light: 'F2F2F2', faint: 'F7F7F7', warning: 'FBE9E7', newround: 'FFF4D6', reference: 'FFF6E5', stamp: 'FFF2CC', head: '1F3864', script: 'F4F4F4' },
  sector: (hex) => hex,
  tint: (hex, amount = 0.85) => mixWhite(hex, amount),
  callout: (fill, edge) => ({ fill, edge, label: edge === 'E8A33A' ? '8A5A00' : edge }),
  glyphFont: null,
};

const MONO = {
  mono: true,
  suffix: '_BW',
  // ink is true black; rules and dashes are medium grey so a photocopy keeps them
  INK: '000000', MUTED: '555555', RULE: '808080', DASH: '808080',
  WARN: '000000', AMBER: '333333', GREEN: '000000', NAVY: '000000', LORE: '333333', WHITE: 'FFFFFF',
  fill: { light: 'F2F2F2', faint: 'F7F7F7', warning: 'E6E6E6', newround: 'F2F2F2', reference: 'D9D9D9', stamp: 'FFFFFF', head: '000000', script: 'F2F2F2' },
  sector: () => '000000',
  // a tint of a sector colour becomes a grey of the same lightness band
  tint: (hex, amount = 0.85) => (amount >= 0.85 ? 'F2F2F2' : amount >= 0.78 ? 'E6E6E6' : 'D9D9D9'),
  callout: () => ({ fill: 'F2F2F2', edge: '000000', label: '000000' }),
  glyphFont: 'Segoe UI Symbol',
};

/**
 * Pick the palette from the command line. `--mono` is removed from argv so
 * the generators' positional arguments keep their places.
 */
function from(argv) {
  const i = argv.indexOf('--mono');
  if (i >= 0) argv.splice(i, 1);
  const mono = i >= 0 || process.env.UNDERCITY_PRINT_MODE === 'bw';
  const P = { ...(mono ? MONO : COLOUR) };
  /** The output file name for this mode: UNDERCITY_X.docx → UNDERCITY_X_BW.docx. */
  P.out = (name) => (P.suffix ? name.replace(/(\.[a-z]+)$/i, `${P.suffix}$1`) : name);
  /** Text split into runs: the glyphs apart, so a monochrome font can carry them. */
  P.splitGlyphs = (text) => {
    if (!P.glyphFont) return [{ text: String(text), glyph: false }];
    return String(text).split(GLYPHS).filter((s) => s.length).map((s) => ({ text: s, glyph: GLYPHS.test(s) }));
  };
  return P;
}

module.exports = { from, GLYPHS, mixWhite };
