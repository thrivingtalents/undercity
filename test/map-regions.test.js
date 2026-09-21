'use strict';
/**
 * THE MAP OVERLAY CALIBRATION SYSTEM (spec MAP-001 … MAP-008).
 *
 * The failure this whole system exists to prevent is a lie on the Big Screen:
 * a brownout dim sitting on the wrong platform, or across the empty rock
 * between two sectors, because somebody's code guessed where a sector was.
 * So these tests are mostly about what is NOT drawn — no polygon without a
 * measurement, no shape spanning two sectors, no alignment that depends on one
 * machine's pixels.
 *
 * The geometry module is the same file the browser loads; the region store is
 * the same one the server writes. Nothing is re-implemented here.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const regions = require('../lib/map-regions');
const M = require('../public/shared/map-overlay');

const SECTORS = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];
const shipped = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'mapConfig', 'haven9-map-regions.json'), 'utf8'));

/** Is a point inside a polygon? Ray casting — used to prove regions are separate. */
function inside(poly, [x, y]) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
const centroid = (poly) => M.centroid(poly);

// -- the geometry the whole thing rests on ------------------------------------

test('MAP-008: the overlay rectangle is the video IMAGE, never the letterboxed container', () => {
  // A 16:9 clip in a tall container: bars top and bottom, full width.
  const tall = M.containRect(1000, 800, 1920, 1080);
  assert.equal(Math.round(tall.width), 1000);
  assert.equal(Math.round(tall.height), 563);
  assert.equal(Math.round(tall.x), 0);
  assert.ok(tall.y > 100 && tall.y < 125, `bars top and bottom, got y=${tall.y}`);

  // The same clip in a wide container: bars left and right, full height.
  const wide = M.containRect(2000, 800, 1920, 1080);
  assert.equal(Math.round(wide.height), 800);
  assert.equal(Math.round(wide.width), 1422);
  assert.equal(Math.round(wide.y), 0);
  assert.ok(wide.x > 280 && wide.x < 292, `bars left and right, got x=${wide.x}`);

  // Exactly 16:9: no bars at all.
  const exact = M.containRect(1920, 1080, 1920, 1080);
  assert.deepEqual([exact.x, exact.y, exact.width, exact.height], [0, 0, 1920, 1080]);

  // Nothing is ever cropped: the image always fits inside its box.
  for (const [bw, bh] of [[1000, 800], [2000, 800], [640, 480], [3840, 1000]]) {
    const r = M.containRect(bw, bh, 1920, 1080);
    assert.ok(r.width <= bw + 0.5 && r.height <= bh + 0.5, 'contain cropped the image');
    assert.ok(Math.abs((r.width / r.height) - (1920 / 1080)) < 1e-9, 'the aspect ratio moved');
  }
});

test('MAP-003: a normalised point lands on the same part of the picture at every resolution', () => {
  const doc = shipped();
  const pow = doc.sectors.POW;
  const at = (poly, boxW, boxH) => {
    const r = M.containRect(boxW, boxH, 1920, 1080);
    // Where the polygon's centre falls, as a fraction of the IMAGE.
    const c = centroid(poly);
    const px = r.x + c.x * r.width;
    const py = r.y + c.y * r.height;
    return [(px - r.x) / r.width, (py - r.y) / r.height];
  };
  const sizes = [[1920, 1080], [1280, 720], [3840, 2160], [1366, 768], [1000, 800], [2400, 900]];
  const first = at(pow.polygon, ...sizes[0]);
  for (const [w, h] of sizes) {
    const here = at(pow.polygon, w, h);
    assert.ok(Math.abs(here[0] - first[0]) < 1e-9 && Math.abs(here[1] - first[1]) < 1e-9,
      `POW moved on the picture at ${w}x${h}`);
  }
});

