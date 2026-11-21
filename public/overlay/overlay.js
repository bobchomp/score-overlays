import { MatchSocket, syncThemeCss, esc } from '/shared/socket.js';
import {
  displayMs, formatClock, findPlayer, otherSide, scorers, POSITION_ORDER, POSITION_NAMES, PLAYING_PERIODS,
} from '/shared/match.js';

const params = new URLSearchParams(location.search);
if (params.has('preview')) document.body.classList.add('preview');

let snap = null; // latest snapshot from the server

const $ = id => document.getElementById(id);
const teamVars = t => `--tp:${esc(t.colors.primary)};--ts:${esc(t.colors.secondary)};--tt:${esc(t.colors.text)}`;
const logo = (src, cls = '') => (src ? `<img class="${cls}" src="${esc(src)}" alt="">` : '');

/**
 * Controls one graphic: shows/hides it with CSS transitions and, when its content changes
 * while on screen, animates it out, swaps the content and animates it back in.
 */
function graphic(el, outMs = 550) {
  let shownKey = null;
  let shown = false;
  let busy = null;
  let want = { visible: false };
  function apply() {
    const { visible, key, render } = want;
    if (!visible) {
      if (shown) { el.classList.remove('show'); shown = false; }
      return;
    }
    if (shown && key === shownKey) return;
    if (shown) {
      el.classList.remove('show');
      shown = false;
      busy = setTimeout(() => { busy = null; apply(); }, outMs);
      return;
    }
    el.innerHTML = render();
    shownKey = key;
    void el.offsetWidth; // restart transitions
    el.classList.add('show');
    shown = true;
  }
  return {
    set(visible, key, render) {
      want = { visible, key, render };
      if (!busy) apply();
    },
    get shown() { return shown; },
  };
}

const gfx = {
  scorebug: graphic($('scorebug')),
  lowerThird: graphic($('lower-third')),
  board: graphic($('board'), 500),
  lineup: graphic($('lineup'), 700),
};

// ---------------------------------------------------------------- scorebug
let lastScore = null;
function periodLabel(period, theme) {
  if (period === 'ET1' || period === 'ET2') return theme.labels.extraTime || 'ET';
  if (period === 'PEN') return theme.labels.penalties || 'PENS';
  if (period === 'PRE') return '';
  return period;
}

function renderScorebug() {
  const { state, theme } = snap;
  const h = state.teams.home;
  const a = state.teams.away;
  return `<div class="sb-row">
    ${theme.clubLogo ? `<div class="sb-logo">${logo(theme.clubLogo)}</div>` : ''}
    <div class="sb-team home" style="${teamVars(h)}"><span class="sb-chip"></span><span class="sb-name">${esc(h.short || 'HOM')}</span></div>
    <div class="sb-score" id="sb-home">0</div>
    <div class="sb-score" id="sb-away">0</div>
    <div class="sb-team away" style="${teamVars(a)}"><span class="sb-name">${esc(a.short || 'AWY')}</span><span class="sb-chip"></span></div>
    <div class="sb-clockbox"><span class="sb-time" id="sb-time">00:00</span></div>
    <div class="sb-period" id="sb-period"></div>
    <div class="sb-added" id="sb-added"></div>
  </div>`;
}

function updateScorebugLive() {
  if (!snap || !$('sb-time')) return;
  const { state, theme, score } = snap;
  const c = state.clock;
  let time;
  if (c.period === 'HT') time = 'HT';
  else if (c.period === 'FT') time = 'FT';
  else if (c.period === 'PEN') time = theme.labels.penalties || 'PENS';
  else time = formatClock(displayMs(c, state.match, sock.now()));
  setText('sb-time', time);
  const pl = PLAYING_PERIODS.includes(c.period) ? periodLabel(c.period, theme) : '';
  setText('sb-period', pl);
  $('sb-period').style.display = pl ? '' : 'none';
  const added = c.addedTime > 0 && PLAYING_PERIODS.includes(c.period) ? `+${c.addedTime}` : '';
  setText('sb-added', added);
  $('sb-added').classList.toggle('on', !!added);
  for (const side of ['home', 'away']) {
    const el = $(`sb-${side}`);
    if (el.textContent !== String(score[side])) {
      const grew = lastScore && score[side] > lastScore[side];
      el.textContent = score[side];
      if (grew) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
    }
  }
  lastScore = { ...score };
}

