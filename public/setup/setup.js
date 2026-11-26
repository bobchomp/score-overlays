import { MatchSocket, syncThemeCss, esc } from '/shared/socket.js';
import { POSITION_ORDER } from '/shared/match.js';
import { FORMATIONS, fitSlots, slotPositions } from '/shared/formations.js';
import { getPin, setPin } from '/shared/pin.js';

const $ = id => document.getElementById(id);
const data = { teams: [], logos: [], fonts: [], theme: null };
let snap = null;

// ------------------------------------------------------------------ helpers
let toastTimer;
function toast(text, error = false) {
  const t = $('toast');
  t.textContent = text; t.classList.toggle('error', error); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, error ? 4000 : 2000);
}

async function api(method, url, body, headers = {}) {
  const isRaw = body instanceof Blob;
  const res = await fetch(url, {
    method,
    headers: { 'X-Pin': getPin(), ...(body && !isRaw ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? (isRaw ? body : JSON.stringify(body)) : undefined,
  });
  let json = {};
  try { json = await res.json(); } catch {}
  if (res.status === 401) { showPin(json.error); throw new Error(json.error || 'PIN required'); }
  if (!res.ok || json.ok === false) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

const action = (name, payload) => api('POST', '/api/action', { action: name, payload });

function showPin(error) {
  $('pin-screen').hidden = false;
  $('pin-error').textContent = error && getPin() ? error : '';
  $('pin-input').focus();
}
$('pin-form').addEventListener('submit', async e => {
  e.preventDefault();
  const pin = $('pin-input').value.trim();
  const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
  const json = await res.json().catch(() => ({}));
  if (json.ok) { setPin(pin); $('pin-screen').hidden = true; $('pin-input').value = ''; }
  else $('pin-error').textContent = json.error || 'Wrong PIN';
});

async function checkPin() {
  if (!getPin()) return showPin();
  const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: getPin() }) });
  if (!res.ok) showPin('Wrong PIN');
}

async function loadData() {
  const [teams, logos, fonts, theme] = await Promise.all(['/api/teams', '/api/logos', '/api/fonts', '/api/theme'].map(u => fetch(u).then(r => r.json())));
  Object.assign(data, { teams, logos, fonts, theme });
}

/** Ask for an image file and upload it; resolves with its URL. */
function uploadImage(nameHint) {
  return new Promise(resolve => {
    const input = $('file-input');
    input.value = '';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      try {
        const r = await api('POST', `/api/upload?name=${encodeURIComponent(nameHint || file.name)}`, file, { 'Content-Type': file.type });
        data.logos = await fetch('/api/logos').then(x => x.json());
        toast('Image uploaded');
        resolve(r.url);
      } catch (err) { toast(err.message, true); resolve(null); }
    };
    input.click();
  });
}

