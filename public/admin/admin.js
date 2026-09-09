'use strict';
/**
 * Admin panel — create a session, name the six tables, hand out the links.
 *
 * This is the only surface used before the room fills, so it optimises for
 * "get six laptops pointed at the right dashboards without a mistake": every
 * link is one click to copy, and each team's link resolves to their sector so
 * nobody types a URL under time pressure.
 */
(function admin() {
  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  let meta = null;
  let current = null;
  let pollTimer = null;
  let me = null;

  // -- transport --------------------------------------------------------------

  async function api(url, { bounceOn401 = true, ...options } = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));

    // A 401 mid-session means the cookie expired: bounce to login. On the
    // login call itself it just means wrong credentials, so let the server's
    // own message through instead of overwriting it with "unauthorised".
    if (res.status === 401 && bounceOn401) {
      showLogin();
      throw new Error(data.error || 'Session expired — sign in again.');
    }
    if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
    return data;
  }

  // -- views ------------------------------------------------------------------

  function showLogin() {
    stopPolling();
    $('setup-view').hidden = true;
    $('login-view').hidden = false;
    $('app-view').hidden = true;
  }

  function showSetup(suggested) {
    stopPolling();
    $('login-view').hidden = true;
    $('app-view').hidden = true;
    $('setup-view').hidden = false;
    if (suggested.suggested_email) $('s-email').value = suggested.suggested_email;
    if (suggested.suggested_name) $('s-name').value = suggested.suggested_name;
    ($('s-email').value ? $('s-password') : $('s-email')).focus();
  }

  function showApp(user) {
    me = user;
    $('setup-view').hidden = true;
    $('login-view').hidden = true;
    $('app-view').hidden = false;
    $('who').textContent = `${user.name} · ${user.email}`;
    // Account management is admin-only, so the tab only exists for admins.
    $('nav-people').hidden = !user.is_admin;
  }

  function showSection(which) {
    for (const id of ['list-view', 'create-view', 'detail-view', 'kit-view', 'people-view']) {
      $(id).hidden = id !== which;
    }
    for (const btn of document.querySelectorAll('.nav button')) {
      // Create and detail both live under the Sessions tab.
      const owner = which === 'kit-view' ? 'kit-view'
        : which === 'people-view' ? 'people-view' : 'list-view';
      btn.classList.toggle('on', btn.dataset.nav === owner);
    }
    // Only the list needs to stay fresh; a detail page is edited, not watched.
    if (which === 'list-view') startPolling(); else stopPolling();
  }

  for (const btn of document.querySelectorAll('.nav button')) {
    btn.addEventListener('click', () => {
      if (btn.dataset.nav === 'kit-view') loadKit();
      else if (btn.dataset.nav === 'people-view') loadPeople();
      else { current = null; loadSessions(); }
    });
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => loadSessions({ quiet: true }), 10000);
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  // -- login ------------------------------------------------------------------

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('login-error');
    err.hidden = true;
    try {
      const { user } = await api('/api/auth/login', {
        method: 'POST',
        bounceOn401: false,
        body: { email: $('login-email').value, password: $('login-password').value },
      });
      $('login-password').value = '';
      showApp(user);
      await boot();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    }
  });

  $('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('setup-error');
    err.hidden = true;
    try {
      const { user } = await api('/api/auth/setup', {
        method: 'POST',
        bounceOn401: false,
        body: {
          email: $('s-email').value,
          name: $('s-name').value,
          password: $('s-password').value,
        },
      });
      $('s-password').value = '';
      showApp(user);
      await boot();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    }
  });

  $('btn-logout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    showLogin();
  });

  // -- session list -----------------------------------------------------------

  async function loadSessions({ quiet = false } = {}) {
    const includeEnded = $('show-ended').checked;
    let data;
    try {
      data = await api(`/api/admin/sessions${includeEnded ? '?all=1' : ''}`);
    } catch {
      return;   // an expired cookie already bounced us to the login view
    }

    const host = $('sessions');
    if (!data.sessions.length) {
      host.innerHTML = `<div class="empty-state">
        No sessions yet.<br>Create one, name the six tables, then hand each table its join link.</div>`;
      if (!quiet) showSection('list-view');
      return;
    }

    host.innerHTML = data.sessions.map((s) => {
      const live = s.live_state
        ? `<span><span class="dot-live"></span>${esc(s.live_state.phase || s.live_state.mode)} · ${esc(s.live_state.round)} · core ${s.live_state.core_integrity}</span>`
        : '';
      const connected = s.connected ? `<span>${s.connected} connected</span>` : '';
      return `<div class="card" data-code="${esc(s.code)}">
          <div>
            <div class="nm">${esc(s.name)}</div>
            <div class="meta">
              <span class="code">${esc(s.code)}</span>
              ${s.client_name ? `<span>${esc(s.client_name)}</span>` : ''}
              <span>${s.team_count} teams</span>
              <span>${esc(s.facilitator_name)}</span>
              ${live}${connected}
            </div>
          </div>
          <div class="right"><span class="status ${esc(s.status)}">${esc(s.status)}</span></div>
        </div>`;
    }).join('');

    for (const card of host.querySelectorAll('.card')) {
      card.addEventListener('click', () => openSession(card.dataset.code));
    }
    if (!quiet) showSection('list-view');
  }

  $('show-ended').addEventListener('change', () => loadSessions());

  // -- create -----------------------------------------------------------------

  $('btn-new').addEventListener('click', () => {
    $('create-form').reset();
    $('create-error').hidden = true;
    $('new-teams').innerHTML = meta.sectors.map((s) => `
      <div class="tf">
        <div class="sec"><span class="swatch" style="background:${esc(s.colour)}"></span>${esc(s.code)}</div>
        <input type="text" data-sector="${esc(s.code)}" placeholder="${esc(s.name)}">
      </div>`).join('') + `
      <div class="tf" style="grid-column:1/-1">
        <div class="sec">SCENARIO</div>
        <select id="new-scenario">${(meta.scenarios || []).map((sc) =>
          `<option value="${esc(sc.id)}">${esc(sc.name)}${sc.builtin ? '' : ' (saved)'}</option>`).join('')}</select>
      </div>`;
    showSection('create-view');
  });

  $('btn-cancel-create').addEventListener('click', () => showSection('list-view'));

  $('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('create-error');
    err.hidden = true;
    const teams = {};
    for (const input of $('new-teams').querySelectorAll('input')) {
      if (input.value.trim()) teams[input.dataset.sector] = input.value.trim();
    }
    try {
      const { session } = await api('/api/admin/sessions', {
        method: 'POST',
        body: {
          name: $('new-name').value,
          client_name: $('new-client').value,
          teams,
          scenario_id: $('new-scenario') ? $('new-scenario').value : null,
        },
      });
      await openSession(session.code);
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    }
  });

  // -- detail -----------------------------------------------------------------

  $('btn-back').addEventListener('click', () => { current = null; loadSessions(); });

  async function openSession(code) {
    const data = await api(`/api/admin/sessions/${encodeURIComponent(code)}`);
    current = { ...data.session, control_token: data.control_token };
    renderDetail();
    showSection('detail-view');
  }

  function absolute(pathname) {
    return `${location.origin}${pathname}`;
  }

  function renderDetail() {
    const s = current;
    const base = `/s/${s.code}`;
    const controlUrl = `${base}/control?token=${encodeURIComponent(s.control_token)}`;

    $('detail-actions').innerHTML = `
      ${s.status !== 'LIVE' && s.status !== 'ENDED'
        ? '<button class="primary" data-act="LIVE">OPEN SESSION</button>' : ''}
      ${s.status === 'LIVE' ? '<button data-act="DRAFT">PAUSE INTAKE</button>' : ''}
      ${s.status !== 'ENDED' ? '<button class="danger" data-act="ENDED">END SESSION</button>' : ''}
      <button data-act="log">DOWNLOAD LOG</button>
      ${s.status === 'ENDED' ? '<button class="danger" data-act="delete">DELETE</button>' : ''}`;

    for (const btn of $('detail-actions').querySelectorAll('button')) {
      btn.addEventListener('click', () => detailAction(btn.dataset.act));
    }

    const teamRows = meta.sectors.map((sec) => {
      const team = s.teams.find((t) => t.sector === sec.code);
      const joinUrl = team ? absolute(`/j/${team.join_code}`) : '';
      return `<tr data-sector="${esc(sec.code)}">
          <td><span class="sec-cell"><span class="swatch" style="background:${esc(sec.colour)}"></span>${esc(sec.code)}</span></td>
          <td><input type="text" class="team-name" value="${esc(team ? team.team_name : '')}"
                     placeholder="${esc(sec.name)}"></td>
          <td class="join">${team ? esc(team.join_code) : '—'}</td>
          <td class="actions">
            ${team ? `<button data-copy="${esc(joinUrl)}">COPY LINK</button>
                      <button data-rotate="${esc(sec.code)}" title="Invalidate the old link">NEW CODE</button>` : ''}
          </td>
        </tr>`;
    }).join('');

    $('detail').innerHTML = `
      <div class="detail-head">
        <h3>${esc(s.name)}</h3>
        <div class="meta">
          <span class="big-code">${esc(s.code)}</span>
          <span class="status ${esc(s.status)}">${esc(s.status)}</span>
          ${s.client_name ? `<span>${esc(s.client_name)}</span>` : ''}
          <span>run ${esc(s.run_id)}</span>
          ${s.live_state ? `<span><span class="dot-live"></span>${esc(s.live_state.phase || s.live_state.mode)} · ${esc(s.live_state.round)}</span>` : ''}
        </div>
      </div>

      <div class="links">
        <div class="link-card">
          <div class="lbl">Wall — projector</div>
          <div class="link-row">
            <input readonly value="${esc(absolute(`${base}/wall`))}">
            <button data-copy="${esc(absolute(`${base}/wall`))}">COPY</button>
            <button data-open="${esc(`${base}/wall`)}">OPEN</button>
          </div>
          <div class="warn-note">${esc(`${base}/bigscreen`)} is the older cross-section map view of the same feed.</div>
        </div>
        <div class="link-card">
          <div class="lbl">Admin console — facilitator only</div>
          <div class="link-row">
            <input readonly value="${esc(absolute(controlUrl))}">
            <button data-copy="${esc(absolute(controlUrl))}">COPY</button>
            <button data-open="${esc(controlUrl)}">OPEN</button>
          </div>
          <div class="warn-note">Carries the answer key. Never put this on the projector.</div>
        </div>
      </div>

      <table class="teams-table">
        <thead><tr><th>Sector</th><th>Team name</th><th>Join code</th><th></th></tr></thead>
        <tbody>${teamRows}</tbody>
      </table>
      <p class="hint">Each team's link opens their own dashboard — no sector to pick, nothing to type.
        Renaming a team saves when you click away.</p>`;

    wireDetail();
  }

  function wireDetail() {
    for (const btn of $('detail').querySelectorAll('[data-copy]')) {
      btn.addEventListener('click', () => copy(btn, btn.dataset.copy));
    }
    for (const btn of $('detail').querySelectorAll('[data-open]')) {
      btn.addEventListener('click', () => window.open(btn.dataset.open, '_blank'));
    }
    for (const btn of $('detail').querySelectorAll('[data-rotate]')) {
      btn.addEventListener('click', async () => {
        if (!confirm(`Issue a new join code for ${btn.dataset.rotate}? The old link stops working.`)) return;
        await api(`/api/admin/sessions/${current.code}/teams/${btn.dataset.rotate}/rotate`, { method: 'POST' });
        await openSession(current.code);
      });
    }
    for (const input of $('detail').querySelectorAll('.team-name')) {
      input.addEventListener('change', async () => {
        const sector = input.closest('tr').dataset.sector;
        const name = input.value.trim();
        if (!name) return;
        await api(`/api/admin/sessions/${current.code}/teams`, {
          method: 'POST', body: { sector, team_name: name },
        });
        await openSession(current.code);
      });
    }
  }

  async function detailAction(act) {
    if (act === 'log') {
      window.open(`/api/admin/sessions/${current.code}/log`, '_blank');
      return;
    }
    if (act === 'delete') {
      if (!confirm(`Delete "${current.name}" permanently? The run log stays on disk.`)) return;
      await api(`/api/admin/sessions/${current.code}`, { method: 'DELETE' });
      current = null;
      return loadSessions();
    }
    if (act === 'ENDED' &&
        !confirm(`End "${current.name}"? Every connected screen disconnects and it cannot be reopened.`)) {
      return;
    }
    await api(`/api/admin/sessions/${current.code}/status`, { method: 'POST', body: { status: act } });
    await openSession(current.code);
  }

  function copy(btn, text) {
    const done = () => {
      const original = btn.textContent;
      btn.textContent = 'COPIED';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1200);
    };
    // clipboard API needs a secure context; fall back for plain-http LAN use.
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    try { document.execCommand('copy'); done(); } catch { /* nothing else to try */ }
    document.body.removeChild(el);
  }

  // -- printable kit ----------------------------------------------------------

  const GROUPS = [
    {
      key: 'participant',
      title: 'Participant-facing',
      blurb: 'Safe to hand out and to leave on a table.',
    },
    {
      key: 'facilitator',
      title: 'Facilitator only — never leave on a participant table',
      blurb: 'The answer key carries every resolution code. Each binder carries that '
           + "sector's own spec values. Print these yourself and keep them with you.",
    },
  ];

  const kb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;

  async function loadKit() {
    showSection('kit-view');
    let kit;
    try {
      kit = await api('/api/admin/kit');
    } catch {
      return;
    }

    const sync = kit.sync || { status: 'unknown', detail: '' };
    const icon = { ok: '✓', drift: '✕', unknown: '!' }[sync.status] || '!';
    const heading = {
      ok: 'Kit matches this server',
      drift: 'Kit is out of date — do not print',
      unknown: 'No kit available',
    }[sync.status];

    const prov = kit.available && kit.sources
      ? `<div class="prov">Built ${new Date(kit.generated_at).toLocaleString()} ·
           ${kit.counts.faults} faults, ${kit.counts.specs} specs ·
           matrix ${(kit.sources.matrix && kit.sources.matrix.sha256 || '').slice(0, 12)}</div>`
      : '';

    $('kit-sync').innerHTML = `<div class="sync ${esc(sync.status)}">
        <span class="icon">${icon}</span>
        <span class="msg"><b>${esc(heading)}</b>${esc(sync.detail)}${prov}</span>
      </div>`;

    if (!kit.available) {
      $('kit-actions').innerHTML = '';
      $('kit-body').innerHTML = `<div class="empty-state">
        No documents have been built.<br>
        The kit is generated during deployment — run <code>npm run kit</code> locally,
        or redeploy.</div>`;
      return;
    }

    $('kit-actions').innerHTML =
      '<button class="primary" data-all="">DOWNLOAD ALL (.zip)</button>';
    $('kit-actions').querySelector('button')
      .addEventListener('click', () => download('/api/admin/kit/download-all'));

    $('kit-body').innerHTML = GROUPS.map((g) => {
      const docs = kit.files.filter((f) => f.audience === g.key);
      if (!docs.length) return '';
      return `<div class="kit-group ${g.key}">
          <h3>${esc(g.title)}</h3>
          <div class="blurb">${esc(g.blurb)}</div>
          <div class="doc-list">
            ${docs.map((d) => `<div class="doc ${g.key}${d.present ? '' : ' missing'}">
                <span><span class="t">${esc(d.title)}</span><br><span class="f">${esc(d.file)}</span></span>
                <span class="sz">${kb(d.bytes)}</span>
                ${d.present
                  ? `<button data-file="${esc(d.file)}">DOWNLOAD</button>`
                  : '<span class="sz">missing</span>'}
              </div>`).join('')}
          </div>
          <div style="margin-top:8px">
            <button data-group="${g.key}">Download ${esc(g.title.split(' —')[0].toLowerCase())} set (.zip)</button>
          </div>
        </div>`;
    }).join('');

    for (const btn of $('kit-body').querySelectorAll('[data-file]')) {
      btn.addEventListener('click', () =>
        download(`/api/admin/kit/download/${encodeURIComponent(btn.dataset.file)}`));
    }
    for (const btn of $('kit-body').querySelectorAll('[data-group]')) {
      btn.addEventListener('click', () =>
        download(`/api/admin/kit/download-all?audience=${btn.dataset.group}`));
    }
  }

  /** Same-origin, cookie-authenticated download. */
  function download(url) {
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // -- facilitators (admin only) ----------------------------------------------

  $('btn-add-person').addEventListener('click', () => {
    $('person-form').reset();
    $('person-error').hidden = true;
    $('person-form').hidden = false;
    $('p-email').focus();
  });
  $('btn-cancel-person').addEventListener('click', () => { $('person-form').hidden = true; });

  $('person-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('person-error');
    err.hidden = true;
    try {
      const res = await api('/api/admin/facilitators', {
        method: 'POST',
        body: {
          email: $('p-email').value,
          name: $('p-name').value,
          password: $('p-password').value || undefined,
          is_admin: $('p-admin').checked,
        },
      });
      $('person-form').hidden = true;
      showPassword(res.facilitator, res.generated_password, 'created');
      await loadPeople({ keepNotice: true });
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    }
  });

  /** A generated password is shown once — there is no way to read it back. */
  function showPassword(user, password, verb) {
    if (!password) {
      $('person-notice').innerHTML =
        `<div class="notice"><b>${esc(user.name)} ${esc(verb)}</b>
           <span class="sub">They can sign in with the password you set.</span></div>`;
      return;
    }
    $('person-notice').innerHTML = `<div class="notice">
        <b>${esc(user.name || 'Password reset')} ${esc(verb)}</b>
        <div class="pw">${esc(password)}</div>
        <div class="sub">Shown once — copy it now and pass it on.
          Nobody, including you, can read it back afterwards.</div>
      </div>`;
  }

  async function loadPeople({ keepNotice = false } = {}) {
    showSection('people-view');
    if (!keepNotice) $('person-notice').innerHTML = '';

    let data;
    try {
      data = await api('/api/admin/facilitators');
    } catch (e) {
      $('people').innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
      return;
    }

    $('people').innerHTML = `<table class="people-table">
        <thead><tr><th>Facilitator</th><th>Role</th><th>Sessions</th><th>Last sign-in</th><th></th></tr></thead>
        <tbody>${data.facilitators.map((u) => {
          const isMe = me && u.email === me.email;
          return `<tr data-id="${u.id}">
            <td><span class="nm">${esc(u.name)}</span>
                ${isMe ? '<span class="badge you">YOU</span>' : ''}<br>
                <span class="em">${esc(u.email)}</span></td>
            <td>${u.is_admin ? '<span class="badge admin">ADMIN</span>'
                             : '<span class="badge">FACILITATOR</span>'}</td>
            <td>${u.sessions_owned}</td>
            <td class="em">${u.last_login_at
              ? new Date(u.last_login_at).toLocaleDateString() : 'never'}</td>
            <td class="actions">
              <button data-reset="${u.id}">RESET PASSWORD</button>
              <button data-admin="${u.id}" data-to="${u.is_admin ? '0' : '1'}">
                ${u.is_admin ? 'REVOKE ADMIN' : 'MAKE ADMIN'}</button>
              ${isMe ? '' : `<button class="danger" data-del="${u.id}">REMOVE</button>`}
            </td></tr>`;
        }).join('')}</tbody></table>`;

    for (const btn of $('people').querySelectorAll('[data-reset]')) {
      btn.addEventListener('click', async () => {
        const row = btn.closest('tr');
        const name = row.querySelector('.nm').textContent;
        if (!confirm(`Reset the password for ${name}? Their current one stops working.`)) return;
        const res = await api(`/api/admin/facilitators/${btn.dataset.reset}/password`, { method: 'POST' });
        showPassword({ name }, res.generated_password, '— password reset');
      });
    }
    for (const btn of $('people').querySelectorAll('[data-admin]')) {
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/admin/facilitators/${btn.dataset.admin}/admin`, {
            method: 'POST', body: { is_admin: btn.dataset.to === '1' },
          });
          await loadPeople();
        } catch (e) { alert(e.message); }
      });
    }
    for (const btn of $('people').querySelectorAll('[data-del]')) {
      btn.addEventListener('click', async () => {
        const name = btn.closest('tr').querySelector('.nm').textContent;
        if (!confirm(`Remove ${name}? They lose access immediately.`)) return;
        try {
          await api(`/api/admin/facilitators/${btn.dataset.del}`, { method: 'DELETE' });
          await loadPeople();
        } catch (e) { alert(e.message); }
      });
    }
  }

  // -- boot -------------------------------------------------------------------

  async function boot() {
    meta = await api('/api/admin/meta');
    renderStorageWarning(meta.storage);
    await loadSessions();
  }

  /**
   * If the data directory will not survive a restart, say so on every page.
   * Losing accounts and run logs silently is the worst thing this platform
   * can do, so this is not tucked into a settings screen.
   */
  function renderStorageWarning(storage) {
    const host = $('storage-warning');
    if (!storage || (storage.verdict !== 'ephemeral' && storage.verdict !== 'unwritable')) {
      host.innerHTML = '';
      return;
    }
    const unwritable = storage.verdict === 'unwritable';
    host.innerHTML = `<div class="storage-warn">
        <span class="ic">${unwritable ? '✕' : '⚠'}</span>
        <span class="txt">
          <b>${unwritable
            ? 'Data directory is not writable'
            : 'Storage is temporary — everything here will be lost on restart'}</b>
          ${esc(storage.detail)}
          <span class="fix">Attach a persistent disk to this service and mount it at
            <code>${esc(storage.dir)}</code>. On Render that needs a paid instance;
            free instances cannot have a disk and spin down when idle.</span>
        </span>
      </div>`;
  }

  (async function start() {
    try {
      const { user } = await api('/api/auth/me', { bounceOn401: false });
      showApp(user);
      await boot();
      return;
    } catch {
      // not signed in — fall through
    }
    try {
      const setup = await api('/api/auth/needs-setup', { bounceOn401: false });
      if (setup.needs_setup) return showSetup(setup);
    } catch {
      // if that check fails, the login form is the safe default
    }
    showLogin();
  })();
})();
