import { MatchSocket, esc } from '/shared/socket.js';
import {
  displayMs, formatClock, findPlayer, otherSide, onPitch, yellowCount, isSentOff, PLAYING_PERIODS, shootoutSummary,
} from '/shared/match.js';
import { getPin, setPin, clearPin } from '/shared/pin.js';

const $ = id => document.getElementById(id);
let snap = null;

// ------------------------------------------------------------------ socket + PIN
const sock = new MatchSocket({
  role: 'control',
  pin: getPin(),
  onState(msg) { snap = msg; render(); },
  onStatus(connected) {
    $('banner-offline').hidden = connected;
    $('dot-server').classList.toggle('on', connected);
    document.body.classList.toggle('offline', !connected);
  },
  onAuth(msg) {
    if (msg.ok) { $('pin-screen').hidden = true; return; }
    $('pin-screen').hidden = false;
    $('pin-error').textContent = getPin() ? msg.error || 'Wrong PIN' : '';
    $('pin-input').focus();
  },
});

if (!getPin()) $('pin-screen').hidden = false;
$('pin-form').addEventListener('submit', e => {
  e.preventDefault();
  const pin = $('pin-input').value.trim();
  setPin(pin);
  $('pin-input').value = '';
  sock.setPin(pin);
});

async function act(action, payload) {
  const r = await sock.action(action, payload);
  if (!r.ok) toast(r.error || 'Failed', true);
  return r;
}

// ------------------------------------------------------------------ toast
let toastTimer;
function toast(text, error = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('error', error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, error ? 3500 : 1800);
}

// ------------------------------------------------------------------ sheet (modal)
let sheetOnClose = null;
function openSheet(title, html, onClose, actionsHtml = '') {
  $('sheet-title').textContent = title;
  $('sheet-actions').innerHTML = actionsHtml;
  $('sheet-body').innerHTML = html;
  $('sheet').hidden = false;
  sheetOnClose = onClose || null;
  $('sheet-body').scrollTop = 0;
}
function closeSheet() {
  $('sheet').hidden = true;
  $('sheet-body').innerHTML = '';
  $('sheet-actions').innerHTML = '';
  const cb = sheetOnClose; sheetOnClose = null;
  if (cb) cb();
}
$('sheet').addEventListener('click', e => {
  if (e.target === $('sheet') || e.target.closest('[data-sheet-close]')) closeSheet();
});

/** Confirmation dialog (native confirm() is unreliable inside OBS docks). */
function ask(message, okLabel = 'Yes', danger = false) {
  return new Promise(resolve => {
    let answered = false;
    openSheet('Are you sure?', `<p>${esc(message)}</p>
      <div class="row"><button class="btn grow" data-sheet-close>Cancel</button>
      <button class="btn grow ${danger ? 'danger' : 'primary'}" id="ask-ok">${esc(okLabel)}</button></div>`,
    () => { if (!answered) resolve(false); });
    $('ask-ok').onclick = () => { answered = true; closeSheet(); resolve(true); };
  });
}

/** Prompt for a value (native prompt() is unreliable inside OBS docks). */
function promptSheet(title, label, value = '', placeholder = '') {
  return new Promise(resolve => {
    let answered = false;
    openSheet(title, `<form id="prompt-form"><label class="field">${esc(label)}
      <input class="input" id="prompt-input" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off"></label>
      <div class="row"><button type="button" class="btn grow" data-sheet-close>Cancel</button><button class="btn grow primary">OK</button></div></form>`,
    () => { if (!answered) resolve(null); });
    const input = $('prompt-input');
    input.focus(); input.select();
    $('prompt-form').onsubmit = e => { e.preventDefault(); answered = true; const v = input.value; closeSheet(); resolve(v); };
  });
}

// ------------------------------------------------------------------ player picker
/**
 * Show a player list for one side and resolve with the chosen player id (or null).
 * opts: { title, side, filter(p) → bool, mark(p) → html, top: html, extra: [{label, value}] }
 */