/** Logo dropdown with preview + upload. */
function logoPicker(el, value, onChange, nameHint) {
  const render = v => {
    const opts = ['', ...new Set([...data.logos, ...(v ? [v] : [])])];
    el.innerHTML = `${v ? `<img src="${esc(v)}" alt="">` : '<span class="none"></span>'}
      <select class="input">${opts.map(o => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${o ? esc(o.split('/').pop()) : 'No badge'}</option>`).join('')}</select>
      <button type="button" class="btn small">Upload…</button>`;
    el.querySelector('select').onchange = e => { render(e.target.value); onChange(e.target.value); };
    el.querySelector('button').onclick = async () => {
      const url = await uploadImage(typeof nameHint === 'function' ? nameHint() : nameHint);
      if (url) { render(url); onChange(url); }
    };
  };
  render(value || '');
}

/** Colour swatch + hex field. */
function colorField(label, value, onChange) {
  const wrap = document.createElement('label');
  wrap.className = 'color';
  wrap.innerHTML = `${esc(label)}<span class="pair"><input type="color"><input class="input hex" maxlength="7"></span>`;
  const [picker, hex] = wrap.querySelectorAll('input');
  const set = v => { picker.value = /^#[0-9a-f]{6}$/i.test(v) ? v : '#000000'; hex.value = v; };
  set(value || '#000000');
  picker.oninput = () => { hex.value = picker.value; onChange(picker.value); };
  hex.oninput = () => { if (/^#[0-9a-f]{6}$/i.test(hex.value)) { picker.value = hex.value; onChange(hex.value); } };
  return wrap;
}

const byNumber = (a, b) => (a.number ?? 999) - (b.number ?? 999);

// ------------------------------------------------------------------ autosave
// Each page watches its draft. When it changes and then stays the same for a moment, it's saved.
// The pill in the corner says what's happening.
let pillTimer = null;
function savePill(text, kind = '') {
  const el = $('autosave');
  el.textContent = text; el.className = `autosave ${kind}`; el.hidden = false;
  clearTimeout(pillTimer);
  if (kind === 'ok') pillTimer = setTimeout(() => { el.hidden = true; }, 2500);
}
class Autosaver {
  constructor({ get, save, check = () => null, delay = 700 }) {
    Object.assign(this, { get, save, check, delay });
    this.saved = null; this.seen = null; this.changedAt = 0; this.busy = false; this.blocked = null;
    setInterval(() => this.tick(), 200);
  }
  json() { const v = this.get(); return v == null ? null : JSON.stringify(v); }
  /** The current draft is what's on the server (just loaded or saved). */
  reset() { this.saved = this.seen = this.json(); }
  dirty() { const j = this.json(); return j != null && this.saved != null && j !== this.saved; }
  tick() {
    if (this.busy) return;
    const j = this.json();
    if (j == null || this.saved == null || j === this.saved) return;
    if (j !== this.seen) { this.seen = j; this.changedAt = Date.now(); return; }
    if (Date.now() - this.changedAt < this.delay) return;
    const why = this.check();
    if (why) { if (why !== this.blocked) { this.blocked = why; savePill(why, 'warn'); } return; }
    this.blocked = null;
    this.flush();
  }
  /** Save now if there are changes (e.g. before switching to another team). */
  async flush() {
    const j = this.json();
    if (this.busy || j == null || j === this.saved || this.check()) return;
    this.busy = true;
    savePill('Saving…');
    try {
      await this.save(JSON.parse(j));
      this.saved = j;
      savePill('All changes saved', 'ok');
    } catch (err) { savePill(`Couldn't save: ${err.message}`, 'bad'); this.changedAt = Date.now() + 3000; }
    finally { this.busy = false; }
  }
}

// ------------------------------------------------------------------ which page
// This page only runs inside the control dock (Lineups tab, Settings → Teams / Theme): ?embed=match|teams|theme.
const EMBED = ['match', 'teams', 'theme'].includes(new URLSearchParams(location.search).get('embed'))
  ? new URLSearchParams(location.search).get('embed') : 'match';
document.querySelectorAll('.tab-panel').forEach(p => { p.hidden = p.id !== `tab-${EMBED}`; });

// ================================================================== MATCH TAB
let form = null;      // working copy of the match setup

function formFromState(st) {
  const side = s => ({
    teamId: st.teams[s].id || '',
    colors: { ...st.teams[s].colors },
    lineup: structuredClone(st.teams[s].lineup || { starting: [], subs: [], captain: null }),
  });
  const fl = st.match.firstLeg || { enabled: false, home: 0, away: 0 };
  return { competition: st.match.competition, competitionLogo: st.match.competitionLogo, firstLeg: { ...fl }, home: side('home'), away: side('away') };
}

function renderMatch() {
  if (!form) return;
  $('m-comp').value = form.competition || '';
  logoPicker(document.querySelector('[data-target="m-comp-logo"]'), form.competitionLogo, v => { form.competitionLogo = v; }, () => `${form.competition || 'competition'}-badge`);
  for (const s of ['home', 'away']) renderSide(s);
  renderLeg();
}
$('m-comp').addEventListener('input', e => { form.competition = e.target.value; });