function setText(id, text) {
  const el = $(id);
  if (el && el.textContent !== text) el.textContent = text;
}

// ---------------------------------------------------------------- goal sting
let stingFor = null;
function updateSting() {
  const { state, theme } = snap;
  const lt = state.graphics.lowerThird;
  const stingMs = Number(theme.timings.stingMs) || 0;
  const el = $('sting');
  const age = sock.now() - lt.shownAt;
  const active = lt.visible && lt.kind === 'goal' && lt.sting && stingMs > 0 && age < stingMs;
  if (active && stingFor !== lt.id) {
    const ev = state.events.find(e => e.id === lt.eventId);
    const t = state.teams[ev?.team || 'home'];
    stingFor = lt.id;
    el.style.cssText = `${teamVars(t)};--sting-ms:${stingMs}ms;--sting-delay:${-Math.max(0, age)}ms`;
    const word = ev?.ownGoal ? theme.labels.ownGoal || theme.labels.goal : theme.labels.goal;
    el.innerHTML = `<div class="stripe a"></div><div class="band"></div><div class="stripe b"></div>
      <div class="word">${logo(t.logo)}<span>${esc(word)}</span></div>`;
    el.classList.remove('play'); void el.offsetWidth; el.classList.add('play');
  } else if (!active && el.classList.contains('play')) {
    el.classList.remove('play');
    el.innerHTML = '';
    if (!lt.visible || lt.id !== stingFor) stingFor = null;
  }
  return active;
}

// ---------------------------------------------------------------- lower third
const ICON_ARROW_UP = '<svg viewBox="0 0 24 24"><path fill="#fff" d="M12 3l9 10h-6v8H9v-8H3z"/></svg>';
const ICON_ARROW_DOWN = '<svg viewBox="0 0 24 24"><path fill="#fff" d="M12 21l-9-10h6V3h6v8h6z"/></svg>';
const ICON_BALL = `<svg class="ball-icon" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" fill="#fff" stroke="#111" stroke-width="4"/>
  <path d="M50 30l17 12-6 20H39l-6-20z" fill="#111"/><path d="M50 30V8M67 42l20-8M61 62l12 20M39 62L27 82M33 42l-20-8" stroke="#111" stroke-width="4" fill="none"/></svg>`;

function playerLine(p) {
  if (!p) return '';
  return `${p.number != null ? `<span class="num">${esc(p.number)}</span>` : ''}${esc(p.name)}`;
}

