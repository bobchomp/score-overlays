// Replays section of the control dock (Live tab) + Replay settings (Settings tab). Self-contained: the dock calls initReplays() and
// replaysUi.render(snapshot) inside try/catch, so nothing here can break match control.
// All the replay logic runs on the server (server/replays.js); this file only sends commands.
import { esc } from '/shared/socket.js';

const $ = id => document.getElementById(id);
const RESERVED_KEYS = ['g', 'h', ' ', 'escape', 'z']; // already used by the match controls

function keyName(k) {
  if (k === ' ') return 'Space';
  if (!k) return '—';
  return k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1);
}

function clipTitle(c) {
  const time = new Date(c.createdAt).toLocaleTimeString('en-GB', { hour12: false });
  return c.label || `${time}${c.minute ? ` · ${c.minute}'` : ''}`;
}

export function initReplays({ sock, toast, promptSheet, openSheet, closeSheet, getSnap }) {
  let snap = null;
  let lastNoticeId = null;
  let settingsKey = '';
  let queueKey = '';
  let settingsDirty = false;

  // ---------------------------------------------------------------- commands
  async function cmd(op, args = {}) {
    const r = await sock.request({ type: 'replay', op, args });
    if (r.busy) toast('Busy saving a replay…');
    else if (!r.ok) toast(r.error || 'Replay command failed', true);
    else if (r.queued && !r.aborted && op === 'now') toast('Replay already on air: clip added to the queue');
    return r;
  }

  // ---------------------------------------------------------------- clicks (no confirmations on live actions)
  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-replay], [data-rq]');
    if (!el || el.disabled) return;
    const d = el.dataset;
    if (d.replay) {
      const speed = d.speed === 'slow' ? 'slow' : Number(d.speed) || 100;
      if (d.replay === 'now') return cmd('now', { speed });
      if (d.replay === 'mark') {
        if (!d.tag) return cmd('mark', {});
        // Tagged mark: save straight away, then ask which team it was for.
        const r = await cmd('mark', { tag: d.tag, silent: true }); // the popup says it was saved
        if (r.ok && r.clip) askTeam(r.clip, d.tag);
        return;
      }
      if (d.replay === 'abort') return cmd('abort');
      if (d.replay === 'playAll') return cmd('playAll', { speed });
      if (d.replay === 'clearQueue') {
        // Not a live action, but it wipes the list: needs a second tap within 3s.
        if (el.dataset.armed) { delete el.dataset.armed; el.textContent = 'Clear'; return cmd('clearQueue'); }
        el.dataset.armed = '1'; el.textContent = 'Tap again';
        setTimeout(() => { delete el.dataset.armed; el.textContent = 'Clear'; }, 3000);
        return;
      }
      return;
    }
    const id = d.id;
    const clip = snap?.replay?.queue?.find(c => c.id === id);
    if (!clip) return;
    switch (d.rq) {
      case 'play': return cmd('play', { id, speed: 100 });
      case 'slow': return cmd('play', { id, speed: 'slow' });
      case 'up': return cmd('move', { id, dir: -1 });
      case 'down': return cmd('move', { id, dir: 1 });
      case 'del': return cmd('delete', { id });
      case 'rename': {
        const v = await promptSheet('Rename clip', 'Label', clip.label || clipTitle(clip));
        if (v != null) cmd('rename', { id, label: v });
        return;
      }
    }
  });
  document.addEventListener('change', e => {
    const sel = e.target.closest('select[data-rq-tag]');
    if (sel) cmd('tag', { id: sel.dataset.rqTag, tag: sel.value });
  });

  // ---------------------------------------------------------------- highlights reel
  function reelOptions() {
    const q = getSnap()?.replay?.queue || [];
    const goals = q.filter(c => c.tag === 'Goal').length;
    const len = getSnap()?.replay?.settings?.lengthSec || 8;
    openSheet('Make highlights reel', `
      <p class="hint" style="margin-top:0">Joins the queued clips, in queue order, into one MP4 in a "Highlights" folder next to your replays.</p>
      <div class="field">Clips
        <span class="r-seg">
          <label><input type="radio" name="reel-only" value="all" checked><span>All clips (${q.length})</span></label>
          <label><input type="radio" name="reel-only" value="goals" ${goals ? '' : 'disabled'}><span>Goals only (${goals})</span></label>
        </span></div>
      <div class="field">Length of each clip
        <span class="r-seg">
          <label><input type="radio" name="reel-len" value="tail" checked><span>Same as replays (last ${len} s)</span></label>
          <label><input type="radio" name="reel-len" value="whole"><span>Whole clips</span></label>
        </span></div>
      <label class="check"><input type="checkbox" id="reel-fade" checked> Fade between clips</label>
      <p class="hint">Best done after the match: it runs at low priority, but it does use the CPU.</p>
      <div class="row"><button class="btn grow" data-sheet-close>Cancel</button><button class="btn primary grow" id="reel-go">🎬 Make reel</button></div>`);
    $('reel-go').onclick = async () => {
      const opts = {
        only: document.querySelector('[name="reel-only"]:checked')?.value || 'all',
        whole: document.querySelector('[name="reel-len"]:checked')?.value === 'whole',
        fade: $('reel-fade').checked,
      };
      closeSheet();
      let r = await sock.request({ type: 'replay', op: 'highlights', args: opts });
      if (r.needsConfirm) {
        openSheet('OBS is streaming', `<p>${esc(r.error)} Make the reel now anyway?</p>
          <div class="row"><button class="btn grow" data-sheet-close>Not now</button><button class="btn primary grow" id="reel-force">Make it anyway</button></div>`);
        $('reel-force').onclick = async () => {
          closeSheet();
          r = await sock.request({ type: 'replay', op: 'highlights', args: { ...opts, force: true } });
          if (!r.ok) toast(r.error || 'Could not start the reel', true);
        };
        return;
      }
      if (!r.ok) toast(r.error || 'Could not start the reel', true);
    };
  }

  function renderReel(r) {
    const el = $('r-reel');
    if (!el) return;
    const reel = r.reel || {};
    const key = JSON.stringify([reel, r.queue.length]);
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    const name = f => esc(String(f || '').split(/[\\/]/).pop());
    if (reel.running) {
      el.innerHTML = `<div class="r-reel-head">🎬 Making highlights reel… ${reel.percent || 0}% <span class="muted">(${reel.clips} clips)</span></div>
        <div class="r-progress"><i style="width:${reel.percent || 0}%"></i></div>
        <button class="btn small danger-ghost" data-reel="cancel">Cancel</button>`;
    } else {
      el.innerHTML = `${reel.file ? `<div class="r-reel-done">✓ Saved <strong>${name(reel.file)}</strong> <span class="muted">(${reel.clips} clips, ${Math.round(reel.seconds || 0)} s${reel.skipped ? `, ${reel.skipped} unreadable skipped` : ''})</span>
          <button class="btn small" data-reel="reveal">Show in folder</button></div>` : ''}
        ${reel.error && reel.error !== 'Cancelled' ? `<div class="r-err">Reel failed: ${esc(reel.error)}</div>` : ''}
        <button class="btn grow r-reel-btn" data-reel="make" ${r.queue.length ? '' : 'disabled'}>🎬 Make highlights reel</button>`;
    }
  }

  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-reel]');
    if (!b || b.disabled) return;
    if (b.dataset.reel === 'make') return reelOptions();
    if (b.dataset.reel === 'cancel') return cmd('cancelHighlights');
    if (b.dataset.reel === 'reveal') {
      const r = await sock.request({ type: 'replay', op: 'reveal', args: {} });
      if (!r.ok) toast(r.error, !/^Saved at/.test(r.error || ''));
    }
  });

  // ---------------------------------------------------------------- "which team?" popup after a tagged mark
  function askTeam(clip, tag) {
    const st = getSnap()?.state;
    if (!st || !openSheet) return;
    const teamBtn = side => {
      const t = st.teams[side];
      return `<button class="btn r-team-btn" data-team-side="${side}" style="--tp:${esc(t.colors?.primary || '#333')}">
        <span class="r-team-chip"></span>${esc(t.name || side)}</button>`;
    };
    openSheet(`${tag}: which team?`, `<p class="hint" style="margin-top:0">Clip saved as <strong>${esc(clip.label)}</strong>. Pick the team to add it to the name.</p>
      <div class="r-team-pick">${teamBtn('home')}${teamBtn('away')}</div>
      <div class="row"><button class="btn grow ghost" data-sheet-close>No team</button></div>`);
    document.querySelectorAll('#sheet-body [data-team-side]').forEach(b => {
      b.onclick = () => {
        const t = st.teams[b.dataset.teamSide];
        closeSheet();
        cmd('rename', { id: clip.id, label: `${t.name} ${clip.label}` });
      };
    });
  }

  // ---------------------------------------------------------------- keyboard shortcuts (work on both tabs)
  document.addEventListener('keydown', e => {
    if (!snap?.replay?.settings) return;
    if (e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!$('sheet').hidden || !$('pin-screen').hidden) return;
    const k = e.key.toLowerCase();
    const sc = snap.replay.settings.shortcuts || {};
    const map = { [sc.replay]: ['now', { speed: 100 }], [sc.replaySlow]: ['now', { speed: 'slow' }], [sc.mark]: ['mark', {}], [sc.abort]: ['abort', {}] };
    if (!k || !map[k]) return;
    e.preventDefault();
    cmd(...map[k]);
  });

  // ---------------------------------------------------------------- settings form
  function settingsHtml(s) {
    const n = s.names;
    const field = (label, name, value, extra = '') => `<label class="field">${esc(label)}<input class="input" name="${name}" value="${esc(value ?? '')}" ${extra}></label>`;
    const pw = (label, name, has) => `<label class="field">${esc(label)}<span class="r-pw"><input class="input" name="${name}" type="password" placeholder="${has ? '•••••• (saved, leave blank to keep)' : 'none'}">
      ${has ? `<button type="button" class="btn small ghost" data-clear-pw="${name}">Clear</button>` : ''}</span></label>`;
    const key = (label, name, value) => `<label class="field">${esc(label)}<input class="input r-key" name="${name}" value="${esc(keyName(value))}" data-key="${esc(value)}" readonly title="Click, then press a key"></label>`;
    return `
      <div class="r-sec">Main OBS (the stream)</div>
      ${field('WebSocket URL (blank = use .env)', 'main.url', s.main.url, `placeholder="${esc(s.main.defaultUrl || 'ws://127.0.0.1:4455')}"`)}
      ${pw('Password', 'main.password', s.main.hasPassword)}
      <div class="r-sec">Replay OBS</div>
      ${field('WebSocket URL', 'replay.url', s.replay.url, 'placeholder="ws://127.0.0.1:4456"')}
      ${pw('Password', 'replay.password', s.replay.hasPassword)}
      <div class="r-sec">Names in the main OBS</div>
      ${field('Replay scene', 'names.scene', n.scene)}
      ${field('Media source', 'names.player', n.player)}
      <div class="r-sec">Stinger</div>
      <label class="check"><input type="radio" name="stinger.mode" value="overlay" ${s.stinger.mode !== 'obs' ? 'checked' : ''}> Graphics wipe in the home team's colours (no video needed)</label>
      <label class="check"><input type="radio" name="stinger.mode" value="obs" ${s.stinger.mode === 'obs' ? 'checked' : ''}> OBS Stinger transition (your own video)</label>
      <div class="field">Between clips in "Play all"
        <span class="r-seg">
          ${[['fade', 'Fade'], ['stinger', 'Full stinger'], ['cut', 'Cut']].map(([v, l]) => `<label><input type="radio" name="stinger.between" value="${v}" ${(s.stinger.between || 'fade') === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}
        </span>
      </div>
      <div class="r-mode r-mode-overlay" ${s.stinger.mode === 'obs' ? 'hidden' : ''}>
        <label class="field">Wipe speed: <strong class="r-wipe-val">${((s.stinger.durationMs || 1300) / 1000).toFixed(1)} s</strong>
          <span class="r-range"><span>Fast</span><input type="range" name="stinger.durationMs" min="600" max="3000" step="100" value="${esc(s.stinger.durationMs || 1300)}"><span>Slow</span></span></label>
        ${field('Cut transition to use under the wipe', 'stinger.cutTransition', s.stinger.cutTransition, 'placeholder="Cut"')}
        <p class="hint">The wipe is part of the graphics overlay, so the overlay Browser Source must be in both your live scene and the replay scene (Paste (Reference)), at the top of each.</p>
      </div>
      <div class="r-mode r-mode-obs" ${s.stinger.mode === 'obs' ? '' : 'hidden'}>
      ${field('Stinger transition', 'names.transition', n.transition)}
      <details class="r-details"${n.sceneB || n.playerB ? ' open' : ''}><summary>"Full stinger" between clips with an OBS video (optional)</summary>
        <p class="hint">OBS can't transition a scene to itself, so for a stinger between every queued clip, add a second scene with its own media source. Without it, "Full stinger" cuts between clips.</p>
        ${field('Second replay scene', 'names.sceneB', n.sceneB, 'placeholder="e.g. REPLAY 2"')}
        ${field('Its media source', 'names.playerB', n.playerB, 'placeholder="e.g. Replay Player 2"')}
      </details>
      </div>
      <div class="r-sec">Goals</div>
      <label class="check"><input type="checkbox" name="autoGoalClip" ${s.autoGoalClip !== false ? 'checked' : ''}> Save a replay for every goal (named e.g. "${esc('Ross County 2')}", tagged Goal)</label>
      <div class="r-sec">Playback</div>
      <div class="r-grid2">
        ${field('Replay length (seconds)', 'lengthSec', s.lengthSec, 'type="number" min="2" max="60"')}
        ${field('Slow-mo speed (%)', 'slowSpeed', s.slowSpeed, 'type="number" min="10" max="99"')}
      </div>
      <div class="r-sec">Keyboard shortcuts</div>
      <div class="r-grid2">
        ${key('Replay', 'shortcuts.replay', s.shortcuts.replay)}
        ${key('Replay slow-mo', 'shortcuts.replaySlow', s.shortcuts.replaySlow)}
        ${key('Mark', 'shortcuts.mark', s.shortcuts.mark)}
        ${key('Abort / back to live', 'shortcuts.abort', s.shortcuts.abort)}
      </div>
      <div class="row"><button class="btn primary grow" type="submit">Save settings</button><button class="btn ghost" type="button" data-r-reset>Discard</button></div>`;
  }

  function renderSettings(force = false) {
    const s = snap?.replay?.settings;
    if (!s) return;
    const key = JSON.stringify(s);
    const form = $('r-settings');
    if (!force && (key === settingsKey || settingsDirty || form.contains(document.activeElement))) return;
    settingsKey = key;
    settingsDirty = false;
    form.innerHTML = settingsHtml(s);
  }

  const form = $('r-settings');
  form.addEventListener('input', e => {
    settingsDirty = true;
    if (e.target.name === 'stinger.durationMs') form.querySelector('.r-wipe-val').textContent = `${(Number(e.target.value) / 1000).toFixed(1)} s`;
  });
  form.addEventListener('change', e => {
    if (e.target.name !== 'stinger.mode') return;
    const obs = e.target.value === 'obs';
    form.querySelector('.r-mode-obs').hidden = !obs;
    form.querySelector('.r-mode-overlay').hidden = obs;
  });
  form.addEventListener('click', e => {
    const clear = e.target.closest('[data-clear-pw]');
    if (clear) {
      const [grp] = clear.dataset.clearPw.split('.');
      cmd('settings', { [grp]: { password: '' } }).then(r => { if (r.ok) { toast('Password cleared'); renderSettings(true); } });
    }
    if (e.target.closest('[data-r-reset]')) renderSettings(true);
  });
  form.addEventListener('keydown', e => {
    const k = e.target.closest('.r-key');
    if (!k) return;
    if (e.key === 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
    const key = e.key === 'Backspace' || e.key === 'Delete' ? '' : e.key.toLowerCase();
    if (RESERVED_KEYS.includes(key)) { toast(`${keyName(key)} is already used by the match controls`, true); return; }
    k.dataset.key = key;
    k.value = keyName(key);
    settingsDirty = true;
  }, true);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const v = name => form.elements[name]?.value ?? '';
    const payload = {
      main: { url: v('main.url') },
      replay: { url: v('replay.url') },
      names: {
        scene: v('names.scene'), player: v('names.player'), transition: v('names.transition'),
        sceneB: v('names.sceneB'), playerB: v('names.playerB'),
      },
      stinger: {
        mode: form.querySelector('[name="stinger.mode"]:checked')?.value || 'overlay',
        between: form.querySelector('[name="stinger.between"]:checked')?.value || 'fade',
        cutTransition: v('stinger.cutTransition'),
        durationMs: Number(v('stinger.durationMs')) || 1300,
      },
      autoGoalClip: !!form.elements.autoGoalClip?.checked,
      lengthSec: Number(v('lengthSec')),
      slowSpeed: Number(v('slowSpeed')),
      shortcuts: Object.fromEntries(['replay', 'replaySlow', 'mark', 'abort'].map(k => [k, form.elements[`shortcuts.${k}`]?.dataset.key || ''])),
    };
    if (v('main.password')) payload.main.password = v('main.password');
    if (v('replay.password')) payload.replay.password = v('replay.password');
    const keys = Object.values(payload.shortcuts).filter(Boolean);
    if (new Set(keys).size !== keys.length) return toast('Each shortcut needs a different key', true);
    const r = await cmd('settings', payload);
    if (r.ok) { settingsDirty = false; toast('Replay settings saved'); setTimeout(() => renderSettings(true), 50); }
  });

  // ---------------------------------------------------------------- render
  function dot(ok, warn = false) { return `<span class="dot ${ok ? 'on' : warn ? 'warn' : ''}"></span>`; }

  function render(next) {
    snap = next;
    const r = snap?.replay;
    if (!r) return;
    if (r.disabled) {
      $('r-status').innerHTML = `<span class="r-err">Replays unavailable: ${esc(r.disabled)}</span>`;
      return;
    }
    const s = r.settings;

    // status
    const buf = r.bufferActive == null ? '—' : r.bufferActive ? 'running' : 'STOPPED';
    $('r-status').innerHTML = `
      <span class="r-conn" title="${esc(r.main.url)} ${esc(r.main.error || '')}">${dot(r.main.connected)} Main OBS</span>
      <span class="r-conn" title="${esc(r.replayObs.url)} ${esc(r.replayObs.error || '')}">${dot(r.replayObs.connected)} Replay OBS</span>
      <span class="r-conn">${dot(r.bufferActive === true, r.bufferActive == null)} Buffer: ${buf}</span>
      ${r.saving ? '<span class="r-busy">Saving…</span>' : ''}`;

    // why buttons are disabled
    const saveBlocked = r.saving ? null : r.saveBlocked;
    const reasons = [saveBlocked, r.playBlocked].filter(Boolean);
    $('r-blocked').hidden = !reasons.length;
    $('r-blocked').innerHTML = reasons.map(esc).join('<br>');
    const nowDisabled = !!(saveBlocked || (r.playBlocked && !r.playing));
    document.querySelectorAll('.r-actions [data-replay="now"]').forEach(b => { b.disabled = nowDisabled; b.classList.toggle('busy', r.saving); });
    document.querySelectorAll('.r-actions [data-replay="mark"]').forEach(b => { b.disabled = !!saveBlocked; b.classList.toggle('busy', r.saving); });
    $('r-abort').disabled = !(r.playing || r.saving);
    document.querySelectorAll('[data-replay="playAll"]').forEach(b => { b.disabled = !!(r.playBlocked || r.playing || !r.queue.length); });
    $('r-slow-label').textContent = `${s.slowSpeed}%`;
    $('r-playall-slow').textContent = `▶ Play all ${s.slowSpeed}%`;

    // quick tags (one tap = MARK with that tag)
    const tagsKey = JSON.stringify([r.tags, saveBlocked]);
    if ($('r-tags').dataset.key !== tagsKey) {
      $('r-tags').dataset.key = tagsKey;
      $('r-tags').innerHTML = r.tags.map(t => `<button class="btn small r-tag" data-replay="mark" data-tag="${esc(t)}" ${saveBlocked ? 'disabled' : ''}>${esc(t)}</button>`).join('');
    }
    const sc = s.shortcuts;
    $('r-keys').innerHTML = `Shortcuts: <kbd>${esc(keyName(sc.replay))}</kbd> replay · <kbd>${esc(keyName(sc.replaySlow))}</kbd> slow-mo · <kbd>${esc(keyName(sc.mark))}</kbd> mark · <kbd>${esc(keyName(sc.abort))}</kbd> abort`;

    // on-air bar (shown on both tabs)
    $('replay-onair').hidden = !r.playing;
    if (r.playing) {
      const p = r.playing;
      $('replay-onair-text').textContent = `REPLAY ON AIR${p.total > 1 ? ` · clip ${p.index + 1} of ${p.total}` : ''}${p.speed < 100 ? ` · ${p.speed}%` : ''}`;
    }

    // notices: toast new ones, keep the latest warning/error visible
    if (r.notice && r.notice.id !== lastNoticeId) {
      const first = lastNoticeId === null;
      lastNoticeId = r.notice.id;
      if (!first || Date.now() - r.notice.at < 5000) toast(r.notice.text, r.notice.level === 'error');
    }
    const important = r.notice && r.notice.level !== 'info' ? r.notice : null;
    const warn = r.bufferWarning && !important ? { level: 'warn', text: r.bufferWarning } : important;
    $('r-notice-card').hidden = !warn;
    if (warn) $('r-notice').innerHTML = `<span class="${warn.level === 'error' ? 'r-err' : 'r-warn'}">${esc(warn.text)}</span>`;

    // queue
    const qKey = JSON.stringify([r.queue, r.playing?.clipId, r.playBlocked, !!r.playing]);
    if (qKey !== queueKey) {
      queueKey = qKey;
      $('r-queue-count').textContent = r.queue.length ? `(${r.queue.length})` : '';
      const canPlay = !r.playBlocked && !r.playing;
      $('r-queue').innerHTML = r.queue.length ? r.queue.map((c, i) => {
        const time = new Date(c.createdAt).toLocaleTimeString('en-GB', { hour12: false });
        const title = clipTitle(c);
        // Subtitle: only what the title doesn't already say.
        const meta = [time, c.minute && !/minute/.test(title) ? `${c.minute}'` : ''].filter(x => x && !title.includes(x)).concat(c.file || []).join(' · ');
        return `<li class="${r.playing?.clipId === c.id ? 'live' : ''}">
          <div class="rq-main">
            <span class="rq-title">${esc(title)}</span>
            <span class="rq-meta">${esc(meta)}</span>
          </div>
          <select class="input rq-tag" data-rq-tag="${esc(c.id)}">${['', ...r.tags].map(t => `<option value="${esc(t)}" ${t === (c.tag || '') ? 'selected' : ''}>${t ? esc(t) : 'No tag'}</option>`).join('')}</select>
          <div class="rq-btns">
            <button class="btn small ok" data-rq="play" data-id="${esc(c.id)}" ${canPlay ? '' : 'disabled'} title="Play at 100%">▶ 100</button>
            <button class="btn small" data-rq="slow" data-id="${esc(c.id)}" ${canPlay ? '' : 'disabled'} title="Play slow-mo">▶ ${esc(s.slowSpeed)}</button>
            <button class="btn small" data-rq="rename" data-id="${esc(c.id)}" title="Rename">✎</button>
            <button class="btn small" data-rq="up" data-id="${esc(c.id)}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
            <button class="btn small" data-rq="down" data-id="${esc(c.id)}" ${i === r.queue.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
            <button class="btn small danger-ghost" data-rq="del" data-id="${esc(c.id)}" title="Remove from queue (the file stays on disk)">✕</button>
          </div></li>`;
      }).join('') : '<li class="empty">No clips yet. REPLAY and MARK add clips here.</li>';
    }

    renderReel(r);
    renderSettings();
  }

  return { render };
}