function pickPlayer({ title, side, sections, top = '', bottom = '', actions = '', onReady }) {
  return new Promise(resolve => {
    let answered = false;
    const t = snap.state.teams[side];
    const btn = (p, opts = {}) => `<button class="btn pbtn" data-pid="${esc(p.id)}" ${opts.disabled ? 'disabled' : ''}>
      <span class="n">${esc(p.number ?? '')}</span><span>${esc(p.name)}</span>${opts.mark || ''}<span class="pos">${esc(p.position)}</span></button>`;
    const body = sections.map(s => s.players.length
      ? `<h4>${esc(s.label)}</h4>${s.players.map(p => btn(p, s.opts?.(p) || {})).join('')}` : '').join('');
    openSheet(title, `${top}<div class="plist">${body || `<p class="muted">No players in the ${esc(t.short || side)} squad. Add them on the setup screen.</p>`}</div>${bottom}`,
      () => { if (!answered) resolve(undefined); }, actions);
    $('sheet-body').querySelectorAll('[data-pid]').forEach(b => {
      b.onclick = () => { answered = true; closeSheet(); resolve(b.dataset.pid); };
    });
    $('sheet-body').querySelectorAll('[data-pick-none]').forEach(b => {
      b.onclick = () => { answered = true; closeSheet(); resolve(null); };
    });
    onReady?.();
  });
}

function sortByNumber(list) {
  return [...list].sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
}

/** Players split into "On the pitch" and "Others", so the likely choice is first. */
function sideSections(side, { opts } = {}) {
  const st = snap.state;
  const t = st.teams[side];
  const on = onPitch(t, st.events, side);
  const squad = sortByNumber(t.squad);
  if (!on.size) return [{ label: 'Squad', players: squad, opts }];
  return [
    { label: 'On the pitch', players: squad.filter(p => on.has(p.id)), opts },
    { label: 'Others', players: squad.filter(p => !on.has(p.id)), opts },
  ];
}

function cardMarks(side) {
  return p => {
    const ev = snap.state.events;
    if (isSentOff(ev, side, p.id)) return { mark: '<span class="tag red">sent off</span>', disabled: true };
    if (yellowCount(ev, side, p.id)) return { mark: '<span class="tag">booked</span>' };
    return {};
  };
}

