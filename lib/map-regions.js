'use strict';
/**
 * HAVEN-9 MAP REGIONS (2026-09-21) — where each sector actually is on the map
 * media, measured once by a human and saved, never guessed at runtime.
 *
 * The Big Screen's map is a fixed-camera looping video. Until now every state
 * overlay on it — the brownout dim, the CRITICAL edge, the DARK wash, the
 * status word — was drawn at coordinates traced on the PAINTED map that the
 * video replaced, so the overlays only landed on the right platforms by
 * accident. This file is the other half of the fix: one calibrated polygon per
 * sector, in NORMALISED coordinates (0..1 of the displayed video image), plus
 * the anchor its status word hangs from and an optional line to the core.
 *
 * Normalised is the whole point: the same numbers land correctly on a laptop,
 * a 1080p projector and a fullscreen 4K wall, because the client scales them
 * against the video's *displayed image* rectangle — never the letterboxed
 * container, never one machine's pixels.
 *
 * Nothing here infers a region. A sector with no calibration draws nothing at
 * all (and Admin is told), because a missing overlay is honest and a guessed
 * one lies about where the city is failing.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'mapConfig', 'haven9-map-regions.json');
const SECTOR_IDS = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];
const MIN_POINTS = 3;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const inRange = (v) => isNum(v) && v >= 0 && v <= 1;
const round4 = (v) => Math.round(v * 10000) / 10000;

/** An empty, valid document — what a build with no calibration yet reads as. */
function empty() {
  return {
    version: 1,
    note: 'Normalised (0..1) sector regions measured against the displayed HAVEN-9 map video. Written by the calibration tool at /calibrate; never hand-guessed.',
    media: { id: 'haven9-map', source: '/assets/wall/art/haven9-map.mp4' },
    sectors: {},
  };
}

function load() {
  try {
    const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!doc || typeof doc !== 'object') return empty();
    return { ...empty(), ...doc, sectors: doc.sectors && typeof doc.sectors === 'object' ? doc.sectors : {} };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[map-regions] cannot read ${FILE}: ${err.message}`);
    return empty();
  }
}

/**
 * Validate one sector's region the way the spec asks: three points or more,
 * every coordinate inside 0..1, a known sector, and a label anchor that is
 * also on the image. Returns { ok } or { ok:false, reason, detail }.
 */
function validateRegion(id, region) {
  const code = String(id || '').toUpperCase();
  if (!SECTOR_IDS.includes(code)) return { ok: false, reason: 'unknown_sector', detail: id };
  if (!region || typeof region !== 'object') return { ok: false, reason: 'empty_region', detail: code };

  const poly = region.polygon;
  if (!Array.isArray(poly)) return { ok: false, reason: 'polygon_required', detail: code };
  if (poly.length < MIN_POINTS) return { ok: false, reason: 'polygon_too_short', detail: `${code}: ${poly.length} point(s), ${MIN_POINTS} needed` };
  for (const pt of poly) {
    if (!Array.isArray(pt) || pt.length !== 2 || !inRange(pt[0]) || !inRange(pt[1])) {
      return { ok: false, reason: 'point_out_of_bounds', detail: `${code}: ${JSON.stringify(pt)}` };
    }
  }

  const anchor = region.statusLabel;
  if (anchor !== undefined && anchor !== null) {
    if (typeof anchor !== 'object' || !inRange(anchor.x) || !inRange(anchor.y)) {
      return { ok: false, reason: 'label_out_of_bounds', detail: code };
    }
  }

  const link = region.coreConnection;
  if (link !== undefined && link !== null) {
    const ends = [link.from, link.to];
    for (const e of ends) {
      if (!Array.isArray(e) || e.length !== 2 || !inRange(e[0]) || !inRange(e[1])) {
        return { ok: false, reason: 'connection_out_of_bounds', detail: code };
      }
    }
  }
  return { ok: true };
}

/** Everything a caller needs to know about one save attempt, before it writes. */
function validate(doc) {
  if (!doc || typeof doc !== 'object') return { ok: false, reason: 'invalid_document' };
  const sectors = doc.sectors || {};
  if (typeof sectors !== 'object' || Array.isArray(sectors)) return { ok: false, reason: 'invalid_document' };
  for (const [id, region] of Object.entries(sectors)) {
    const check = validateRegion(id, region);
    if (!check.ok) return check;
  }
  return { ok: true };
}

/** Coordinates as stored: four decimals is ~1px on a 4K wall and reads cleanly. */
function normaliseDoc(doc) {
  const out = { ...empty(), ...doc, sectors: {} };
  for (const [id, region] of Object.entries(doc.sectors || {})) {
    const code = String(id).toUpperCase();
    const r = {
      id: code,
      label: String(region.label || '').slice(0, 40) || code,
      polygon: region.polygon.map(([x, y]) => [round4(x), round4(y)]),
    };
    if (region.statusLabel) r.statusLabel = { x: round4(region.statusLabel.x), y: round4(region.statusLabel.y) };
    if (region.coreConnection) {
      r.coreConnection = {
        from: [round4(region.coreConnection.from[0]), round4(region.coreConnection.from[1])],
        to: [round4(region.coreConnection.to[0]), round4(region.coreConnection.to[1])],
      };
    }
    r.calibrated_at = region.calibrated_at || new Date().toISOString();
    out.sectors[code] = r;
  }
  out.saved_at = new Date().toISOString();
  return out;
}

/** Write the whole document, or refuse it whole. A half-saved map is worse than none. */
function save(doc) {
  const check = validate(doc);
  if (!check.ok) return check;
  const out = normaliseDoc(doc);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, `${JSON.stringify(out, null, 2)}\n`);
  return { ok: true, document: out };
}

/** Which of the six have no usable region — what Admin is warned about. */
function missing(doc = load()) {
  return SECTOR_IDS.filter((code) => !validateRegion(code, (doc.sectors || {})[code]).ok);
}

module.exports = { FILE, SECTOR_IDS, MIN_POINTS, empty, load, save, validate, validateRegion, missing, normaliseDoc };
