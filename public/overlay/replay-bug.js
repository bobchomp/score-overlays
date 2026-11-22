// Replay graphics: the REPLAY bug (top-right) and the replay wipe ("graphics stinger").
// Self-contained: the overlay calls updateReplayBug() inside a try/catch, so a problem here can
// never stop the other graphics.
//
// The wipe is a full-screen sweep in the home team's colours. The server cuts OBS to/from the
// REPLAY scene at `switchAtMs`, while the wipe fully covers the screen, so the cut is never seen.
// This only works because the overlay Browser Source is in both scenes (Paste (Reference)).
import { esc } from '/shared/socket.js';

let bugEl = null;
let wipeEl = null;
let shownSpeed = null;
let wipeId = null;

function ensureEls() {
  const stage = document.getElementById('stage');
  if (!bugEl) {
    bugEl = document.createElement('div');
    bugEl.id = 'replay-bug';
    bugEl.className = 'gfx';
    stage.appendChild(bugEl);
  }
  if (!wipeEl) {
    wipeEl = document.createElement('div');
    wipeEl.id = 'replay-wipe';
    wipeEl.setAttribute('aria-hidden', 'true');
    stage.appendChild(wipeEl);
  }
}

/** @param snap latest server snapshot  @param now server-synchronised clock (ms) */
export function updateReplayBug(snap, now = Date.now()) {
  ensureEls();
  const labels = snap?.theme?.labels || {};

  // ---- bug
  const bug = snap?.replay?.bug;
  const visible = !!bug?.visible;
  if (visible && shownSpeed !== bug.speed) {
    shownSpeed = bug.speed;
    const slow = bug.speed && bug.speed < 100;
    bugEl.innerHTML = `<div class="rb"><span class="rb-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" fill="currentColor"/></svg></span>
      <span class="rb-word">${esc(labels.replay || 'REPLAY')}</span>${slow ? `<span class="rb-slow">${esc(labels.slowMo || 'SLOW MO')}</span>` : ''}</div>`;
  }
  bugEl.classList.toggle('show', visible);
  if (!visible) shownSpeed = null;

  // ---- wipe (plays once per id; joins mid-way if the overlay was refreshed during it)
  const w = snap?.replay?.wipe;
  if (!w || w.id === wipeId) return;
  wipeId = w.id;
  const age = now - w.at;
  if (age >= w.totalMs) return;
  const team = snap.state?.teams?.home || {};
  const c = team.colors || {};
  const badge = team.logo || snap.theme?.clubLogo || '';
  wipeEl.style.cssText = `--tp:${esc(c.primary || '#333')};--ts:${esc(c.secondary || '#fff')};--tt:${esc(c.text || '#fff')};--wipe-ms:${w.totalMs}ms;--wipe-delay:${-Math.max(0, age)}ms`;
  wipeEl.innerHTML = `<div class="rw-panel rw-accent"></div><div class="rw-panel rw-second"></div><div class="rw-panel rw-main"></div>
    <div class="rw-mark">${badge ? `<img src="${esc(badge)}" alt="">` : ''}<span>${esc(labels.replay || 'REPLAY')}</span></div>`;
  wipeEl.classList.remove('play');
  void wipeEl.offsetWidth;
  wipeEl.classList.add('play');
  clearTimeout(wipeEl._t);
  wipeEl._t = setTimeout(() => { wipeEl.classList.remove('play'); wipeEl.innerHTML = ''; }, w.totalMs - Math.max(0, age) + 100);
}
