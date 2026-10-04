'use strict';
/**
 * The printable kit, as the admin panel sees it.
 *
 * Documents are generated at build time from the same commit that produced
 * content/*.json, so paper and server agree by construction. This module does
 * not take that on trust: it re-hashes the content the server is actually
 * running and compares it to the hashes recorded when the documents were
 * built. If they diverge, the admin page says so loudly, because a desynced
 * binder makes a fault unsolvable mid-session — the one failure a facilitator
 * cannot recover from live (spec §1).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONTENT_FILES = ['faults.json', 'specs.json', 'sectors.json', 'faults.reference-chain.json'];

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

class Kit {
  constructor({ kitDir, contentDir }) {
    this.kitDir = kitDir;
    this.contentDir = contentDir;
  }

  manifestPath() {
    return path.join(this.kitDir, 'MANIFEST.json');
  }

  available() {
    return fs.existsSync(this.manifestPath());
  }

  manifest() {
    if (!this.available()) return null;
    try {
      return JSON.parse(fs.readFileSync(this.manifestPath(), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Resolve a requested filename to a real path, refusing anything else. */
  resolve(file) {
    const manifest = this.manifest();
    if (!manifest) return null;
    // Whitelist by manifest entry, so a traversal attempt has nothing to hit:
    // the name must be one this build actually produced.
    const entry = manifest.files.find((f) => f.file === file);
    if (!entry) return null;
    const full = path.join(this.kitDir, entry.file);
    return fs.existsSync(full) ? { entry, full } : null;
  }

  /**
   * Does the built kit match the content this server is running?
   * Returns { status, detail } where status is 'ok' | 'drift' | 'unknown'.
   */
  syncStatus() {
    const manifest = this.manifest();
    if (!manifest) return { status: 'unknown', detail: 'No kit has been built.' };

    const recorded = (manifest.sources && manifest.sources.content) || {};
    if (!Object.keys(recorded).length) {
      return { status: 'unknown', detail: 'This kit records no content fingerprints.' };
    }

    const drifted = [];
    for (const file of CONTENT_FILES) {
      const full = path.join(this.contentDir, file);
      if (!fs.existsSync(full)) continue;
      if (!recorded[file]) continue;
      if (sha(full) !== recorded[file]) drifted.push(file);
    }

    if (drifted.length) {
      return {
        status: 'drift',
        detail: `The kit was built from a different version of ${drifted.join(', ')}. ` +
                'Printing it risks handing teams values the server will reject. Redeploy to rebuild.',
        drifted,
      };
    }
    return { status: 'ok', detail: 'The kit was built from the content this server is running.' };
  }

  /** Manifest plus live sync status, for the admin page. */
  summary() {
    const manifest = this.manifest();
    if (!manifest) {
      return { available: false, sync: this.syncStatus(), files: [], counts: null };
    }
    const missing = manifest.files.filter((f) => !fs.existsSync(path.join(this.kitDir, f.file)));
    return {
      available: true,
      generated_at: manifest.generated_at,
      counts: manifest.counts,
      sources: manifest.sources,
      sync: this.syncStatus(),
      files: manifest.files.map((f) => ({
        ...f,
        present: !missing.some((m) => m.file === f.file),
      })),
    };
  }

  /** Every present document, for a download-all. */
  entries({ audience = null } = {}) {
    const manifest = this.manifest();
    if (!manifest) return [];
    return manifest.files
      .filter((f) => !audience || f.audience === audience)
      .map((f) => {
        const full = path.join(this.kitDir, f.file);
        return fs.existsSync(full) ? { name: f.file, data: fs.readFileSync(full) } : null;
      })
      .filter(Boolean);
  }
}

module.exports = { Kit, CONTENT_FILES };