function renderLeg() {
  const fl = form.firstLeg;
  $('m-2leg').checked = fl.enabled;
  $('m-leg').hidden = !fl.enabled;
  if (document.activeElement !== $('m-leg-home')) $('m-leg-home').value = fl.home;
  if (document.activeElement !== $('m-leg-away')) $('m-leg-away').value = fl.away;
  for (const s of ['home', 'away']) {
    const t = data.teams.find(x => x.id === form[s].teamId);
    $(`m-leg-${s}-name`).textContent = t ? t.name : (s === 'home' ? 'Home team' : 'Away team');
  }
}
$('m-2leg').addEventListener('change', e => { form.firstLeg.enabled = e.target.checked; renderLeg(); });
for (const s of ['home', 'away']) {
  $(`m-leg-${s}`).addEventListener('input', e => { form.firstLeg[s] = Math.max(0, Number(e.target.value) || 0); });
}

const pitchPick = { home: null, away: null }; // slot tapped first when swapping two players

function formationHtml(s, f, team) {
  const lu = f.lineup;
  const opts = `<option value="" ${!lu.formation ? 'selected' : ''}>None (list)</option>`
    + FORMATIONS.map(x => `<option ${x === lu.formation ? 'selected' : ''}>${x}</option>`).join('');
  if (!lu.formation) {
    return `<div class="formation"><label class="field">Formation (lineup graphic)<select class="input form-sel">${opts}</select></label>
      <p class="hint">No formation: the lineup graphic lists the XI by position.</p></div>`;
  }
  const pos = slotPositions(lu.formation);
  const byId = new Map(team.squad.map(p => [p.id, p]));
  const marks = lu.slots.map((id, i) => {
    const p = id ? byId.get(id) : null;
    const last = p ? p.name.trim().split(/\s+/).pop() : '';
    return `<button class="pm ${i === 0 ? 'gk' : ''} ${p ? '' : 'empty'} ${pitchPick[s] === i ? 'picked' : ''}" data-slot="${i}"
      style="left:${pos[i].x}%;top:${pos[i].y}%" title="${esc(p ? p.name : 'Empty: add players to the XI')}">
      <span class="pm-dot">${p ? esc(p.number ?? '') : '+'}</span><span class="pm-name">${esc(last)}</span></button>`;
  }).join('');
  return `<div class="formation"><label class="field">Formation (lineup graphic)<select class="input form-sel">${opts}</select></label>
    <div class="mini-pitch">${marks}</div>
    <p class="hint">${pitchPick[s] != null ? 'Now tap the player (or empty spot) to swap with.' : 'Tap two players to swap their places. The XI fills in from the positions above (GK, DEF, MID, FWD).'}</p></div>`;
}