// ------------------------------------------------------------------ flows
async function goalFlow(side, existing = null) {
  let penalty = existing?.penalty || false;
  let ownGoal = existing?.ownGoal || false;
  let pending = null; // goal already on the scorebug, waiting for its scorer
  const short = s => snap.state.teams[s].short || s.toUpperCase();
  for (;;) {
    const squadSide = ownGoal ? otherSide(side) : side;
    const top = `${pending ? `<p class="pending-note">✓ Goal ${esc(short(side))} ${esc(pending.minute)}' is on the scorebug. Pick the scorer when you know it to show their name.</p>` : ''}
      <div class="opts">
      <button class="tog ${penalty ? 'on' : ''}" id="opt-pen">Penalty</button>
      <button class="tog ${ownGoal ? 'on' : ''}" id="opt-og">Own goal</button></div>
      ${ownGoal ? `<p class="hint">Own goal: pick the ${esc(short(squadSide))} player who scored it.</p>` : ''}`;
    const bottom = `<div class="row"><button class="btn grow" data-pick-none>${
      pending ? 'Close: scorer unknown (add later with Edit)' : existing ? 'No scorer' : 'Scorer unknown / add later'}</button></div>`;
    const actions = !existing && !pending
      ? '<button class="btn small ok" id="goal-now" title="Update the score and play GOAL! now; pick the scorer when you know">⚽ Goal now, scorer later</button>' : '';
    let toggled = null;
    const pid = await pickPlayer({
      title: pending ? `Who scored? ${short(side)} ${pending.minute}'` : `${existing ? 'Edit goal' : 'Goal'}: ${short(side)}`,
      side: squadSide,
      sections: sideSections(squadSide),
      top, bottom, actions,
      onReady() {
        $('opt-pen').onclick = () => { toggled = 'pen'; closeSheet(); };
        $('opt-og').onclick = () => { toggled = 'og'; closeSheet(); };
        if ($('goal-now')) $('goal-now').onclick = () => { toggled = 'now'; closeSheet(); };
      },
    });
    if (toggled === 'pen' || toggled === 'og') {
      if (toggled === 'pen') { penalty = !penalty; if (penalty) ownGoal = false; }
      else { ownGoal = !ownGoal; if (ownGoal) penalty = false; }
      if (pending) await act('event.update', { id: pending.id, penalty, ownGoal });
      continue;
    }
    if (toggled === 'now') {
      const r = await act('goal.add', { team: side, playerId: null, penalty, ownGoal, pending: true });
      if (!r.ok) return;
      pending = r.result.event;
      toast(`Goal ${short(side)} ${pending.minute}': pick the scorer when you know`);
      continue;
    }
    if (pid === undefined) return; // closed with ✕ / Esc (a pending goal stays, scorer unknown)
    if (pending) {
      if (pid === null) return;
      const r = await act('event.update', { id: pending.id, playerId: pid, penalty, ownGoal });
      if (r.ok && snap.state.settings.autoShow.goal) await act('lowerThird.event', { id: pending.id });
    } else if (existing) {
      await act('event.update', { id: existing.id, playerId: pid, penalty, ownGoal });
    } else {
      const r = await act('goal.add', { team: side, playerId: pid, penalty, ownGoal });
      if (r.ok) toast(`Goal ${short(side)} ${r.result.event.minute}'`);
    }
    return;
  }
}

async function cardFlow(side, card) {
  const t = snap.state.teams[side];
  const pid = await pickPlayer({
    title: `${card === 'red' ? 'Red' : 'Yellow'} card: ${t.short}`,
    side,
    sections: sideSections(side, { opts: cardMarks(side) }),
  });
  if (!pid) return;
  const r = await act('card.add', { team: side, playerId: pid, card });
  if (r.ok && r.result.event.secondYellow) toast('Second yellow → red card');
}

async function subFlow(side) {
  const st = snap.state;
  const t = st.teams[side];
  const on = onPitch(t, st.events, side);
  const squad = sortByNumber(t.squad);
  const usedOn = new Set(st.events.filter(e => e.type === 'sub' && e.team === side).map(e => e.offId));
  const offSections = on.size
    ? [{ label: 'On the pitch', players: squad.filter(p => on.has(p.id)) }, { label: 'Others', players: squad.filter(p => !on.has(p.id)) }]
    : [{ label: 'Squad', players: squad }];
  const offId = await pickPlayer({ title: `Sub ${t.short}: player OFF`, side, sections: offSections });
  if (!offId) return;
  const bench = squad.filter(p => !on.has(p.id) && p.id !== offId && !usedOn.has(p.id) && !isSentOff(st.events, side, p.id));
  const subsListed = new Set(t.lineup.subs);
  const onSections = [
    { label: 'Substitutes', players: bench.filter(p => subsListed.has(p.id) || !subsListed.size) },
    { label: 'Rest of squad', players: subsListed.size ? bench.filter(p => !subsListed.has(p.id)) : [] },
  ];
  const offName = findPlayer(t, offId)?.name || '';
  const onId = await pickPlayer({ title: `Sub ${t.short}: player ON (for ${offName})`, side, sections: onSections });
  if (!onId) return;
  await act('sub.add', { team: side, offId, onId });
}

