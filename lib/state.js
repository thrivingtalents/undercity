'use strict';
/**
 * Authoritative game state and its reducers.
 *
 * The server owns everything; clients render what they are told and send
 * intents (contract §0.1). Nothing in here trusts a client, and nothing in
 * here carries a balance number of its own — every rate, threshold and
 * multiplier comes from the scenario (`this.cfg`, see lib/config.js).
 *
 * The economy (`lib/economy.js`) and the crisis systems — council,
 * continuity order, rolling blackout, events, timeline (`lib/crisis.js`) —
 * are mixed into this class so the state stays one object with one tick.
 */

const { ScenarioLibrary } = require('./config');
const economy = require('./economy');

const TICKER_MAX = 80;
const ANNOUNCE_MAX = 30;

/** Ticker kinds the projector shows. Everything else is facilitator detail. */
const WALL_KINDS = new Set([
  'fault', 'resolve', 'status', 'transfer', 'council', 'announce', 'cycle',
  'blackout', 'order', 'expired', 'injury', 'core', 'event', 'phase', 'pause',
]);

class GameState {
  constructor({ content, rounds, scenario = null, runId, log }) {
    this.content = content;
    this.rounds = rounds;
    this.log = log;
    this.faultsByCode = new Map(content.faults.faults.map((f) => [f.code, f]));
    this.stings = [];       // drained by the server after every mutation
    this.changed = 0;       // bumped by touch(); the server broadcasts on change
    this.applyScenario(scenario || new ScenarioLibrary({ rounds, content }).resolve());
    this.reset(runId, { silent: true });
  }

  // -- configuration ----------------------------------------------------------

  applyScenario(scenario) {
    this.scenario = scenario;
    this.cfg = scenario.defaults;
  }

  /** Live patch of the configuration (Admin → SETTINGS). Logged, snapshotted. */
  patchConfig(patch = {}) {
    const { deepMerge } = require('./config');
    this.cfg = deepMerge(this.cfg, patch);
    this.scenario.defaults = this.cfg;
    if (patch.sound_enabled !== undefined) this.state.sound_enabled = !!patch.sound_enabled;
    if (patch.cycle_length_s !== undefined) this.state.cycle.length_s = Number(patch.cycle_length_s);
    this.log.write('config_patched', { patch });
    this.touch();
    return this.cfg;
  }

  /** Per-sector economy edits (starting values apply on the next reset). */
  patchSectorConfig(code, patch = {}) {
    const s = this.state.sectors[code];
    const def = this.scenario.sectors[code];
    if (!s || !def) return false;
    if (patch.production) { def.production = { ...patch.production }; s.production = { ...patch.production }; }
    if (patch.upkeep) { def.upkeep = { ...patch.upkeep }; s.upkeep_per_round = { ...patch.upkeep }; }
    for (const k of ['start_integrity', 'start_workforce']) if (patch[k] !== undefined) def[k] = Number(patch[k]);
    if (patch.start_inventory) def.start_inventory = { ...def.start_inventory, ...patch.start_inventory };
    this.log.write('sector_config_patched', { sector: code, patch });
    this.touch();
    return true;
  }

  // -- lifecycle --------------------------------------------------------------

  reset(runId, { silent = false, scenario = null } = {}) {
    if (scenario) this.applyScenario(scenario);
    const cfg = this.cfg;

    const sectors = {};
    for (const [code, def] of Object.entries(this.content.sectors.sectors)) {
      const sc = this.scenario.sectors[code];
      sectors[code] = {
        code,
        name: def.name,
        colour: def.colour,
        integrity: sc.start_integrity,
        status: 'ACTIVE',
        // Set only by the facilitator (or the Continuity Order / a blackout).
        // Auto-status never overwrites BROWNOUT.
        status_override: null,
        brownout_by: null,
        workforce: { active: sc.start_workforce, injured: 0, loaned: 0, borrowed: 0 },
        inventory: { ...sc.start_inventory },
        production: { ...sc.production },
        upkeep_per_round: { ...sc.upkeep },
        transfers_this_cycle: 0,
        faults: [],
      };
    }

    const firstRound = this.rounds.rounds[0];
    const firstPhase = (this.rounds.phases || [])[0];
    this.state = {
      run_id: runId,
      scenario_id: this.scenario.id,
      scenario_name: this.scenario.name,
      mode: 'BRIEFING',
      phase: firstPhase ? firstPhase.id : 'SETUP',
      phase_started_at: new Date().toISOString(),
      phase_history: [],
      paused: false,
      breather: false,
      round: firstRound.id,
      round_clock: { running: false, remaining_s: firstRound.length_s },
      council_clock: { running: false, remaining_s: cfg.council_clock_s },
      game_clock_s: 0,
      core_integrity: 100,
      city_stability: 100,
      cycle: {
        number: 1, length_s: cfg.cycle_length_s, remaining_s: cfg.cycle_length_s,
        running: false, last_summary: null, processed_at: null, stamped: 0,
      },
      council: {
        active: false, started_at: null, ended_at: null, order: null, order_at: null,
        no_order: false, count: 0,
      },
      continuity_order: null,
      blackout: { active: false, started_at: null, current: [], index: 0, next_rotate_s: 0, restore: {} },
      alert: null,
      effects: [],
      scheduled: [],
      timeline: [],
      transfers: [],
      intel: (this.scenario.intel || []).map((i) => ({ ...i })),
      sound_enabled: cfg.sound_enabled !== false,
      sectors,
      ticker: [],
      announcements: [],
      // 290 is the public half of the seeded discrepancy; the WTR binder
      // prints 340. Both resolve F-201. These are never reconciled (§7).
      telemetry: { wtr_reservoir_pressure: 290, core_output_pct: 100 },
    };

    this.delayed = [];
    this.runbookDone = new Set();
    this.nextId = 1;
    this.armTimeline(firstRound.id);

    if (!silent) this.log.write('run_reset', { run_id: runId, scenario: this.scenario.id });
    this.touch();
  }