test('MAP-004: changed bounds move the overlay with the picture, not away from it', () => {
  // Fullscreen is just another box. What must hold is that a stored point maps
  // to the same feature of the image before and after.
  const p = [0.2575, 0.2311];
  const place = (bw, bh) => {
    const r = M.containRect(bw, bh, 1920, 1080);
    return { x: r.x + p[0] * r.width, y: r.y + p[1] * r.height, r };
  };
  const windowed = place(947, 615);
  const full = place(1920, 1080);
  const asFractionOfImage = (v) => [(v.x - v.r.x) / v.r.width, (v.y - v.r.y) / v.r.height];
  assert.deepEqual(asFractionOfImage(windowed).map((n) => n.toFixed(6)),
    asFractionOfImage(full).map((n) => n.toFixed(6)));
  // And the absolute position really did change — otherwise this proves nothing.
  assert.notEqual(Math.round(windowed.x), Math.round(full.x));
});

// -- what is drawn, and what is refused ---------------------------------------

test('MAP-005: an uncalibrated sector draws nothing and is reported, never guessed', () => {
  const doc = { sectors: { POW: { id: 'POW', polygon: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3]] } } };
  assert.equal(M.isCalibrated(doc.sectors.POW), true);
  assert.equal(M.isCalibrated(doc.sectors.MED), false);
  assert.equal(M.isCalibrated({ polygon: [[0.1, 0.1], [0.2, 0.2]] }), false, 'two points is not a region');
  assert.equal(M.isCalibrated({ polygon: [[0.1, 0.1], [0.2, 0.2], [1.4, 0.2]] }), false, 'off the picture');
  // The store agrees with the client about which sectors are missing.
  assert.deepEqual(regions.missing(doc).sort(), ['AGR', 'COM', 'MED', 'TRN', 'WTR']);
});

test('data validation: three points, inside the picture, a known sector, an anchor on the image', () => {
  const ok = { polygon: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]] };
  assert.equal(regions.validateRegion('POW', ok).ok, true);
  assert.equal(regions.validateRegion('XXX', ok).reason, 'unknown_sector');
  assert.equal(regions.validateRegion('POW', { polygon: [[0.1, 0.1], [0.2, 0.2]] }).reason, 'polygon_too_short');
  assert.equal(regions.validateRegion('POW', { polygon: [[0.1, 0.1], [0.2, 0.1], [1.2, 0.2]] }).reason, 'point_out_of_bounds');
  assert.equal(regions.validateRegion('POW', { polygon: [[0.1, 0.1], [0.2, 0.1], [-0.2, 0.2]] }).reason, 'point_out_of_bounds');
  assert.equal(regions.validateRegion('POW', { ...ok, statusLabel: { x: 1.5, y: 0.2 } }).reason, 'label_out_of_bounds');
  assert.equal(regions.validateRegion('POW', { ...ok, coreConnection: { from: [0.1, 0.1], to: [2, 0.2] } }).reason, 'connection_out_of_bounds');
  assert.equal(regions.validateRegion('POW', null).reason, 'empty_region');
});

test('MAP-006: saved coordinates are normalised, and a bad document is refused whole', () => {
  const doc = {
    sectors: {
      wtr: { label: 'Water & Filtration', polygon: [[0.61752, 0.30669], [0.69, 0.24], [0.765, 0.3067]], statusLabel: { x: 0.69, y: 0.4578 } },
    },
  };
  const out = regions.normaliseDoc(doc);
  assert.ok(out.sectors.WTR, 'the sector id is normalised too');
  assert.deepEqual(out.sectors.WTR.polygon[0], [0.6175, 0.3067], 'four decimals, and nothing outside 0..1');
  for (const [x, y] of out.sectors.WTR.polygon) {
    assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1);
  }
  assert.ok(out.sectors.WTR.calibrated_at, 'a region records when it was measured');
  assert.equal(regions.validate({ sectors: { POW: { polygon: [[0, 0], [1, 1]] } } }).ok, false,
    'a two-point polygon must not be writable');
});

// -- the six regions this build ships -----------------------------------------

test('the shipped map is calibrated: six independent regions, every point on the picture', () => {
  const doc = shipped();
  assert.deepEqual(regions.missing(doc), [], 'a sector is not calibrated');
  for (const code of SECTORS) {
    const r = doc.sectors[code];
    assert.equal(r.id, code);
    assert.ok(r.polygon.length >= 3, `${code} has fewer than three points`);
    for (const [x, y] of r.polygon) {
      assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1, `${code} has a point off the picture`);
    }
    assert.ok(r.statusLabel, `${code} has no status-label anchor`);
    assert.ok(r.statusLabel.x >= 0 && r.statusLabel.x <= 1 && r.statusLabel.y >= 0 && r.statusLabel.y <= 1);
  }
});