async function editEvent(ev) {
  if (ev.type === 'goal') {
    const choice = await new Promise(resolve => {
      let answered = false;
      openSheet(`Edit goal ${ev.minute}'`, `<div class="row wrap">
        <button class="btn grow" id="ed-scorer">Change scorer / type</button>
        <button class="btn grow" id="ed-min">Change minute</button></div>`, () => { if (!answered) resolve(null); });
      $('ed-scorer').onclick = () => { answered = true; closeSheet(); resolve('scorer'); };
      $('ed-min').onclick = () => { answered = true; closeSheet(); resolve('minute'); };
    });
    if (choice === 'scorer') return goalFlow(ev.team, ev);
    if (choice !== 'minute') return;
  }
  const v = await promptSheet(`Edit ${ev.type} minute`, 'Minute (e.g. 23 or 45+2)', ev.minute);
  if (v != null && v.trim()) await act('event.update', { id: ev.id, minute: v.trim() });
}

async function playerForText() {
  const side = await new Promise(resolve => {
    let answered = false;
    const st = snap.state;
    openSheet('Which team?', `<div class="row"><button class="btn grow" data-s="home">${esc(st.teams.home.name || 'Home')}</button>
      <button class="btn grow" data-s="away">${esc(st.teams.away.name || 'Away')}</button></div>`, () => { if (!answered) resolve(null); });
    $('sheet-body').querySelectorAll('[data-s]').forEach(b => { b.onclick = () => { answered = true; closeSheet(); resolve(b.dataset.s); }; });
  });
  if (!side) return;
  const pid = await pickPlayer({ title: 'Pick player', side, sections: sideSections(side) });
  if (!pid) return;
  const t = snap.state.teams[side];
  const p = findPlayer(t, pid);
  $('lt-sub').value = `${p.number != null ? `#${p.number} ` : ''}${p.name} · ${t.name}`;
  $('lt-team').value = side;
}

async function resetGameFlow() {
  const choice = await new Promise(resolve => {
    let answered = false;
    openSheet('Reset game', `<p>What do you want to reset? All graphics will be hidden.</p>
      <div class="plist">
        <button class="btn danger" data-reset="match">Reset score, events &amp; clock<br>(keep teams, lineups &amp; competition)</button>
        <button class="btn danger" data-reset="all">Reset EVERYTHING<br>(also clears teams, lineups &amp; competition)</button>
        <button class="btn" data-sheet-close>Cancel</button>
      </div>`, () => { if (!answered) resolve(null); });
    $('sheet-body').querySelectorAll('[data-reset]').forEach(b => {
      b.onclick = () => { answered = true; closeSheet(); resolve(b.dataset.reset); };
    });
  });
  if (!choice) return;
  const r = await act(choice === 'all' ? 'match.resetAll' : 'match.reset');
  if (r.ok) toast(choice === 'all' ? 'Everything reset (Undo to bring it back)' : 'Score, events & clock reset (Undo to bring it back)');
}

