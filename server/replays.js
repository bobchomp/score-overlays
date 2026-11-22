// Replays: a self-contained module. It talks to two OBS instances over obs-websocket v5:
//   - the Replay OBS (clean camera, Replay Buffer always running): saves clips
//   - the main OBS (the stream): plays clips in the "Replay Player" media source on the "REPLAY" scene
//
// Isolation: nothing here touches the match store. It has its own file (data/replays.json),
// every OBS call is wrapped, and failures are reported as status/notice instead of thrown
// into the rest of the server. If this module breaks, the graphics keep running.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, readJson, writeJsonAtomic } from './config.js';
import { ObsLink } from './obs.js';

export const REPLAYS_FILE = path.join(DATA_DIR, 'replays.json');

export const DEFAULT_SETTINGS = {
  main: { url: '', password: '' },                       // blank = use OBS_HOST/OBS_PORT/OBS_PASSWORD from .env
  replay: { url: 'ws://127.0.0.1:4456', password: '' },
  names: {
    scene: 'REPLAY', player: 'Replay Player', transition: 'Replay Stinger',
    // Optional second scene + player. When both are set, "Play all" alternates between the
    // two scenes so the stinger plays between every clip (OBS can't transition a scene to itself).
    sceneB: '', playerB: '',
  },
  // How the replay is wiped in and out:
  //  'overlay': the graphics overlay plays a full-screen wipe in the home team's colours and OBS
  //             cuts underneath it (no video file needed; works between every Play-all clip too)
  //  'obs':     an OBS Stinger transition (your own video), named in names.transition
  stinger: { mode: 'overlay', cutTransition: 'Cut', durationMs: 1300 }, // durationMs: length of the graphics wipe
  lengthSec: 8,          // play the last N seconds of each clip
  slowSpeed: 50,         // speed of the slow-motion button, in %
  saveTimeoutMs: 5000,   // wait this long for ReplayBufferSaved before falling back
  shortcuts: { replay: 'r', replaySlow: 't', mark: 'm', abort: 'b' },
};
export const TAGS = ['Goal', 'Chance', 'Save', 'Foul', 'Other'];