  /** Restore from a snapshot written by a previous process. */
  restore(snapshot) {
    if (!snapshot || !snapshot.state) return false;
    if (snapshot.scenario) this.applyScenario(snapshot.scenario);
    // A snapshot from an older build may predate a field; fill gaps from a
    // fresh state so a redeploy mid-run never crashes a projection.
    const fresh = this.state;
    this.state = { ...fresh, ...snapshot.state };
    for (const [code, s] of Object.entries(this.state.sectors)) {
      const base = fresh.sectors[code] || {};
      this.state.sectors[code] = { ...base, ...s, workforce: { ...base.workforce, ...s.workforce } };
    }
    this.delayed = snapshot.delayed || [];
    this.runbookDone = new Set(snapshot.runbook_done || []);
    this.nextId = snapshot.next_id || 1000;
    this.touch();
    return true;
  }

  serialise() {
    return {
      state: this.state,
      scenario: this.scenario,
      delayed: this.delayed,
      runbook_done: [...this.runbookDone],
      next_id: this.nextId,
      saved_at: new Date().toISOString(),
    };
  }

  roundConfig(id = this.state.round) {
    return this.rounds.rounds.find((r) => r.id === id) || this.rounds.rounds[0];
  }

  phaseConfig(id = this.state.phase) {
    return (this.rounds.phases || []).find((p) => p.id === id) || null;
  }

  touch() { this.changed += 1; }

  id(prefix) { return `${prefix}-${String(this.nextId++).padStart(4, '0')}`; }

  /** Is the simulation frozen? Pause, breather and briefing all stop time. */
  get frozen() {
    return this.state.paused || this.state.breather ||
      this.state.mode === 'PAUSED' || this.state.mode === 'BRIEFING';
  }

  // -- feed -------------------------------------------------------------------

  /**
   * `scope`: undefined = everyone (wall included); a sector code = that sector
   * and the facilitator; 'admin' = facilitator only.
   */
  ticker(kind, text, { scope } = {}) {
    const entry = { t: new Date().toISOString(), kind, text };
    if (scope) entry.scope = scope;
    this.state.ticker.unshift(entry);
    if (this.state.ticker.length > TICKER_MAX) this.state.ticker.length = TICKER_MAX;
    this.touch();
  }

  announce(text, { sector = null } = {}) {
    const entry = { t: new Date().toISOString(), text };
    if (sector) entry.sector = sector;
    this.state.announcements.unshift(entry);
    if (this.state.announcements.length > ANNOUNCE_MAX) this.state.announcements.length = ANNOUNCE_MAX;
    this.log.write('announce', { text, sector });
    if (!sector) this.ticker('announce', text);
    this.touch();
  }

  /** Full-screen emergency overlay; clients shrink it after alert_full_screen_s. */
  setAlert({ title, subtitle = '', big = '' }) {
    this.state.alert = {
      id: this.id('A'), title: String(title || '').trim(), subtitle: String(subtitle || ''),
      big: String(big || ''), t: new Date().toISOString(), dismissed: false,
    };
    this.log.write('alert', { title: this.state.alert.title, subtitle: this.state.alert.subtitle });
    this.ticker('event', this.state.alert.title);
    this.sting('alert');
    this.touch();
    return this.state.alert;
  }

  dismissAlert() {
    if (!this.state.alert) return false;
    this.log.write('alert_dismissed', { id: this.state.alert.id });
    this.state.alert = null;
    this.touch();
    return true;
  }

  sting(name) {
    if (!this.state.sound_enabled) return;
    this.stings.push(name);
  }

  drainStings() {
    const out = this.stings;
    this.stings = [];
    return out;
  }

  setSound(on) {
    this.state.sound_enabled = !!on;
    this.log.write('sound', { on: this.state.sound_enabled });
    this.touch();
  }

  // -- status -----------------------------------------------------------------