// ------------------------------------------------------------------ click handling
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act], [data-period], [data-preset], [data-scene], [data-ev]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  if (d.period) {
    const st = snap?.state;
    if (st && st.clock.running && d.period !== st.clock.period && !(await ask(`The clock is running. Switch to ${d.period}? This stops the clock and resets it to the start of ${d.period}.`, `Switch to ${d.period}`))) return;
    return act('clock.period', { period: d.period });
  }
  if (d.preset !== undefined) { $('lt-title').value = d.preset; $('lt-sub').focus(); return; }
  if (d.scene) {
    const r = await sock.scene(d.scene);
    if (!r.ok) toast(r.error, true);
    return;
  }
  if (d.ev) {
    const ev = snap.state.events.find(x => x.id === d.ev);
    if (!ev) return;
    if (d.evAct === 'show') return act('lowerThird.event', { id: ev.id });
    if (d.evAct === 'edit') return editEvent(ev);
    if (d.evAct === 'del' && (await ask('Delete this event? (You can undo.)', 'Delete', true))) return act('event.delete', { id: ev.id });
    return;
  }
  const st = snap?.state;
  switch (d.act) {
    case 'undo': {
      const r = await sock.action('undo');
      if (r.ok) toast(`Undone: ${r.result.undone}`); else toast(r.error, true);
      break;
    }
    case 'goal': return goalFlow(d.side);
    case 'goal-remove':
      if (await ask(`Remove the last ${st.teams[d.side].short || d.side} goal?`, 'Remove', true)) act('goal.removeLast', { team: d.side });
      break;
    case 'clock-toggle': return act('clock.toggle');
    case 'clock-reset':
      if (await ask(`Reset the ${st.clock.period} clock to the start of the period?`, 'Reset', true)) act('clock.reset');
      break;
    case 'nudge': return act('clock.adjust', { deltaMs: Number(d.ms) });
    case 'clock-set': {
      const cur = formatClock(displayMs(st.clock, st.match, sock.now()));
      const v = await promptSheet('Set match clock', `Match time shown on the scorebug (MM:SS), ${st.clock.period}`, cur, '23:15');
      if (v == null) break;
      const m = v.trim().match(/^(\d{1,3})(?::(\d{1,2}))?$/);
      if (!m) { toast('Use MM:SS, e.g. 23:15', true); break; }
      const total = (Number(m[1]) * 60 + Number(m[2] || 0)) * 1000;
      const base = displayMs({ ...st.clock, running: false, accumulatedMs: 0 }, st.match, 0);
      if (total < base) { toast(`${st.clock.period} starts at ${formatClock(base)}`, true); break; }
      act('clock.set', { ms: total - base });
      break;
    }
    case 'added': return act('clock.addedTime', { minutes: (st.clock.addedTime || 0) + Number(d.delta) });
    case 'added-clear': return act('clock.addedTime', { minutes: 0 });
    case 'tog-scorebug': return act('scorebug.set', { visible: !st.graphics.scorebug.visible });
    case 'tog-clock': return act('scorebug.clock', { visible: st.graphics.scorebug.clock === false });
    case 'tog-lt': {
      if (st.graphics.lowerThird.visible) return act('lowerThird.hide');
      const last = [...st.events].pop();
      if (last) return act('lowerThird.event', { id: last.id });
      return toast('Nothing to show yet: log an event or use the text lower third', true);
    }
    case 'board': return act('board.show', { kind: d.kind, toggle: true });
    case 'lineup': return act('lineup.show', { team: d.side, toggle: true });
    case 'hide-all': return act('graphics.hideAll');
    case 'card': return cardFlow(d.side, d.card);
    case 'sub': return subFlow(d.side);
    case 'lt-show': {
      const team = $('lt-team').value || null;
      const r = await act('lowerThird.text', { title: $('lt-title').value, subtitle: $('lt-sub').value, team });
      if (r.ok) rememberPreset($('lt-title').value);
      break;
    }
    case 'lt-hide': return act('lowerThird.hide');
    case 'lt-player': return playerForText();
    case 'demo-start':
      if (await ask('Run the demo match? Your current match is backed up and restored when you press "Stop demo".', 'Run demo')) {
        const r = await sock.demo('start'); if (!r.ok) toast(r.error, true);
      }
      break;
    case 'demo-stop': { const r = await sock.demo('stop'); if (r.ok) toast('Demo stopped, match restored'); break; }
    case 'lock': clearPin(); location.reload(); break;
    case 'reset-game': return resetGameFlow();
    case 'pens-toggle': return act('shootout.show', { visible: !st.graphics.shootout.visible });
    case 'pen': return act('shootout.kick', { team: d.side, scored: d.scored === '1' });
    case 'pen-remove': return act('shootout.removeLast');
    case 'pen-clear':
      if (await ask('Clear every penalty logged in this shootout? (You can undo.)', 'Clear', true)) act('shootout.clear');
      break;
  }
});

