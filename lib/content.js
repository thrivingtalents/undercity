'use strict';
/**
 * THE CONTENT LOAD, in one place.
 *
 * content/faults.json and content/specs.json come out of the Excel pipeline
 * (tools/export_faults.py). Two generated decks join them at load:
 *   content/faults.reference-chain.json  tools/build_reference_chain_faults.js
 *   content/faults.late-shift.json       tools/build_late_shift_faults.js
 * Each reads a hand-edited structural source and resolves every three-digit
 * value from specs.json — so no generator ever disagrees with the workbook
 * about a specification value, because only the workbook owns any.
 *
 * The merge happens here rather than in a generator so that faults.json is
 * never written to by either build: it stays exactly what the workbook
 * exported, and the generated faults are separate files that join the list
 * at load. `meta.fault_count` is kept truthful by the merge, because
 * lib/validate.js checks it against the list it is handed.
 */
const fs = require('fs');
const path = require('path');

const FILES = {
  faults: 'faults.json',
  specs: 'specs.json',
  sectors: 'sectors.json',
};
const CHAIN_FILE = 'faults.reference-chain.json';
const LATE_FILE = 'faults.late-shift.json';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/**
 * Read the content directory into the shape the engine expects.
 *
 * The generated files are optional: a checkout that has not run a generator
 * still boots, with the thirty-six workbook faults and whatever else is
 * there. None is ever half-loaded — a malformed file throws rather than
 * silently dropping faults a facilitator is expecting to find in the library.
 */
function loadContent(dir) {
  const content = {};
  for (const [key, file] of Object.entries(FILES)) content[key] = readJson(path.join(dir, file));

  // Facilitator-side only, all of it. Nothing in lib/visibility.js projects a
  // reference chain, a section or a facilitator target to a sector or to the
  // wall; the admin console reads them over /api/content, which is
  // control-gated.
  const extra = [
    [CHAIN_FILE, (file) => { content.reference_directory = file.reference_directory; content.reference_chain_meta = file.meta; }],
    [LATE_FILE, (file) => { content.late_shift_meta = file.meta; }],
  ];
  for (const [name, keep] of extra) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    const file = readJson(p);
    const known = new Set(content.faults.faults.map((f) => f.code));
    const added = file.faults.filter((f) => !known.has(f.code));
    content.faults = {
      ...content.faults,
      meta: { ...content.faults.meta, fault_count: content.faults.faults.length + added.length },
      faults: [...content.faults.faults, ...added],
    };
    keep(file);
  }
  return content;
}

module.exports = { loadContent, FILES, CHAIN_FILE, LATE_FILE };
