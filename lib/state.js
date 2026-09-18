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
const AGR_CARDS = require('./agr-cards.json');
const rewards = require('./rewards');

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
    // A new length for the CURRENT round takes effect at once while its clock
    // is not running (SETUP, or between rounds); a running clock is never
    // yanked from under the room.
    const lengths = patch.round_length_s || {};
    if (lengths[this.state.round] !== undefined && !this.state.round_clock.running) {
      this.state.round_clock.remaining_s = Number(lengths[this.state.round]);
    }
    for (const s of Object.values(this.state.sectors)) this.refreshStatus(s);
    this.log.write('config_patched', { patch });
    this.touch();
    return this.cfg;
  }

  /**
   * Per-fault tuning (spec §44): EXTRA
   * accepted codes for one fault code. `patch` null removes the override.
   * Applies to faults fired from now on; the canonical answer from the
   * content is never removed, so paper and server cannot fall out of sync.
   */
  setFaultOverride(faultCode, patch) {
    const code = String(faultCode || '').toUpperCase().trim();
    if (!this.faultsByCode.has(code)) return { ok: false, reason: 'unknown_fault' };
    const overrides = { ...(this.cfg.fault_overrides || {}) };
    if (patch === null || patch === undefined) {
      delete overrides[code];
    } else {
      const clean = {};
      if (Array.isArray(patch.extra_valid_codes)) {
        clean.extra_valid_codes = [...new Set(patch.extra_valid_codes.map((c) => String(c || '').trim().toUpperCase()).filter(Boolean))];
      }
      overrides[code] = clean;
    }
    this.cfg = { ...this.cfg, fault_overrides: overrides };
    this.scenario.defaults = this.cfg;
    this.log.write('fault_override', { fault: code, override: overrides[code] || null });
    this.touch();
    return { ok: true, fault: code, override: overrides[code] || null };
  }

  /** The status word a screen prints for a sector — thresholds from the scenario. */
  statusWord(sector) {
    return economy.statusWord(this.cfg, sector);
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
      round_clock: { running: false, started: false, remaining_s: firstRound.length_s },
      council_clock: { running: false, remaining_s: cfg.council_clock_s },
      game_clock_s: 0,
      core_integrity: economy.clamp(cfg.core_start_output ?? 100),
      city_stability: 100,
      cycle: {
        number: 1, length_s: cfg.cycle_length_s, remaining_s: cfg.cycle_length_s,
        running: false, last_summary: null, processed_at: null, stamped: 0,
      },
      // Transport's stamp allowance, counted per round (the default basis).
      // `cycle.stamped` is the same count per cycle; both are kept.
      // Two per-round allowances, counted only on success. `cycle.stamped` is
      // the same transport count per cycle, kept for the legacy basis.
      trn_approvals_used_this_round: 0,
      med_heals_used_this_round: 0,
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
      requests: [],
      transfers: [],
      healing: [],
      // COM's hand-maintained public board (never read from inventory) and
      // AGR's dealt hand for the round (dealt once, kept here, never rerolled
      // by a render). Both are filled in below once sectors exist.
      broadcast: null,
      // Fault rewards claimed this run, by fault code. Once each, ever, per run.
      rewards_claimed: {},
      // v17: the scarcity guardrail's two counters, and each sector's last archetype (anti-repeat).
      repair_material_units_consumed: 0,
      // v17.3: the scarcity budget's basis (binder units of issued, uncancelled faults),
      // what unresolved rewards have reserved, and what paid rewards have created.
      repair_material_units_issued: 0,
      fault_reward_resource_units_reserved: 0,
      fault_reward_resource_units_generated: 0,
      reward_last: {},
      agr: { round: null, offered: [], selected: null, used: false, target: null, previous: [], reroll_count: 0, history: [] },
      intel: (this.scenario.intel || []).map((i) => ({ ...i })),
      sound_enabled: cfg.sound_enabled !== false,
      sectors,
      ticker: [],
      announcements: [],
      // 290 is the public half of the seeded discrepancy; the WTR binder
      // prints 340. Both resolve F-201. These are never reconciled (§7).
      telemetry: { wtr_reservoir_pressure: 290, core_output_pct: economy.clamp(cfg.core_start_output ?? 100) },
    };
    this.state.city_stability = economy.computeStability(this);
    this.state.broadcast = this.emptyBroadcast();

    this.delayed = [];
    this.runbookDone = new Set();
    this.nextId = 1;
    this.armTimeline(firstRound.id);

    if (!silent) this.log.write('run_reset', { run_id: runId, scenario: this.scenario.id });
    this.agrEnsureOffer({ by: 'reset' });
    this.touch();
  }

  /** Restore from a snapshot written by a previous process. */
  restore(snapshot) {
    if (!snapshot || !snapshot.state) return false;
    if (snapshot.scenario) {
      // The saved scenario keeps every live edit the facilitator made, but a
      // newer build may know settings the snapshot predates: fill those from
      // the freshly resolved defaults so a redeploy mid-run never leaves a
      // hole in the configuration.
      const { deepMerge } = require('./config');
      this.applyScenario({
        ...snapshot.scenario,
        defaults: deepMerge(this.cfg, snapshot.scenario.defaults || {}),
      });
    }
    // A snapshot from an older build may predate a field; fill gaps from a
    // fresh state so a redeploy mid-run never crashes a projection.
    const fresh = this.state;
    this.state = { ...fresh, ...snapshot.state };
    for (const [code, s] of Object.entries(this.state.sectors)) {
      const base = fresh.sectors[code] || {};
      this.state.sectors[code] = { ...base, ...s, workforce: { ...base.workforce, ...s.workforce } };
    }
    this.migrateTransfers();
    // A snapshot from the deadline era: strip every clock field, reopen a
    // fault a clock had marked EXPIRED, and never fire a penalty for it.
    for (const sec of Object.values(this.state.sectors)) {
      for (const f of sec.faults || []) {
        for (const k of ['deadline', 'deadline_s', 'deadline_remaining_s', 'deadline_at', 'time_remaining', 'time_limit',
          'integrity_penalty', 'expired', 'expired_at', 'warned_30']) delete f[k];
        if (!f.resolved && f.status === 'EXPIRED') f.status = 'ACTIVE';
      }
    }
    if (!this.state.broadcast || !this.state.broadcast.rows) this.state.broadcast = this.emptyBroadcast();
    for (const code of Object.keys(this.state.sectors)) {
      if (!this.state.broadcast.rows[code]) this.state.broadcast.rows[code] = { power: null, water: null, med: null, parts: null, round: null };
    }
    if (!this.state.agr || !Array.isArray(this.state.agr.offered)) {
      this.state.agr = { round: null, offered: [], selected: null, used: false, target: null, previous: [], reroll_count: 0, history: [] };
    }
    if (!this.state.rewards_claimed || typeof this.state.rewards_claimed !== 'object') this.state.rewards_claimed = {};
    if (typeof this.state.repair_material_units_consumed !== 'number') this.state.repair_material_units_consumed = 0;
    if (typeof this.state.fault_reward_resource_units_generated !== 'number') this.state.fault_reward_resource_units_generated = 0;
    if (typeof this.state.repair_material_units_issued !== 'number') this.state.repair_material_units_issued = 0;
    if (typeof this.state.fault_reward_resource_units_reserved !== 'number') this.state.fault_reward_resource_units_reserved = 0;
    for (const s of Object.values(this.state.sectors || {})) {
      for (const f of s.faults || []) {
        if (typeof f.wrong_code_attempts !== 'number') f.wrong_code_attempts = 0;
        if (typeof f.material_units !== 'number') f.material_units = rewards.units(f.resources_required);
        if (typeof f.reward_resource_units_reserved !== 'number') f.reward_resource_units_reserved = 0;
        if (typeof f.reward_applied !== 'boolean') f.reward_applied = !!(this.state.rewards_claimed && this.state.rewards_claimed[f.id]);
        if (f.issued_round === undefined) f.issued_round = null;
      }
    }
    if (!this.state.reward_last || typeof this.state.reward_last !== 'object') this.state.reward_last = {};
    // A fault from before v17 has no dealt reward: deal it now, once, from its tier.
    for (const [code, sec] of Object.entries(this.state.sectors)) {
      for (const f of sec.faults || []) if (!f.resolved && f.reward === undefined) f.reward = rewards.assign(this, code, f);
    }
    this.agrEnsureOffer({ by: 'restore' });
    this.delayed = snapshot.delayed || [];
    this.runbookDone = new Set(snapshot.runbook_done || []);
    this.nextId = snapshot.next_id || 1000;
    this.touch();
    return true;
  }

  /**
   * A snapshot written before requests and transfers were separated holds one
   * `transfers[]` where REQUESTED meant "asked". Split it on the way in, so a
   * redeploy mid-round does not strand a live session's paperwork.
   */
  migrateTransfers() {
    const st = this.state;
    if (!Array.isArray(st.requests)) st.requests = [];
    if (!Array.isArray(st.healing)) st.healing = [];
    if (st.trn_approvals_used_this_round === undefined) {
      st.trn_approvals_used_this_round = Number(st.stamps_this_round || 0);
    }
    if (st.med_heals_used_this_round === undefined) st.med_heals_used_this_round = 0;
    delete st.stamps_this_round;

    const keep = [];
    for (const t of st.transfers || []) {
      if (t.supplier || t.requester) { st.requests.push(t); continue; }   // already a request
      switch (t.status) {
        case 'REQUESTED':
          st.requests.push({
            ...t, supplier: t.from, requester: t.to, transfer_id: null, fulfilled_at: null,
          });
          continue;
        case 'DECLINED':
          st.requests.push({
            ...t, supplier: t.from, requester: t.to, status: 'DECLINED_BY_SUPPLIER',
          });
          continue;
        case 'AGREED':
        case 'WAITING_TRN':
          keep.push({ ...t, status: 'PENDING_TRN_APPROVAL', created_by: t.from, request_id: null });
          continue;
        case 'STAMPED':
          keep.push({ ...t, status: 'APPROVED', approved_at: t.stamped_at, approved_by: 'TRN' });
          continue;
        default:
          keep.push({ ...t, approved_at: t.approved_at ?? t.stamped_at ?? null });
      }
    }
    st.transfers = keep;
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

  /** Round definition with the scenario's `round_length_s` override applied (spec §44). */
  roundConfig(id = this.state.round) {
    const base = this.rounds.rounds.find((r) => r.id === id) || this.rounds.rounds[0];
    const over = (this.cfg.round_length_s || {})[base.id];
    if (over === undefined || over === null || over === '') return base;
    return { ...base, length_s: Math.max(0, Number(over) || 0) };
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

    // There is no deadline: decay is the only clock on a fault. An old
    // `deadline_s` in the content or in an override is read and ignored.
    const override = (this.cfg.fault_overrides || {})[def.code] || {};
    // Extra accepted codes are ADDED to the content's answer, never replace it.
    const validCodes = [...new Set([...def.valid_codes, ...(override.extra_valid_codes || [])])];

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
      paused: false,
      cross_sector: crossSector,
      resources_consumed: null,
      // P2 architectural insurance (spec §9). Null unless a preset/timeline
      // fired it, in which case it names the source.
      triggered_by: source === 'facilitator' ? null : source,
      valid_codes: validCodes,
      false_alarm: def.false_alarm,
      procedure: def.procedure,
      // v17.3: the round it was issued in, the wrong-code counter the card
      // shows, and the budget bookkeeping the reward runs on.
      issued_round: this.state.round,
      wrong_code_attempts: 0,
      material_units: rewards.units(def.resources_required),
      material_units_issued: false,
      reward_resource_units_reserved: 0,
      reward_applied: false,
    };
    // v17.3: a reward-bearing fault's binder units join the budget basis first;
    // then ONE exact reward is dealt, its stock reserved, and both persist with
    // the instance. Nothing after this can change what the card says.
    if (this.cfg.fault_rewards_enabled !== false && instance.material_units > 0) {
      this.state.repair_material_units_issued = Number(this.state.repair_material_units_issued || 0) + instance.material_units;
      instance.material_units_issued = true;
    }
    instance.reward = rewards.assign(this, target, instance);
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
    for (const e of this.state.effects) {
      if (e.kind === 'extra_workers' && e.target === sector.code) n += Number(e.delta) || 0;
    }
    return Math.max(0, n);
  }

  findFault(sectorCode, faultCode) {
    const sector = this.state.sectors[sectorCode];
    if (!sector) return null;
    return sector.faults.find((f) => f.code === faultCode && !f.resolved) || null;
  }

  clearFault(sectorCode, faultCode, reason, { withReward = false } = {}) {
    const fault = this.findFault(sectorCode, faultCode);
    if (!fault) return false;
    fault.resolved = true;
    fault.status = 'CLEARED';
    fault.resolved_at = new Date().toISOString();
    fault.cleared_by_facilitator = true;
    this.ticker('clear', `${sectorCode} ${faultCode} cleared — ${reason || 'facilitator'}`);
    this.log.write('fault_cleared', { sector: sectorCode, fault: faultCode, reason: reason || null });
    // A ghost (no procedure at all) has no other way to finish: the clear IS
    // its completion. Clearing a real fault is a force-resolve, unrewarded by
    // default so troubleshooting never moves the economy.
    const ghost = Array.isArray(fault.valid_codes) && fault.valid_codes.length === 0;
    const via = ghost && this.cfg.reward_on_false_alarm_clear !== false ? 'false_alarm_clear' : 'force';
    fault.reward_result = this.applyFaultReward(sectorCode, fault, { via, by: 'facilitator', force: !ghost && !!withReward });
    // A clear that pays nothing is a cancellation for the budget: its reserved
    // stock and its binder units leave the books. A stabilisation on it ends.
    const rr = fault.reward_result || {};
    if (!rr.applied && !rr.pending) {
      rewards.releaseReservation(this, fault, 'facilitator_clear');
      rewards.cancelIssued(this, fault, 'facilitator_clear');
    }
    rewards.endEffectsFor(this, fault.id);
    this.touch();
    return true;
  }

  // -- fault rewards (v17) --------------------------------------------------------
  //
  // Every fault instance is dealt one reward when it fires (lib/rewards.js):
  // tiered, smart-random, filtered by the active sectors and the scarcity
  // guardrail, persisted on the instance, paid once by the authoritative
  // completion after the materials are gone. Opening, viewing, assigning
  // crew, a wrong code, a failed attempt, a refresh: nothing.

  /** What a screen may show before completion, or null when the preview is off. */
  rewardPreview(fault) {
    return rewards.preview(this, fault);
  }

  /** The reward's line, for logs and screens. */
  rewardText(fault) {
    return rewards.previewLine(fault && fault.reward);
  }

  applyFaultReward(sectorCode, fault, opts = {}) {
    return rewards.apply(this, sectorCode, fault, opts);
  }

  /** A table picks the target of its choosing reward. Sector intent, or the facilitator for it. */
  chooseRewardTarget(sectorCode, faultId, target, { by = sectorCode } = {}) {
    const sector = this.state.sectors[sectorCode];
    if (!sector) return { ok: false, reason: 'unknown_sector' };
    const fault = sector.faults.find((f) => f.id === faultId);
    if (!fault || !fault.reward) return { ok: false, reason: 'unknown_fault' };
    if (!fault.reward.pending) return { ok: false, reason: 'no_choice_pending' };
    if (by !== sectorCode && by !== 'facilitator') return { ok: false, reason: 'not_your_sector' };
    const res = rewards.apply(this, sectorCode, fault, { via: fault.resolved_by_code ? 'resolve' : 'false_alarm_clear', by, target, consumed: fault.resources_consumed });
    return res.applied ? { ok: true, ...res } : { ok: false, reason: res.reason || 'reward_not_applied', options: res.options };
  }

  /** Whether the tray holds every binder material for a fault. A boolean, never the recipe. */
  materialsReady(sectorCode, fault) {
    const sector = this.state.sectors[sectorCode];
    if (!sector || !this.cfg.auto_economy || this.cfg.resolve_requires_resources === false) return true;
    return Object.entries(fault.resources_required || {}).every(([k, v]) => (Number(sector.inventory[k]) || 0) >= v);
  }

  /** The stabilisation multiplier on a fault's decay (1 when untouched). */
  decayMultiplier(fault) {
    return rewards.decayMultiplier(this, fault);
  }

  rewardBudget() {
    return rewards.budget(this);
  }

  /**
   * The binder's definition with its v17.3 case record merged in — the
   * content file stays generated and hash-checked, so the record lives in
   * lib/reward-pools.json and is joined here.
   */
  faultDefinition(code) {
    const def = this.faultsByCode.get(code);
    if (!def) return null;
    const bal = rewards.balanceOf(this, code, def);
    return {
      ...def,
      minimum_crew: bal.minimum_crew, materials: { ...def.resources_required }, severity_level: bal.severity_level,
      external_information_dependencies: [...(bal.external_information_dependencies || [])],
      difficulty_score: bal.difficulty_score, reward_target_rvu: bal.reward_target_rvu, allowed_reward_rvu: [...bal.allowed_reward_rvu],
      reward_case_profile: bal.case_profile, max_resource_units_in_single_reward: bal.max_resource_units_in_single_reward,
      repair_type: bal.repair_type, reward_tier: bal.reward_tier,
    };
  }

  activeSectorCodes() {
    return rewards.activeSectors(this);
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
   * ADMIN RESOURCE CONTROL (v18). The facilitator sets a sector's REAL tray
   * to exact values: every edited resource together, none below zero, whole
   * numbers only — a blank, a fraction or a word is refused, never coerced.
   * It is a correction of the count and nothing else: no request, no
   * transfer, no Transport stamp, no touch on COM's board, no undoing of
   * upkeep or repair costs already paid. One audit line carries before,
   * after and delta.
   */
  overrideInventory(code, values = {}, { reason = null, by = 'facilitator' } = {}) {
    const s = this.state.sectors[code];
    if (!s) return { ok: false, reason: 'unknown_sector' };
    const next = {};
    for (const [k, v] of Object.entries(values || {})) {
      if (!(k in s.inventory)) return { ok: false, reason: 'unknown_resource', resource: k };
      if (typeof v !== 'number' || !Number.isInteger(v)) return { ok: false, reason: 'invalid_value', resource: k };
      if (v < 0) return { ok: false, reason: 'negative_value', resource: k };
      next[k] = v;
    }
    if (!Object.keys(next).length) return { ok: false, reason: 'nothing_to_change' };
    const before = { ...s.inventory };
    for (const [k, v] of Object.entries(next)) s.inventory[k] = v;   // validated above: all of it lands, or none did
    const after = { ...s.inventory };
    const delta = Object.fromEntries(Object.keys(next).map((k) => [k, after[k] - before[k]]));
    this.log.write('admin_resource_override', { sector: code, before, after, delta, reason, by, round: this.state.round, phase: this.state.phase, run_id: this.state.run_id });
    this.ticker('override', `${code} stock set by hand — ${Object.entries(delta).map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${v}`).join(', ')}`, { scope: 'admin' });
    this.touch();
    return { ok: true, sector: code, before, after, delta };
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

  // -- requests, transfers and healing -----------------------------------------
  //
  // Three collections, deliberately distinct (spec v3 §important_semantics):
  //
  //   requests[]  one sector ASKS another for stock. Moves nothing, approves
  //               nothing. The supplier may DECLINE it or FULFIL it.
  //   transfers[] a proposed movement of stock. Any sector may raise one, for
  //               its own stock, either directly or by fulfilling a request.
  //               Nothing moves until TRANSPORT APPROVES it.
  //   healing[]   a sector asks MED to heal one of its injured workers. The
  //               target is always MED and only MED may heal. Transport has
  //               no part in it.
  //
  // Two per-round allowances, counted only on SUCCESS: Transport gets three
  // approvals, Medical gets three heals. A refusal costs nothing. A cycle
  // boundary hands nothing back; a round change resets both.

  /** Transport's approval allowance, after brownout, DARK and effects. */
  trnCapacity() {
    let cap = Number(this.cfg.trn_approval_limit ?? this.cfg.transport_stamp_limit ?? this.cfg.trn_capacity_per_cycle ?? 3);
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

  /** Medical's healing allowance. A dark Medical Bay heals nobody. */
  medCapacity() {
    const med = this.state.sectors.MED;
    if (med && med.status === 'DARK') return 0;
    let cap = Number(this.cfg.med_healing_limit ?? 3);
    for (const e of this.state.effects) {
      if (e.kind !== 'med_capacity') continue;
      if (e.value !== undefined) cap = Number(e.value);
      if (e.delta !== undefined) cap += Number(e.delta);
    }
    return Math.max(0, cap);
  }

  /** Which counter the transport allowance is measured against. */
  stampBasis() {
    return this.cfg.transfer_limit_basis === 'cycle' ? 'cycle' : 'round';
  }

  /** Transport approvals spent in the current period. */
  stampsUsed() {
    return this.stampBasis() === 'cycle'
      ? Number(this.state.cycle.stamped || 0)
      : Number(this.state.trn_approvals_used_this_round || 0);
  }

  /** Heals Medical has spent this round. */
  medHealsUsed() {
    return Number(this.state.med_heals_used_this_round || 0);
  }

  /** Older name for the active transport counter. */
  transfersStampedThisCycle() {
    return this.stampsUsed();
  }

  /**
   * Zero an allowance. 'round' at a round change, 'cycle' at a cycle boundary,
   * 'all' for the facilitator's manual reset. A cycle boundary must never
   * clear a round counter — that is the whole point of the round basis.
   */
  resetStamps(which = 'round', { by = 'system' } = {}) {
    if (which === 'round' || which === 'all') this.state.trn_approvals_used_this_round = 0;
    if (which === 'cycle' || which === 'all') this.state.cycle.stamped = 0;
    this.log.write('trn_approval_counter_reset', { which, by, basis: this.stampBasis() });
    this.touch();
    return { ok: true, which, used: this.stampsUsed(), capacity: this.trnCapacity() };
  }

  resetHeals({ by = 'system' } = {}) {
    this.state.med_heals_used_this_round = 0;
    this.log.write('med_healing_counter_reset', { by });
    this.touch();
    return { ok: true, used: 0, capacity: this.medCapacity() };
  }

  /** What a sector can actually hand over right now. */
  supplierAvailable(t) {
    const from = this.state.sectors[t.from];
    if (!from) return 0;
    return t.resource === 'workers'
      ? Number(from.workforce.active) || 0
      : Number(from.inventory[t.resource]) || 0;
  }

  static get OPEN_REQUEST() { return ['REQUESTED']; }
  static get OPEN_TRANSFER() { return ['PENDING_TRN_APPROVAL', 'APPROVED']; }
  static get OPEN_HEALING() { return ['WAITING_FOR_MED']; }

  findRequest(id) { return this.state.requests.find((r) => r.id === id) || null; }
  findTransfer(id) { return this.state.transfers.find((t) => t.id === id) || null; }
  findHealing(id) { return this.state.healing.find((h) => h.id === id) || null; }

  /** Shared validation: two different sectors, a real amount, a real resource. */
  checkPair(from, to, resource, amount) {
    const a = this.state.sectors[from];
    const b = this.state.sectors[to];
    if (!a || !b) return { ok: false, reason: 'bad_request' };
    if (from === to) return { ok: false, reason: 'same_sector' };
    if (!(Number(amount) > 0)) return { ok: false, reason: 'invalid_amount' };
    if (resource !== 'workers' && !(resource in a.inventory)) return { ok: false, reason: 'bad_request' };
    return { ok: true };
  }

  // -- resource requests --------------------------------------------------------

  /**
   * A REQUEST: one sector asks another for stock. It moves nothing, it spends
   * no allowance, and it approves nothing. `from` is the supplier being asked,
   * `to` is the sector that wants the goods.
   */
  requestTransfer({ from, to, resource, amount, note = '', by = 'sector' }) {
    const supplier = String(from || '').toUpperCase();
    const requester = String(to || '').toUpperCase();
    const qty = Math.floor(Number(amount) || 0);
    const valid = this.checkPair(supplier, requester, resource, qty);
    if (!valid.ok) return valid;

    const now = new Date().toISOString();
    const request = {
      id: this.id('R'),
      // supplier/requester are the meaningful names; from/to are kept so every
      // existing screen and log reader keeps working.
      from: supplier, to: requester, supplier, requester,
      resource, amount: qty, note: String(note || '').slice(0, 120),
      status: 'REQUESTED', requested_at: now, updated_at: now, requested_by: by,
      round_created: this.state.round,
      declined_at: null, declined_by: null, cancelled_at: null, expired_at: null,
      transfer_id: null, fulfilled_at: null, accepted_by: null,
    };
    this.state.requests.unshift(request);
    if (this.state.requests.length > 60) this.state.requests.length = 60;
    this.ticker('transfer', `Request ${requester} ← ${supplier}: ${qty} ${resource}`, { scope: 'admin' });
    this.log.write('request_created', {
      id: request.id, supplier, requester, resource, amount: qty, by, round_created: request.round_created,
    });
    this.touch();
    return { ok: true, request, transfer: request };
  }

  /** The supplier says no. Supplier only. Moves nothing, costs nothing. */
  declineRequest(id, { by = 'facilitator', reason = null } = {}) {
    const r = this.findRequest(id);
    if (!r) return { ok: false, reason: 'unknown_request' };
    if (r.status === 'EXPIRED') return { ok: false, reason: 'expired' };
    if (r.status !== 'REQUESTED') return { ok: false, reason: 'request_closed', status: r.status };
    const override = by === 'facilitator';
    if (!override && by !== r.supplier) return { ok: false, reason: 'not_supplier', supplier: r.supplier };

    r.status = 'DECLINED_BY_SUPPLIER';
    r.declined_at = new Date().toISOString();
    r.updated_at = r.declined_at;
    r.declined_by = by;
    this.ticker('transfer', `${r.supplier} declined ${r.requester}: ${r.amount} ${r.resource}`, { scope: 'admin' });
    this.log.write('request_declined', {
      id, supplier: r.supplier, requester: r.requester, resource: r.resource, amount: r.amount,
      by, reason: reason || null, facilitator_override: override,
    });
    this.touch();
    return { ok: true, request: r };
  }

  /**
   * The supplier says yes, which CREATES A TRANSFER — supplier consent, not
   * approval. The goods still do not move until Transport approves.
   */
  fulfillRequest(id, { by = 'facilitator' } = {}) {
    const r = this.findRequest(id);
    if (!r) return { ok: false, reason: 'unknown_request' };
    if (r.status === 'EXPIRED') return { ok: false, reason: 'expired' };
    if (r.status !== 'REQUESTED') return { ok: false, reason: 'request_closed', status: r.status };
    const override = by === 'facilitator';
    if (!override && by !== r.supplier) return { ok: false, reason: 'not_supplier', supplier: r.supplier };

    if (this.cfg.enforce_supplier_stock !== false) {
      const have = this.supplierAvailable({ from: r.supplier, resource: r.resource });
      if (have < r.amount) {
        this.log.write('request_fulfil_refused', {
          id, supplier: r.supplier, requester: r.requester, resource: r.resource,
          amount: r.amount, reason: 'insufficient_stock', have, by,
        });
        return { ok: false, reason: 'insufficient_stock_accept', have, need: r.amount, resource: r.resource };
      }
    }

    const made = this.createTransfer({
      from: r.supplier, to: r.requester, resource: r.resource, amount: r.amount,
      by, request_id: r.id, silent: true,
    });
    if (!made.ok) return made;

    r.status = 'TRANSFER_CREATED';
    r.transfer_id = made.transfer.id;
    r.fulfilled_at = new Date().toISOString();
    r.updated_at = r.fulfilled_at;
    r.accepted_by = by;
    this.ticker('transfer', `${r.supplier} fulfilled ${r.requester}: ${r.amount} ${r.resource} — awaiting TRN`, { scope: 'admin' });
    this.log.write('request_fulfilled', {
      id, transfer_id: made.transfer.id, supplier: r.supplier, requester: r.requester,
      resource: r.resource, amount: r.amount, by, facilitator_override: override,
    });
    this.touch();
    return { ok: true, request: r, transfer: made.transfer };
  }

  /** Withdraw an ask, while it is still unanswered. */
  cancelRequest(id, { by = 'facilitator' } = {}) {
    const r = this.findRequest(id);
    if (!r) return { ok: false, reason: 'unknown_request' };
    if (r.status !== 'REQUESTED') return { ok: false, reason: 'request_closed', status: r.status };
    if (by !== 'facilitator' && by !== r.requester && by !== r.supplier) {
      return { ok: false, reason: 'not_party' };
    }
    r.status = 'CANCELLED';
    r.cancelled_at = new Date().toISOString();
    r.updated_at = r.cancelled_at;
    this.log.write('request_cancelled', { id, supplier: r.supplier, requester: r.requester, by });
    this.touch();
    return { ok: true, request: r };
  }

  // -- resource transfers -------------------------------------------------------

  /**
   * A TRANSFER: a proposed movement of the creator's own stock. Any sector may
   * raise one, directly or by fulfilling a request. Creating it moves nothing
   * and spends no allowance; it lands in Transport's approval queue.
   */
  createTransfer({ from, to, resource, amount, by = 'facilitator', request_id = null, silent = false }) {
    const supplier = String(from || '').toUpperCase();
    const receiver = String(to || '').toUpperCase();
    const qty = Math.floor(Number(amount) || 0);
    const valid = this.checkPair(supplier, receiver, resource, qty);
    if (!valid.ok) return valid;
    // A sector may only move its OWN stock; the facilitator may move anyone's.
    if (by !== 'facilitator' && by !== supplier) return { ok: false, reason: 'not_supplier', supplier };

    const now = new Date().toISOString();
    const transfer = {
      id: this.id('T'),
      from: supplier, to: receiver, resource, amount: qty,
      status: 'PENDING_TRN_APPROVAL',
      created_by: by, requested_by: by,
      requested_at: now, created_at: now, updated_at: now,
      round_created: this.state.round,
      request_id,
      approved_at: null, approved_by: null, stamped_at: null, stamped_by: null,
      round_approved: null, round_stamped: null, delivered_at: null,
      declined_at: null, declined_by: null, cancelled_at: null, expired_at: null,
      chit_confirmed: false, chit_confirmed_at: null, facilitator_override: false,
      moved: null,
    };
    this.state.transfers.unshift(transfer);
    if (this.state.transfers.length > 60) this.state.transfers.length = 60;
    if (!silent) {
      this.ticker('transfer', `Transfer raised ${supplier} → ${receiver}: ${qty} ${resource} — awaiting TRN`, { scope: 'admin' });
    }
    this.log.write('transfer_created', {
      id: transfer.id, from: supplier, to: receiver, resource, amount: qty, by,
      request_id, round_created: transfer.round_created,
    });
    this.touch();
    return { ok: true, transfer };
  }

  /**
   * Transport records that the PHYSICAL Transfer Chit is in its hand, signed by
   * both Liaisons. The paper is still the real instrument; this only says
   * Transport has seen it, and it is what unlocks approval.
   */
  confirmChit(id, confirmed = true, { by = 'TRN' } = {}) {
    const t = this.findTransfer(id);
    if (!t) return { ok: false, reason: 'unknown_transfer' };
    if (!GameState.OPEN_TRANSFER.includes(t.status)) return { ok: false, reason: 'transfer_closed', status: t.status };
    t.chit_confirmed = !!confirmed;
    t.chit_confirmed_at = t.chit_confirmed ? new Date().toISOString() : null;
    t.updated_at = new Date().toISOString();
    this.log.write('transfer_chit', {
      id, from: t.from, to: t.to, resource: t.resource, amount: t.amount,
      confirmed: t.chit_confirmed, by,
    });
    this.touch();
    return { ok: true, transfer: t };
  }

  /**
   * TRANSPORT APPROVAL — the only step that moves stock, gated in this order:
   * Transport itself, the round allowance, the physical chit, then live
   * supplier stock, re-checked here because it may have drained since the
   * transfer was raised. A refusal moves nothing and spends no allowance.
   *
   * `force` is the facilitator's override. It lifts the allowance and the
   * chit, because those are rules; it never invents stock, because that is the
   * world. Every override is flagged in the log.
   */
  approveTransfer(id, { by = 'TRN', force = false } = {}) {
    const t = this.findTransfer(id);
    if (!t) return { ok: false, reason: 'unknown_transfer' };
    if (t.approved_at) return { ok: false, reason: 'already_stamped' };
    if (t.status === 'EXPIRED') return { ok: false, reason: 'expired' };
    if (['DELIVERED', 'CANCELLED', 'DECLINED_BY_TRN'].includes(t.status)) {
      return { ok: false, reason: 'transfer_closed', status: t.status };
    }

    const refuse = (reason, extra = {}) => {
      this.log.write('transfer_refused', {
        id, from: t.from, to: t.to, resource: t.resource, amount: t.amount, reason, by, ...extra,
      });
      return { ok: false, reason, ...extra };
    };

    // Approval belongs to Transport alone. The facilitator overrides by force.
    if (!force && by !== 'TRN') return refuse('approval_trn_only', { actor: by });

    const cap = this.trnCapacity();
    const used = this.stampsUsed();
    const basis = this.stampBasis();
    if (!force && used >= cap) return refuse('capacity', { capacity: cap, used, basis });

    if (!force && this.cfg.require_physical_transfer_chit !== false && !t.chit_confirmed) {
      return refuse('chit_required');
    }

    const auto = !!this.cfg.auto_economy;
    const partialOk = this.cfg.insufficient_stock_behavior === 'legacy_partial_if_supported';
    const enforce = this.cfg.enforce_supplier_stock !== false;
    const available = this.supplierAvailable(t);
    if (auto && enforce && !partialOk && available < t.amount) {
      return refuse('insufficient_stock_stamp', { have: available, need: t.amount, resource: t.resource });
    }

    const from = this.state.sectors[t.from];
    const to = this.state.sectors[t.to];
    const now = new Date().toISOString();
    let moved = t.amount;

    // Both sides move together: the checks above guarantee the supplier can
    // cover it, so neither balance is ever left half-applied.
    if (auto) {
      moved = partialOk ? Math.min(t.amount, available) : t.amount;
      if (t.resource === 'workers') {
        from.workforce.active -= moved;
        from.workforce.loaned += moved;
        to.workforce.active += moved;
        to.workforce.borrowed += moved;
      } else {
        from.inventory[t.resource] = (from.inventory[t.resource] || 0) - moved;
        to.inventory[t.resource] = (to.inventory[t.resource] || 0) + moved;
      }
    }

    t.status = 'APPROVED';
    t.approved_at = now;
    t.approved_by = force && by !== 'TRN' ? by : 'TRN';
    t.stamped_at = now;                       // the older field name, kept for the debrief
    t.stamped_by = by;
    t.round_approved = this.state.round;
    t.round_stamped = this.state.round;
    t.updated_at = now;
    t.moved = moved;
    if (force) t.facilitator_override = true;
    // Both counters advance; `stampsUsed()` reads whichever basis is in force.
    this.state.trn_approvals_used_this_round = Number(this.state.trn_approvals_used_this_round || 0) + 1;
    this.state.cycle.stamped = Number(this.state.cycle.stamped || 0) + 1;
    if (this.cfg.deliver_on_stamp !== false) { t.status = 'DELIVERED'; t.delivered_at = now; }

    const line = `TRN approved ${t.from} → ${t.to}: ${moved} ${t.resource}`;
    this.ticker('transfer', line, this.cfg.show_completed_transfer_on_wall === false ? { scope: 'admin' } : {});
    this.log.write('transfer_approved', {
      id, from: t.from, to: t.to, resource: t.resource, amount: t.amount, moved, by,
      capacity: cap, used_after: this.stampsUsed(), basis,
      chit_confirmed: !!t.chit_confirmed, facilitator_override: !!force,
      request_id: t.request_id, delivered: !!t.delivered_at,
    });
    if (force) {
      this.log.write('facilitator_force_transfer', {
        id, from: t.from, to: t.to, resource: t.resource, amount: moved, by,
      });
    }
    this.sting('chime');
    this.touch();
    return { ok: true, transfer: t };
  }

  /** Transport refuses to carry it. Moves nothing, costs no allowance. */
  declineTransfer(id, { by = 'TRN', reason = null } = {}) {
    const t = this.findTransfer(id);
    if (!t) return { ok: false, reason: 'unknown_transfer' };
    if (t.status === 'EXPIRED') return { ok: false, reason: 'expired' };
    if (!GameState.OPEN_TRANSFER.includes(t.status)) return { ok: false, reason: 'transfer_closed', status: t.status };
    const override = by === 'facilitator';
    if (!override && by !== 'TRN') return { ok: false, reason: 'approval_trn_only', actor: by };

    t.status = 'DECLINED_BY_TRN';
    t.declined_at = new Date().toISOString();
    t.updated_at = t.declined_at;
    t.declined_by = by;
    this.ticker('transfer', `TRN declined ${t.from} → ${t.to}: ${t.amount} ${t.resource}`, { scope: 'admin' });
    this.log.write('transfer_declined', {
      id, from: t.from, to: t.to, resource: t.resource, amount: t.amount, by,
      reason: reason || null, facilitator_override: override,
    });
    this.touch();
    return { ok: true, transfer: t };
  }

  /**
   * Move an item along by hand. Fulfilment, approval and decline have their own
   * rules, so this only routes to them. Accepts a request id or a transfer id.
   */
  updateTransfer(id, status, { by = 'facilitator' } = {}) {
    const req = this.findRequest(id);
    const t = this.findTransfer(id) || req;
    if (!t) return { ok: false, reason: 'unknown_transfer' };
    if (status === 'AGREED' || status === 'ACCEPTED' || status === 'FULFILLED') {
      return req ? this.fulfillRequest(id, { by }) : { ok: false, reason: 'not_a_request' };
    }
    if (status === 'DECLINED') {
      return req ? this.declineRequest(id, { by }) : this.declineTransfer(id, { by });
    }
    if (status === 'STAMPED' || status === 'APPROVED') return this.approveTransfer(id, { by });
    if (status === 'CANCELLED' && req) return this.cancelRequest(id, { by });

    if (['DELIVERED', 'CANCELLED', 'DECLINED_BY_TRN'].includes(t.status)) return { ok: false, reason: 'transfer_closed' };
    if (t.status === 'EXPIRED') return { ok: false, reason: 'expired' };
    const now = new Date().toISOString();

    switch (status) {
      case 'WAITING_TRN': t.waiting_at = t.waiting_at || now; break;
      case 'DELIVERED': {
        if (!t.approved_at) return { ok: false, reason: 'not_stamped' };
        t.status = 'DELIVERED'; t.delivered_at = now;
        this.ticker('transfer', `Delivered ${t.from} → ${t.to}: ${t.amount} ${t.resource}`);
        break;
      }
      case 'CANCELLED':
        // Once Transport holds it, a table can no longer walk it back.
        if (by !== 'facilitator' && by !== t.from) return { ok: false, reason: 'cancel_locked', status: t.status };
        t.status = 'CANCELLED'; t.cancelled_at = now;
        this.ticker('transfer', `Transfer ${t.from} → ${t.to} cancelled`, { scope: 'admin' });
        break;
      default:
        return { ok: false, reason: 'bad_status' };
    }
    t.updated_at = now;
    this.log.write('transfer_' + status.toLowerCase(), { id, from: t.from, to: t.to, resource: t.resource, amount: t.amount, by });
    this.touch();
    return { ok: true, transfer: t };
  }

  /** Older name for Transport's approval, kept for existing callers. */
  stampTransfer(id, opts = {}) {
    return this.approveTransfer(id, opts);
  }

  /** Older name for the supplier's yes, which now creates a transfer. */
  acceptTransfer(id, opts = {}) {
    return this.fulfillRequest(id, opts);
  }

  // -- healing ------------------------------------------------------------------

  /**
   * Injured workers in this game are a COUNT, not individuals (workforce
   * {active, injured, …}). A healing request therefore claims one injured slot
   * in its sector: it carries a label for the room to say out loud, and it is
   * valid while the sector still has more injured workers than there are live
   * requests ahead of it.
   */
  liveHealingFor(sectorCode) {
    return this.state.healing.filter((h) => h.sector === sectorCode && h.status === 'WAITING_FOR_MED');
  }

  /** Injured workers in this sector not already claimed by a live request. */
  unclaimedInjured(sectorCode) {
    const s = this.state.sectors[sectorCode];
    if (!s) return 0;
    return Math.max(0, (Number(s.workforce.injured) || 0) - this.liveHealingFor(sectorCode).length);
  }

  /**
   * Any sector may ask MED to heal one of its injured workers. The target is
   * always MED — there is no sector to choose — and creating it spends no
   * healing capacity.
   */
  requestHealing(sectorCode, { by = 'facilitator', worker_label: label = null } = {}) {
    const code = String(sectorCode || by || '').toUpperCase();
    const s = this.state.sectors[code];
    if (!s) return { ok: false, reason: 'unknown_sector' };
    if (by !== 'facilitator' && by !== code) return { ok: false, reason: 'not_own_sector' };
    if (this.unclaimedInjured(code) <= 0) {
      return { ok: false, reason: 'worker_not_injured', injured: Number(s.workforce.injured) || 0 };
    }

    const n = this.liveHealingFor(code).length + 1;
    const now = new Date().toISOString();
    const request = {
      id: this.id('H'),
      sector: code, requesting_sector: code,
      target_sector: 'MED',                 // always MED; there is no choice to make
      worker_id: `${code}-W${n}`,
      worker_label: label || `${code} WORKER ${n}`,
      status: 'WAITING_FOR_MED',
      requested_at: now, updated_at: now, requested_by: by,
      round_created: this.state.round,
      healed_at: null, healed_by: null, round_healed: null,
      declined_at: null, declined_by: null, cancelled_at: null, expired_at: null,
      facilitator_override: false,
    };
    this.state.healing.unshift(request);
    if (this.state.healing.length > 60) this.state.healing.length = 60;
    this.ticker('injury', `${code} requested healing: ${request.worker_label}`, { scope: 'admin' });
    this.log.write('heal_requested', {
      id: request.id, sector: code, target: 'MED', worker_id: request.worker_id,
      worker_label: request.worker_label, by, round_created: request.round_created,
    });
    this.touch();
    return { ok: true, healing: request };
  }

  /**
   * MED HEALS. Only Medical Bay, only with capacity left, and only if the
   * worker is still injured — a facilitator or the cycle may have healed them
   * already. A refusal spends nothing. Transport plays no part in this.
   */
  healWorker(id, { by = 'MED', force = false } = {}) {
    const h = this.findHealing(id);
    if (!h) return { ok: false, reason: 'unknown_healing' };
    if (h.status === 'EXPIRED') return { ok: false, reason: 'expired' };
    if (h.status !== 'WAITING_FOR_MED') return { ok: false, reason: 'healing_closed', status: h.status };

    const refuse = (reason, extra = {}) => {
      this.log.write('heal_refused', {
        id, sector: h.sector, worker_id: h.worker_id, reason, by, ...extra,
      });
      return { ok: false, reason, ...extra };
    };

    // Healing belongs to Medical alone. The facilitator overrides by force.
    if (!force && by !== 'MED') return refuse('heal_med_only', { actor: by });

    const cap = this.medCapacity();
    const used = this.medHealsUsed();
    if (!force && used >= cap) return refuse('med_capacity', { capacity: cap, used });

    const sector = this.state.sectors[h.sector];
    if (!sector || (Number(sector.workforce.injured) || 0) <= 0) {
      return refuse('worker_not_injured', { injured: sector ? Number(sector.workforce.injured) || 0 : 0 });
    }

    sector.workforce.injured -= 1;
    sector.workforce.active += 1;
    const now = new Date().toISOString();
    h.status = 'HEALED';
    h.healed_at = now;
    h.updated_at = now;
    h.healed_by = force && by !== 'MED' ? by : 'MED';
    h.round_healed = this.state.round;
    if (force) h.facilitator_override = true;
    this.state.med_heals_used_this_round = Number(this.state.med_heals_used_this_round || 0) + 1;

    this.ticker('injury', `MED healed ${h.worker_label}`,
      this.cfg.show_completed_transfer_on_wall === false ? { scope: 'admin' } : {});
    this.log.write('worker_healed', {
      id, sector: h.sector, worker_id: h.worker_id, worker_label: h.worker_label,
      by, healed_by: h.healed_by, capacity: cap, used_after: this.medHealsUsed(),
      facilitator_override: !!force,
    });
    if (force) this.log.write('facilitator_force_heal', { id, sector: h.sector, worker_id: h.worker_id, by });
    this.sting('chime');
    this.touch();
    return { ok: true, healing: h, sector: h.sector };
  }

  /** MED refuses. Costs no capacity, heals nobody. */
  declineHealing(id, { by = 'MED', reason = null } = {}) {
    const h = this.findHealing(id);
    if (!h) return { ok: false, reason: 'unknown_healing' };
    if (h.status === 'EXPIRED') return { ok: false, reason: 'expired' };
    if (h.status !== 'WAITING_FOR_MED') return { ok: false, reason: 'healing_closed', status: h.status };
    const override = by === 'facilitator';
    if (!override && by !== 'MED') return { ok: false, reason: 'heal_med_only', actor: by };

    h.status = 'DECLINED_BY_MED';
    h.declined_at = new Date().toISOString();
    h.updated_at = h.declined_at;
    h.declined_by = by;
    this.ticker('injury', `MED declined healing for ${h.worker_label}`, { scope: 'admin' });
    this.log.write('heal_declined', {
      id, sector: h.sector, worker_id: h.worker_id, by, reason: reason || null,
      facilitator_override: override,
    });
    this.touch();
    return { ok: true, healing: h };
  }

  /** The asking sector withdraws. */
  cancelHealing(id, { by = 'facilitator' } = {}) {
    const h = this.findHealing(id);
    if (!h) return { ok: false, reason: 'unknown_healing' };
    if (h.status !== 'WAITING_FOR_MED') return { ok: false, reason: 'healing_closed', status: h.status };
    if (by !== 'facilitator' && by !== h.sector) return { ok: false, reason: 'not_own_sector' };
    h.status = 'CANCELLED';
    h.cancelled_at = new Date().toISOString();
    h.updated_at = h.cancelled_at;
    this.log.write('heal_cancelled', { id, sector: h.sector, worker_id: h.worker_id, by });
    this.touch();
    return { ok: true, healing: h };
  }

  // -- COM: the city broadcast ---------------------------------------------------
  //
  // The big screen's resource board is a PUBLIC INFORMATION LAYER that COM
  // maintains by hand. It is never read from inventory and never written to
  // it: a row says what COM last reported, stamped with the ROUND it was
  // reported in, and it stays that way — through production, transfers, AGR
  // cards and round changes — until COM reports again. Stale information is
  // the point of the exercise, so freshness is derived from round numbers
  // alone; players never see a clock time on it.

  /** The number in a round id (R2 → 2), or its position in the round list. */
  roundNumber(id = this.state.round) {
    const m = /^R(\d+)$/.exec(String(id || ''));
    if (m) return Number(m[1]);
    const i = this.rounds.rounds.findIndex((r) => r.id === id);
    return i < 0 ? 0 : i;
  }

  /** CURRENT / STALE / OUTDATED by round distance, NOT UPDATED when never set. */
  broadcastFreshness(round) {
    if (round === null || round === undefined) return 'NOT UPDATED';
    const age = this.roundNumber() - this.roundNumber(round);
    if (age <= 0) return 'CURRENT';
    if (age === 1) return 'STALE';
    return 'OUTDATED';
  }

  static get BROADCAST_KEYS() { return ['power', 'water', 'med', 'parts']; }

  emptyBroadcast() {
    const rows = {};
    for (const code of Object.keys(this.state ? this.state.sectors : {})) {
      rows[code] = { power: null, water: null, med: null, parts: null, round: null };
    }
    return { rows, announcement: { headline: '', message: '', round: null } };
  }

  /**
   * COM reports a sector's stock. Only COM, or the facilitator overriding COM.
   * Touches the displayed row and nothing else in the world.
   */
  setBroadcastRow(sectorCode, values = {}, { by = 'COM' } = {}) {
    const code = String(sectorCode || '').toUpperCase();
    const override = by === 'facilitator';
    if (!override && by !== 'COM') return { ok: false, reason: 'com_edit_forbidden', actor: by };
    const row = this.state.broadcast.rows[code];
    if (!row) return { ok: false, reason: 'unknown_sector' };

    const previous = { ...row };
    for (const k of GameState.BROADCAST_KEYS) {
      if (values[k] === undefined || values[k] === null || values[k] === '') continue;
      const n = Number(values[k]);
      if (!Number.isFinite(n)) return { ok: false, reason: 'invalid_amount', field: k };
      row[k] = Math.max(0, Math.floor(n));
    }
    row.round = this.state.round;
    this.log.write('com_row_updated', {
      sector: code, by, previous, values: { ...row }, facilitator_override: override,
    });
    if (override) this.log.write('facilitator_com_override', { what: 'row', sector: code, by });
    this.touch();
    return { ok: true, row: { ...row }, freshness: this.broadcastFreshness(row.round) };
  }

  /** One city-wide priority line. A new one replaces the old. */
  setBroadcastAnnouncement({ headline = '', message = '' } = {}, { by = 'COM' } = {}) {
    const override = by === 'facilitator';
    if (!override && by !== 'COM') return { ok: false, reason: 'com_edit_forbidden', actor: by };
    const h = String(headline || '').trim().slice(0, 40);
    const m = String(message || '').trim().slice(0, 160);
    if (!h && !m) return { ok: false, reason: 'empty_announcement' };
    const a = this.state.broadcast.announcement;
    const previous = { ...a };
    a.headline = h;
    a.message = m;
    a.round = this.state.round;
    this.log.write('com_announcement_published', {
      headline: h, message: m, by, previous, facilitator_override: override,
    });
    if (override) this.log.write('facilitator_com_override', { what: 'announcement', by });
    this.ticker('announce', `COM: ${h || m}`);
    this.touch();
    return { ok: true, announcement: { ...a }, freshness: this.broadcastFreshness(a.round) };
  }

  clearBroadcastAnnouncement({ by = 'COM' } = {}) {
    const override = by === 'facilitator';
    if (!override && by !== 'COM') return { ok: false, reason: 'com_edit_forbidden', actor: by };
    const a = this.state.broadcast.announcement;
    const previous = { ...a };
    a.headline = '';
    a.message = '';
    a.round = null;
    this.log.write('com_announcement_cleared', { by, previous, facilitator_override: override });
    if (override) this.log.write('facilitator_com_override', { what: 'clear', by });
    this.touch();
    return { ok: true };
  }

  // -- AGR: random intervention cards -----------------------------------------
  //
  // Every round AGR is dealt three cards from the enabled pool, drawn once,
  // server-side, and kept in game state: a refresh, a reconnect, a reopened
  // screen or a cycle boundary shows the same three. Only a new round deals
  // again, and last round's cards sit that draw out while enough others
  // remain. AGR activates ONE; the round is spent only when the effect
  // actually lands, so a refusal costs nothing.
  //
  // Nothing here grants AGR any authority it does not have: a card can widen
  // Transport's or Medical's allowance for the round, but Transport still
  // approves and Medical still heals.

  /** FNV-1a over a string, so the same run and round always deal the same hand. */
  static seedFrom(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** mulberry32 — small, deterministic, good enough to deal three cards. */
  static rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** The whole pool, with the scenario's disabled set marked. */
  agrPool() {
    const disabled = new Set((this.cfg.agr_disabled_cards || []).map(String));
    return AGR_CARDS.cards.map((c) => ({ ...c, enabled: !disabled.has(c.id) }));
  }

  agrCard(id) {
    return AGR_CARDS.cards.find((c) => c.id === id) || null;
  }

  agrEnabledIds() {
    return this.agrPool().filter((c) => c.enabled).map((c) => c.id);
  }

  /**
   * Deal `n` unique cards for a round. Last round's cards are excluded while
   * the rest of the pool can still fill the hand; otherwise every fresh card
   * is dealt first and the remaining slots come from last round's, never a
   * duplicate. `salt` changes the draw for a facilitator reroll.
   */
  agrDraw(roundId, { salt = 0 } = {}) {
    const n = Math.max(1, Number(this.cfg.agr_cards_per_round ?? 3));
    const enabled = this.agrEnabledIds();
    const previous = new Set(this.state.agr.previous || []);
    const antiRepeat = this.cfg.agr_anti_repeat !== false;
    const fresh = antiRepeat ? enabled.filter((id) => !previous.has(id)) : enabled;
    const repeats = antiRepeat ? enabled.filter((id) => previous.has(id)) : [];

    const seed = GameState.seedFrom(`${this.state.run_id}|${roundId}|${salt}`);
    const rand = GameState.rng(seed);
    const shuffle = (list) => {
      const a = [...list];
      for (let i = a.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };

    const hand = shuffle(fresh).slice(0, n);
    if (hand.length < n) hand.push(...shuffle(repeats).slice(0, n - hand.length));
    return { hand: [...new Set(hand)], seed };
  }

  /** Deal for the current round if it has no offer yet. Idempotent. */
  agrEnsureOffer({ by = 'system' } = {}) {
    const agr = this.state.agr;
    if (agr.round === this.state.round && agr.offered.length) return agr;
    if (agr.round && agr.offered.length) {
      agr.history.unshift({ round: agr.round, offered: [...agr.offered], selected: agr.selected, used: agr.used });
      if (agr.history.length > 12) agr.history.length = 12;
      this.log.write('agr_round_offer_archived', {
        round: agr.round, offered: [...agr.offered], selected: agr.selected, used: agr.used,
      });
      agr.previous = [...agr.offered];
    }
    const { hand, seed } = this.agrDraw(this.state.round);
    agr.round = this.state.round;
    agr.offered = hand;
    agr.selected = null;
    agr.used = false;
    agr.target = null;
    agr.reroll_count = 0;
    agr.generated_at = new Date().toISOString();
    this.log.write('agr_random_offer_generated', {
      round: agr.round, offered: [...hand], seed, previous: [...agr.previous], by,
    });
    this.touch();
    return agr;
  }

  /** AGR looks at a card. Records the choice; spends nothing. */
  agrSelect(cardId, { by = 'AGR' } = {}) {
    if (by !== 'AGR' && by !== 'facilitator') return { ok: false, reason: 'agr_only', actor: by };
    const agr = this.state.agr;
    if (agr.round !== this.state.round || !agr.offered.length) return { ok: false, reason: 'agr_offer_not_ready' };
    if (agr.used) return { ok: false, reason: 'agr_card_already_used', selected: agr.selected };
    if (!agr.offered.includes(cardId)) return { ok: false, reason: 'agr_card_not_in_offer' };
    agr.selected = cardId;
    this.log.write('agr_card_selected', { round: agr.round, card: cardId, by });
    this.touch();
    return { ok: true, selected: cardId };
  }

  /**
   * AGR plays a card. Checked against the live world at this moment; the
   * round's one choice is consumed only when the effect lands.
   */
  agrActivate(cardId, { by = 'AGR', target = null, force = false } = {}) {
    const agr = this.state.agr;
    const override = by === 'facilitator';
    const refuse = (reason, extra = {}) => {
      this.log.write('agr_card_activation_refused', { round: this.state.round, card: cardId, reason, by, target, ...extra });
      return { ok: false, reason, ...extra };
    };
    if (!override && by !== 'AGR') return refuse('agr_only', { actor: by });
    if (agr.round !== this.state.round || !agr.offered.length) return refuse('agr_offer_not_ready');
    if (!agr.offered.includes(cardId) && !(force && this.agrCard(cardId))) return refuse('agr_card_not_in_offer');
    if (agr.used && !force) return refuse('agr_card_already_used', { selected: agr.selected });
    const card = this.agrCard(cardId);
    if (!card) return refuse('agr_card_not_in_offer');
    if (card.target && (!target || Object.keys(target).length === 0)) return refuse('agr_target_required', { target_type: card.target });

    const result = this.agrResolve(card, target || {});
    if (!result.ok) return refuse(result.reason || 'agr_activation_failed', result);

    agr.selected = cardId;
    agr.used = true;
    agr.target = target || null;
    agr.activated_at = new Date().toISOString();
    if (force) agr.facilitator_override = true;
    this.log.write('agr_card_activated', {
      round: agr.round, card: cardId, offered: [...agr.offered], target: target || null, by,
      before: result.before, after: result.after, facilitator_override: !!force,
    });
    if (force) this.log.write('agr_admin_force_activate', { round: agr.round, card: cardId, by });
    this.ticker('announce', `AGR intervention: ${card.title}`);
    this.sting('chime');
    this.touch();
    return { ok: true, card: cardId, before: result.before, after: result.after };
  }

  /** Sectors a health card may touch: lit, and not already at the floor. */
  agrActiveSectors() {
    return Object.values(this.state.sectors).filter((s) => s.status !== 'DARK' && s.integrity > 0);
  }

  /** The sectors tied for lowest health among the active ones. */
  agrLowestSectors() {
    const live = this.agrActiveSectors();
    if (!live.length) return [];
    const min = Math.min(...live.map((s) => s.integrity));
    return live.filter((s) => s.integrity === min).map((s) => s.code);
  }

  /**
   * The one place a card becomes a change in the world. Returns before/after
   * for the log, or a reason and NO change.
   */
  agrResolve(card, target = {}) {
    const fx = card.effect || {};
    const inv = (code) => ({ ...this.state.sectors[code].inventory });
    const health = () => Object.fromEntries(Object.values(this.state.sectors).map((s) => [s.code, Math.round(s.integrity)]));

    switch (fx.type) {
      case 'health_all': {
        const before = health();
        for (const s of this.agrActiveSectors()) this.setIntegrity(s.code, s.integrity + fx.delta);
        return { ok: true, before, after: health() };
      }
      case 'health_lowest': {
        const tied = this.agrLowestSectors();
        if (!tied.length) return { ok: false, reason: 'agr_invalid_target', detail: 'no active sector' };
        let code = tied[0];
        if (tied.length > 1) {
          if (!target.sector) return { ok: false, reason: 'agr_target_required', target_type: 'sector', ties: tied };
          if (!tied.includes(String(target.sector).toUpperCase())) return { ok: false, reason: 'agr_invalid_target', ties: tied };
          code = String(target.sector).toUpperCase();
        }
        const before = { [code]: Math.round(this.state.sectors[code].integrity) };
        this.setIntegrity(code, this.state.sectors[code].integrity + fx.delta);
        return { ok: true, before, after: { [code]: Math.round(this.state.sectors[code].integrity) } };
      }
      case 'health_one': {
        const code = String(target.sector || '').toUpperCase();
        const s = this.state.sectors[code];
        if (!s) return { ok: false, reason: 'agr_invalid_target' };
        if (s.status === 'DARK' || s.integrity <= 0) return { ok: false, reason: 'agr_invalid_target', detail: 'sector is dark' };
        const before = { [code]: Math.round(s.integrity) };
        this.setIntegrity(code, s.integrity + fx.delta);
        return { ok: true, before, after: { [code]: Math.round(s.integrity) } };
      }
      case 'stock': {
        const s = this.state.sectors[fx.sector];
        if (!s) return { ok: false, reason: 'agr_activation_failed' };
        const before = inv(fx.sector);
        for (const [k, v] of Object.entries(fx.add || {})) s.inventory[k] = (Number(s.inventory[k]) || 0) + Number(v);
        return { ok: true, before: { [fx.sector]: before }, after: { [fx.sector]: inv(fx.sector) } };
      }
      case 'cache': {
        const key = String(target.resource || target.resource_type || '').toLowerCase();
        const amount = (fx.choices || {})[key];
        if (!amount) return { ok: false, reason: 'agr_invalid_target', choices: Object.keys(fx.choices || {}) };
        const s = this.state.sectors[fx.sector];
        const before = inv(fx.sector);
        s.inventory[key] = (Number(s.inventory[key]) || 0) + Number(amount);
        return { ok: true, before: { [fx.sector]: before }, after: { [fx.sector]: inv(fx.sector) } };
      }
      case 'capacity': {
        // A wider allowance for the rest of the round. The sector still does its own work.
        const e = this.addEffect({
          kind: fx.kind, target: fx.sector, delta: Number(fx.delta) || 1,
          expires: 'round', round: this.state.round, label: card.title,
        });
        const read = fx.kind === 'trn_capacity' ? this.trnCapacity() : this.medCapacity();
        return { ok: true, before: { capacity: read - e.delta }, after: { capacity: read, effect: e.id } };
      }
      case 'relief_crew': {
        const code = String(target.sector || '').toUpperCase();
        const s = this.state.sectors[code];
        if (!s) return { ok: false, reason: 'agr_invalid_target' };
        const before = { [code]: this.availableWorkers(s) };
        const e = this.addEffect({
          kind: 'extra_workers', target: code, delta: Number(fx.workers) || 1,
          expires: 'round', round: this.state.round, label: card.title,
        });
        return { ok: true, before, after: { [code]: this.availableWorkers(s), effect: e.id } };
      }
      case 'workforce_recovery': {
        // Reported conflict (spec v5 §card_pool AGR_WORKFORCE_RECOVERY): this
        // game's workers are counts, and the only non-injury "unavailable"
        // ones are on loan to another sector — pulling one back would reverse
        // a Transport-approved movement. No state is invented here.
        if (target.injured || target.worker_state === 'INJURED') {
          return { ok: false, reason: 'agr_injured_worker_blocked' };
        }
        return { ok: false, reason: 'agr_no_valid_worker' };
      }
      default:
        return { ok: false, reason: 'agr_activation_failed', detail: `unknown effect ${fx.type}` };
    }
  }

  /** Facilitator: deal the current round again. Logged as an override. */
  agrReroll({ by = 'facilitator' } = {}) {
    if (by !== 'facilitator') return { ok: false, reason: 'agr_only', actor: by };
    const agr = this.state.agr;
    if (agr.used) return { ok: false, reason: 'agr_card_already_used' };
    agr.reroll_count = Number(agr.reroll_count || 0) + 1;
    const previousOffer = [...agr.offered];
    const { hand, seed } = this.agrDraw(this.state.round, { salt: agr.reroll_count });
    agr.offered = hand;
    agr.selected = null;
    agr.generated_at = new Date().toISOString();
    this.log.write('agr_admin_reroll', {
      round: this.state.round, previous_offer: previousOffer, offered: [...hand], seed, reroll: agr.reroll_count, by,
    });
    this.touch();
    return { ok: true, offered: [...hand] };
  }

  /** Facilitator: take a card out of, or put it back into, the draw. */
  agrSetCardEnabled(cardId, enabled, { by = 'facilitator' } = {}) {
    if (!this.agrCard(cardId)) return { ok: false, reason: 'agr_card_not_in_offer' };
    const set = new Set((this.cfg.agr_disabled_cards || []).map(String));
    if (enabled) set.delete(cardId); else set.add(cardId);
    this.patchConfig({ agr_disabled_cards: [...set] });
    this.log.write('agr_card_enabled', { card: cardId, enabled: !!enabled, by });
    return { ok: true, disabled: [...set] };
  }

  /** Effects that live "until the round ends" end here. */
  expireRoundEffects() {
    for (const e of [...this.state.effects]) {
      if (e.expires === 'round') this.removeEffect(e.id);
    }
  }

  // -- round change -------------------------------------------------------------

  /**
   * A round change is a clean sheet: anything unfinished is dead paper.
   * Delivered stock and healed workers are history and are never reversed.
   * Each collection has its own switch.
   */
  expirePendingTransfers({ reason = 'round_change' } = {}) {
    const now = new Date().toISOString();
    let n = 0;
    const kill = (list, open, ev, key) => {
      if (this.cfg[`expire_pending_${key}_on_round_change`] === false) return;
      for (const x of list) {
        if (!open.includes(x.status)) continue;
        x.status = 'EXPIRED';
        x.expired_at = now;
        x.updated_at = now;
        x.expire_reason = reason;
        n += 1;
        this.log.write(ev, {
          id: x.id, from: x.from ?? x.sector, to: x.to ?? 'MED',
          resource: x.resource ?? null, amount: x.amount ?? null,
          worker_id: x.worker_id ?? null, reason, round_created: x.round_created ?? null,
        });
      }
    };
    kill(this.state.requests, GameState.OPEN_REQUEST, 'request_expired', 'requests');
    kill(this.state.transfers, GameState.OPEN_TRANSFER, 'transfer_expired', 'transfers');
    kill(this.state.healing, GameState.OPEN_HEALING, 'heal_expired', 'healing');
    if (n) {
      this.ticker('transfer', `${n} unfinished item${n === 1 ? '' : 's'} expired`, { scope: 'admin' });
      this.touch();
    }
    return n;
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
    const prev = this.state.round;
    const changed = cfg.id !== prev;
    // Upkeep falls due when a played round ends (2026-09-18): one economy
    // pass for the outgoing round — its output already generated by hand,
    // its upkeep charged now — before its allowances reset. A round whose
    // clock never started (SETUP, a skipped phase) is not charged.
    if (changed && this.cfg.upkeep_on_round_change !== false && this.state.round_clock.started) {
      economy.processCycle(this, { round: prev });
    }
    this.state.round = cfg.id;
    this.state.round_clock = { running: false, started: false, remaining_s: cfg.length_s };
    this.state.cycle.running = false;
    // A new round gives Transport and Medical their allowances back and voids
    // everything unfinished. Delivered stock and healed workers stay untouched.
    if (changed) {
      rewards.settlePending(this);
      this.resetStamps('round', { by: 'round_change' });
      this.resetHeals({ by: 'round_change' });
      this.expirePendingTransfers({ reason: 'round_change' });
      // Bonuses that lasted "until the round ends" end. AGR is dealt again.
      this.expireRoundEffects();
      this.agrEnsureOffer({ by: 'round_change' });
    }
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
  /**
   * The one authoritative countdown. start/resume/pause/end as before; add,
   * set and (v18) reset move the remaining time by hand — never below zero,
   * never past the round: 00:00 stops the clock and moves nothing, NEXT PHASE
   * does. Every hand on the round timer writes its own audit line.
   */
  clock(action, seconds, which = 'round', { reason = null, by = 'facilitator' } = {}) {
    const clk = which === 'council' ? this.state.council_clock : this.state.round_clock;
    const before = clk.remaining_s;
    if (action === 'start' || action === 'resume') {
      clk.running = true;
      if (which === 'round') {
        clk.started = true;
        if (this.state.mode === 'BRIEFING') this.state.mode = 'PLAY';
        // The free-running cycle timer is retired: upkeep rides on the round
        // clock. A scenario may still switch the legacy timer back on.
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
    } else if (action === 'reset') {
      // Time only: the configured length of the current round. The round,
      // the trays, health, faults, workers, allowances, AGR and the phase stay.
      clk.remaining_s = which === 'council' ? Number(this.cfg.council_length_s ?? clk.remaining_s) : this.roundConfig().length_s;
    } else {
      return { ok: false, reason: 'unknown_clock_action' };
    }
    this.log.write('clock', { which, action, seconds: seconds ?? null, remaining_s: Math.ceil(clk.remaining_s), by, reason });
    if (which === 'round') {
      const ms = (v) => Math.round(v * 1000);
      const ctx = { by, round: this.state.round, phase: this.state.phase, run_id: this.state.run_id };
      if (action === 'add' || action === 'set') {
        this.log.write('admin_timer_adjust', { ...ctx, action, before_remaining_ms: ms(before), after_remaining_ms: ms(clk.remaining_s), delta_ms: ms(clk.remaining_s - before), reason });
      } else if (action === 'reset') {
        this.log.write('admin_timer_reset', { ...ctx, before_remaining_ms: ms(before), default_remaining_ms: ms(clk.remaining_s), reason });
      } else {
        this.log.write('admin_timer_pause_resume', { ...ctx, action, remaining_ms: ms(clk.remaining_s) });
      }
    }
    this.touch();
    return { ok: true, which, action, before_s: before, remaining_s: clk.remaining_s, running: !!clk.running };
  }

  /**
   * ROUND OUTPUT (2026-09-18). A producing sector — POW, WTR — generates its
   * own output once a round by pressing the button; the stock lands in its
   * real inventory at once, and never on COM's board. Brownout, DARK, core
   * output and a supply delay shape the amount exactly as they shaped the
   * old automatic production. The stamp lives on the sector, so a refresh,
   * a reconnect or a restart cannot hand out a second output.
   */
  generateOutput(code, { by = code } = {}) {
    const s = this.state.sectors[code];
    if (!s) return { ok: false, reason: 'unknown_sector' };
    if (by !== code && by !== 'facilitator') return { ok: false, reason: 'not_your_sector' };
    if (!Object.keys(s.production || {}).length) return { ok: false, reason: 'no_output' };
    if (this.cfg.round_output_manual === false) return { ok: false, reason: 'output_automatic' };
    if (this.frozen) return { ok: false, reason: 'frozen' };
    if (s.status === 'DARK') return { ok: false, reason: 'sector_dark' };
    if (s.round_output && s.round_output.round === this.state.round) {
      return { ok: false, reason: 'already_generated', round_output: { ...s.round_output } };
    }
    const added = economy.productionFor(this, s);
    if (!Object.values(added).some((v) => v > 0)) return { ok: false, reason: 'no_output_now' };
    const auto = !!this.cfg.auto_economy;
    if (auto) for (const [k, v] of Object.entries(added)) s.inventory[k] = (s.inventory[k] || 0) + v;
    s.round_output = { round: this.state.round, added, at: new Date().toISOString(), by };
    this.refreshStatus(s);
    const text = Object.entries(added).map(([k, v]) => `+${v} ${k}`).join(' ');
    this.log.write('round_output', { sector: code, round: this.state.round, added, by, moved: auto });
    this.ticker('output', `${code} generated ${text}`, { scope: code });
    this.touch();
    return { ok: true, sector: code, round: this.state.round, added, moved: auto };
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
    this.log.write('admin_timer_pause_resume', { action: 'session_pause', remaining_ms: Math.round(this.state.round_clock.remaining_s * 1000), round: this.state.round, phase: this.state.phase, run_id: this.state.run_id });
    this.ticker('pause', 'SIMULATION PAUSED');
    this.touch();
    return true;
  }

  resume() {
    if (!this.state.paused) return false;
    this.state.paused = false;
    this.log.write('pause', { on: false });
    this.log.write('admin_timer_pause_resume', { action: 'session_resume', remaining_ms: Math.round(this.state.round_clock.remaining_s * 1000), round: this.state.round, phase: this.state.phase, run_id: this.state.run_id });
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

      for (const fault of sector.faults) {
        if (fault.resolved) continue;
        if (fault.locked_until_s > 0) {
          fault.locked_until_s = Math.max(0, fault.locked_until_s - secs);
          if (fault.locked_until_s === 0) this.touch();
        }
        if (frozen) continue;
        if (!fault.paused && fault.decay_per_min > 0 && sector.status !== 'DARK') {
          // A stabilisation reward halves or pauses this fault's bleed until the round ends.
          sector.integrity = Math.max(0, sector.integrity - (fault.decay_per_min * this.decayMultiplier(fault) * secs) / 60);
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
      rewards.tickEffects(this, secs);   // v17.3: stabilisation runs on game time, 90 s or 60 s

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
      frame.sectors[code] = { integrity: Math.round(s.integrity), status: s.status, word: this.statusWord(s) };
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
      const integrity = this.scenario.sectors[code].start_integrity;
      start[code] = { integrity, status: 'ACTIVE', word: this.statusWord({ integrity, status: 'ACTIVE' }) };
    }
    return start;
  }
}

Object.assign(GameState.prototype, require('./crisis'));

module.exports = { GameState, WALL_KINDS };