// typed added time: Enter (or leaving the box) applies it, Esc cancels
const addedInput = $('added-val');
function applyAddedTime() {
  addedInput.classList.remove('pending');
  if (!snap) return;
  const raw = addedInput.value.trim().replace(/^\+/, '');
  const minutes = raw === '' ? 0 : Math.round(Number(raw));
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 30) {
    toast('Added time must be 0–30 minutes', true);
    addedInput.value = snap.state.clock.addedTime || '';
    return;
  }
  if (minutes !== (snap.state.clock.addedTime || 0)) act('clock.addedTime', { minutes });
}
addedInput.addEventListener('input', () => addedInput.classList.add('pending'));
addedInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); addedInput.blur(); }
  if (e.key === 'Escape') { e.stopPropagation(); addedInput.value = snap?.state.clock.addedTime || ''; addedInput.classList.remove('pending'); addedInput.blur(); }
});
addedInput.addEventListener('blur', applyAddedTime);
addedInput.addEventListener('focus', () => addedInput.select());

// settings checkboxes
for (const [id, key] of [['opt-show-goal', 'goal'], ['opt-show-card', 'card'], ['opt-show-sub', 'sub']]) {
  $(id).addEventListener('change', e => act('settings.set', { autoShow: { [key]: e.target.checked } }));
}
$('opt-sting').addEventListener('change', e => act('settings.set', { sting: e.target.checked }));
$('opt-sting-away').addEventListener('change', e => act('settings.set', { stingAway: e.target.checked }));

// ------------------------------------------------------------------ text presets (per device)
const DEFAULT_PRESETS = ['Man of the Match', 'Attendance', 'Next home match', 'Weather', 'Injury update'];
function loadPresets() {
  try { return JSON.parse(localStorage.getItem('lt-presets')) || DEFAULT_PRESETS; } catch { return DEFAULT_PRESETS; }
}
function rememberPreset(title) {
  title = String(title || '').trim();
  if (!title) return;
  const list = [title, ...loadPresets().filter(t => t !== title)].slice(0, 8);
  try { localStorage.setItem('lt-presets', JSON.stringify(list)); } catch {}
  renderPresets();
}
function renderPresets() {
  $('presets').innerHTML = loadPresets().map(t => `<button data-preset="${esc(t)}">${esc(t)}</button>`).join('');
}
renderPresets();

// ------------------------------------------------------------------ preview
function setPreview(on) {
  $('preview-card').hidden = !on;
  const f = $('preview');
  if (on && !f.src) f.src = '/overlay/?preview=1';
  if (!on) f.removeAttribute('src');
  try { localStorage.setItem('dock-preview', on ? '1' : ''); } catch {}
  fitPreview();
}
function fitPreview() {
  const w = $('preview-wrap').clientWidth;
  if (w) $('preview').style.transform = `scale(${w / 1920})`;
}
window.addEventListener('resize', fitPreview);
$('opt-preview').addEventListener('change', e => setPreview(e.target.checked));
let previewOn = false;
try { previewOn = localStorage.getItem('dock-preview') === '1'; } catch {}
$('opt-preview').checked = previewOn;
setPreview(previewOn);

// ------------------------------------------------------------------ keyboard shortcuts
document.addEventListener('keydown', e => {
  const typing = e.target.closest('input, textarea, select');
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault(); $('btn-undo').click(); return;
  }
  if (e.key === 'Escape') {
    if (!$('sheet').hidden) { closeSheet(); return; }
    if (typing) { e.target.blur(); return; }
    act('graphics.hideAll');
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || !$('sheet').hidden || !$('pin-screen').hidden || !snap) return;
  const k = e.key.toLowerCase();
  if (k === 'g') { e.preventDefault(); goalFlow('home'); }
  else if (k === 'h') { e.preventDefault(); goalFlow('away'); }
  else if (e.code === 'Space') { e.preventDefault(); act('clock.toggle'); }
});