function renderLowerThird() {
  const { state, theme } = snap;
  const lt = state.graphics.lowerThird;
  if (lt.kind === 'text') {
    const t = lt.team ? state.teams[lt.team] : null;
    const badge = t ? `<div class="lt-badge" style="${teamVars(t)}">${logo(t.logo) || `<span class="lt-num">${esc(t.short)}</span>`}</div>`
      : theme.clubLogo ? `<div class="lt-badge" style="--tp:var(--c-panel-alt);--ts:var(--c-accent)">${logo(theme.clubLogo)}</div>` : '';
    return `<div class="lt">${badge}<div class="lt-body">
      ${lt.title ? `<div class="lt-tag">${esc(lt.title)}</div>` : ''}
      <div class="lt-main"><div class="lt-title">${esc(lt.subtitle || lt.title)}</div></div></div></div>`;
  }
  const ev = state.events.find(e => e.id === lt.eventId);
  if (!ev) return '';
  const team = state.teams[ev.team];
  const badge = `<div class="lt-badge" style="${teamVars(team)}">${logo(team.logo) || `<span class="lt-num">${esc(team.short)}</span>`}</div>`;

  if (ev.type === 'goal') {
    const scorerTeam = state.teams[ev.ownGoal ? otherSide(ev.team) : ev.team];
    const p = findPlayer(scorerTeam, ev.playerId);
    const tag = `${ev.ownGoal ? theme.labels.ownGoal : theme.labels.goal.replace(/!$/, '')} · ${ev.minute}'${ev.penalty ? ' (P)' : ''}`;
    const title = p ? playerLine(p) : esc(team.name);
    const sub = p ? (ev.ownGoal ? `Own goal · ${esc(scorerTeam.name)}` : esc(team.name)) : `${snap.score.home} – ${snap.score.away}`;
    return `<div class="lt">${badge}<div class="lt-body"><div class="lt-tag">${esc(tag)}</div>
      <div class="lt-main"><div class="lt-title">${title}</div><div class="lt-sub">${sub}</div></div></div>
      <div class="lt-icon">${ICON_BALL}</div></div>`;
  }
  if (ev.type === 'card') {
    const p = findPlayer(team, ev.playerId);
    const label = ev.secondYellow ? theme.labels.secondYellow : ev.card === 'red' ? theme.labels.redCard : theme.labels.yellowCard;
    const icon = ev.secondYellow ? '<div class="card-icon second"><i class="yellow"></i><i class="red"></i></div>'
      : `<div class="card-icon"><i class="${ev.card}"></i></div>`;
    return `<div class="lt">${badge}<div class="lt-body"><div class="lt-tag">${esc(label)} · ${esc(ev.minute)}'</div>
      <div class="lt-main"><div class="lt-title">${playerLine(p)}</div><div class="lt-sub">${esc(team.name)}</div></div></div>
      <div class="lt-icon">${icon}</div></div>`;
  }
  if (ev.type === 'sub') {
    const on = findPlayer(team, ev.onId);
    const off = findPlayer(team, ev.offId);
    return `<div class="lt">${badge}<div class="lt-body"><div class="lt-tag">${esc(theme.labels.substitution)} · ${esc(team.short)} · ${esc(ev.minute)}'</div>
      <div class="lt-sub-rows">
        <div class="sub-row on"><span class="arrow">${ICON_ARROW_UP}</span>${playerLine(on)}</div>
        <div class="sub-row off"><span class="arrow">${ICON_ARROW_DOWN}</span>${playerLine(off)}</div>
      </div></div></div>`;
  }
  return '';
}

// ---------------------------------------------------------------- scoreboard
function renderBoard() {
  const { state, theme, score } = snap;
  const b = state.graphics.board;
  const h = state.teams.home;
  const a = state.teams.away;
  const label = { KO: theme.labels.kickOff, HT: theme.labels.halfTime, FT: theme.labels.fullTime }[b.kind] || '';
  const middle = b.kind === 'KO'
    ? `<span class="vs">${esc(theme.labels.versus)}</span>`
    : `<span>${score.home}</span><span class="dash">–</span><span>${score.away}</span>`;
  let scorerHtml = '';
  if (b.kind !== 'KO') {
    const col = side => scorers(state, side).map(s => `<div class="row">${esc(s.name)}<span class="min">${s.minutes.map(esc).join(', ')}</span></div>`).join('');
    const hs = col('home');
    const as = col('away');
    if (hs || as) scorerHtml = `<div class="col home">${hs}</div><div class="col away">${as}</div>`;
  }
  const comp = state.match.competition || state.match.competitionLogo
    ? `<div class="board-comp">${logo(state.match.competitionLogo)}${esc(state.match.competition)}</div>` : '<span></span>';
  return `<div class="board">
    <div class="board-head"><div class="board-label">${esc(label)}</div>${comp}</div>
    <div class="board-main">
      <div class="board-team home" style="${teamVars(h)}">${logo(h.logo)}<div class="name">${esc(h.name)}</div></div>
      <div class="board-score">${middle}</div>
      <div class="board-team away" style="${teamVars(a)}">${logo(a.logo)}<div class="name">${esc(a.name)}</div></div>
    </div>
    <div class="board-scorers">${scorerHtml}</div>
  </div>`;
}