function renderSide(s) {
  const el = document.querySelector(`.side[data-side="${s}"]`);
  const f = form[s];
  const team = data.teams.find(t => t.id === f.teamId);
  const nXI = f.lineup.starting.length;
  // Older matches have no formation yet: start from the team's last one (or 4-4-2).
  if (team && f.lineup.formation === undefined) f.lineup.formation = team.formation || '4-4-2';
  if (team && f.lineup.formation) f.lineup.slots = fitSlots(f.lineup.formation, f.lineup.slots, f.lineup.starting, team.squad);
  el.innerHTML = `<h2>${s === 'home' ? 'Home' : 'Away'} team <span class="lu-count ${nXI && nXI !== 11 ? 'bad' : ''}">XI: ${nXI}/11 · Subs: ${f.lineup.subs.length}</span></h2>
    <select class="input team-sel"><option value="">Pick a team…</option>
      ${data.teams.map(t => `<option value="${esc(t.id)}" ${t.id === f.teamId ? 'selected' : ''}>${esc(t.name)} (${esc(t.short)})</option>`).join('')}</select>
    <div class="colors"></div>
    ${team ? `<div class="row wrap">
        <button class="btn small" data-q="first11">Auto-pick XI (first 11 by number)</button>
        <button class="btn small" data-q="restsubs">Everyone else → subs</button>
        <button class="btn small ghost" data-q="clear">Clear</button></div>
      ${formationHtml(s, f, team)}
      <table class="lu-table"><thead><tr><th></th><th>Player</th><th>Pos</th><th>Role</th><th title="Captain">C</th></tr></thead><tbody>
      ${[...team.squad].sort((a, b) => POSITION_ORDER.indexOf(a.position) - POSITION_ORDER.indexOf(b.position) || byNumber(a, b)).map(p => {
        const xi = f.lineup.starting.includes(p.id);
        const sub = f.lineup.subs.includes(p.id);
        return `<tr data-pid="${esc(p.id)}"><td class="n">${esc(p.number ?? '')}</td><td>${esc(p.name)}</td><td class="pos">${esc(p.position)}</td>
          <td><span class="role"><button data-r="xi" class="${xi ? 'on' : ''}" ${!xi && nXI >= 11 ? 'disabled title="The XI is full: take a player out first"' : ''}>XI</button><button data-r="sub" class="${sub ? 'on' : ''}">SUB</button></span></td>
          <td><input type="radio" class="cap" name="cap-${s}" ${f.lineup.captain === p.id ? 'checked' : ''} ${xi ? '' : 'disabled'}></td></tr>`;
      }).join('')}</tbody></table>` : '<p class="hint">Teams are managed on the Teams tab.</p>'}`;

  el.querySelector('.team-sel').onchange = e => {
    const t = data.teams.find(x => x.id === e.target.value);
    // Changes go live straight away, so once the match is under way a team swap must be meant.
    const st = snap?.state;
    const underway = st && f.teamId && (st.clock.period !== 'PRE' || st.clock.running || st.events.length);
    if (underway && !confirm(`The match has started. Change the ${s} team to ${t ? t.name : 'none'}? The scorebug and graphics change straight away.`)) {
      e.target.value = f.teamId;
      return;
    }
    form[s] = { teamId: e.target.value, colors: t ? { ...t.colors } : f.colors, lineup: { starting: [], subs: [], captain: null, formation: t?.formation || '4-4-2', slots: [] } };
    pitchPick[s] = null;
    renderSide(s); renderLeg();
  };
  const colors = el.querySelector('.colors');
  for (const [k, label] of [['primary', 'Primary'], ['secondary', 'Secondary'], ['text', 'Text on primary']]) {
    colors.append(colorField(label, f.colors[k], v => { f.colors[k] = v; }));
  }
  if (!team) return;
  el.querySelectorAll('[data-q]').forEach(b => b.onclick = () => {
    const sorted = [...team.squad].sort(byNumber);
    if (b.dataset.q === 'first11') { f.lineup.starting = sorted.slice(0, 11).map(p => p.id); f.lineup.subs = f.lineup.subs.filter(id => !f.lineup.starting.includes(id)); }
    if (b.dataset.q === 'restsubs') f.lineup.subs = sorted.filter(p => !f.lineup.starting.includes(p.id)).map(p => p.id);
    if (b.dataset.q === 'clear') f.lineup = { starting: [], subs: [], captain: null, formation: f.lineup.formation, slots: [] };
    if (!f.lineup.starting.includes(f.lineup.captain)) f.lineup.captain = null;
    renderSide(s);
  });
  const fsel = el.querySelector('.form-sel');
  if (fsel) fsel.onchange = () => { f.lineup.formation = fsel.value || null; pitchPick[s] = null; renderSide(s); };
  el.querySelectorAll('.pm[data-slot]').forEach(b => b.onclick = () => {
    const i = Number(b.dataset.slot);
    const first = pitchPick[s];
    if (first == null) pitchPick[s] = i;
    else {
      if (first !== i) { const sl = f.lineup.slots; [sl[first], sl[i]] = [sl[i], sl[first]]; }
      pitchPick[s] = null;
    }
    renderSide(s);
  });
  el.querySelectorAll('tr[data-pid]').forEach(tr => {
    const pid = tr.dataset.pid;
    tr.querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
      const lu = f.lineup;
      const r = b.dataset.r;
      const wasOn = (r === 'xi' ? lu.starting : lu.subs).includes(pid);
      if (r === 'xi' && !wasOn && lu.starting.length >= 11) return toast('The XI already has 11 players. Take one out first.', true);
      lu.starting = lu.starting.filter(x => x !== pid);
      lu.subs = lu.subs.filter(x => x !== pid);
      if (!wasOn) (r === 'xi' ? lu.starting : lu.subs).push(pid);
      if (!lu.starting.includes(lu.captain)) lu.captain = null;
      renderSide(s);
    });
    tr.querySelector('.cap').onchange = () => { f.lineup.captain = pid; };
  });
}

