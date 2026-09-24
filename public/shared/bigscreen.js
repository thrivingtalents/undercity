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
  const CARD_RES_ORDER = ['power', 'water', 'parts', 'med'];      // the Big Screen card's order
  const GLYPH = { power: '⚡', water: '💧', med: '⚕', parts: '🔧' };
  const RES_NAME = { power: 'POWER', water: 'WATER', med: 'MEDICAL', parts: 'PARTS' };
  const STATES = ['stable', 'degraded', 'critical', 'dark', 'brownout'];
  const STATE_WORD = { stable: 'STABLE', degraded: 'DEGRADED', critical: 'CRITICAL', dark: 'DARK', brownout: 'BROWNOUT' };
  const SECTOR_ORDER = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];
  /**
   * A sector's IDENTITY colour — who it is, never how it is doing. The Big
   * Screen spec fixes these, and the card keeps them off the status: Medical
   * is red because Medical is red, not because Medical is in trouble.
   */
  const SECTOR_COLOUR = {
    POW: '#FFB31A', WTR: '#22C7F2', MED: '#FF4148', TRN: '#E7EDF2', AGR: '#66D72E', COM: '#A855F7',
  };
  /** A sector's OPERATIONAL colour — how it is doing, never who it is. */
  const STATUS_COLOUR = {
    stable: '#5DD68A', degraded: '#FFB83D', critical: '#FF555D', dark: '#8D98A1', brownout: '#FFB83D', unknown: '#8FA5B8',
  };
  /** The card's words. The map's state tag keeps the short STATE_WORD: its box is narrow. */
  const CARD_WORD = {
    stable: 'STABLE', degraded: 'DEGRADED', critical: 'CRITICAL', dark: 'DARK / OFFLINE', brownout: 'BROWNOUT',
  };
  const AWAITING_REPORT = 'AWAITING REPORT';
  const CORE_INSUFFICIENT = 60;          // the line the Council text already draws
  const ANNOUNCEMENT_MAX_AGE_S = 120;    // a facilitator announcement stays on the strip this long
  const MAX_ALERTS = 4;

  const clamp = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

  /**
   * The Core's condition, from the bands the wall has always drawn it with
   * (85 / 70 / 50 / 30) and the insufficiency line the Council text already
   * uses. No new thresholds: the band decides, this only puts a word and a
   * status colour on it so the room can read the Core at a glance.
   */
  function coreBand(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 'healthy';
    if (n >= 85) return 'healthy';
    if (n >= 70) return 'weaker';
    if (n >= 50) return 'warning';
    if (n >= 30) return 'unstable';
    return 'critical';
  }
  const CORE_WORD = { stable: 'NOMINAL', degraded: 'DEGRADED', critical: 'CRITICAL' };
  function coreStatus(v) {
    const band = coreBand(v);
    const state = band === 'healthy' ? 'stable' : (band === 'weaker' || band === 'warning') ? 'degraded' : 'critical';
    // The insufficiency line is the Council's, and the alert strip already
    // spells it out; here the Core keeps one steady word.
    const insufficient = Number.isFinite(Number(v)) && Number(v) <= CORE_INSUFFICIENT;
    return { band, state, label: CORE_WORD[state], insufficient };
  }

  /**
   * How many of the six COM has reported, as one line for the panel head. It
   * replaces the NO REPORT / NOT UPDATED pair that used to repeat on every
   * card; a card that is still waiting says AWAITING REPORT once.
   */
  function reportSummary(rows, order = SECTOR_ORDER) {
    const r = rows || {};
    const count = order.filter((c) => reported(r[c])).length;
    return { reported: count, total: order.length, text: `REPORTS ${count}/${order.length}` };
  }

  /**
   * The freshness of a report in the width a card has — the word alone.
   *
   * The card now carries the report's own round beside the numbers (R1), so a
   * second stamp counted in cycles would be two different answers to "when".
   * What is left here is the one thing the tag cannot say: whether the room
   * has moved on since. A current report says nothing, because a report that
   * is current needs no mark.
   */
  function freshnessShort(row) {
    const f = freshnessLine(row);
    if (f.level === 'NOT UPDATED' || f.level === 'CURRENT') return { level: f.level, text: '' };
    return { level: f.level, text: f.level };
  }

  /**
   * A health value the room can trust: the number when the frame has one, an
   * em dash when it does not. Nothing here invents 100.
   */
  function healthValue(s) {
    const v = s ? s.integrity : undefined;
    // null is "the frame did not carry one", which is not the same as 0 — a DARK
    // sector really is at 0 and says so.
    if (v === null || v === undefined || v === '') return '—';
    const n = Number(v);
    return Number.isFinite(n) ? String(clamp(n)) : '—';
  }

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

  /** Has COM ever reported this sector? A row with no cycle stamp is a row COM never touched. */
  const reported = (row) => !!row && row.round !== null && row.round !== undefined;

  /** The freshness line under a card: UPDATED CYCLE 2 · STALE, or NOT UPDATED. */
  function freshnessLine(row) {
    if (!reported(row) || row.freshness === 'NOT UPDATED') return { level: 'NOT UPDATED', text: 'NOT UPDATED' };
    const level = String(row.freshness || 'CURRENT');
    return { level, text: `UPDATED CYCLE ${row.round_number} · ${level}` };
  }

  /**
   * The ROUND a report was filed in, as the card's tag: R0 … R4.
   *
   * It comes off the row's own stamp, so it holds still while the game moves
   * on — a POW report filed in Round 1 still reads R1 in Round 2, and only a
   * newer POW report changes it. A row COM never reported has no tag, and a
   * row from a run saved before the stamp existed has none either.
   */
  function reportTag(row) {
    if (!reported(row)) return { show: false, text: '' };
    const n = row.report_round_number;
    if (n === null || n === undefined) return { show: false, text: '' };
    return { show: true, round: Number(n), text: `R${Number(n)}` };
  }

  /** The bar's fill, 0-100. An unknown health draws an empty track, never a full one. */
  function healthPercent(s) {
    const v = healthValue(s);
    return v === '—' ? 0 : Number(v);
  }

  /**
   * What COM reported, in the given order — or NO REPORT, alone.
   *
   * Two spacings, because the two places this is read are different widths.
   * `text` is the airy one a console or a facilitator's screen can afford;
   * `compact` is the one that fits a Big Screen card, which is a sixth of a
   * panel and has to hold four glyphs, four figures and a round tag on one
   * line at a size a projector can carry to the back of a room.
   */
  function reportLine(row, order = RES_ORDER) {
    if (!reported(row)) return { none: true, text: 'NO REPORT', compact: 'NO REPORT', values: [] };
    const values = order.map((key) => ({
      key, glyph: GLYPH[key], value: row[key] === null || row[key] === undefined ? '—' : String(row[key]),
    }));
    const pairs = values.map((v) => `${v.glyph} ${v.value}`);
    return { none: false, text: pairs.join('   '), compact: pairs.join(' '), values };
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
    RES_ORDER, CARD_RES_ORDER, GLYPH, RES_NAME, STATES, STATE_WORD, SECTOR_ORDER, CORE_INSUFFICIENT, ANNOUNCEMENT_MAX_AGE_S, MAX_ALERTS,
    SECTOR_COLOUR, STATUS_COLOUR, CARD_WORD, CORE_WORD, AWAITING_REPORT,
    clamp, healthState, healthWord, reported, freshnessLine, freshnessShort, reportLine, reportSummary, reportTag,
    healthValue, healthPercent, coreBand, coreStatus, transferAlert, buildAlerts,
  };
});
