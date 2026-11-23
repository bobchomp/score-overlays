// Pre-match check (Settings tab) + a warning chip in the top bar. Self-contained: dock.js calls
// initHealth() inside try/catch. The checks themselves run on the server (server/health.js).
import { esc } from '/shared/socket.js';

const $ = id => document.getElementById(id);
const ICON = { ok: '✓', warn: '!', bad: '✕', skip: '–' };
const POLL_MS = 30000;
const FIX_LABEL = { refreshOverlay: '↻ Refresh overlay in OBS', addLiveAudio: '🔊 Add live sound to REPLAY scene' };

export function initHealth({ sock, toast, setTab }) {
  let running = false;
  let last = null;

  async function run(manual = false) {
    if (running || !sock.connected) return;
    running = true;
    $('health-run').disabled = true;
    $('health-run').textContent = 'Checking…';
    try {
      const r = await sock.request({ type: 'health' });
      if (r.ok) { last = r.report; render(); }
      else if (manual) toast(r.error || 'Check failed', true);
    } finally {
      running = false;
      $('health-run').disabled = false;
      $('health-run').textContent = 'Run check now';
    }
  }

  function render() {
    if (!last) return;
    const { status, counts, items, at } = last;
    $('health-when').textContent = `· checked ${new Date(at).toLocaleTimeString('en-GB', { hour12: false })}`;
    $('health-summary').className = `health-summary ${status}`;
    $('health-summary').textContent = status === 'ok' ? 'All good: ready for kick-off.'
      : `${counts.bad ? `${counts.bad} problem${counts.bad > 1 ? 's' : ''}` : ''}${counts.bad && counts.warn ? ' and ' : ''}${counts.warn ? `${counts.warn} warning${counts.warn > 1 ? 's' : ''}` : ''} to look at.`;
    $('health-list').innerHTML = items.map(i => `<li class="${i.status}">
      <span class="h-icon">${ICON[i.status] || ''}</span>
      <div class="h-body"><div class="h-label">${esc(i.label)}</div>
        ${i.detail ? `<div class="h-detail">${esc(i.detail)}</div>` : ''}
        ${i.fix && i.status !== 'ok' ? `<div class="h-fix">→ ${esc(i.fix)}</div>` : ''}
        ${i.action && FIX_LABEL[i.action] ? `<button class="btn small" data-health-fix="${i.action}">${FIX_LABEL[i.action]}</button>` : ''}
      </div></li>`).join('');
    const chip = $('health-chip');
    const n = counts.bad + counts.warn;
    chip.hidden = !n;
    chip.className = `health-chip ${counts.bad ? 'bad' : 'warn'}`;
    chip.textContent = `${counts.bad ? '✕' : '!'} ${n} to check`;
  }

  $('health-run').addEventListener('click', () => run(true));
  $('health-chip').addEventListener('click', () => {
    setTab('settings');
    $('health-card').scrollIntoView({ block: 'start', behavior: 'smooth' });
    run();
  });
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-health-fix]');
    if (!b) return;
    b.disabled = true;
    const r = await sock.request({ type: 'health', fix: b.dataset.healthFix });
    if (r.ok) { toast(r.message || 'Done'); setTimeout(() => run(), 1500); }
    else { toast(r.error || 'Could not refresh', true); b.disabled = false; }
  });
  document.querySelector('[data-dock-tab="settings"]')?.addEventListener('click', () => run());

  setTimeout(() => run(), 2000);           // shortly after the dock loads
  setInterval(() => run(), POLL_MS);       // then keep an eye on things
  return { run };
}
