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
  // One badge: the home team's crest, or the club badge from the theme if the home team has none.
  const badge = h.logo || theme.clubLogo;
  return `<div class="sb-row">
    ${badge ? `<div class="sb-logo">${logo(badge)}</div>` : ''}
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
  // No tag for normal halves; only extra time (ET) gets one.
  const pl = ['ET1', 'ET2'].includes(c.period) ? periodLabel(c.period, theme) : '';
  setText('sb-period', pl);
  $('sb-period').style.display = pl ? '' : 'none';
  const added = c.addedTime > 0 && PLAYING_PERIODS.includes(c.period) ? `+${c.addedTime}` : '';
  updateAddedBadge(added);
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

// The added-time badge slides out from behind the clock. When it's cleared, keep the old
// number on it while it slides back in, then empty it (an empty badge collapses).
let addedClearTimer = null;
function updateAddedBadge(added) {
  const el = $('sb-added');
  if (added) {
    clearTimeout(addedClearTimer); addedClearTimer = null;
    setText('sb-added', added);
    el.classList.add('on');
  } else if (el.classList.contains('on')) {
    el.classList.remove('on');
    addedClearTimer = setTimeout(() => { addedClearTimer = null; if (!el.classList.contains('on')) el.textContent = ''; }, 500);
  } else if (!addedClearTimer && el.textContent) {
    el.textContent = '';
  }
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
// Classic 32-panel ball: panel geometry projected onto a sphere, with shading for depth.
const ICON_BALL = `<svg class="ball-icon" viewBox="0 0 100 100" aria-hidden="true">
  <defs>
    <radialGradient id="ltBallBase" cx="38%" cy="32%" r="75%">
      <stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#eef1f4"/><stop offset="1" stop-color="#b9c0c8"/>
    </radialGradient>
    <radialGradient id="ltBallPent" cx="38%" cy="32%" r="80%">
      <stop offset="0" stop-color="#3a3f46"/><stop offset="1" stop-color="#0b0d10"/>
    </radialGradient>
    <radialGradient id="ltBallShade" cx="40%" cy="35%" r="65%">
      <stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".38"/>
    </radialGradient>
    <radialGradient id="ltBallShine" cx="34%" cy="26%" r="22%">
      <stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="ltBallClip"><circle cx="50" cy="50" r="46"/></clipPath>
  </defs>
  <circle cx="50" cy="50" r="46" fill="url(#ltBallBase)"/>
  <g clip-path="url(#ltBallClip)">
    <g transform="rotate(-16 50 50)"><path d="M50.0 34.8 L50.0 33.5 L50.0 32.3 L50.0 31.1 L50.0 29.9 L50.0 28.7 L50.0 27.5 L50.0 26.4 L50.0 25.2 L50.0 24.1 L50.0 23.0 L50.0 21.9 L50.0 20.9 M64.5 45.3 L65.7 44.9 L66.8 44.5 L68.0 44.2 L69.1 43.8 L70.3 43.4 L71.4 43.0 L72.5 42.7 L73.6 42.3 L74.6 42.0 L75.7 41.7 L76.7 41.3 L77.7 41.0 M58.9 62.3 L59.7 63.3 L60.4 64.3 L61.1 65.3 L61.8 66.3 L62.5 67.2 L63.2 68.2 L63.9 69.1 L64.6 70.0 L65.2 70.9 L65.9 71.8 L66.5 72.7 L67.1 73.5 M41.1 62.3 L40.3 63.3 L39.6 64.3 L38.9 65.3 L38.2 66.3 L37.5 67.2 L36.8 68.2 L36.1 69.1 L35.4 70.0 L34.8 70.9 L34.1 71.8 L33.5 72.7 L32.9 73.5 M35.5 45.3 L34.3 44.9 L33.2 44.5 L32.0 44.2 L30.9 43.8 L29.7 43.4 L28.6 43.0 L27.5 42.7 L26.4 42.3 L25.4 42.0 L24.3 41.7 L23.3 41.3 L22.3 41.0 M62.5 14.1 L64.1 15.1 L65.6 16.0 L67.1 17.0 L68.7 18.0 L70.2 19.1 L71.7 20.2 L73.2 21.3 L74.6 22.4 L76.1 23.5 L77.5 24.7 L78.9 25.8 L80.2 27.0 M88.0 50.8 L87.6 52.6 L87.1 54.3 L86.7 56.1 L86.2 57.9 L85.6 59.6 L85.1 61.4 L84.5 63.2 L83.9 64.9 L83.3 66.6 L82.6 68.3 L81.9 70.0 L81.2 71.7 M60.9 86.4 L59.2 86.5 L57.4 86.7 L55.5 86.8 L53.7 86.8 L51.8 86.9 L50.0 86.9 L48.2 86.9 L46.3 86.8 L44.5 86.8 L42.6 86.7 L40.8 86.5 L39.1 86.4 M18.8 71.7 L18.1 70.0 L17.4 68.3 L16.7 66.6 L16.1 64.9 L15.5 63.2 L14.9 61.4 L14.4 59.6 L13.8 57.9 L13.3 56.1 L12.9 54.3 L12.4 52.6 L12.0 50.8 M19.8 27.0 L21.1 25.8 L22.5 24.7 L23.9 23.5 L25.4 22.4 L26.8 21.3 L28.3 20.2 L29.8 19.1 L31.3 18.0 L32.9 17.0 L34.4 16.0 L35.9 15.1 L37.5 14.1 M43.3 6.1 L43.2 5.8 L43.2 5.5 L43.2 5.3 L43.1 5.1 L43.1 4.9 L43.1 4.8 L43.1 4.7 L43.0 4.6 L43.0 4.5 L43.0 4.5 L43.0 4.5 L43.0 4.5 L43.0 4.5 L43.0 4.5 L43.0 4.5 L43.0 4.5 M56.7 6.1 L56.8 5.8 L56.8 5.5 L56.8 5.3 L56.9 5.1 L56.9 4.9 L56.9 4.8 L56.9 4.7 L57.0 4.6 L57.0 4.5 L57.0 4.5 L57.0 4.5 L57.0 4.5 L57.0 4.5 L57.0 4.5 L57.0 4.5 L57.0 4.5 M89.7 30.0 L90.0 29.9 L90.2 29.8 L90.4 29.7 L90.6 29.6 L90.8 29.5 L90.9 29.4 L91.0 29.4 L91.1 29.4 L91.1 29.3 L91.1 29.3 L91.1 29.3 L91.1 29.3 L91.1 29.3 L91.1 29.3 L91.1 29.3 L91.1 29.3 M93.9 42.8 L94.2 42.8 L94.4 42.7 L94.7 42.7 L94.9 42.7 L95.0 42.6 L95.2 42.6 L95.3 42.6 L95.3 42.6 L95.4 42.6 L95.4 42.6 L95.4 42.6 L95.4 42.6 L95.4 42.6 L95.4 42.6 L95.4 42.6 L95.4 42.6 M81.3 81.6 L81.5 81.8 L81.7 82.0 L81.8 82.2 L82.0 82.3 L82.1 82.4 L82.2 82.5 L82.3 82.6 L82.3 82.7 L82.3 82.7 L82.4 82.7 L82.4 82.7 L82.4 82.7 L82.4 82.7 L82.4 82.7 L82.4 82.7 L82.4 82.7 M70.4 89.5 L70.5 89.8 L70.6 90.0 L70.8 90.2 L70.8 90.4 L70.9 90.5 L71.0 90.7 L71.0 90.8 L71.1 90.8 L71.1 90.9 L71.1 90.9 L71.1 90.9 L71.1 90.9 L71.1 90.9 L71.1 90.9 L71.1 90.9 L71.1 90.9 M29.6 89.5 L29.5 89.8 L29.4 90.0 L29.2 90.2 L29.2 90.4 L29.1 90.5 L29.0 90.7 L29.0 90.8 L28.9 90.8 L28.9 90.9 L28.9 90.9 L28.9 90.9 L28.9 90.9 L28.9 90.9 L28.9 90.9 L28.9 90.9 L28.9 90.9 M18.7 81.6 L18.5 81.8 L18.3 82.0 L18.2 82.2 L18.0 82.3 L17.9 82.4 L17.8 82.5 L17.7 82.6 L17.7 82.7 L17.7 82.7 L17.6 82.7 L17.6 82.7 L17.6 82.7 L17.6 82.7 L17.6 82.7 L17.6 82.7 L17.6 82.7 M6.1 42.8 L5.8 42.8 L5.6 42.7 L5.3 42.7 L5.1 42.7 L5.0 42.6 L4.8 42.6 L4.7 42.6 L4.7 42.6 L4.6 42.6 L4.6 42.6 L4.6 42.6 L4.6 42.6 L4.6 42.6 L4.6 42.6 L4.6 42.6 L4.6 42.6 M10.3 30.0 L10.0 29.9 L9.8 29.8 L9.6 29.7 L9.4 29.6 L9.2 29.5 L9.1 29.4 L9.0 29.4 L8.9 29.4 L8.9 29.3 L8.9 29.3 L8.9 29.3 L8.9 29.3 L8.9 29.3 L8.9 29.3 L8.9 29.3 L8.9 29.3" fill="none" stroke="#8d96a0" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M50.0 34.8 L51.2 35.6 L52.4 36.5 L53.6 37.4 L54.8 38.2 L56.1 39.1 L57.3 40.0 L58.5 40.9 L59.7 41.7 L60.9 42.6 L62.1 43.5 L63.3 44.4 L64.5 45.3 L64.0 46.7 L63.6 48.1 L63.1 49.5 L62.7 51.0 L62.2 52.4 L61.8 53.8 L61.3 55.3 L60.8 56.7 L60.4 58.1 L59.9 59.5 L59.4 60.9 L58.9 62.3 L57.5 62.3 L56.0 62.3 L54.5 62.4 L53.0 62.4 L51.5 62.4 L50.0 62.4 L48.5 62.4 L47.0 62.4 L45.5 62.4 L44.0 62.3 L42.5 62.3 L41.1 62.3 L40.6 60.9 L40.1 59.5 L39.6 58.1 L39.2 56.7 L38.7 55.3 L38.2 53.8 L37.8 52.4 L37.3 51.0 L36.9 49.5 L36.4 48.1 L36.0 46.7 L35.5 45.3 L36.7 44.4 L37.9 43.5 L39.1 42.6 L40.3 41.7 L41.5 40.9 L42.7 40.0 L43.9 39.1 L45.2 38.2 L46.4 37.4 L47.6 36.5 L48.8 35.6Z M50.0 20.9 L48.9 20.2 L47.8 19.6 L46.6 18.9 L45.6 18.3 L44.5 17.7 L43.4 17.1 L42.4 16.6 L41.4 16.0 L40.4 15.5 L39.4 15.0 L38.4 14.6 L37.5 14.1 L38.0 13.2 L38.5 12.4 L39.0 11.6 L39.5 10.8 L40.0 10.1 L40.5 9.4 L41.0 8.7 L41.4 8.1 L41.9 7.5 L42.4 7.0 L42.8 6.5 L43.3 6.1 L44.4 6.0 L45.5 5.9 L46.6 5.8 L47.7 5.8 L48.9 5.8 L50.0 5.7 L51.1 5.8 L52.3 5.8 L53.4 5.8 L54.5 5.9 L55.6 6.0 L56.7 6.1 L57.2 6.5 L57.6 7.0 L58.1 7.5 L58.6 8.1 L59.0 8.7 L59.5 9.4 L60.0 10.1 L60.5 10.8 L61.0 11.6 L61.5 12.4 L62.0 13.2 L62.5 14.1 L61.6 14.6 L60.6 15.0 L59.6 15.5 L58.6 16.0 L57.6 16.6 L56.6 17.1 L55.5 17.7 L54.4 18.3 L53.4 18.9 L52.2 19.6 L51.1 20.2Z M77.7 41.0 L78.0 39.7 L78.3 38.5 L78.5 37.2 L78.8 36.0 L79.0 34.8 L79.2 33.6 L79.5 32.4 L79.6 31.3 L79.8 30.2 L80.0 29.1 L80.1 28.0 L80.2 27.0 L81.2 27.2 L82.2 27.4 L83.1 27.7 L84.0 27.9 L84.9 28.1 L85.7 28.4 L86.5 28.6 L87.2 28.9 L87.9 29.2 L88.5 29.5 L89.1 29.7 L89.7 30.0 L90.1 31.1 L90.6 32.1 L91.0 33.1 L91.4 34.2 L91.7 35.3 L92.1 36.3 L92.4 37.4 L92.7 38.5 L93.1 39.6 L93.3 40.6 L93.6 41.7 L93.9 42.8 L93.6 43.4 L93.2 44.0 L92.9 44.6 L92.5 45.2 L92.0 45.8 L91.6 46.5 L91.1 47.2 L90.5 47.9 L89.9 48.6 L89.3 49.3 L88.7 50.1 L88.0 50.8 L87.3 50.1 L86.5 49.3 L85.8 48.5 L85.0 47.7 L84.2 46.9 L83.3 46.1 L82.4 45.3 L81.5 44.4 L80.6 43.6 L79.6 42.7 L78.7 41.9Z M67.1 73.5 L68.4 73.4 L69.7 73.3 L71.0 73.2 L72.2 73.0 L73.5 72.9 L74.7 72.7 L75.8 72.6 L77.0 72.4 L78.1 72.2 L79.2 72.0 L80.2 71.9 L81.2 71.7 L81.3 72.7 L81.4 73.7 L81.5 74.6 L81.5 75.5 L81.6 76.4 L81.6 77.3 L81.6 78.1 L81.5 78.9 L81.5 79.6 L81.4 80.3 L81.4 81.0 L81.3 81.6 L80.4 82.3 L79.6 83.0 L78.7 83.7 L77.8 84.4 L76.9 85.1 L76.0 85.8 L75.1 86.5 L74.2 87.1 L73.2 87.7 L72.3 88.3 L71.3 88.9 L70.4 89.5 L69.8 89.4 L69.1 89.3 L68.4 89.1 L67.7 88.9 L66.9 88.7 L66.2 88.5 L65.4 88.2 L64.5 87.9 L63.7 87.5 L62.8 87.2 L61.9 86.8 L60.9 86.4 L61.5 85.5 L62.0 84.5 L62.5 83.6 L63.0 82.6 L63.5 81.5 L64.0 80.5 L64.5 79.4 L65.0 78.3 L65.6 77.1 L66.1 75.9 L66.6 74.8Z M32.9 73.5 L33.4 74.8 L33.9 75.9 L34.4 77.1 L35.0 78.3 L35.5 79.4 L36.0 80.5 L36.5 81.5 L37.0 82.6 L37.5 83.6 L38.0 84.5 L38.5 85.5 L39.1 86.4 L38.1 86.8 L37.2 87.2 L36.3 87.5 L35.5 87.9 L34.6 88.2 L33.8 88.5 L33.1 88.7 L32.3 88.9 L31.6 89.1 L30.9 89.3 L30.2 89.4 L29.6 89.5 L28.7 88.9 L27.7 88.3 L26.8 87.7 L25.8 87.1 L24.9 86.5 L24.0 85.8 L23.1 85.1 L22.2 84.4 L21.3 83.7 L20.4 83.0 L19.6 82.3 L18.7 81.6 L18.6 81.0 L18.6 80.3 L18.5 79.6 L18.5 78.9 L18.4 78.1 L18.4 77.3 L18.4 76.4 L18.5 75.5 L18.5 74.6 L18.6 73.7 L18.7 72.7 L18.8 71.7 L19.8 71.9 L20.8 72.0 L21.9 72.2 L23.0 72.4 L24.2 72.6 L25.3 72.7 L26.5 72.9 L27.8 73.0 L29.0 73.2 L30.3 73.3 L31.6 73.4Z M22.3 41.0 L21.3 41.9 L20.4 42.7 L19.4 43.6 L18.5 44.4 L17.6 45.3 L16.7 46.1 L15.8 46.9 L15.0 47.7 L14.2 48.5 L13.5 49.3 L12.7 50.1 L12.0 50.8 L11.3 50.1 L10.7 49.3 L10.1 48.6 L9.5 47.9 L8.9 47.2 L8.4 46.5 L8.0 45.8 L7.5 45.2 L7.1 44.6 L6.8 44.0 L6.4 43.4 L6.1 42.8 L6.4 41.7 L6.7 40.6 L6.9 39.6 L7.3 38.5 L7.6 37.4 L7.9 36.3 L8.3 35.3 L8.6 34.2 L9.0 33.1 L9.4 32.1 L9.9 31.1 L10.3 30.0 L10.9 29.7 L11.5 29.5 L12.1 29.2 L12.8 28.9 L13.5 28.6 L14.3 28.4 L15.1 28.1 L16.0 27.9 L16.9 27.7 L17.8 27.4 L18.8 27.2 L19.8 27.0 L19.9 28.0 L20.0 29.1 L20.2 30.2 L20.4 31.3 L20.5 32.4 L20.8 33.6 L21.0 34.8 L21.2 36.0 L21.5 37.2 L21.7 38.5 L22.0 39.7Z" fill="url(#ltBallPent)" stroke="#0b0d10" stroke-width=".8" stroke-linejoin="round"/>
    </g>
    <circle cx="50" cy="50" r="46" fill="url(#ltBallShade)"/>
    <circle cx="50" cy="50" r="46" fill="url(#ltBallShine)"/>
  </g>
  <circle cx="50" cy="50" r="45.5" fill="none" stroke="#0b0d10" stroke-opacity=".55" stroke-width="1.2"/>
</svg>`;

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
  $('scorebug').classList.toggle('no-clock', g.scorebug.clock === false);

  gfx.scorebug.set(g.scorebug.visible, `${themeRev}|${teamsKey(state)}|${snap.theme.clubLogo}`, renderScorebug);
  updateScorebugLive();

  const stingActive = updateSting();
  const lt = g.lowerThird;
  // During the goal sting the lower third waits, then follows it in.
  gfx.lowerThird.set(lt.visible && !lt.stingOnly && !stingActive && !full, `${lt.id}|${themeRev}`, renderLowerThird);

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