// ------------------------------------------------------------------ rendering
function setOn(id, on) { $(id).classList.toggle('on', !!on); }

function eventRow(ev, st) {
  const t = st.teams[ev.team];
  // name() returns escaped HTML
  const name = (side, id) => { const p = findPlayer(st.teams[side], id); return p ? esc(`${p.number ?? ''} ${p.name}`.trim()) : '—'; };
  let ico = '';
  let who = '';
  if (ev.type === 'goal') {
    ico = '⚽';
    who = ev.playerId ? name(ev.ownGoal ? otherSide(ev.team) : ev.team, ev.playerId) : '<em class="muted">scorer not set</em>';
    if (ev.ownGoal) who += ' (OG)';
    if (ev.penalty) who += ' (P)';
  } else if (ev.type === 'card') {
    ico = ev.secondYellow ? '<i class="ci yellow"></i><i class="ci red"></i>' : `<i class="ci ${ev.card === 'red' ? 'red' : 'yellow'}"></i>`;
    who = name(ev.team, ev.playerId);
  } else if (ev.type === 'sub') {
    ico = '<span class="sub-ico">⇅</span>';
    who = `${name(ev.team, ev.onId)} <span class="muted">for</span> ${name(ev.team, ev.offId)}`;
  }
  const live = st.graphics.lowerThird.visible && st.graphics.lowerThird.eventId === ev.id;
  return `<li class="${live ? 'live' : ''}"><span class="min">${esc(ev.minute)}'</span><span class="ico">${ico}</span>
    <span class="tm">${esc(t.short)}</span><span class="who">${who}</span>
    <button class="btn" data-ev="${esc(ev.id)}" data-ev-act="show">Show</button>
    <button class="btn" data-ev="${esc(ev.id)}" data-ev-act="edit">Edit</button>
    <button class="btn danger-ghost" data-ev="${esc(ev.id)}" data-ev-act="del" title="Delete">✕</button></li>`;
}

let lastEventsKey = '';

