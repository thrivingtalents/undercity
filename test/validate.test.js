'use strict';
/**
 * The content guardrail. These tests pin the checks that stop a desynchronised
 * answer key reaching a room — including the F-208 class of defect, where the
 * printed card and the server disagree about which spec row to fetch.
 */
const test = require('node:test');
const assert = require('node:assert');

const { loadContent } = require('./helpers');
const { validateContent } = require('../lib/validate');

/** A deep clone so a mutation in one test cannot leak into another. */
const clone = (v) => JSON.parse(JSON.stringify(v));

test('the shipped content is clean — no errors, no warnings', () => {
  const { errors, warnings } = validateContent(loadContent());
  assert.deepEqual(errors, [], 'shipped fixtures must never fail validation');
  assert.deepEqual(warnings, [], 'no fault card may contradict the answer key');
});

test('F-208 reconciles: the card and the answer key name the same row', () => {
  const { faults, specs } = loadContent();
  const f208 = faults.faults.find((f) => f.code === 'F-208');
  const ref = specs.specs.find((s) => s.spec_id === f208.spec_refs[0].spec_id);

  // The defect this fixture used to carry: flavour said West, key said East.
  assert.match(f208.flavour, /AGR East/);
  assert.equal(ref.row_label, 'Array East');
  assert.equal(ref.value, 915);
  assert.deepEqual(f208.valid_codes, ['P-04-915']);
});

test('the prose detector still fires when a card contradicts the key', () => {
  // No shipped fault trips this check any more, so prove it still works —
  // otherwise fixing the content silently retires the guardrail that caught it.
  const content = clone(loadContent());
  const f208 = content.faults.faults.find((f) => f.code === 'F-208');
  f208.flavour = f208.flavour.replace('AGR East', 'AGR West');

  const { warnings } = validateContent(content);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^F-208:/);
  assert.match(warnings[0], /flavour says "West"/);
  assert.match(warnings[0], /A4-3 "Array East" \(915\)/);
  assert.match(warnings[0], /A4-4 "Array West" \(534\)/);
});

test('the detector catches the same defect on any fault, not just F-208', () => {
  // F-209 legitimately mentions COM's Grid South. Point its flavour at Grid
  // North instead and the contradiction must surface.
  const content = clone(loadContent());
  const f209 = content.faults.faults.find((f) => f.code === 'F-209');
  f209.flavour = 'Array dead; re-strike needs COM Grid North calibration offset.';

  const { warnings } = validateContent(content);
  assert.ok(warnings.some((w) => w.startsWith('F-209:')),
    'the check is structural, not hardcoded to one fault code');
});

test('F-209 is not flagged — its direction word describes its own equipment', () => {
  const { warnings } = validateContent(loadContent());
  assert.ok(!warnings.some((w) => w.startsWith('F-209:')),
    '"North array dead" refers to AGR\'s own kit, not to COM\'s Grid South spec');
});

test('a resolution code that does not match its spec refs is an error', () => {
  const content = clone(loadContent());
  const fault = content.faults.faults.find((f) => f.code === 'F-101');
  fault.valid_codes = ['P-02-111'];

  const { errors } = validateContent(content);
  assert.ok(errors.some((e) => e.includes('F-101') && e.includes('derived P-02-990')),
    'a desynchronised answer key must abort the boot');
});

test('duplicate spec values are an error — they break the uniqueness property', () => {
  const content = clone(loadContent());
  content.specs.specs.find((s) => s.spec_id === 'P1-2').value =
    content.specs.specs.find((s) => s.spec_id === 'P1-1').value;

  const { errors } = validateContent(content);
  assert.ok(errors.some((e) => e.includes('is not unique')));
});

test('the reserved value 290 may not appear in a spec table', () => {
  const content = clone(loadContent());
  content.specs.specs.find((s) => s.spec_id === 'P1-1').value = 290;

  const { errors } = validateContent(content);
  assert.ok(errors.some((e) => e.includes('Reserved value 290')),
    '290 is the big screen half of the discrepancy and must stay unambiguous');
});

test('two faults in one sector sharing a code is an error', () => {
  const content = clone(loadContent());
  const [a, b] = content.faults.faults.filter((f) => f.sector === 'POW' && !f.false_alarm);
  b.valid_codes = [...a.valid_codes];

  const { errors } = validateContent(content);
  assert.ok(errors.some((e) => e.includes('Ambiguous code')),
    'the server could not tell which fault a submission resolves');
});

test('false_alarm must agree with an empty valid_codes array', () => {
  const content = clone(loadContent());
  content.faults.faults.find((f) => f.code === 'F-201').valid_codes = [];

  const { errors } = validateContent(content);
  assert.ok(errors.some((e) => e.includes('F-201') && e.includes('contradicts')));
});

test('a fault referencing an unknown spec id is an error', () => {
  const content = clone(loadContent());
  content.faults.faults.find((f) => f.code === 'F-101').spec_refs[0].spec_id = 'ZZ-9';

  const { errors } = validateContent(content);
  assert.ok(errors.some((e) => e.includes('unknown spec ZZ-9')));
});

test('meta counts that disagree with the file are an error', () => {
  const content = clone(loadContent());
  content.faults.meta.fault_count = 99;

  const { errors } = validateContent(content);
  assert.ok(errors.some((e) => e.includes('fault_count')));
});

test('content holds the two-code discrepancy and no codeless fault', () => {
  const { faults } = loadContent();
  const multi = faults.faults.filter((f) => f.valid_codes.length > 1);
  const empty = faults.faults.filter((f) => f.valid_codes.length === 0);

  assert.deepEqual(multi.map((f) => f.code), ['F-201'], 'the two-code discrepancy fault');
  assert.deepEqual(empty.map((f) => f.code), [], 'no false alarm — every card has a code');
});

test('every binder holds exactly one buried appendix spec', () => {
  const { specs } = loadContent();
  const counts = {};
  for (const s of specs.specs) {
    if (s.buried) counts[s.binder] = (counts[s.binder] || 0) + 1;
  }
  assert.deepEqual(counts, { POW: 1, WTR: 1, MED: 1, TRN: 1, AGR: 1, COM: 1 },
    'spec §4.1: one buried item per binder, no more');
});

test('the discrepancy seed is intact in the content', () => {
  const { specs, faults } = loadContent();
  const w43 = specs.specs.find((s) => s.spec_id === 'W4-3');
  assert.equal(w43.value, 340, 'the WTR binder prints 340');
  assert.match(w43.flags, /DISCREPANCY/);

  const f201 = faults.faults.find((f) => f.code === 'F-201');
  assert.deepEqual(f201.valid_codes, ['P-03-340', 'P-03-290'],
    'the server accepts the binder value and the big screen value alike');
});
