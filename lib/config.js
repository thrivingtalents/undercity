'use strict';
/**
 * Game configuration — separate from the game engine (spec §45).
 *
 * Nothing involving balance lives in code. A *scenario* is one JSON document
 * holding every tunable: thresholds, cycle length, production, upkeep,
 * brownout effects, deadlines, event presets, fault presets and the scripted
 * timeline. The engine reads `game.cfg` and `game.scenario`; it never carries
 * a number of its own.
 *
 * Two sources, merged by id:
 *   config/scenarios/*.json   built-in, shipped with the code (read-only)
 *   SQLite `scenarios` table  saved from Admin ("SAVE AS SCENARIO")
 *
 * A saved scenario with the same id as a built-in shadows it. Deleting the
 * saved copy reveals the built-in again, so a facilitator can never destroy
 * the shipped baseline.
 */

const fs = require('fs');
const path = require('path');

const BUILTIN_DIR = path.join(__dirname, '..', 'config', 'scenarios');
const DEFAULT_ID = 'haven9-standard';

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/** Recursive merge; arrays and scalars in `patch` replace, objects merge. */
function deepMerge(base, patch) {
  if (!isObject(base) || !isObject(patch)) return patch === undefined ? base : clone(patch);
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObject(v) && isObject(base[k]) ? deepMerge(base[k], v) : clone(v);
  }
  return out;
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function slug(text) {
  return String(text || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'scenario';
}

class ScenarioLibrary {
  /**
   * @param {object} opts
   * @param {object} opts.store     lib/db Store (may be null in unit tests)
   * @param {object} opts.rounds    lib/rounds.json (its defaults are the floor)
   * @param {object} opts.content   the three content fixtures
   */
  constructor({ store = null, rounds, content }) {
    this.store = store;
    this.rounds = rounds;
    this.content = content;
    this.builtins = new Map();
    this.loadBuiltins();
  }

  loadBuiltins() {
    this.builtins.clear();
    if (!fs.existsSync(BUILTIN_DIR)) return;
    for (const file of fs.readdirSync(BUILTIN_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(BUILTIN_DIR, file), 'utf8'));
        doc.id = doc.id || file.replace(/\.json$/, '');
        doc.builtin = true;
        this.builtins.set(doc.id, doc);
      } catch (err) {
        console.error(`[config] cannot read scenario ${file}: ${err.message}`);
      }
    }
  }

  /** Every scenario the facilitator can pick, saved copies shadowing built-ins. */
  list() {
    const out = new Map();
    for (const [id, doc] of this.builtins) {
      out.set(id, { id, name: doc.name, notes: doc.notes || '', builtin: true, updated_at: null });
    }
    if (this.store) {
      for (const row of this.store.listScenarios()) {
        out.set(row.id, {
          id: row.id, name: row.name, notes: row.notes || '', builtin: false,
          updated_at: row.updated_at, shadows_builtin: this.builtins.has(row.id),
        });
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The raw scenario document, saved copy first. */
  raw(id) {
    const key = id || DEFAULT_ID;
    if (this.store) {
      const row = this.store.scenarioById(key);
      if (row) {
        try { return { ...JSON.parse(row.json), id: row.id, name: row.name, builtin: false }; }
        catch { /* fall through to the built-in */ }
      }
    }
    return this.builtins.get(key) ? clone(this.builtins.get(key)) : null;
  }

  /**
   * A document with its `extends` chain folded in: `defaults` and `sectors`
   * deep-merge over the parent, while `intel`, `events`, `fault_presets` and
   * `timelines` are taken whole from the child when it defines them. A
   * variant ("HAVEN-9 HARD", the demo) therefore states only what differs.
   */
  expanded(id, seen = new Set()) {
    const doc = this.raw(id);
    if (!doc || !doc.extends || seen.has(doc.id)) return doc;
    seen.add(doc.id);
    const parent = this.expanded(doc.extends, seen);
    if (!parent) return doc;
    const out = { ...parent, ...doc };
    out.defaults = deepMerge(parent.defaults || {}, doc.defaults || {});
    out.sectors = deepMerge(parent.sectors || {}, doc.sectors || {});
    for (const k of ['intel', 'events', 'fault_presets']) {
      out[k] = clone(doc[k] !== undefined ? doc[k] : parent[k] || []);
    }
    out.timelines = clone({ ...(parent.timelines || {}), ...(doc.timelines || {}) });
    out.builtin = !!doc.builtin;
    return out;
  }

  /**
   * A scenario resolved for play: defaults filled from rounds.json, sectors
   * filled from content, so a hand-written scenario may omit anything.
   */
  resolve(id) {
    const doc = this.expanded(id) || this.expanded(DEFAULT_ID);
    if (!doc) throw new Error('no scenario available — config/scenarios is empty');

    const defaults = deepMerge(this.rounds.defaults || {}, doc.defaults || {});
    const sectors = {};
    for (const [code, def] of Object.entries(this.content.sectors.sectors)) {
      const over = (doc.sectors || {})[code] || {};
      sectors[code] = {
        start_integrity: over.start_integrity ?? def.start_integrity,
        start_workforce: over.start_workforce ?? def.start_workforce,
        start_inventory: { ...def.start_inventory, ...(over.start_inventory || {}) },
        production: over.production
          ? { ...over.production }
          : (def.produces ? { [def.produces]: 2 } : {}),
        upkeep: over.upkeep ? { ...over.upkeep } : { ...def.upkeep_per_round },
        note: over.note || null,
      };
    }
    return {
      id: doc.id,
      name: doc.name || doc.id,
      notes: doc.notes || '',
      builtin: !!doc.builtin,
      defaults,
      sectors,
      intel: clone(doc.intel || []),
      events: clone(doc.events || []),
      fault_presets: clone(doc.fault_presets || []),
      timelines: clone(doc.timelines || {}),
    };
  }

  /** Persist a scenario document under `id` (new or overwrite). */
  save({ id, name, doc }) {
    if (!this.store) throw new Error('scenario saving needs the database');
    const key = slug(id || name);
    const clean = clone(doc);
    delete clean.builtin;
    clean.id = key;
    clean.name = String(name || clean.name || key).trim();
    this.store.upsertScenario({
      id: key, name: clean.name, notes: clean.notes || '', json: JSON.stringify(clean),
    });
    return key;
  }

  remove(id) {
    if (!this.store) return false;
    return this.store.deleteScenario(id);
  }
}

module.exports = { ScenarioLibrary, deepMerge, clone, slug, DEFAULT_ID };