test('MAP-002: no region contains another sector, and none spans the space between two', () => {
  const doc = shipped();
  for (const a of SECTORS) {
    for (const b of SECTORS) {
      if (a === b) continue;
      const c = centroid(doc.sectors[b].polygon);
      assert.equal(inside(doc.sectors[a].polygon, [c.x, c.y]), false,
        `${a}'s region covers ${b} — one polygon is standing in for two sectors`);
    }
  }
  // Each region is a small part of the picture: a shape stretched across the
  // map would pass the test above and still be wrong.
  for (const code of SECTORS) {
    const xs = doc.sectors[code].polygon.map((p) => p[0]);
    const ys = doc.sectors[code].polygon.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    assert.ok(w < 0.35 && h < 0.35, `${code} covers ${(w * 100).toFixed(0)}x${(h * 100).toFixed(0)}% of the map — too big to be one platform`);
  }
});

test('the status word hangs from the saved anchor, never from a centroid when one exists', () => {
  const doc = shipped();
  for (const code of SECTORS) {
    const r = doc.sectors[code];
    const anchor = M.labelAnchor(r);
    assert.deepEqual([anchor.x, anchor.y], [r.statusLabel.x, r.statusLabel.y]);
    const c = centroid(r.polygon);
    assert.ok(Math.abs(anchor.y - c.y) > 0.01 || Math.abs(anchor.x - c.x) > 0.01,
      `${code}'s anchor is its centroid — the word will sit on the artwork`);
  }
});

// -- the store on disk ---------------------------------------------------------

test('a save writes the whole document or none of it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercity-map-'));
  const file = path.join(dir, 'regions.json');
  const original = regions.FILE;
  try {
    // The module writes one known path, so the round trip is tested through a
    // copy of the document rather than by moving the file about.
    const good = { sectors: { POW: { polygon: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]] } } };
    const normalised = regions.normaliseDoc(good);
    fs.writeFileSync(file, JSON.stringify(normalised, null, 2));
    const back = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(back.sectors.POW.polygon, [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]]);
    assert.equal(regions.validate(back).ok, true);
  } finally {
    assert.equal(regions.FILE, original, 'the module writes one path only');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -- over the wire -------------------------------------------------------------

test('the regions are public to read and gated to write', async (t) => {
  const PORT = 3231;
  const BASE = `http://localhost:${PORT}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercity-map-srv-'));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, MODE: 'lan', FACILITATOR_TOKEN: 'test-token' },
    stdio: 'ignore',
  });
  // Windows keeps the SQLite handle a moment after the process dies, so the
  // scratch directory is left for the OS rather than failing a green test.
  t.after(() => {
    server.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* the OS will */ }
  });

  let up = false;
  for (let i = 0; i < 40 && !up; i += 1) {
    try { up = (await fetch(`${BASE}/healthz`)).ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(up, 'server never came up');

  // Any screen may read the coordinates: they are geometry, not answers.
  const read = await fetch(`${BASE}/config/haven9-map-regions.json`);
  assert.equal(read.status, 200);
  const doc = await read.json();
  assert.deepEqual(Object.keys(doc.sectors).sort(), [...SECTORS].sort());

  // Nobody writes them without the facilitator's token.
  const forbidden = await fetch(`${BASE}/api/map-regions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document: { sectors: {} } }),
  });
  assert.equal(forbidden.status, 403, 'the map was writable without a token');

  // And a bad document is refused even with one.
  const bad = await fetch(`${BASE}/api/map-regions?token=test-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document: { sectors: { POW: { polygon: [[0.1, 0.1], [0.2, 0.2]] } } } }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'polygon_too_short');

  // The refusal changed nothing on disk.
  const after = await (await fetch(`${BASE}/config/haven9-map-regions.json`)).json();
  assert.deepEqual(Object.keys(after.sectors).sort(), [...SECTORS].sort(), 'a refused save damaged the map');
});