// Lineups save by themselves (they never touch the score, events or clock).
const lineupSaver = new Autosaver({
  get: () => form,
  check: () => (form.home.teamId && form.home.teamId === form.away.teamId ? 'Home and away are the same team: pick another to save' : null),
  save: async f => {
    await action('match.setup', { ...f, newMatch: false });
    rememberFormations(f);
  },
});

// Remember each team's formation for its next match.
async function rememberFormations(f) {
  for (const s of ['home', 'away']) {
    const t = data.teams.find(x => x.id === f[s].teamId);
    const fm = f[s].lineup.formation || '';
    if (t && (t.formation || '') !== fm) {
      try { await api('POST', '/api/teams', { ...t, formation: fm }); t.formation = fm; } catch {}
    }
  }
}

$('m-new').onclick = async () => {
  if (!form.home.teamId || !form.away.teamId) return toast('Pick both teams first', true);
  if (form.home.teamId === form.away.teamId) return toast('Home and away must be different teams', true);
  if (!(await confirmBox('Start a NEW match? The score, events and clock will be cleared (you can still undo from the dock).'))) return;
  try {
    await action('match.setup', { ...form, newMatch: true });
    lineupSaver.reset();
    rememberFormations(form);
    toast('New match ready');
  } catch (err) { toast(err.message, true); }
};

function confirmBox(msg) { return Promise.resolve(window.confirm(msg)); }

// ================================================================== TEAMS TAB
let editing = null;   // team being edited (copy)
let editingIsNew = false;

function renderTeamList() {
  $('team-list').innerHTML = data.teams.map(t => `<button class="btn ${editing && !editingIsNew && editing.id === t.id ? 'active' : ''}" data-team="${esc(t.id)}">
    ${t.logo ? `<img src="${esc(t.logo)}" alt="">` : ''}${esc(t.name)} <span class="muted">${esc(t.short)} · ${t.squad.length}</span></button>`).join('')
    || '<p class="muted">No teams yet.</p>';
  $('team-list').querySelectorAll('[data-team]').forEach(b => b.onclick = async () => {
    await teamSaver.flush(); // finish saving the team you were on
    editing = structuredClone(data.teams.find(t => t.id === b.dataset.team));
    editingIsNew = false;
    teamSaver.reset();
    renderTeamList(); renderTeamEditor();
  });
}
$('t-new').onclick = async () => {
  await teamSaver.flush();
  editing = { id: '', name: '', short: '', colors: { primary: '#1d4ed8', secondary: '#ffffff', text: '#ffffff' }, logo: '', manager: '', formation: '', squad: [] };
  editingIsNew = true;
  teamSaver.reset();
  renderTeamList(); renderTeamEditor();
};

// An existing team saves by itself; a new one is created once with "Create team" (it needs a name first).
const teamSaver = new Autosaver({
  get: () => (editing && !editingIsNew ? editing : null),
  check: () => (!editing.name.trim() ? 'Enter a team name to save' : null),
  delay: 800,
  save: async t => {
    if (!t.short.trim()) t.short = t.name.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase();
    const r = await api('POST', '/api/teams', t);
    data.teams = await fetch('/api/teams').then(x => x.json());
    renderTeamList();
    const nums = r.team.squad.filter(p => p.number != null).map(p => p.number);
    const dup = nums.find((n, i) => nums.indexOf(n) !== i);
    if (dup != null) setTimeout(() => savePill(`Saved, but shirt number ${dup} is used twice`, 'warn'), 50);
  },
});