  /**
   * Derive status from integrity, without clobbering a facilitator override.
   * DARK at the configured floor wins over everything; BROWNOUT is held until
   * lifted by hand or by the blackout rotation.
   */
  refreshStatus(sector) {
    const darkAt = Number(this.cfg.dark_at ?? 0);
    if (sector.integrity <= darkAt) {
      sector.integrity = Math.max(0, sector.integrity);
      if (sector.status !== 'DARK') {
        this.ticker('status', `${sector.code} IS DARK`);
        this.log.write('status', { sector: sector.code, status: 'DARK' });
        this.sting('dark');
        this.touch();
      }
      sector.status = 'DARK';
      return;
    }
    if (sector.status_override === 'BROWNOUT') {
      if (sector.status !== 'BROWNOUT') this.touch();
      sector.status = 'BROWNOUT';
      return;
    }
    if (sector.status_override === 'DARK') {
      sector.status = 'DARK';
      return;
    }
    const next = sector.integrity < this.cfg.critical_below ? 'CRITICAL' : 'ACTIVE';
    if (next !== sector.status) {
      this.log.write('status', { sector: sector.code, status: next });
      if (next === 'CRITICAL') {
        this.ticker('status', `${sector.code} CRITICAL`);
        this.sting('critical');
      }
      this.touch();
    }
    sector.status = next;
  }

  setIntegrity(code, value) {
    const s = this.state.sectors[code];
    if (!s) return false;
    s.integrity = Math.max(0, Math.min(100, Number(value)));
    this.refreshStatus(s);
    this.log.write('set_integrity', { sector: code, value: Math.round(s.integrity * 10) / 10 });
    this.touch();
    return true;
  }

  adjustIntegrity(code, delta) {
    const s = this.state.sectors[code];
    if (!s) return false;
    return this.setIntegrity(code, s.integrity + Number(delta || 0));
  }

  setStatus(code, value, { by = 'facilitator' } = {}) {
    const s = this.state.sectors[code];
    if (!s) return false;
    s.status_override = value === 'ACTIVE' ? null : value;
    s.brownout_by = value === 'BROWNOUT' ? by : null;
    if (value === 'ACTIVE' && s.integrity <= Number(this.cfg.dark_at ?? 0)) {
      // Restoring a sector that is at the floor: give it a foothold.
      s.integrity = Math.max(s.integrity, Number(this.cfg.dark_at ?? 0) + 1);
    }
    s.status = value;
    this.refreshStatus(s);
    this.log.write('set_status', { sector: code, status: value, by });
    this.ticker('status', `${code} → ${value}`);
    if (value === 'BROWNOUT') this.sting('brownout');
    if (value === 'DARK') this.sting('dark');
    this.touch();
    return true;
  }

  /** CORE OUTPUT (%). `core_integrity` is the historical field name. */
  setCoreOutput(value) {
    const before = this.state.core_integrity;
    this.state.core_integrity = Math.max(0, Math.min(100, Math.round(Number(value))));
    this.state.telemetry.core_output_pct = this.state.core_integrity;
    this.log.write('set_core_integrity', { value: this.state.core_integrity });
    this.ticker('core', `CORE OUTPUT ${this.state.core_integrity}%`);
    if (before >= 60 && this.state.core_integrity < 60) this.sting('core_warning');
    this.state.city_stability = economy.computeStability(this);
    this.touch();
  }

  setCoreIntegrity(value) { return this.setCoreOutput(value); }

  setStability({ mode, value }) {
    const st = { ...(this.cfg.stability || {}) };
    if (mode) st.mode = mode === 'manual' ? 'manual' : 'auto';
    if (value !== undefined) st.manual_value = economy.clamp(value);
    this.cfg = { ...this.cfg, stability: st };
    this.scenario.defaults = this.cfg;
    this.state.city_stability = economy.computeStability(this);
    this.log.write('set_stability', { mode: st.mode, value: st.manual_value });
    this.touch();
  }

  setTelemetry(patch = {}) {
    Object.assign(this.state.telemetry, patch);
    this.log.write('set_telemetry', { telemetry: patch });
    this.touch();
  }

  setIntel(key, patch) {
    const item = this.state.intel.find((i) => i.key === key);
    const values = typeof patch === 'object' && patch ? patch : { value: patch };
    if (item) Object.assign(item, values);
    else this.state.intel.push({ key, label: values.label || key.toUpperCase(), value: values.value ?? '—', hidden_in_brownout: !!values.hidden_in_brownout });
    this.log.write('intel', { key, ...values });
    this.touch();
    return true;
  }

  // -- faults -----------------------------------------------------------------