const MEDIA_STOP = 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP';
// Graphics stinger timing. The overlay animation (public/overlay/replay-bug.js + overlay.css) is
// keyframed in percentages of totalMs and is fully covering from ~38% to ~56%; we cut at 46%.
export const WIPE_COVERED_AT = 0.46;
export const WIPE_LIMITS = { min: 600, max: 3000 };
export function wipeTiming(durationMs = 1300) {
  const totalMs = Math.max(WIPE_LIMITS.min, Math.min(WIPE_LIMITS.max, Math.round(Number(durationMs) || 1300)));
  return { totalMs, switchAtMs: Math.round(totalMs * WIPE_COVERED_AT) };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ABORTED = Symbol('aborted');

function mergeSettings(base, over) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') Object.assign(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/** Turn an obs-websocket error into something an operator can act on. */
function friendly(err, what = '') {
  const m = err?.message || String(err);
  if (err?.code === 600 || /not found|No source|No scene|could not be found/i.test(m)) return `${what || 'Something'} was not found in OBS (${m})`;
  if (/not active|not running/i.test(m)) return `${what ? what + ': ' : ''}${m}`;
  return `${what ? what + ': ' : ''}${m}`;
}

export class Replays extends EventEmitter {
  /**
   * @param {object} o
   * @param {ObsLink} o.mainObs   the existing main OBS connection (shared with scene switching)
   * @param {{url: string, password?: string}} o.mainDefault  main OBS address from .env
   * @param {() => string|null} o.getMinute  current match minute ("23", "45+2") or null
   * @param {string} [o.file]
   */
  constructor({ mainObs, mainDefault, getMinute = () => null, file = REPLAYS_FILE }) {
    super();
    this.file = file;
    this.mainObs = mainObs;
    this.mainDefault = mainDefault;
    this.getMinute = getMinute;
    const saved = readJson(file, {}) || {};
    this.settings = mergeSettings(DEFAULT_SETTINGS, saved.settings);
    this.queue = Array.isArray(saved.queue) ? saved.queue.filter(c => c && c.id && c.path) : [];
    this.bus = new EventEmitter(); // internal: 'saved', 'ended', 'transitionEnded', 'abort'
    this.bus.setMaxListeners(50);
    this.status = { saving: false, playing: null, bug: { visible: false, speed: 100 }, wipe: null, bufferActive: null, bufferWarning: null };
    this.notice = null; // { id, level, text } — latest message for the dock
    this.session = null;
    this.lastSavedPath = null;

    this.replayObs = new ObsLink({ url: this.settings.replay.url, password: this.settings.replay.password }, {}, 'Replay OBS');
    this.replayObs.on('status', () => this.changed());
    this.replayObs.on('connected', () => this.safe(() => this.checkBuffer()));
    this.replayObs.on('disconnected', () => { this.status.bufferActive = null; this.changed(); });
    this.mainObs.on('status', () => this.changed());

    const ro = this.replayObs.obs;
    ro.on('ReplayBufferSaved', d => this.bus.emit('saved', d?.savedReplayPath));
    ro.on('ReplayBufferStateChanged', d => {
      this.status.bufferActive = !!d?.outputActive;
      this.changed();
    });
    const mo = this.mainObs.obs;
    mo.on('MediaInputPlaybackEnded', d => this.bus.emit('ended', d?.inputName));
    mo.on('SceneTransitionEnded', d => this.bus.emit('transitionEnded', d?.transitionName));
    // If the operator switches scenes in OBS during a replay, step aside: no switching back.
    mo.on('CurrentProgramSceneChanged', d => {
      const ses = this.session;
      const n = this.settings.names;
      if (!ses || !ses.onReplay || ses.switchingBack || ses.manual) return;
      if (d?.sceneName && d.sceneName !== n.scene && d.sceneName !== n.sceneB) {
        ses.manual = d.sceneName;
        ses.aborted = true;
        this.bus.emit('abort');
      }
    });
  }

  // ------------------------------------------------------------------ plumbing
  start() {
    this.applyMainSettings();
    this.replayObs.start();
  }

  stop() { this.replayObs.stop(); }

  changed() { this.emit('change'); }

  /** Run fn, turning any failure into an error notice instead of an exception. */
  async safe(fn) {
    try { return await fn(); } catch (err) { this.say('error', err.message || String(err)); return undefined; }
  }

  say(level, text) {
    this.notice = { id: crypto.randomBytes(4).toString('hex'), level, text, at: Date.now() };
    if (level === 'error') console.warn('[replays]', text);
    this.changed();
  }

  persist() {
    try { writeJsonAtomic(this.file, { settings: this.settings, queue: this.queue }); } catch (err) { console.warn('[replays] could not save', err.message); }
  }

  /** Wait for an internal bus event (optionally filtered). Resolves ABORTED if the replay is aborted. */
  waitFor(event, ms, filter = () => true) {
    return new Promise((resolve, reject) => {
      const done = (fn, v) => { clearTimeout(timer); this.bus.off(event, onEvent); this.bus.off('abort', onAbort); fn(v); };
      const onEvent = v => { if (filter(v)) done(resolve, v); };
      const onAbort = () => done(resolve, ABORTED);
      const timer = setTimeout(() => done(reject, new Error(`timeout waiting for ${event}`)), ms);
      this.bus.on(event, onEvent);
      this.bus.on('abort', onAbort);
    });
  }

  // ------------------------------------------------------------------ status for the dock / overlay
  saveBlockedReason() {
    if (!this.replayObs.status.connected) return `Replay OBS not connected (${this.replayObs.status.error || 'connecting…'})`;
    if (this.status.bufferActive === false) return 'Replay Buffer is not running on the Replay OBS';
    if (this.status.saving) return 'Saving…';
    return null;
  }

  playBlockedReason() {
    if (!this.mainObs.status.connected) return `Main OBS not connected (${this.mainObs.status.error || 'connecting…'})`;
    return null;
  }

  publicStatus() {
    const s = this.settings;
    return {
      settings: {
        ...s,
        main: { url: s.main.url, hasPassword: !!s.main.password, defaultUrl: this.mainDefault.url },
        replay: { url: s.replay.url, hasPassword: !!s.replay.password },
      },
      tags: TAGS,
      queue: this.queue,
      main: { connected: this.mainObs.status.connected, error: this.mainObs.status.error, url: this.mainObs.url },
      replayObs: { connected: this.replayObs.status.connected, error: this.replayObs.status.error, url: this.replayObs.url },
      bufferActive: this.status.bufferActive,
      bufferWarning: this.status.bufferWarning,
      saving: this.status.saving,
      playing: this.status.playing,
      bug: this.status.bug,
      wipe: this.status.wipe,
      saveBlocked: this.saveBlockedReason(),
      playBlocked: this.playBlockedReason(),
      notice: this.notice,
    };
  }

  // ------------------------------------------------------------------ Replay OBS: buffer + saving
  async checkBuffer() {
    const res = await this.replayObs.call('GetReplayBufferStatus');
    this.status.bufferActive = !!res.outputActive;
    if (!res.outputActive) {
      try {
        await this.replayObs.call('StartReplayBuffer');
        this.status.bufferActive = true;
        this.status.bufferWarning = 'Replay Buffer was not running on the Replay OBS, so it was started. Clips only contain what was recorded since then.';
        this.say('warn', this.status.bufferWarning);
      } catch (err) {
        this.status.bufferWarning = `Replay Buffer is stopped and could not be started: ${err.message}. In the Replay OBS enable Settings → Output → Replay Buffer.`;
        this.say('error', this.status.bufferWarning);
      }
    } else {
      this.status.bufferWarning = null;
    }
    this.changed();
  }

  /** Save the Replay Buffer and return the file path. One save at a time. */
  async saveBuffer() {
    const blocked = this.saveBlockedReason();
    if (blocked) throw new Error(blocked);
    this.status.saving = true;
    this.changed();
    try {
      const waiter = this.waitFor('saved', this.settings.saveTimeoutMs).catch(() => null);
      await this.replayObs.call('SaveReplayBuffer');
      let file = await waiter;
      if (file === ABORTED) file = null;
      if (!file) {
        // Event never arrived: ask OBS for the last replay, but only trust it if it's a new file.
        let last = null;
        try { last = (await this.replayObs.call('GetLastReplayBufferReplay')).savedReplayPath; } catch {}
        if (!last || last === this.lastSavedPath || this.queue.some(c => c.path === last)) {
          throw new Error(`Saving the replay timed out: the Replay OBS didn't report a new file within ${Math.round(this.settings.saveTimeoutMs / 1000)}s`);
        }
        file = last;
      }
      this.lastSavedPath = file;
      return file;
    } catch (err) {
      throw new Error(err.message.startsWith('Saving the replay') ? err.message : friendly(err, 'Saving the replay'));
    } finally {
      this.status.saving = false;
      this.changed();
    }
  }

  addClip(file, { label = '', tag = '' } = {}) {
    const clip = {
      id: crypto.randomBytes(5).toString('hex'),
      path: file,
      file: path.basename(String(file)),
      label: String(label).slice(0, 80),
      tag: TAGS.includes(tag) ? tag : '',
      minute: this.safeMinute(),
      createdAt: Date.now(),
    };
    this.queue.push(clip);
    this.persist();
    this.changed();
    return clip;
  }

  safeMinute() { try { return this.getMinute() || null; } catch { return null; } }

  // ------------------------------------------------------------------ actions
  /** REPLAY NOW: save, then play the last N seconds. If a replay is already on air, just queue it. */
  async replayNow(speed = 100) {
    if (this.status.saving) return { ok: false, busy: true, error: 'Already saving a replay…' };
    if (this.status.playing) {
      const file = await this.saveBuffer();
      const clip = this.addClip(file);
      this.say('info', 'A replay is already on air, so this clip was added to the queue');
      return { ok: true, queued: true, clip };
    }
    const playBlocked = this.playBlockedReason();
    if (playBlocked) throw new Error(playBlocked);
    this.pendingAbort = false;
    const file = await this.saveBuffer();
    const clip = this.addClip(file);
    if (this.pendingAbort) { this.pendingAbort = false; return { ok: true, queued: true, clip, aborted: true }; }
    this.playSequence([clip], speed); // runs in the background; progress/errors come through status
    return { ok: true, clip };
  }

  /** MARK: save and queue without playing. */
  async mark(tag = '') {
    if (this.status.saving) return { ok: false, busy: true, error: 'Already saving a replay…' };
    const file = await this.saveBuffer();
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const minute = this.safeMinute();
    const clip = this.addClip(file, { label: `${time}${minute ? ` · ${minute}'` : ''}`, tag });
    this.say('info', `Marked: ${clip.label}${clip.tag ? ` (${clip.tag})` : ''}`);
    return { ok: true, clip };
  }

  playClip(id, speed = 100) {
    const clip = this.queue.find(c => c.id === id);
    if (!clip) throw new Error('Clip not found');
    return this.startSequence([clip], speed);
  }

  playAll(speed = 100) {
    if (!this.queue.length) throw new Error('The queue is empty');
    return this.startSequence([...this.queue], speed);
  }

  startSequence(clips, speed) {
    if (this.status.playing) throw new Error('A replay is already on air');
    if (this.status.saving) throw new Error('Saving a replay, try again in a moment');
    const blocked = this.playBlockedReason();
    if (blocked) throw new Error(blocked);
    this.playSequence(clips, speed);
    return { ok: true };
  }

  /** ABORT / BACK TO LIVE: works during saving (cancels the pending play) and during playback. */
  abort() {
    if (this.status.saving && !this.status.playing) { this.pendingAbort = true; return { ok: true }; }
    if (!this.session) return { ok: true, idle: true };
    this.session.aborted = true;
    this.bus.emit('abort');
    return { ok: true };
  }

  // ------------------------------------------------------------------ playback
  async preflight() {
    const n = this.settings.names;
    const [scenes, transitions] = await Promise.all([
      this.mainObs.call('GetSceneList'),
      this.mainObs.call('GetSceneTransitionList'),
    ]);
    const sceneSet = new Set((scenes.scenes || []).map(s => s.sceneName));
    const transSet = new Set((transitions.transitions || []).map(t => t.transitionName));
    const fix = 'Create it in the main OBS or change the name in Replays → Settings.';
    if (!sceneSet.has(n.scene)) throw new Error(`Scene "${n.scene}" not found in the main OBS. ${fix}`);
    const overlayStinger = this.settings.stinger.mode === 'overlay';
    const needTransition = overlayStinger ? this.settings.stinger.cutTransition : n.transition;
    if (!transSet.has(needTransition)) throw new Error(`Transition "${needTransition}" not found in the main OBS. ${fix}`);
    const players = [n.player];
    if (!overlayStinger && this.useB()) {
      if (!sceneSet.has(n.sceneB)) throw new Error(`Scene "${n.sceneB}" (second replay scene) not found in the main OBS. ${fix}`);
      players.push(n.playerB);
    }
    for (const p of players) {
      try { await this.mainObs.call('GetInputSettings', { inputName: p }); } catch { throw new Error(`Media source "${p}" not found in the main OBS. ${fix}`); }
    }
  }

  useB() { const n = this.settings.names; return this.settings.stinger.mode !== 'overlay' && !!(n.sceneB && n.playerB); }

  /**
   * Graphics stinger: start the overlay wipe, and once it covers the screen run `whileCovered`
   * (cut to a scene and/or load the next clip). Resolves at the switch point.
   */
  async wipe(whileCovered) {
    const t = wipeTiming(this.settings.stinger.durationMs);
    this.status.wipe = { id: crypto.randomBytes(4).toString('hex'), at: Date.now(), ...t };
    this.changed();
    await sleep(t.switchAtMs);
    await whileCovered();
  }

  /** Wait until the media source has loaded the clip, then jump to the last N seconds. Returns media ms left. */
  async seekToTail(player) {
    const start = Date.now();
    let st = null;
    while (Date.now() - start < 3000) {
      if (this.session?.aborted) return 0;
      try {
        st = await this.mainObs.call('GetMediaInputStatus', { inputName: player });
        if (st.mediaDuration > 0 && st.mediaState !== 'OBS_MEDIA_STATE_OPENING') break;
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    const duration = st?.mediaDuration || 0;
    if (!duration) return null; // unknown length: just wait for the end event
    const tailMs = this.settings.lengthSec * 1000;
    const cursor = Math.max(0, duration - tailMs);
    if (cursor > (st.mediaCursor || 0)) await this.mainObs.call('SetMediaInputCursor', { inputName: player, mediaCursor: cursor });
    return duration - cursor;
  }

  async playSequence(clips, speed) {
    speed = clampInt(speed, 10, 200, 100);
    const n = this.settings.names;
    const session = { aborted: false };
    this.session = session;
    this.status.playing = { total: clips.length, index: 0, clipId: clips[0]?.id, speed, startedAt: Date.now(), label: clips[0]?.label || '' };
    this.changed();
    let prevScene = null;
    let prevTransition = null;
    let wentToReplay = false;
    try {
      prevScene = (await this.mainObs.call('GetCurrentProgramScene')).currentProgramSceneName;
      if (prevScene === n.scene || prevScene === n.sceneB) prevScene = this.mainObs.config.mainScene || prevScene;
      prevTransition = (await this.mainObs.call('GetCurrentSceneTransition')).transitionName;
      await this.preflight();

      let current = null; // scene currently on program
      for (let i = 0; i < clips.length; i++) {
        if (session.aborted) break;
        const clip = clips[i];
        this.status.playing = { ...this.status.playing, index: i, clipId: clip.id, label: clip.label || '' };
        this.changed();
        if (!fs.existsSync(clip.path)) {
          this.say('error', `Replay file is missing: ${clip.path}`);
          if (clips.length === 1) break;
          continue;
        }
        const overlayStinger = this.settings.stinger.mode === 'overlay';
        const alt = this.useB() && current === n.scene; // OBS stinger: alternate scenes so it can play between clips
        const scene = alt ? n.sceneB : n.scene;
        const player = alt ? n.playerB : n.player;
        const loadClip = () => this.mainObs.call('SetInputSettings', {
          inputName: player,
          inputSettings: { is_local_file: true, local_file: clip.path, speed_percent: speed, restart_on_activate: true, close_when_inactive: true },
          overlay: true,
        });
        const enterScene = async () => {
          await this.mainObs.call('SetCurrentProgramScene', { sceneName: scene });
          current = scene;
          wentToReplay = true;
          session.onReplay = true;
        };
        if (overlayStinger) {
          if (current !== scene) {
            await loadClip();
            await this.mainObs.call('SetCurrentSceneTransition', { transitionName: this.settings.stinger.cutTransition });
            await this.wipe(enterScene);               // wipe in, cut to REPLAY under it
          } else {
            await this.wipe(loadClip);                 // between Play-all clips: swap the clip under the wipe
          }
        } else {
          await loadClip();
          if (scene !== current) {
            await this.mainObs.call('SetCurrentSceneTransition', { transitionName: n.transition });
            await enterScene();
          }
        }
        const leftMs = await this.seekToTail(player);
        if (!this.status.bug.visible) { this.status.bug = { visible: true, speed }; this.changed(); }
        if (session.aborted) break;
        const wallMs = leftMs == null ? 120000 : (leftMs * 100) / speed + 5000;
        const r = await this.waitFor('ended', wallMs, name => name === player).catch(() => null);
        if (r === ABORTED) break;
      }
    } catch (err) {
      this.say('error', err.message.includes('not found') ? err.message : friendly(err, 'Replay'));
    } finally {
      await this.backToLive({ session, prevScene, prevTransition, wentToReplay });
    }
  }

  async backToLive({ session, prevScene, prevTransition, wentToReplay }) {
    const n = this.settings.names;
    this.status.bug = { visible: false, speed: this.status.bug.speed };
    this.changed();
    session.switchingBack = true;
    try {
      if (session.manual) {
        // Operator already switched away in OBS: just tidy up.
        if (prevTransition) await this.mainObs.call('SetCurrentSceneTransition', { transitionName: prevTransition });
        this.say('info', `Replay ended: you switched to "${session.manual}" in OBS`);
      } else if (wentToReplay && prevScene) {
        if (session.aborted) {
          // Straight back with the operator's normal transition, and stop the clip.
          for (const p of [n.player, this.useB() ? n.playerB : null].filter(Boolean)) {
            this.mainObs.call('TriggerMediaInputAction', { inputName: p, mediaAction: MEDIA_STOP }).catch(() => {});
          }
          if (prevTransition) await this.mainObs.call('SetCurrentSceneTransition', { transitionName: prevTransition });
          await this.mainObs.call('SetCurrentProgramScene', { sceneName: prevScene });
        } else if (this.settings.stinger.mode === 'overlay') {
          await this.mainObs.call('SetCurrentSceneTransition', { transitionName: this.settings.stinger.cutTransition });
          await this.wipe(() => this.mainObs.call('SetCurrentProgramScene', { sceneName: prevScene }));
          const t = wipeTiming(this.settings.stinger.durationMs);
          await sleep(t.totalMs - t.switchAtMs);
          if (prevTransition) await this.mainObs.call('SetCurrentSceneTransition', { transitionName: prevTransition });
        } else {
          await this.mainObs.call('SetCurrentSceneTransition', { transitionName: n.transition });
          const ended = this.waitFor('transitionEnded', 6000).catch(() => null);
          await this.mainObs.call('SetCurrentProgramScene', { sceneName: prevScene });
          await ended;
          if (prevTransition) await this.mainObs.call('SetCurrentSceneTransition', { transitionName: prevTransition });
        }
      } else if (prevTransition) {
        // Never got to the replay scene: just make sure the operator's transition is restored.
        const cur = (await this.mainObs.call('GetCurrentSceneTransition')).transitionName;
        if (cur !== prevTransition) await this.mainObs.call('SetCurrentSceneTransition', { transitionName: prevTransition });
      }
    } catch (err) {
      this.say('error', `Could not return to "${prevScene}": ${err.message}. Switch back manually in OBS.`);
    } finally {
      if (this.session === session) this.session = null;
      this.status.playing = null;
      this.changed();
    }
  }

  // ------------------------------------------------------------------ queue + settings
  rename(id, label) { this.editClip(id, c => { c.label = String(label || '').trim().slice(0, 80); }); }
  tag(id, tag) { this.editClip(id, c => { c.tag = TAGS.includes(tag) ? tag : ''; }); }
  editClip(id, fn) {
    const c = this.queue.find(x => x.id === id);
    if (!c) throw new Error('Clip not found');
    fn(c);
    this.persist(); this.changed();
  }
  remove(id) {
    const i = this.queue.findIndex(x => x.id === id);
    if (i < 0) throw new Error('Clip not found');
    this.queue.splice(i, 1);
    this.persist(); this.changed();
  }
  move(id, dir) {
    const i = this.queue.findIndex(x => x.id === id);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= this.queue.length) return;
    [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    this.persist(); this.changed();
  }
  clearQueue() { this.queue = []; this.persist(); this.changed(); }

  updateSettings(p = {}) {
    const s = structuredClone(this.settings);
    const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
    if (p.main) {
      if (p.main.url !== undefined) s.main.url = str(p.main.url);
      if (p.main.password !== undefined) s.main.password = String(p.main.password);
    }
    if (p.replay) {
      if (p.replay.url !== undefined) s.replay.url = str(p.replay.url) || DEFAULT_SETTINGS.replay.url;
      if (p.replay.password !== undefined) s.replay.password = String(p.replay.password);
    }
    for (const url of [s.main.url, s.replay.url]) {
      if (url && !/^wss?:\/\/[^\s/]+(:\d+)?\/?$/.test(url)) throw new Error(`"${url}" is not a WebSocket address like ws://127.0.0.1:4456`);
    }
    if (p.names) for (const k of Object.keys(DEFAULT_SETTINGS.names)) if (p.names[k] !== undefined) s.names[k] = str(p.names[k], 100);
    for (const k of ['scene', 'player', 'transition']) if (!s.names[k]) s.names[k] = DEFAULT_SETTINGS.names[k];
    if (p.stinger) {
      if (p.stinger.mode !== undefined) s.stinger.mode = p.stinger.mode === 'obs' ? 'obs' : 'overlay';
      if (p.stinger.cutTransition !== undefined) s.stinger.cutTransition = str(p.stinger.cutTransition, 100) || 'Cut';
      if (p.stinger.durationMs !== undefined) s.stinger.durationMs = wipeTiming(p.stinger.durationMs).totalMs;
    }
    if (p.lengthSec !== undefined) s.lengthSec = clampInt(p.lengthSec, 2, 60, s.lengthSec);
    if (p.slowSpeed !== undefined) s.slowSpeed = clampInt(p.slowSpeed, 10, 99, s.slowSpeed);
    if (p.shortcuts) {
      for (const k of Object.keys(DEFAULT_SETTINGS.shortcuts)) {
        if (p.shortcuts[k] !== undefined) s.shortcuts[k] = String(p.shortcuts[k] || '').toLowerCase().slice(0, 20);
      }
    }
    this.settings = s;
    this.persist();
    this.applyMainSettings();
    this.replayObs.reconfigure({ url: s.replay.url, password: s.replay.password });
    this.changed();
  }

  applyMainSettings() {
    const m = this.settings.main;
    this.mainObs.reconfigure({ url: m.url || this.mainDefault.url, password: m.url ? m.password : (m.password || this.mainDefault.password) });
  }

  // ------------------------------------------------------------------ one entry point for the dock / HTTP
  async handle(op, args = {}) {
    switch (op) {
      case 'now': return this.replayNow(args.speed === 'slow' ? this.settings.slowSpeed : args.speed);
      case 'mark': return this.mark(args.tag);
      case 'abort': return this.abort();
      case 'play': return this.playClip(args.id, args.speed === 'slow' ? this.settings.slowSpeed : args.speed);
      case 'playAll': return this.playAll(args.speed === 'slow' ? this.settings.slowSpeed : args.speed);
      case 'rename': return this.rename(args.id, args.label);
      case 'tag': return this.tag(args.id, args.tag);
      case 'delete': return this.remove(args.id);
      case 'move': return this.move(args.id, args.dir);
      case 'clearQueue': return this.clearQueue();
      case 'settings': return this.updateSettings(args);
      case 'recheckBuffer': return this.checkBuffer();
      default: throw new Error(`Unknown replay command "${op}"`);
    }
  }
}

/** Stand-in used if the replay module fails to start: graphics carry on, replays report the problem. */
export function disabledReplays(reason) {
  const e = new EventEmitter();
  const status = { disabled: reason, queue: [], bug: { visible: false, speed: 100 }, saveBlocked: `Replays unavailable: ${reason}`, playBlocked: `Replays unavailable: ${reason}` };
  return Object.assign(e, {
    start() {}, stop() {},
    publicStatus: () => status,
    handle: async () => { throw new Error(`Replays unavailable: ${reason}`); },
  });
}
