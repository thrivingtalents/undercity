'use strict';
/**
 * THE CONTENT LOAD, in one place.
 *
 * content/faults.json and content/specs.json come out of the Excel pipeline
 * (tools/export_faults.py). content/faults.reference-chain.json comes out of
 * tools/build_reference_chain_faults.js, which reads a hand-edited structural
 * source and resolves every three-digit value from specs.json — so the two
 * generators never disagree about a specification value, because only one of
 * them owns any.
 *
 * The merge happens here rather than in either generator so that faults.json
 * is never written to by the reference-chain build: it stays exactly what the
 * workbook exported, and the twelve chain faults are a separate file that
 * joins the list at load. `meta.fault_count` is kept truthful by the merge,
 * because lib/validate.js checks it against the list it is handed.
 */
const fs = require('fs');
const path = require('path');

const FILES = {
  faults: 'faults.json',
  specs: 'specs.json',
  sectors: 'sectors.json',
};
const CHAIN_FILE = 'faults.reference-chain.json';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/**
 * Read the content directory into the shape the engine expects.
 *
 * The reference-chain file is optional: a checkout that has not run the
 * generator still boots, with the thirty-six workbook faults and nothing else.
 * It is never half-loaded — a malformed file throws rather than silently
 * dropping twelve faults a facilitator is expecting to find in the library.
 */
function loadContent(dir) {
  const content = {};
  for (const [key, file] of Object.entries(FILES)) content[key] = readJson(path.join(dir, file));

  const chainPath = path.join(dir, CHAIN_FILE);
  if (fs.existsSync(chainPath)) {
    const chain = readJson(chainPath);
    const known = new Set(content.faults.faults.map((f) => f.code));
    const added = chain.faults.filter((f) => !known.has(f.code));
    content.faults = {
      ...content.faults,
      meta: { ...content.faults.meta, fault_count: content.faults.faults.length + added.length },
      faults: [...content.faults.faults, ...added],
    };
    // Facilitator-side only. Nothing in lib/visibility.js projects this to a
    // sector or to the wall; the admin console reads it over /api/content,
    // which is control-gated.
    content.reference_directory = chain.reference_directory;
    content.reference_chain_meta = chain.meta;
  }
  return content;
}

module.exports = { loadContent, FILES, CHAIN_FILE };