  /** Instantiate a fault definition onto a sector. */
  fireFault(faultCode, sectorCode, { source = 'facilitator' } = {}) {
    const def = this.faultsByCode.get(faultCode);
    if (!def) return { ok: false, reason: 'unknown_fault' };

    const target = sectorCode || def.sector;
    const sector = this.state.sectors[target];
    if (!sector) return { ok: false, reason: 'unknown_sector' };

    if (sector.faults.some((f) => f.code === faultCode && !f.resolved)) {
      return { ok: false, reason: 'already_active' };
    }

    // Deadline: the content's own, else the scenario default for the severity.
    let deadline = def.deadline_s;
    if (deadline == null) {
      const d = (this.cfg.deadline_default_s || {})[String(def.severity)];
      deadline = d == null ? null : Number(d);
    }
    if (deadline != null && sector.status === 'BROWNOUT') {
      deadline = Math.round(deadline * Number(economy.brownoutEffects(this.cfg, target).fault_timer_multiplier ?? 1));
    }

    const crossSector = (def.spec_refs || []).some((r) => r.binder && r.binder !== def.sector);

    const instance = {
      id: this.id('F'),
      code: def.code,
      name: def.name,
      flavour: def.flavour,
      severity: def.severity,
      crew_required: def.crew_required,
      resources_required: { ...def.resources_required },
      decay_per_min: def.decay_per_min,
      deadline_s: deadline,
      deadline_remaining_s: deadline,
      integrity_penalty: Number((this.cfg.deadline_penalty || {})[String(def.severity)] ?? 0),
      attempts: 0,
      // Lifetime `attempts` is what the contract reports; the lockout runs off
      // a separate consecutive counter that any accepted code resets.
      consecutive_invalid: 0,
      locked_until_s: 0,
      lockouts: 0,
      status: 'ACTIVE',
      fired_at: new Date().toISOString(),
      opened_at: null,
      first_action_at: null,
      resolved: false,
      resolved_at: null,
      expired: false,
      expired_at: null,
      paused: false,
      cross_sector: crossSector,
      resources_consumed: null,
      warned_30: false,
      // P2 architectural insurance (spec §9). Null unless a preset/timeline
      // fired it, in which case it names the source.
      triggered_by: source === 'facilitator' ? null : source,
      valid_codes: [...def.valid_codes],
      false_alarm: def.false_alarm,
      procedure: def.procedure,
    };
    sector.faults.push(instance);

    if (def.injures_workforce > 0) {
      this.injure(target, def.injures_workforce);
    }

    this.ticker('fault', `${target} fault detected: ${def.code}`);
    this.log.write('fault_fired', {
      sector: target,
      fault: def.code,
      round: this.state.round,
      severity: def.severity,
      deadline_s: deadline,
      cross_sector: crossSector,
      injures: def.injures_workforce || 0,
      source,
    });
    this.sting(def.severity >= 3 ? 'critical' : 'fault_alert');
    this.touch();
    return { ok: true, fault: instance, sector: target };
  }

  /** The Systems Lead opened this card — time-to-first-action starts here. */
  openFault(sectorCode, faultCode) {
    const fault = this.findFault(sectorCode, faultCode);
    if (!fault) return false;
    if (!fault.opened_at) {
      fault.opened_at = new Date().toISOString();
      if (!fault.first_action_at) fault.first_action_at = fault.opened_at;
      this.ticker('open', `${sectorCode} opened ${faultCode}`, { scope: 'admin' });
      this.log.write('fault_opened', { sector: sectorCode, fault: faultCode });
      this.touch();
    }
    return true;
  }

  /**
   * Injured workers leave the sector and appear in MED's injured pile — the
   * server does this so the facilitator never has to remember (contract §4).
   */
  injure(sectorCode, count) {
    const sector = this.state.sectors[sectorCode];
    if (!sector) return 0;
    const moved = Math.min(Number(count) || 0, sector.workforce.active);
    sector.workforce.active -= moved;
    sector.workforce.injured += moved;
    this.log.write('injury', { sector: sectorCode, count: moved });
    if (moved > 0) this.ticker('injury', `${sectorCode}: ${moved} worker${moved > 1 ? 's' : ''} injured`);
    this.touch();
    return moved;
  }

  recover(sectorCode, count) {
    const sector = this.state.sectors[sectorCode];
    if (!sector) return 0;
    const moved = Math.min(Number(count) || 0, sector.workforce.injured);
    sector.workforce.injured -= moved;
    sector.workforce.active += moved;
    this.log.write('worker_recovered', { sector: sectorCode, count: moved, by: 'facilitator' });
    if (moved > 0) this.ticker('injury', `${sectorCode}: ${moved} worker${moved > 1 ? 's' : ''} recovered`);
    this.touch();
    return moved;
  }

  /** Workers a sector can actually put on a fault right now. */
  availableWorkers(sector) {
    let n = sector.workforce.active;
    if (sector.status === 'BROWNOUT') {
      n -= Number(economy.brownoutEffects(this.cfg, sector.code).worker_penalty ?? 0);
    }
    return Math.max(0, n);
  }

  findFault(sectorCode, faultCode) {
    const sector = this.state.sectors[sectorCode];
    if (!sector) return null;
    return sector.faults.find((f) => f.code === faultCode && !f.resolved) || null;
  }

  clearFault(sectorCode, faultCode, reason) {
    const fault = this.findFault(sectorCode, faultCode);
    if (!fault) return false;
    fault.resolved = true;
    fault.status = 'CLEARED';
    fault.resolved_at = new Date().toISOString();
    fault.cleared_by_facilitator = true;
    this.ticker('clear', `${sectorCode} ${faultCode} cleared — ${reason || 'facilitator'}`);
    this.log.write('fault_cleared', { sector: sectorCode, fault: faultCode, reason: reason || null });
    this.touch();
    return true;
  }