function renderTeamEditor() {
  const el = $('team-editor');
  const t = editing;
  if (!t) { el.innerHTML = '<p class="muted">Pick a team to edit, or create a new one.</p>'; return; }
  el.innerHTML = `<h2>${editingIsNew ? 'New team' : `Edit ${esc(t.name)}`}</h2>
    <div class="grid3">
      <label class="field">Full name<input class="input" id="te-name" value="${esc(t.name)}" maxlength="40"></label>
      <label class="field">Short name (3 letters)<input class="input" id="te-short" value="${esc(t.short)}" maxlength="4" style="text-transform:uppercase"></label>
      <label class="field">Badge / logo<div class="logo-pick" id="te-logo"></div></label>
    </div>
    <div class="grid3">
      <label class="field">Manager<input class="input" id="te-manager" value="${esc(t.manager || '')}" maxlength="40" placeholder="e.g. Don Cowie"></label>
    </div>
    <div class="colors" id="te-colors"></div>
    <div class="sec-title">Squad (${t.squad.length})</div>
    <table class="squad-table"><thead><tr><th>No.</th><th>Name</th><th>Position</th><th></th></tr></thead><tbody id="te-squad"></tbody></table>
    <div class="row wrap"><button class="btn small" id="te-add">+ Add player</button><button class="btn small ghost" id="te-sort">Sort by number</button></div>
    <details><summary>Paste a squad list</summary>
      <p class="hint">One player per line: <code>number name position</code>, e.g. <code>9 Dan Kerr FWD</code>. Position is GK, DEF, MID or FWD (optional). Pasted players are added to the list.</p>
      <textarea class="input" id="te-paste" placeholder="1 Sam Carter GK&#10;2 Leo Hughes DEF"></textarea>
      <div class="row"><button class="btn small" id="te-import">Add pasted players</button></div>
    </details>
    <div class="row wrap" style="margin-top:16px">
      ${editingIsNew ? '<button class="btn primary" id="te-save">Create team</button>' : ''}
      ${editingIsNew ? '' : '<button class="btn danger-ghost" id="te-del">Delete team</button>'}
    </div>`;
  $('te-name').oninput = e => { t.name = e.target.value; };
  $('te-short').oninput = e => { t.short = e.target.value.toUpperCase(); };
  $('te-manager').oninput = e => { t.manager = e.target.value; };
  logoPicker($('te-logo'), t.logo, v => { t.logo = v; }, () => t.name || 'team');
  for (const [k, label] of [['primary', 'Primary'], ['secondary', 'Secondary'], ['text', 'Text on primary']]) {
    $('te-colors').append(colorField(label, t.colors[k], v => { t.colors[k] = v; }));
  }
  renderSquad();
  $('te-add').onclick = () => {
    const next = Math.max(0, ...t.squad.map(p => p.number || 0)) + 1;
    t.squad.push({ id: '', number: next, name: '', position: 'MID' });
    renderSquad();
    const inputs = $('te-squad').querySelectorAll('.pname');
    inputs[inputs.length - 1]?.focus();
  };
  $('te-sort').onclick = () => { t.squad.sort(byNumber); renderSquad(); };
  $('te-import').onclick = () => {
    const lines = $('te-paste').value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let added = 0;
    for (const line of lines) {
      const m = line.replace(/[,;\t]+/g, ' ').match(/^#?(\d{1,3})?\s*(.+?)(?:\s+(GK|DEF|MID|FWD|G|D|M|F))?$/i);
      if (!m || !m[2]) continue;
      const pos = (m[3] || 'MID').toUpperCase();
      t.squad.push({ id: '', number: m[1] ? Number(m[1]) : null, name: m[2].trim(), position: { G: 'GK', D: 'DEF', M: 'MID', F: 'FWD' }[pos] || pos });
      added++;
    }
    $('te-paste').value = '';
    renderSquad();
    toast(`${added} player(s) added`);
  };
  if (editingIsNew) $('te-save').onclick = saveTeam;
  if (!editingIsNew) $('te-del').onclick = async () => {
    if (!confirm(`Delete ${t.name}? This removes config/teams/${t.id}.json.`)) return;
    try { await api('DELETE', `/api/teams/${encodeURIComponent(t.id)}`); editing = null; await refreshTeams(); renderTeamEditor(); toast('Team deleted'); }
    catch (err) { toast(err.message, true); }
  };
}

function renderSquad() {
  const t = editing;
  $('te-squad').innerHTML = t.squad.map((p, i) => `<tr data-i="${i}">
    <td class="num"><input class="input pnum" type="number" min="0" max="999" value="${esc(p.number ?? '')}"></td>
    <td><input class="input pname" value="${esc(p.name)}" placeholder="Player name" maxlength="40"></td>
    <td class="posc"><select class="input ppos">${POSITION_ORDER.map(x => `<option ${x === p.position ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
    <td class="del"><button class="btn small danger-ghost" title="Remove">✕</button></td></tr>`).join('');
  $('te-squad').querySelectorAll('tr').forEach(tr => {
    const p = t.squad[Number(tr.dataset.i)];
    tr.querySelector('.pnum').oninput = e => { p.number = e.target.value === '' ? null : Number(e.target.value); };
    tr.querySelector('.pname').oninput = e => { p.name = e.target.value; };
    tr.querySelector('.ppos').onchange = e => { p.position = e.target.value; };
    tr.querySelector('button').onclick = () => { t.squad.splice(Number(tr.dataset.i), 1); renderSquad(); };
  });
}

async function saveTeam() {
  const t = editing;
  if (!t.name.trim()) return toast('Enter a team name', true);
  if (!t.short.trim()) t.short = t.name.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase();
  const nums = t.squad.filter(p => p.name.trim() && p.number != null).map(p => p.number);
  const dup = nums.find((n, i) => nums.indexOf(n) !== i);
  if (dup != null && !confirm(`Shirt number ${dup} is used twice. Save anyway?`)) return;
  if (editingIsNew) {
    const id = t.name.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '');
    if (data.teams.some(x => x.id === id) && !confirm(`A team file "${id}" already exists. Overwrite it?`)) return;
    t.id = id;
  }
  try {
    const r = await api('POST', '/api/teams', t);
    editing = structuredClone(r.team);
    editingIsNew = false;
    teamSaver.reset();
    await refreshTeams();
    renderTeamEditor();
    toast('Team created: changes now save by themselves');
  } catch (err) { toast(err.message, true); }
}

async function refreshTeams() {
  data.teams = await fetch('/api/teams').then(r => r.json());
  renderTeamList();
  if (form) for (const s of ['home', 'away']) renderSide(s);
}

// ================================================================== THEME TAB
const COLOR_LABELS = {
  panel: 'Panel background', panelAlt: 'Panel (alternate)', panelText: 'Panel text', muted: 'Secondary text',
  accent: 'Accent (tags, highlights)', accentText: 'Text on accent', clock: 'Clock text', clockBg: 'Clock background',
  yellow: 'Yellow card', red: 'Red card / added time', green: 'Sub on arrow',
};
const LABEL_NAMES = {
  goal: 'Goal sting text', ownGoal: 'Own goal', kickOff: 'Kick-off board', halfTime: 'Half-time board', fullTime: 'Full-time board',
  startingXI: 'Lineup title', substitutes: 'Lineup subs title', manager: 'Lineup manager title', substitution: 'Substitution tag', yellowCard: 'Yellow card tag',
  redCard: 'Red card tag', secondYellow: 'Second yellow tag', versus: 'Kick-off "VS"', extraTime: 'Extra time period', penalties: 'Penalties period (scorebug)',
  shootout: 'Shootout title', suddenDeath: 'Shootout sudden death', win: 'Shootout winner (e.g. HIL WIN)',
  aggregate: 'Aggregate tab (e.g. AGG)', replay: 'Replay bug', slowMo: 'Replay bug slow-motion tag',
};

let themeDraft = null;
const themeSaver = new Autosaver({
  get: () => themeDraft,
  delay: 800,
  save: async th => { const r = await api('PUT', '/api/theme', th); data.theme = r.theme; },
});

function renderTheme() {
  const th = themeDraft = structuredClone(data.theme);
  themeSaver.reset();
  const el = $('theme-editor');
  el.innerHTML = `<h2>Theme</h2>
    <div class="grid2">
      <label class="field">Club name<input class="input" id="th-club" value="${esc(th.clubName)}"></label>
      <label class="field">Club badge (shown on the scorebug and text lower thirds)<div class="logo-pick" id="th-logo"></div></label>
    </div>
    <div class="sec-title">Colours</div><div class="colors" id="th-colors"></div>
    <div class="sec-title">Fonts</div>
    <div class="grid2">
      ${['heading', 'body'].map(k => `<label class="field">${k === 'heading' ? 'Headings, names, numbers' : 'Body text'}
        <select class="input" data-font="${k}">${data.fonts.map(f => `<option ${f === th.fonts[k] ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>
        <span class="font-sample" data-sample="${k}" style="font-family:'${esc(th.fonts[k])}'">GOAL! 23' Dan Kerr</span></label>`).join('')}
    </div>
    <p class="hint">To add a font, put its files in <code>public/assets/fonts/&lt;Font Name&gt;/</code> named by weight (<code>400.woff2</code>, <code>700.woff2</code>…) and restart.</p>
    <div class="sec-title">Titles &amp; labels</div>
    <div class="grid4">${Object.keys(LABEL_NAMES).map(k => `<label class="field">${esc(LABEL_NAMES[k])}<input class="input" data-label="${k}" value="${esc(th.labels[k] ?? '')}" maxlength="40"></label>`).join('')}</div>
    <div class="sec-title">Timings</div>
    <div class="grid4">
      <label class="field">Lower third on screen (seconds, 0 = until hidden)<input class="input" type="number" min="0" max="120" id="th-lt" value="${esc(th.timings.lowerThirdSec)}"></label>
      <label class="field">Goal sting length (ms, 0 = off)<input class="input" type="number" min="0" max="10000" step="100" id="th-sting" value="${esc(th.timings.stingMs)}"></label>
    </div>
    <p class="hint">Changes save by themselves and the overlay updates straight away.</p>`;
  $('th-club').oninput = e => { th.clubName = e.target.value; };
  logoPicker($('th-logo'), th.clubLogo, v => { th.clubLogo = v; }, () => th.clubName || 'club');
  for (const k of Object.keys(COLOR_LABELS)) $('th-colors').append(colorField(COLOR_LABELS[k], th.colors[k], v => { th.colors[k] = v; }));
  el.querySelectorAll('[data-font]').forEach(s => s.onchange = () => {
    th.fonts[s.dataset.font] = s.value;
    el.querySelector(`[data-sample="${s.dataset.font}"]`).style.fontFamily = `'${s.value}'`;
  });
  el.querySelectorAll('[data-label]').forEach(i => i.oninput = () => { th.labels[i.dataset.label] = i.value; });
  $('th-lt').oninput = e => { th.timings.lowerThirdSec = Number(e.target.value) || 0; };
  $('th-sting').oninput = e => { th.timings.stingMs = Number(e.target.value) || 0; };
}

// ================================================================== boot
new MatchSocket({
  role: 'overlay',
  page: 'setup',
  onState(msg) {
    snap = msg;
    syncThemeCss(msg.themeRev);
    // Pick up changes made elsewhere, unless there are unsaved edits here. Only redraw if something
    // actually differs, so the box you're typing in keeps its focus after an autosave.
    if (!form || !lineupSaver.dirty()) {
      const next = formFromState(msg.state);
      if (!form || JSON.stringify(next) !== JSON.stringify(form)) {
        form = next;
        lineupSaver.reset(); // what the server has; anything the page fills in (e.g. a starting formation) then saves
        renderMatch();
      } else lineupSaver.reset();
    }
  },
  onStatus(connected) { $('banner-offline').hidden = connected; },
});

await checkPin();
await loadData();
renderTeamList();
renderTheme();
if (snap) { form = formFromState(snap.state); lineupSaver.reset(); renderMatch(); }
// Ctrl+Z here undoes the last match change, as it does in the dock (inside a text box it undoes the typing).
addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return;
  if (e.target.closest('input, textarea, select')) return;
  e.preventDefault();
  try { parent.postMessage({ type: 'undo' }, location.origin); } catch {}
});

// The dock asks for a refresh when the tab is shown again, so teams saved on the Teams tab appear on the Lineups tab.
addEventListener('message', async e => {
  if (e.origin !== location.origin || e.data?.type !== 'refresh') return;
  try { await loadData(); renderTeamList(); if (form) renderMatch(); } catch {}
});