function render() {
  if (!snap) return;
  const { state: st, score, undo, obs, demo } = snap;
  const g = st.graphics;

  // header
  $('top-title').textContent = st.teams.home.short && st.teams.away.short
    ? `${st.teams.home.short} v ${st.teams.away.short}${st.match.competition ? ' · ' + st.match.competition : ''}` : 'Match Control · open setup to pick teams';
  const undoBtn = $('btn-undo');
  undoBtn.disabled = !undo.depth;
  undoBtn.innerHTML = `⟲ <span>${undo.label ? `Undo: ${esc(undo.label)}` : 'Undo'}</span>`;

  // banners
  $('dot-obs').classList.toggle('on', obs.connected);
  $('dot-obs').classList.toggle('warn', !obs.connected);
  $('dot-obs').title = obs.connected ? `OBS connected (${obs.url})` : `OBS: ${obs.error || 'not connected'}`;
  $('banner-obs').hidden = obs.connected;
  $('banner-obs').textContent = `⚠ OBS not connected: ${obs.error || 'connecting…'}. Graphics still work; scene switching is off.`;
  $('banner-demo').hidden = !demo.running;
  $('demo-step').textContent = `DEMO: ${demo.step || 'running'}`;

  // teams + score
  for (const side of ['home', 'away']) {
    const t = st.teams[side];
    $(`short-${side}`).textContent = t.short || side.toUpperCase();
    $(`chip-${side}`).style.background = t.colors.primary;
    $(`score-${side}`).textContent = score[side];
    document.querySelectorAll(`.lbl-${side}`).forEach(el => { el.textContent = t.short || side.toUpperCase(); });
    $(`tog-lu-${side}`).querySelector('.lu-name').textContent = t.short || side.toUpperCase();
  }

  // clock
  const c = st.clock;
  const canRun = PLAYING_PERIODS.includes(c.period) || c.period === 'PRE' || c.period === 'HT';
  const btn = $('btn-clock');
  btn.textContent = c.running ? '❚❚ PAUSE' : c.period === 'PRE' ? '▶ KICK OFF (1H)' : c.period === 'HT' ? '▶ START 2ND HALF' : '▶ START';
  btn.className = `btn big ${c.running ? 'running' : 'stopped'}`;
  btn.disabled = !canRun;
  $('period-badge').textContent = c.period;
  document.querySelectorAll('#periods .seg').forEach(s => s.classList.toggle('active', s.dataset.period === c.period));
  const addedInput = $('added-val');
  // Don't overwrite what the operator is typing.
  if (document.activeElement !== addedInput) addedInput.value = c.addedTime ? String(c.addedTime) : '';
  updateClock();

  // penalty shootout tile: only while in PEN (or while its graphic is still on screen)
  const so = shootoutSummary(st.shootout.kicks);
  $('pens-card').hidden = !(c.period === 'PEN' || g.shootout.visible);
  setOn('tog-pens', g.shootout.visible);
  $('pens-status').textContent = so.decided
    ? `· ${st.teams[so.winner].short} win ${so[so.winner]}–${so[otherSide(so.winner)]}`
    : so.total ? `· ${so.home}–${so.away}${so.suddenDeath ? ' · sudden death' : ''}` : '';
  for (const side of ['home', 'away']) {
    const t = st.teams[side];
    $(`pens-short-${side}`).textContent = t.short || side.toUpperCase();
    $(`pens-chip-${side}`).style.background = t.colors.primary;
    $(`pens-total-${side}`).textContent = so[side];
    $(`pens-dots-${side}`).innerHTML = so.rows[side].map(r => `<i class="pd ${r || 'empty'}">${r === 'scored' ? '✓' : r === 'missed' ? '✗' : ''}</i>`).join('');
    const teamEl = $(`pens-team-${side}`);
    teamEl.classList.toggle('next', so.next === side);
    teamEl.classList.toggle('win', so.winner === side);
    teamEl.querySelectorAll('[data-act=pen]').forEach(b => { b.disabled = so.decided; });
  }

  // toggles
  setOn('tog-scorebug', g.scorebug.visible);
  setOn('tog-clock', g.scorebug.clock !== false);
  setOn('tog-lt', g.lowerThird.visible);
  for (const k of ['KO', 'HT', 'FT']) setOn(`tog-${k}`, g.board.visible && g.board.kind === k);
  setOn('tog-lu-home', g.lineup.visible && g.lineup.team === 'home');
  setOn('tog-lu-away', g.lineup.visible && g.lineup.team === 'away');

  // settings
  $('opt-show-goal').checked = st.settings.autoShow.goal;
  $('opt-show-card').checked = st.settings.autoShow.card;
  $('opt-show-sub').checked = st.settings.autoShow.sub;
  $('opt-sting').checked = st.settings.sting;
  $('opt-sting-away').checked = st.settings.stingAway;

  // events
  const evKey = `${st.rev}`;
  if (evKey !== lastEventsKey) {
    lastEventsKey = evKey;
    const evs = [...st.events].reverse();
    $('events').innerHTML = evs.length ? evs.map(ev => eventRow(ev, st)).join('') : '<li class="empty">No events yet</li>';
    $('ev-count').textContent = evs.length ? `(${evs.length})` : '';
  }

  // exports carry the PIN as a query param because downloads can't send headers
  const pin = encodeURIComponent(getPin());
  $('export-json').href = `/api/export.json?pin=${pin}`;
  $('export-csv').href = `/api/export.csv?pin=${pin}`;
}

function updateClock() {
  if (!snap) return;
  const { state: st } = snap;
  const el = $('clock');
  el.textContent = formatClock(displayMs(st.clock, st.match, sock.now()));
  el.classList.toggle('paused', !st.clock.running && PLAYING_PERIODS.includes(st.clock.period));
}
setInterval(updateClock, 200);