  accelerateFault(sectorCode, faultCode, decayPerMin) {
    const fault = this.findFault(sectorCode, faultCode);
    if (!fault) return false;
    fault.decay_per_min = Number(decayPerMin);
    this.log.write('accelerate_fault', {
      sector: sectorCode, fault: faultCode, decay_per_min: fault.decay_per_min,
    });
    this.touch();
    return true;
  }

  pauseFault(sectorCode, faultCode, paused) {
    const fault = this.findFault(sectorCode, faultCode);
    if (!fault) return false;
    fault.paused = !!paused;
    this.log.write('pause_fault', { sector: sectorCode, fault: faultCode, paused: fault.paused });
    this.touch();
    return true;
  }

  addFaultTime(sectorCode, faultCode, seconds) {
    const fault = this.findFault(sectorCode, faultCode);
    if (!fault || fault.deadline_remaining_s == null) return false;
    fault.deadline_remaining_s = Math.max(0, fault.deadline_remaining_s + Number(seconds || 0));
    this.log.write('fault_time_added', { sector: sectorCode, fault: faultCode, seconds: Number(seconds) });
    this.touch();
    return true;
  }

  /** Deadline reached: penalty once, status EXPIRED, decay continues. */
  expireFault(sector, fault) {
    fault.expired = true;
    fault.expired_at = new Date().toISOString();
    fault.status = 'EXPIRED';
    const penalty = fault.integrity_penalty || 0;
    if (penalty > 0) sector.integrity = Math.max(0, sector.integrity - penalty);
    this.ticker('expired', `${sector.code} ${fault.code} DEADLINE PASSED${penalty ? ` −${penalty} INTEGRITY` : ''}`);
    this.log.write('deadline_expired', { sector: sector.code, fault: fault.code, penalty });
    this.sting('critical');
    if (!this.cfg.expired_faults_remain_solvable) {
      fault.resolved = true;
      fault.status = 'FAILED';
      fault.resolved_at = fault.expired_at;
      this.log.write('fault_failed', { sector: sector.code, fault: fault.code });
    }
    this.touch();
  }

  // -- workforce / inventory --------------------------------------------------

  adjustWorkforce(code, activeDelta = 0, injuredDelta = 0) {
    const s = this.state.sectors[code];
    if (!s) return false;
    s.workforce.active = Math.max(0, s.workforce.active + Number(activeDelta || 0));
    s.workforce.injured = Math.max(0, s.workforce.injured + Number(injuredDelta || 0));
    this.log.write('adjust_workforce', { sector: code, workforce: { ...s.workforce } });
    this.touch();
    return true;
  }

  adjustInventory(code, delta = {}, { reason = 'facilitator' } = {}) {
    const s = this.state.sectors[code];
    if (!s) return false;
    for (const [k, v] of Object.entries(delta)) {
      if (!(k in s.inventory)) continue;
      s.inventory[k] = Math.max(0, s.inventory[k] + Number(v || 0));
    }
    this.log.write('adjust_inventory', { sector: code, delta, reason, inventory: { ...s.inventory } });
    this.touch();
    return true;
  }

  /**
   * A declaration, not a transaction (contract §3). With auto_economy off the
   * physical chits are the source of truth; with it on this is the team's
   * correction of the digital count, and the divergence is still logged.
   */
  setInventory(code, inventory = {}) {
    const s = this.state.sectors[code];
    if (!s) return false;
    for (const [k, v] of Object.entries(inventory)) {
      if (!(k in s.inventory)) continue;
      s.inventory[k] = Math.max(0, Number(v) || 0);
    }
    this.log.write('inventory_declared', { sector: code, inventory: { ...s.inventory } });
    this.touch();
    return true;
  }

  // -- transfers --------------------------------------------------------------

  /** TRN's capacity this cycle after brownout and temporary effects. */
  trnCapacity() {
    let cap = Number(this.cfg.trn_capacity_per_cycle ?? 3);
    const trn = this.state.sectors.TRN;
    if (trn && trn.status === 'BROWNOUT') {
      const eff = economy.brownoutEffects(this.cfg, 'TRN');
      if (eff.transfer_capacity !== undefined) cap = Number(eff.transfer_capacity);
    }
    if (trn && trn.status === 'DARK') cap = 0;
    for (const e of this.state.effects) {
      if (e.kind !== 'trn_capacity') continue;
      if (e.value !== undefined) cap = Number(e.value);
      if (e.delta !== undefined) cap += Number(e.delta);
    }
    return Math.max(0, cap);
  }

  transfersStampedThisCycle() {
    return Number(this.state.cycle.stamped || 0);
  }

