'use strict';
/**
 * BIG SCREEN RULES — the display derivations the wall and its tests share.
 *
 * The participant Big Screen (public/wall) is display-only. Everything it
 * prints is either the server's word or a formatting of it, and the
 * formatting lives here so that node tests can exercise exactly what the
 * projector runs. Nothing in this file stores state, and nothing in it
 * reads real inventory: the resource line is COM's reported row, verbatim.
 *
 * UMD: `window.UndercityBigscreen` in the browser, `module.exports` in node.
 */
(function attach(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UndercityBigscreen = factory();
})(typeof window !== 'undefined' ? window : globalThis, function factory() {
  const RES_ORDER = ['power', 'water', 'med', 'parts'];           // POWER · WATER · MEDICAL · PARTS
  const GLYPH = { power: '⚡', water: '💧', med: '⚕', parts: '🔧' };
  const RES_NAME = { power: 'POWER', water: 'WATER', med: 'MEDICAL', parts: 'PARTS' };
  const STATES = ['stable', 'degraded', 'critical', 'dark', 'brownout'];
  const STATE_WORD = { stable: 'STABLE', degraded: 'DEGRADED', critical: 'CRITICAL', dark: 'DARK', brownout: 'BROWNOUT' };
  const SECTOR_ORDER = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];
  const CORE_INSUFFICIENT = 60;          // the line the Council text already draws
  const ANNOUNCEMENT_MAX_AGE_S = 120;    // a facilitator announcement stays on the strip this long
  const MAX_ALERTS = 4;

  const clamp = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

  /**
   * A sector's health state, from the server's status word so the wall never
   * disagrees with a laptop. The map and the card both call this — it is the
   * one place the state is decided.
   */
  function healthState(s) {
    if (!s) return 'stable';
    const w = String(s.status_word || s.status || '').toUpperCase();
    if (w === 'DARK' || s.status === 'DARK' || Number(s.integrity) <= 0) return 'dark';
    if (w === 'BROWNOUT' || s.status === 'BROWNOUT') return 'brownout';
    if (w === 'CRITICAL' || s.status === 'CRITICAL') return 'critical';
    if (w === 'DEGRADED' || w === 'WARNING') return 'degraded';
    return 'stable';
  }
  const healthWord = (s) => STATE_WORD[healthState(s)];

  /** Has COM ever reported this sector? A row with no round stamp is a row COM never touched. */
  const reported = (row) => !!row && row.round !== null && row.round !== undefined;

  /** The freshness line under a card: UPDATED ROUND 2 · STALE, or NOT UPDATED. */
  function freshnessLine(row) {
    if (!reported(row) || row.freshness === 'NOT UPDATED') return { level: 'NOT UPDATED', text: 'NOT UPDATED' };
    const level = String(row.freshness || 'CURRENT');
    return { level, text: `UPDATED ROUND ${row.round_number} · ${level}` };
  }

  /** What COM reported, in POWER · WATER · MEDICAL · PARTS order — or NO REPORT, alone. */
  function reportLine(row) {
    if (!reported(row)) return { none: true, text: 'NO REPORT', values: [] };
    const values = RES_ORDER.map((key) => ({
      key, glyph: GLYPH[key], value: row[key] === null || row[key] === undefined ? '—' : String(row[key]),
    }));
    return { none: false, text: values.map((v) => `${v.glyph} ${v.value}`).join('   '), values };
  }

  /** One clear FROM → TO route. Transport approves every transfer; it is not a hop. */
  const route = (t) => `${t.from} → ${t.to}`;
  const itemLine = (t) => `${GLYPH[t.resource] || ''} ${t.amount} ${RES_NAME[t.resource] || String(t.resource || '').toUpperCase()}`.trim();

  /** The transfer alert: one transfer gets its route and item, more get a count. */
  function transferAlert(transfers) {
    const waiting = (transfers || []).filter((t) => t.status === 'PENDING_TRN_APPROVAL');
    if (!waiting.length) return null;
    if (waiting.length === 1) {
      const t = waiting[0];
      return { kind: 'transfer', accent: 'grey', count: 1, key: `trn:${t.id}`,
        head: '⚠ 1 TRANSFER WAITING FOR TRN', detail: `${route(t)}   ${itemLine(t)}`, route: route(t) };
    }
    return { kind: 'transfer', accent: 'grey', count: waiting.length, key: `trn:${waiting.length}`,
      head: `⚠ ${waiting.length} TRANSFERS WAITING FOR TRN`, detail: '', route: '' };
  }

  /** Seconds between two ISO stamps, never negative, Infinity when either is missing. */
  function ageS(later, earlier) {
    const a = Date.parse(later); const b = Date.parse(earlier);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
    return Math.max(0, (a - b) / 1000);
  }

  /**
   * Every alert the strip shows, most important first: the facilitator's
   * emergency, DARK sectors, CRITICAL sectors (worst first), core
   * insufficiency, the Council, transfers waiting for TRN, then a recent
   * facilitator announcement. An empty list means the city is calm and the
   * strip is not drawn at all.
   */
  function buildAlerts(frame, { order = SECTOR_ORDER, max = MAX_ALERTS } = {}) {
    const f = frame || {};
    const sectors = f.sectors || {};
    const out = [];
    if (f.alert) {
      out.push({ kind: 'emergency', accent: 'red', key: `alert:${f.alert.id}`,
        head: String(f.alert.title || 'EMERGENCY'), detail: String(f.alert.subtitle || '') });
    }
    const codes = order.filter((c) => sectors[c]);
    for (const c of codes) {
      if (healthState(sectors[c]) === 'dark') out.push({ kind: 'dark', accent: 'red', sector: c, key: `dark:${c}`, head: `⚠ ${c} DARK`, detail: '' });
    }
    const critical = codes.filter((c) => healthState(sectors[c]) === 'critical')
      .sort((a, b) => Number(sectors[a].integrity) - Number(sectors[b].integrity));
    for (const c of critical) {
      out.push({ kind: 'critical', accent: 'red', sector: c, key: `crit:${c}`,
        head: `⚠ ${c} CRITICAL · ${clamp(sectors[c].integrity)}% HEALTH`, detail: '' });
    }
    if (Number.isFinite(Number(f.core_output)) && Number(f.core_output) <= CORE_INSUFFICIENT) {
      out.push({ kind: 'core', accent: 'amber', key: 'core',
        head: `⚠ CORE STABILITY ${clamp(f.core_output)}%`, detail: 'CAPACITY INSUFFICIENT · SECTORS MUST ENTER BROWNOUT' });
    }
    if ((f.council && f.council.active) || f.mode === 'COUNCIL') {
      const c = f.council || {};
      const order_ = f.continuity_order && Array.isArray(f.continuity_order.order) ? f.continuity_order : null;
      const detail = order_
        ? `CONTINUITY ORDER ${order_.order.join(' › ')}${order_.brownout && order_.brownout.length ? ` · BROWNOUT ${order_.brownout.join(' ')}` : ''}`
        : 'CHIEFS + LIAISONS REPORT TO CENTRAL COUNCIL';
      out.push({ kind: 'council', accent: 'purple', key: `council:${c.count || 0}:${c.no_order ? 'no' : ''}:${order_ ? 'o' : ''}`,
        head: c.no_order ? 'NO CONTINUITY ORDER RECEIVED' : 'COUNCIL IN SESSION', detail });
    }
    const t = transferAlert(f.transfers);
    if (t) out.push(t);
    const a = Array.isArray(f.announcements) ? f.announcements[0] : null;
    if (a && a.text && ageS(f.server_time, a.t) <= ANNOUNCEMENT_MAX_AGE_S) {
      out.push({ kind: 'announcement', accent: 'blue', key: `ann:${a.t}`, head: `📣 ${String(a.text).toUpperCase()}`, detail: '' });
    }
    return out.slice(0, max);
  }

  return {
    RES_ORDER, GLYPH, RES_NAME, STATES, STATE_WORD, SECTOR_ORDER, CORE_INSUFFICIENT, ANNOUNCEMENT_MAX_AGE_S, MAX_ALERTS,
    clamp, healthState, healthWord, reported, freshnessLine, reportLine, transferAlert, buildAlerts,
  };
});
