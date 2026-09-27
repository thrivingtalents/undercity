#!/usr/bin/env node
'use strict';
/**
 * Records what produced the paper kit.
 *
 * The whole design rests on paper and server deriving from the same cells. The
 * admin panel should not have to take that on trust, so this writes down the
 * fingerprints of the matrix and of each content file at the moment the
 * documents were generated. The server compares those against the content it
 * is actually running and can then say, rather than assume, that the printed
 * kit matches the game.
 *
 *   node tools/kit/manifest.js [kitDir] [matrix] [contentDir]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KIT = process.argv[2] || 'kit';
const MATRIX = process.argv[3] || path.join('tools', 'undercity-crossref-matrix.xlsx');
const CONTENT = process.argv[4] || 'content';

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// Which documents may sit on a participant table, and which must never.
// A binder is facilitator-issued: it holds that sector's own spec values, and
// the answer key holds every resolution code in the game.
const FACILITATOR_ONLY = new Set([
  'UNDERCITY_AnswerKey.docx',
  'UNDERCITY_Binder_POW.docx',
  'UNDERCITY_Binder_WTR.docx',
  'UNDERCITY_Binder_MED.docx',
  'UNDERCITY_Binder_TRN.docx',
  'UNDERCITY_Binder_AGR.docx',
  'UNDERCITY_Binder_COM.docx',
  'UNDERCITY_Facilitator_Guidebook.docx',
]);

const TITLES = {
  'UNDERCITY_FaultCards.docx': 'Fault card deck — 36 cards, 4-up on A4',
  'UNDERCITY_CityCharter.docx': 'City Charter + Continuity Order ballot',
  'UNDERCITY_RoleCards.docx': 'Role cards — one per participant',
  'UNDERCITY_TransferChits.docx': 'Transfer chits',
  'UNDERCITY_ConsentPack_TableTents.docx': 'PDPA consent pack + table tents',
  'UNDERCITY_AnswerKey.docx': 'Answer key — every resolution code',
  'UNDERCITY_Facilitator_Guidebook.docx': 'Facilitator & Administrator Guidebook',
};
const binderTitle = (code) => `Sector binder — ${code}`;

function describe(file) {
  const m = /^UNDERCITY_Binder_([A-Z]{3})\.docx$/.exec(file);
  return TITLES[file] || (m ? binderTitle(m[1]) : file.replace(/^UNDERCITY_|\.docx$/g, ''));
}

// Word leaves an owner file (~$name.docx) beside any document it has open;
// it is a lock, not a document, and must never be counted or fingerprinted.
const files = fs.readdirSync(KIT)
  .filter((f) => f.endsWith('.docx') && !f.startsWith('~$'))
  .sort()
  .map((file) => {
    const full = path.join(KIT, file);
    return {
      file,
      title: describe(file),
      audience: FACILITATOR_ONLY.has(file) ? 'facilitator' : 'participant',
      bytes: fs.statSync(full).size,
      sha256: sha(full),
    };
  });

const content = {};
for (const f of ['faults.json', 'specs.json', 'sectors.json']) {
  const p = path.join(CONTENT, f);
  if (fs.existsSync(p)) content[f] = sha(p);
}

const faults = JSON.parse(fs.readFileSync(path.join(CONTENT, 'faults.json'), 'utf8'));

const manifest = {
  generated_at: new Date().toISOString(),
  // Sources these documents were built from. The server re-hashes its own
  // content at boot and compares; a mismatch means paper and screen drifted.
  sources: {
    matrix: fs.existsSync(MATRIX)
      ? { file: path.basename(MATRIX), sha256: sha(MATRIX) }
      : null,
    content,
  },
  counts: {
    faults: faults.faults.length,
    specs: faults.meta.spec_count,
    documents: files.length,
  },
  files,
};

fs.writeFileSync(path.join(KIT, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`✓ ${path.join(KIT, 'MANIFEST.json')} — ${files.length} documents, ` +
  `${files.filter((f) => f.audience === 'facilitator').length} facilitator-only`);