  requestTransfer({ from, to, resource, amount, note = '', by = 'sector' }) {
    const a = this.state.sectors[from];
    const b = this.state.sectors[to];
    const qty = Math.max(1, Math.floor(Number(amount) || 0));
    const okResource = resource === 'workers' || (a && resource in a.inventory);
    if (!a || !b || a === b || !okResource) return { ok: false, reason: 'bad_request' };

    const now = new Date().toISOString();
    const transfer = {
      id: this.id('T'), from, to, resource, amount: qty, note: String(note || '').slice(0, 120),
      status: 'REQUESTED', requested_at: now, requested_by: by,
      agreed_at: null, waiting_at: null, stamped_at: null, delivered_at: null, cancelled_at: null,
    };
    this.state.transfers.unshift(transfer);
    if (this.state.transfers.length > 60) this.state.transfers.length = 60;
    this.ticker('transfer', `Transfer requested ${from} → ${to}: ${qty} ${resource}`);
    this.log.write('transfer_requested', { id: transfer.id, from, to, resource, amount: qty, by });
    this.touch();
    return { ok: true, transfer };
  }

  findTransfer(id) {
    return this.state.transfers.find((t) => t.id === id) || null;
  }

  /** Move a transfer along its lifecycle. STAMPED is the only step that moves stock. */
  updateTransfer(id, status, { by = 'facilitator' } = {}) {
    const t = this.findTransfer(id);
    if (!t) return { ok: false, reason: 'unknown_transfer' };
    if (['DELIVERED', 'CANCELLED'].includes(t.status)) return { ok: false, reason: 'transfer_closed' };
    const now = new Date().toISOString();

    switch (status) {
      case 'AGREED':       t.status = 'AGREED'; t.agreed_at = now; break;
      case 'WAITING_TRN':  t.status = 'WAITING_TRN'; t.waiting_at = t.waiting_at || now; break;
      case 'STAMPED':      return this.stampTransfer(id, { by });
      case 'DELIVERED': {
        if (!t.stamped_at) return { ok: false, reason: 'not_stamped' };
        t.status = 'DELIVERED'; t.delivered_at = now;
        this.ticker('transfer', `Delivered ${t.from} → ${t.to}: ${t.amount} ${t.resource}`);
        break;
      }
      case 'CANCELLED':
        t.status = 'CANCELLED'; t.cancelled_at = now;
        this.ticker('transfer', `Transfer ${t.from} → ${t.to} cancelled`, { scope: 'admin' });
        break;
      default:
        return { ok: false, reason: 'bad_status' };
    }
    this.log.write('transfer_' + status.toLowerCase(), { id, from: t.from, to: t.to, resource: t.resource, amount: t.amount, by });
    this.touch();
    return { ok: true, transfer: t };
  }

  stampTransfer(id, { by = 'TRN', force = false } = {}) {
    const t = this.findTransfer(id);
    if (!t) return { ok: false, reason: 'unknown_transfer' };
    if (t.stamped_at) return { ok: false, reason: 'already_stamped' };
    if (['DELIVERED', 'CANCELLED'].includes(t.status)) return { ok: false, reason: 'transfer_closed' };

    const cap = this.trnCapacity();
    const used = this.transfersStampedThisCycle();
    if (!force && used >= cap) {
      this.log.write('transfer_refused', { id, reason: 'capacity', capacity: cap, used, by });
      return { ok: false, reason: 'capacity', capacity: cap, used };
    }

    const from = this.state.sectors[t.from];
    const to = this.state.sectors[t.to];
    const now = new Date().toISOString();
    let moved = t.amount;

    if (this.cfg.auto_economy) {
      if (t.resource === 'workers') {
        moved = Math.min(t.amount, from.workforce.active);
        from.workforce.active -= moved;
        from.workforce.loaned += moved;
        to.workforce.active += moved;
        to.workforce.borrowed += moved;
      } else {
        moved = Math.min(t.amount, from.inventory[t.resource] || 0);
        from.inventory[t.resource] -= moved;
        to.inventory[t.resource] = (to.inventory[t.resource] || 0) + moved;
      }
    }

    t.status = 'STAMPED';
    t.stamped_at = now;
    t.moved = moved;
    this.state.cycle.stamped = Number(this.state.cycle.stamped || 0) + 1;
    if (this.cfg.deliver_on_stamp) { t.status = 'DELIVERED'; t.delivered_at = now; }
    this.ticker('transfer', `TRN stamped ${t.from} → ${t.to}: ${moved} ${t.resource}`);
    this.log.write('transfer_stamped', {
      id, from: t.from, to: t.to, resource: t.resource, amount: t.amount, moved, by,
      capacity: cap, used_after: used + 1, delivered: !!t.delivered_at,
    });
    this.sting('chime');
    this.touch();
    return { ok: true, transfer: t };
  }

  // -- tempo ------------------------------------------------------------------

  setPhase(id) {
    const def = this.phaseConfig(id);
    if (!def) return false;
    const prev = this.state.phase;
    this.state.phase_history.push({ phase: prev, ended_at: new Date().toISOString() });
    this.state.phase = def.id;
    this.state.phase_started_at = new Date().toISOString();
    if (this.log.setContext) this.log.setContext({ round: def.round, phase: def.id });
    if (def.round !== this.state.round) this.setRound(def.round);
    this.setMode(def.mode);
    this.log.write('phase', { phase: def.id, from: prev, round: this.state.round, mode: def.mode });
    this.ticker('phase', `${def.name.toUpperCase()}`);
    this.touch();
    return true;
  }

