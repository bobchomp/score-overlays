// REPLAY bug (top-right) shown while a replay is on air. Self-contained: the overlay calls
// updateReplayBug() inside a try/catch, so a problem here can never stop the other graphics.
import { esc } from '/shared/socket.js';

let el = null;
let shownSpeed = null;

export function updateReplayBug(snap) {
  if (!el) {
    el = document.createElement('div');
    el.id = 'replay-bug';
    el.className = 'gfx';
    document.getElementById('stage').appendChild(el);
  }
  const bug = snap?.replay?.bug;
  const visible = !!bug?.visible;
  const labels = snap?.theme?.labels || {};
  if (visible && shownSpeed !== bug.speed) {
    shownSpeed = bug.speed;
    const slow = bug.speed && bug.speed < 100;
    el.innerHTML = `<div class="rb"><span class="rb-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" fill="currentColor"/></svg></span>
      <span class="rb-word">${esc(labels.replay || 'REPLAY')}</span>${slow ? `<span class="rb-slow">${esc(labels.slowMo || 'SLOW MO')}</span>` : ''}</div>`;
  }
  el.classList.toggle('show', visible);
  if (!visible) shownSpeed = null;
}