// ---------------------------------------------------------------- lineup
function renderLineup() {
  const { state, theme } = snap;
  const side = state.graphics.lineup.team;
  const t = state.teams[side];
  const cap = t.lineup.captain;
  let i = 0;
  const row = p => `<div class="lu-player" style="--i:${i++}"><span class="num">${esc(p.number ?? '')}</span><span>${esc(p.name)}${p.id === cap ? '<span class="cap">C</span>' : ''}</span></div>`;
  const starting = t.lineup.starting.map(id => findPlayer(t, id)).filter(Boolean);
  const groups = POSITION_ORDER.map(pos => {
    const ps = starting.filter(p => p.position === pos);
    return ps.length ? `<div class="lu-group"><h3>${esc(POSITION_NAMES[pos])}</h3>${ps.map(row).join('')}</div>` : '';
  }).join('');
  const subs = t.lineup.subs.map(id => findPlayer(t, id)).filter(Boolean);
  return `<div class="lineup" style="${teamVars(t)}">
    <div class="lu-side">${logo(t.logo)}<div class="name">${esc(t.name)}</div><div class="label">${esc(theme.labels.startingXI)}</div>
      ${state.match.competition ? `<div class="comp">${esc(state.match.competition)}</div>` : ''}</div>
    <div class="lu-xi">${groups || '<div class="lu-empty">No starting XI selected. Pick one on the setup screen.</div>'}</div>
    <div class="lu-subs"><h3>${esc(theme.labels.substitutes)}</h3>${subs.map(row).join('') || '<div class="lu-empty">—</div>'}</div>
  </div>`;
}

// ---------------------------------------------------------------- main loop
function teamsKey(state) {
  const t = s => [s.short, s.name, s.logo, s.colors.primary, s.colors.secondary, s.colors.text].join('|');
  return `${t(state.teams.home)}#${t(state.teams.away)}`;
}

function render() {
  if (!snap) return;
  const { state, themeRev } = snap;
  const g = state.graphics;
  const full = g.board.visible || g.lineup.visible;
  document.body.classList.toggle('has-full', full);

  gfx.scorebug.set(g.scorebug.visible, `${themeRev}|${teamsKey(state)}|${snap.theme.clubLogo}`, renderScorebug);
  updateScorebugLive();

  const stingActive = updateSting();
  const lt = g.lowerThird;
  // During the goal sting the lower third waits, then follows it in.
  gfx.lowerThird.set(lt.visible && !stingActive && !full, `${lt.id}|${themeRev}`, renderLowerThird);

  const boardKey = [g.board.kind, themeRev, teamsKey(state), state.match.competition, state.match.competitionLogo,
    JSON.stringify(snap.score), JSON.stringify(scorers(state, 'home')), JSON.stringify(scorers(state, 'away'))].join('|');
  gfx.board.set(g.board.visible, boardKey, renderBoard);
  gfx.lineup.set(g.lineup.visible, `${g.lineup.team}|${themeRev}|${teamsKey(state)}|${JSON.stringify(state.teams[g.lineup.team].lineup)}`, renderLineup);
}


const sock = new MatchSocket({
  role: 'overlay',
  onState(msg) {
    snap = msg;
    syncThemeCss(msg.themeRev);
    render();
  },
  onStatus(connected) {
    if (params.has('preview')) $('offline').hidden = connected;
  },
});

// Time-based parts (clock text, sting → lower third hand-over) are re-evaluated 10x a second.
setInterval(render, 100);