  nextPhase() {
    const phases = this.rounds.phases || [];
    const i = phases.findIndex((p) => p.id === this.state.phase);
    if (i < 0 || i >= phases.length - 1) return false;
    return this.setPhase(phases[i + 1].id);
  }

  setRound(id) {
    const cfg = this.roundConfig(id);
    this.state.round = cfg.id;
    this.state.round_clock = { running: false, remaining_s: cfg.length_s };
    this.state.cycle.running = false;
    this.armTimeline(cfg.id);
    if (this.log.setContext) this.log.setContext({ round: cfg.id, phase: this.state.phase });
    this.log.write('round', { round: cfg.id });
    this.ticker('round', `${cfg.id} — ${cfg.name}`);
    this.touch();
  }

  setMode(mode) {
    if (mode === 'COUNCIL' && !this.state.council.active) return this.callCouncil();
    if (this.state.mode === 'COUNCIL' && mode !== 'COUNCIL' && this.state.council.active) {
      this.endCouncil('mode changed');
    }
    this.state.mode = mode;
    this.log.write('mode', { mode });
    this.touch();
    return true;
  }

  /** START / PAUSE / RESUME / END for the round (and the city cycle with it). */
  clock(action, seconds, which = 'round') {
    const clk = which === 'council' ? this.state.council_clock : this.state.round_clock;
    if (action === 'start' || action === 'resume') {
      clk.running = true;
      if (which === 'round') {
        if (this.state.mode === 'BRIEFING') this.state.mode = 'PLAY';
        if (this.cfg.cycle_autostart) this.state.cycle.running = true;
      }
    } else if (action === 'pause') {
      clk.running = false;
      if (which === 'round') this.state.cycle.running = false;
    } else if (action === 'end') {
      clk.running = false;
      clk.remaining_s = 0;
      if (which === 'round') this.state.cycle.running = false;
    } else if (action === 'add') {
      clk.remaining_s = Math.max(0, clk.remaining_s + Number(seconds || 0));
    } else if (action === 'set') {
      clk.remaining_s = Math.max(0, Number(seconds || 0));
    }
    this.log.write('clock', { which, action, seconds: seconds ?? null, remaining_s: Math.ceil(clk.remaining_s) });
    this.touch();
  }

  cycleControl(action, seconds) {
    const c = this.state.cycle;
    if (action === 'start') c.running = true;
    else if (action === 'pause') c.running = false;
    else if (action === 'set') c.remaining_s = Math.max(0, Number(seconds || 0));
    else if (action === 'add') c.remaining_s = Math.max(0, c.remaining_s + Number(seconds || 0));
    else if (action === 'process') return economy.processCycle(this);
    this.log.write('cycle_clock', { action, seconds: seconds ?? null, remaining_s: Math.ceil(c.remaining_s) });
    this.touch();
    return null;
  }

  /** PAUSE freezes every timer; RESUME continues from the exact remaining times. */
  pause() {
    if (this.state.paused) return false;
    this.state.paused = true;
    this.log.write('pause', { on: true });
    this.ticker('pause', 'SIMULATION PAUSED');
    this.touch();
    return true;
  }

  resume() {
    if (!this.state.paused) return false;
    this.state.paused = false;
    this.log.write('pause', { on: false });
    this.ticker('pause', 'SIMULATION RESUMED');
    this.touch();
    return true;
  }

  setBreather(on) {
    this.state.breather = !!on;
    if (on) {
      this.state.round_clock.running = false;
      this.state.council_clock.running = false;
      this.state.cycle.running = false;
    }
    this.log.write('breather', { on: this.state.breather });
    this.ticker('breather', on ? 'BREATHER — systems holding' : 'BREATHER OVER');
    this.touch();
  }

  // -- effects ----------------------------------------------------------------

  hasEffect(kind, target = null) {
    return this.state.effects.some((e) => e.kind === kind && (target === null || e.target === target || e.target === 'ALL'));
  }

  addEffect(effect) {
    const e = { id: this.id('E'), ...effect };
    this.state.effects.push(e);
    this.log.write('effect_started', { ...e });
    this.touch();
    return e;
  }

  removeEffect(id) {
    const i = this.state.effects.findIndex((e) => e.id === id);
    if (i < 0) return false;
    const [e] = this.state.effects.splice(i, 1);
    this.log.write('effect_ended', { id: e.id, kind: e.kind, target: e.target });
    this.touch();
    return true;
  }

  expireCycleEffects() {
    for (const e of [...this.state.effects]) {
      if (e.cycles_remaining === undefined) continue;
      e.cycles_remaining -= 1;
      if (e.cycles_remaining <= 0) this.removeEffect(e.id);
    }
  }

