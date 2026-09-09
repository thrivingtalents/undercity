'use strict';
/**
 * Shared websocket client: connect, identify, re-render, reconnect.
 *
 * A frozen dashboard mid-crisis with no indicator is the worst possible
 * failure mode in the room (contract §1), so connection state is surfaced
 * to the UI rather than hidden: live → amber on a missed heartbeat → red
 * with RECONNECTING on a drop.
 *
 * Timers: the server is authoritative and ticks every second, but only
 * broadcasts on change (or every ~10 s). Between frames the client counts
 * down locally from the last frame with `countdown(clock)` — never past
 * zero, never while the server said the clock is not running.
 */
(function attachUndercity(global) {
  const RECONNECT_MIN_MS = 500;
  const RECONNECT_MAX_MS = 5000;
  // The server heartbeats every 10 s; allow a generous margin before amber.
  const STALE_MS = 30000;

  let lastFrameAt = 0;   // performance.now() when the latest state frame arrived

  function connect({ hello, onState, onMessage, onStatus }) {
    let ws = null;
    let backoff = RECONNECT_MIN_MS;
    let lastFrame = Date.now();
    let closedByUs = false;

    const setStatus = (status) => onStatus && onStatus(status);

    function open() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}`);

      ws.addEventListener('open', () => {
        backoff = RECONNECT_MIN_MS;
        lastFrame = Date.now();
        setStatus('live');
        ws.send(JSON.stringify(hello));
      });

      ws.addEventListener('message', (event) => {
        lastFrame = Date.now();
        setStatus('live');
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === 'state') {
          lastFrameAt = performance.now();
          if (onState) onState(msg);
        }
        if (onMessage) onMessage(msg);
      });

      ws.addEventListener('close', () => {
        if (closedByUs) return;
        setStatus('down');
        setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      });

      ws.addEventListener('error', () => {
        try { ws.close(); } catch { /* close handler reconnects */ }
      });
    }

    // Browsers give no hook for a missed pong, so infer staleness from silence.
    setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastFrame > STALE_MS) setStatus('stale');
    }, 5000);

    open();

    return {
      send(payload) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(payload));
          return true;
        }
        return false;
      },
      close() {
        closedByUs = true;
        if (ws) ws.close();
      },
    };
  }

  /**
   * Seconds left on a server clock right now. `clock` is any object with
   * `running` and `remaining_s` from the latest frame; `frozen` (the frame's
   * pause flag) stops interpolation even if the clock says running.
   */
  function countdown(clock, frozen = false) {
    if (!clock) return 0;
    const base = Number(clock.remaining_s) || 0;
    if (!clock.running || frozen) return Math.max(0, base);
    const elapsed = (performance.now() - lastFrameAt) / 1000;
    return Math.max(0, base - elapsed);
  }

  /**
   * Which session and sector this page belongs to, read from the URL.
   *
   *   /s/ABC123/sector/POW  -> hosted session ABC123, sector POW
   *   /sector/POW           -> LAN mode, the implicit LOCAL session
   */
  function context() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts[0] === 's' && parts[1]) {
      const session = parts[1].toUpperCase();
      const sector = parts[2] === 'sector' && parts[3] ? parts[3].toUpperCase() : null;
      return { session, sector, base: `/s/${session}` };
    }
    const sector = parts[0] === 'sector' && parts[1] ? parts[1].toUpperCase() : null;
    return { session: 'LOCAL', sector, base: '' };
  }

  // -- small shared helpers ---------------------------------------------------

  function mmss(seconds) {
    const s = Math.max(0, Math.ceil(Number(seconds) || 0));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function integrityClass(value) {
    if (value <= 0) return 'dark';
    if (value < 30) return 'critical';
    if (value < 60) return 'warn';
    return 'ok';
  }

  function severityPips(severity) {
    return '▲'.repeat(Math.max(1, Number(severity) || 1));
  }

  function severityName(severity) {
    return Number(severity) >= 3 ? 'CRISIS' : Number(severity) === 2 ? 'EMERGENCY' : 'INCIDENT';
  }

  const GLYPH = { power: '⚡', water: '💧', parts: '🔧', med: '⚕', workers: '👤' };
  const SECTOR_GLYPH = { POW: '⚡', WTR: '💧', MED: '⚕', TRN: '🚇', AGR: '🌱', COM: '📡' };

  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // -- audio ------------------------------------------------------------------

  /**
   * Stings. A file at /audio/<name>.mp3 (or .wav) is played if present;
   * otherwise a synthesised placeholder tone, so the kit ships with no media
   * and every cue is still audible. Klaxon at R0 is the recording join key.
   */
  const missingAudio = new Set();
  let unlocked = false;
  let muted = false;

  function setMuted(on) { muted = !!on; }

  function unlockAudio() {
    unlocked = true;
    try {
      const Ctx = global.AudioContext || global.webkitAudioContext;
      if (Ctx) { const c = new Ctx(); c.resume().then(() => c.close()).catch(() => {}); }
    } catch { /* no audio */ }
  }
  global.addEventListener('pointerdown', unlockAudio, { once: true });
  global.addEventListener('keydown', unlockAudio, { once: true });

  function playSting(sound) {
    if (muted || sound === 'silence') return;
    if (!missingAudio.has(sound)) {
      try {
        const audio = new Audio(`/audio/${sound}.mp3`);
        audio.addEventListener('error', () => { missingAudio.add(sound); synth(sound); }, { once: true });
        audio.play().catch(() => { missingAudio.add(sound); synth(sound); });
        return;
      } catch { /* fall through */ }
    }
    synth(sound);
  }

  function synth(sound) {
    const Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) return;
    let ctx;
    try { ctx = new Ctx(); } catch { return; }
    const now = ctx.currentTime;

    const beep = (freq, start, duration, type = 'square', gainValue = 0.18) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(gainValue, now + start + 0.02);
      gain.gain.linearRampToValueAtTime(0, now + start + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + duration + 0.05);
    };

    switch (sound) {
      case 'klaxon':       beep(320, 0, 0.45); beep(240, 0.5, 0.45); beep(320, 1.0, 0.45); break;
      case 'chime':        beep(880, 0, 0.25, 'sine', 0.14); beep(1320, 0.18, 0.35, 'sine', 0.12); break;
      case 'fault_alert':  beep(660, 0, 0.12, 'square', 0.14); beep(660, 0.18, 0.12, 'square', 0.14); break;
      case 'critical':     beep(220, 0, 0.3, 'sawtooth', 0.16); beep(196, 0.35, 0.3, 'sawtooth', 0.16); beep(220, 0.7, 0.3, 'sawtooth', 0.16); break;
      case 'resolved':     beep(523, 0, 0.12, 'sine', 0.14); beep(659, 0.12, 0.12, 'sine', 0.14); beep(784, 0.24, 0.25, 'sine', 0.14); break;
      case 'council':      beep(392, 0, 0.35, 'triangle', 0.16); beep(392, 0.45, 0.35, 'triangle', 0.16); beep(523, 0.9, 0.6, 'triangle', 0.16); break;
      case 'warning_30':   beep(988, 0, 0.08, 'square', 0.12); beep(988, 0.15, 0.08, 'square', 0.12); beep(988, 0.3, 0.08, 'square', 0.12); break;
      case 'brownout':     beep(330, 0, 0.5, 'sawtooth', 0.1); beep(262, 0.5, 0.7, 'sawtooth', 0.1); break;
      case 'dark':         beep(196, 0, 0.6, 'sawtooth', 0.14); beep(131, 0.6, 1.1, 'sawtooth', 0.14); break;
      case 'core_warning': beep(147, 0, 0.5, 'square', 0.12); beep(147, 0.6, 0.5, 'square', 0.12); beep(110, 1.2, 0.8, 'square', 0.12); break;
      case 'alert':        beep(740, 0, 0.15, 'square', 0.12); beep(740, 0.25, 0.15, 'square', 0.12); break;
      case 'cycle':        beep(440, 0, 0.15, 'sine', 0.1); beep(440, 0.2, 0.15, 'sine', 0.1); break;
      default:             beep(600, 0, 0.15, 'sine', 0.1);
    }
    setTimeout(() => ctx.close().catch(() => {}), 3000);
  }

  global.Undercity = {
    connect, context, countdown, mmss, integrityClass, severityPips, severityName,
    escapeHtml, playSting, setMuted, GLYPH, SECTOR_GLYPH,
  };
})(window);
