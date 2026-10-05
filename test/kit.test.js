'use strict';
/**
 * The printable kit surface.
 *
 * Two things matter here. The answer key and the binders must never be
 * reachable without a signed-in facilitator, and the page must not tell anyone
 * the kit is current when it is not — a desynced binder makes a fault
 * unsolvable mid-session, which the spec calls the one failure a facilitator
 * cannot recover from live.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { Kit } = require('../lib/kit');
const { zip } = require('../lib/zip');

const ROOT = path.join(__dirname, '..');
const KIT_DIR = path.join(ROOT, 'kit');
const CONTENT_DIR = path.join(ROOT, 'content');

const kit = () => new Kit({ kitDir: KIT_DIR, contentDir: CONTENT_DIR });

test('the committed kit matches the committed content', () => {
  const status = kit().syncStatus();
  assert.equal(status.status, 'ok', status.detail);
});

test('the manifest describes every document that exists', () => {
  const summary = kit().summary();
  assert.equal(summary.available, true);
  assert.equal(summary.counts.documents, 13);
  assert.ok(summary.files.every((f) => f.present), 'every listed document is on disk');

  // Word's owner files (~$name.docx) are locks, not documents.
  const onDisk = fs.readdirSync(KIT_DIR).filter((f) => f.endsWith('.docx') && !f.startsWith('~$')).sort();
  assert.deepEqual(summary.files.map((f) => f.file).sort(), onDisk,
    'the manifest and the directory agree — no ghost or unlisted document');
});

test('only the answer key and the guidebook are facilitator-only; every binder goes to its station', () => {
  const summary = kit().summary();
  const facilitator = summary.files.filter((f) => f.audience === 'facilitator').map((f) => f.file);

  assert.deepEqual(facilitator.sort(), ['UNDERCITY_AnswerKey.docx', 'UNDERCITY_Facilitator_Guidebook.docx']);
  const participant = summary.files.filter((f) => f.audience === 'participant').map((f) => f.file);
  for (const sector of ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM']) {
    assert.ok(participant.includes(`UNDERCITY_Binder_${sector}.docx`),
      `${sector} binder is the team's operating manual and must be participant-facing`);
  }
});

test('participant-facing set contains nothing carrying an answer', () => {
  const summary = kit().summary();
  const participant = summary.files.filter((f) => f.audience === 'participant').map((f) => f.file);

  assert.deepEqual(participant.sort(), [
    'UNDERCITY_Binder_AGR.docx',
    'UNDERCITY_Binder_COM.docx',
    'UNDERCITY_Binder_MED.docx',
    'UNDERCITY_Binder_POW.docx',
    'UNDERCITY_Binder_TRN.docx',
    'UNDERCITY_Binder_WTR.docx',
    'UNDERCITY_CityCharter.docx',
    'UNDERCITY_ConsentPack_TableTents.docx',
    'UNDERCITY_FaultCards.docx',
    'UNDERCITY_RoleCards.docx',
    'UNDERCITY_TransferChits.docx',
  ]);
  assert.ok(!participant.some((f) => /AnswerKey|Guidebook/.test(f)));
});

test('resolve() refuses anything the manifest does not list', () => {
  const k = kit();
  assert.ok(k.resolve('UNDERCITY_AnswerKey.docx'), 'a real document resolves');

  for (const attempt of [
    '../content/faults.json',
    '../../etc/passwd',
    'MANIFEST.json',
    'nope.docx',
    '',
    'UNDERCITY_AnswerKey.docx/../../server.js',
  ]) {
    assert.equal(k.resolve(attempt), null, `must refuse ${JSON.stringify(attempt)}`);
  }
});

test('drifted content is reported, not silently accepted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercity-kit-'));
  const contentDir = path.join(dir, 'content');
  fs.mkdirSync(contentDir);
  for (const f of ['faults.json', 'specs.json', 'sectors.json']) {
    fs.copyFileSync(path.join(CONTENT_DIR, f), path.join(contentDir, f));
  }

  const k = new Kit({ kitDir: KIT_DIR, contentDir });
  assert.equal(k.syncStatus().status, 'ok', 'a faithful copy is in sync');

  // Simulate content re-exported after the kit was built.
  const faults = JSON.parse(fs.readFileSync(path.join(contentDir, 'faults.json'), 'utf8'));
  faults.faults[0].flavour = 'Something changed after the documents were printed.';
  fs.writeFileSync(path.join(contentDir, 'faults.json'), JSON.stringify(faults, null, 2));

  const drifted = k.syncStatus();
  assert.equal(drifted.status, 'drift');
  assert.deepEqual(drifted.drifted, ['faults.json']);
  assert.match(drifted.detail, /risks handing teams values the server will reject/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing kit reports unknown rather than pretending to be fine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercity-nokit-'));
  const k = new Kit({ kitDir: dir, contentDir: CONTENT_DIR });

  assert.equal(k.available(), false);
  assert.equal(k.syncStatus().status, 'unknown');
  assert.equal(k.summary().available, false);
  assert.deepEqual(k.entries(), []);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the download-all zip is valid and round-trips every document', () => {
  const entries = kit().entries();
  assert.equal(entries.length, 13);

  const archive = zip(entries);

  // End-of-central-directory signature, and the entry count it declares.
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, 'archive carries an end-of-central-directory record');
  assert.equal(archive.readUInt16LE(eocd + 10), 13, 'it declares all 13 entries');

  // Every local header is where the central directory says, and the stored
  // bytes are the file's bytes — a corrupt kit download would be worse than
  // none, since it fails at the printer rather than here.
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const at = archive.indexOf(name);
    assert.ok(at > 0, `${entry.name} appears in the archive`);
    const stored = archive.subarray(at + name.length, at + name.length + entry.data.length);
    assert.ok(stored.equals(entry.data), `${entry.name} round-trips byte for byte`);
  }
});

test('audience filters produce the two printable sets', () => {
  const k = kit();
  assert.equal(k.entries({ audience: 'participant' }).length, 11);
  assert.equal(k.entries({ audience: 'facilitator' }).length, 2);

  const names = k.entries({ audience: 'participant' }).map((e) => e.name);
  assert.ok(!names.some((n) => /AnswerKey|Guidebook/.test(n)),
    'the participant zip can never carry an answer');
});

test('manifest fingerprints actually match the files they describe', () => {
  const manifest = kit().manifest();
  for (const f of manifest.files) {
    const actual = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(KIT_DIR, f.file))).digest('hex');
    assert.equal(actual, f.sha256, `${f.file} hash matches the manifest`);
    assert.equal(fs.statSync(path.join(KIT_DIR, f.file)).size, f.bytes);
  }
});