  /**
   * COM's sensors. Hard-blind (DARK, or a comms blackout effect) hides
   * everything; a brownout with lose_telemetry hides the foreign fault feed,
   * while intelligence items follow their own hidden_in_brownout flag.
   */
  comHardBlind() {
    const com = this.state.sectors.COM;
    if (!com) return false;
    return com.status === 'DARK' || this.hasEffect('com_blind');
  }

  comBlind() {
    const com = this.state.sectors.COM;
    if (!com) return false;
    if (this.comHardBlind()) return true;
    return com.status === 'BROWNOUT' && !!economy.brownoutEffects(this.cfg, 'COM').lose_telemetry;
  }

  // -- the tick ---------------------------------------------------------------

  /**
   * Decay, clocks and countdowns. Pause, breather and BRIEFING freeze
   * everything except the lockout timer — a locked console still unlocks.
   */
  tick(elapsedMs) {
    const secs = elapsedMs / 1000;
    const frozen = this.frozen;

    for (const sector of Object.values(this.state.sectors)) {
      const brown = sector.status === 'BROWNOUT' ? economy.brownoutEffects(this.cfg, sector.code) : null;
      const timerRate = brown && brown.fault_timer_multiplier ? 1 / Number(brown.fault_timer_multiplier) : 1;

      for (const fault of sector.faults) {
        if (fault.resolved) continue;
        if (fault.locked_until_s > 0) {
          fault.locked_until_s = Math.max(0, fault.locked_until_s - secs);
          if (fault.locked_until_s === 0) this.touch();
        }
        if (frozen) continue;
        if (!fault.paused && fault.decay_per_min > 0 && sector.status !== 'DARK') {
          sector.integrity = Math.max(0, sector.integrity - (fault.decay_per_min * secs) / 60);
        }
        if (fault.deadline_remaining_s !== null && fault.deadline_remaining_s > 0 && !fault.paused) {
          fault.deadline_remaining_s = Math.max(0, fault.deadline_remaining_s - secs * timerRate);
          if (fault.deadline_remaining_s <= 30 && !fault.warned_30) {
            fault.warned_30 = true;
            this.sting('warning_30');
          }
          if (fault.deadline_remaining_s === 0 && !fault.expired) this.expireFault(sector, fault);
        }
      }

      if (!frozen) {
        // Brownout sectors bleed slowly even with no active fault (spec §3.6).
        if (brown) {
          sector.integrity = Math.max(0, sector.integrity - (Number(brown.decay_per_min ?? 0) * secs) / 60);
        }
      }
      this.refreshStatus(sector);
    }

    if (!frozen) {
      this.state.game_clock_s += secs;

      for (const clk of [this.state.round_clock, this.state.council_clock]) {
        if (clk.running && clk.remaining_s > 0) {
          clk.remaining_s = Math.max(0, clk.remaining_s - secs);
          if (clk.remaining_s === 0) this.touch();
        }
      }
      if (this.state.council.active) this.tickCouncil();

      const cycle = this.state.cycle;
      if (cycle.running && cycle.remaining_s > 0) {
        cycle.remaining_s = Math.max(0, cycle.remaining_s - secs);
        if (cycle.remaining_s === 0) economy.processCycle(this);
      }

      for (const e of [...this.state.effects]) {
        if (e.remaining_s === undefined) continue;
        e.remaining_s = Math.max(0, e.remaining_s - secs);
        if (e.remaining_s === 0) this.removeEffect(e.id);
      }

      this.tickBlackout(secs);
      this.tickScheduled();
      this.tickTimeline();
    }

    this.state.city_stability = economy.computeStability(this);
    this.sampleDelayed();
  }

  // -- the delayed city feed --------------------------------------------------

  /**
   * Other sectors are visible to participants only as they were 60 s ago.
   * The buffer is kept server-side so the live numbers never reach a
   * participant client at all (contract §2).
   */
  sampleDelayed() {
    const now = Date.now();
    const frame = { t: now, sectors: {} };
    for (const [code, s] of Object.entries(this.state.sectors)) {
      frame.sectors[code] = { integrity: Math.round(s.integrity), status: s.status };
    }
    this.delayed.push(frame);
    const cutoff = now - this.cfg.delay_window_s * 1000 * 3;
    while (this.delayed.length > 2 && this.delayed[0].t < cutoff) this.delayed.shift();
  }

  /** The newest frame at least `delay_window_s` old, or the oldest we hold. */
  delayedView() {
    const cutoff = Date.now() - this.cfg.delay_window_s * 1000;
    let chosen = null;
    for (const frame of this.delayed) {
      if (frame.t <= cutoff) chosen = frame;
      else break;
    }
    if (chosen) return chosen.sectors;

    // Early in a run nothing is old enough yet: show starting values rather
    // than leaking the present.
    const start = {};
    for (const code of Object.keys(this.content.sectors.sectors)) {
      start[code] = { integrity: this.scenario.sectors[code].start_integrity, status: 'ACTIVE' };
    }
    return start;
  }
}

Object.assign(GameState.prototype, require('./crisis'));

module.exports = { GameState, WALL_KINDS };
