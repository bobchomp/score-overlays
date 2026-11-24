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
import { buildReel } from './highlights.js';
import { spawn } from 'node:child_process';

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
  // durationMs: length of the graphics wipe. between: what happens between clips in Play all:
  //   'fade' = quick dip to black by the overlay (default), 'stinger' = full wipe/stinger, 'cut'
  stinger: { mode: 'overlay', cutTransition: 'Cut', durationMs: 1300, between: 'fade' },
  autoGoalClip: true,    // pressing + GOAL saves a replay into the queue as "<team> <goal number>"
  volume: 50,            // replay sound level in % (the live sound keeps playing underneath)
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
export const DIP_MS = 300; // fade-to-black / fade-up time between Play-all clips (overlay uses the same)
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
  constructor({ mainObs, mainDefault, getMinute = () => null, getTimerMinute = () => null, getMatch = () => ({}), file = REPLAYS_FILE }) {
    super();
    this.file = file;
    this.mainObs = mainObs;
    this.mainDefault = mainDefault;
    this.getMinute = getMinute;
    this.getTimerMinute = getTimerMinute;
    this.getMatch = getMatch;
    this.reel = { running: false, percent: 0, file: null, error: null, clips: 0 };
    const saved = readJson(file, {}) || {};
    this.settings = mergeSettings(DEFAULT_SETTINGS, saved.settings);
    this.queue = Array.isArray(saved.queue) ? saved.queue.filter(c => c && c.id && c.path) : [];
    this.bus = new EventEmitter(); // internal: 'saved', 'ended', 'transitionEnded', 'abort'
    this.bus.setMaxListeners(50);
    this.status = { saving: false, playing: null, bug: { visible: false, speed: 100 }, wipe: null, dip: null, bufferActive: null, bufferWarning: null };
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
    // If the saved highlights reel is deleted/moved in Explorer, stop showing it in the dock.
    this.reelWatch = setInterval(() => this.checkReelFile(), 3000);
    this.reelWatch.unref?.();
  }

  checkReelFile() {
    if (this.reel.running || !this.reel.file) return;
    if (!fs.existsSync(this.reel.file)) {
      this.reel = { running: false, percent: 0, file: null, error: null, clips: 0 };
      this.changed();
    }
  }

  stop() { clearTimeout(this.renameTimer); this.renameTimer = null; clearInterval(this.reelWatch); this.replayObs.stop(); }

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
      dip: this.status.dip,
      saveBlocked: this.saveBlockedReason(),
      playBlocked: this.playBlockedReason(),
      notice: this.notice,
      reel: this.reel,
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
        if (!last || last === this.lastSavedPath || this.queue.some(c => c.path === last) || !fs.existsSync(last)) {
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
      dir: this.matchFolder(file),
    };
    this.queue.push(clip);
    this.syncFileName(clip);
    this.persist();
    this.changed();
    return clip;
  }

  // ------------------------------------------------------------------ one folder per match
  /**
   * Where this match's clips go: a folder next to OBS's replay folder named
   * "2026-11-24 Ross County v Airdrie" (local date of the clip, then the teams).
   */
  matchFolder(file) {
    const m = (() => { try { return this.getMatch() || {}; } catch { return {}; } })();
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const name = Replays.fileBase(m.home && m.away ? `${day} ${m.home} v ${m.away}` : `${day} Replays`);
    const dir = path.dirname(String(file));
    // Already in a match folder (e.g. a clip re-added from one): leave it there.
    if (/^\d{4}-\d{2}-\d{2} /.test(path.basename(dir))) return dir;
    return path.join(dir, name);
  }

  // ------------------------------------------------------------------ file names follow clip names
  /** A clip's label as a safe Windows file name (no extension). */
  static fileBase(label) {
    let b = String(label || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 120)
      .trim();
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(b)) b = `_${b}`;
    return b;
  }

  /**
   * Rename the clip's file on disk to match its label ("Ross County Chance - 23 minutes.mkv").
   * Unnamed clips keep OBS's name. If the file is busy (e.g. playing in OBS) it's retried later.
   */
  syncFileName(clip) {
    if (!clip) return;
    const moving = clip.dir && path.dirname(clip.path) !== clip.dir;
    const renaming = clip.label && clip.fileLabel !== clip.label;
    if (!moving && !renaming) return;
    const base = (clip.label && Replays.fileBase(clip.label)) || path.basename(clip.path, path.extname(clip.path));
    if (!base) return;
    const dir = clip.dir || path.dirname(clip.path);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const ext = path.extname(clip.path) || '.mkv';
    let target = path.join(dir, base + ext);
    for (let n = 2; fs.existsSync(target) && target !== clip.path; n++) target = path.join(dir, `${base} (${n})${ext}`);
    try {
      if (target !== clip.path) fs.renameSync(clip.path, target);
      clip.path = target;
      clip.file = path.basename(target);
      clip.fileLabel = clip.label;
      delete clip.renamePending;
    } catch (err) {
      if (err.code === 'ENOENT' && !fs.existsSync(clip.path)) { clip.fileLabel = clip.label; clip.dir = path.dirname(clip.path); delete clip.renamePending; return; } // file gone: nothing to rename
      clip.renamePending = true; // busy (e.g. open in OBS): try again shortly
      this.scheduleRenameRetry();
    }
  }

  scheduleRenameRetry() {
    if (this.renameTimer) return;
    this.renameTimer = setTimeout(() => {
      this.renameTimer = null;
      let changed = false;
      for (const c of this.queue) {
        if (!c.renamePending) continue;
        if (this.status.playing && this.session && this.status.playing.clipId === c.id) { this.scheduleRenameRetry(); continue; }
        const before = c.path;
        this.syncFileName(c);
        if (c.path !== before) changed = true;
      }
      if (changed) { this.persist(); this.changed(); }
    }, 10000);
    this.renameTimer.unref?.();
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
  async mark(tag = '', { label, silent = false } = {}) {
    if (this.status.saving) return { ok: false, busy: true, error: 'Already saving a replay…' };
    const file = await this.saveBuffer();
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const minute = this.safeMinute();
    // Tagged marks are named "<Tag> - <timer minutes> minutes"; the dock then adds the team in front.
    let auto = `${time}${minute ? ` · ${minute}'` : ''}`;
    if (tag) {
      let tm = null;
      try { tm = this.getTimerMinute(); } catch {}
      if (tm != null) auto = `${tag} - ${tm} ${tm === '1' ? 'minute' : 'minutes'}`;
    }
    const clip = this.addClip(file, { label: label || auto, tag });
    if (!silent) this.say('info', `Marked: ${clip.label}${clip.tag ? ` (${clip.tag})` : ''}`);
    return { ok: true, clip };
  }

  /** Goal logged from the Stream Deck / HTTP: save a clip named "<team> <n>". Never throws. */
  async goalClip(label, eventId) {
    if (!this.settings.autoGoalClip || this.saveBlockedReason()) return null;
    try {
      const clip = (await this.mark('Goal', { label, silent: true })).clip || null;
      if (clip && eventId) { clip.goalEventId = eventId; this.persist(); }
      return clip;
    } catch { return null; }
  }

  /**
   * A goal was chopped off (VAR, offside...) or put back with Undo: its clip becomes
   * "<team> <n> - Disallowed", or loses that ending again. Never throws.
   */
  goalDisallowed(eventId, disallowed = true) {
    try {
      const c = this.queue.find(x => x.goalEventId === eventId);
      if (!c) return;
      const base = c.label.replace(/ - Disallowed$/, '');
      const label = disallowed ? `${base} - Disallowed` : base;
      if (label !== c.label) this.rename(c.id, label);
    } catch (err) { console.error('[replays] could not rename disallowed goal clip:', err.message); }
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
    const fix = 'Create it in the main OBS or change the name in the dock under Settings → Replay settings.';
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

  useB() {
    const n = this.settings.names;
    return this.settings.stinger.mode !== 'overlay' && this.settings.stinger.between === 'stinger' && !!(n.sceneB && n.playerB);
  }

  /** Overlay dip to black between Play-all clips: 'out' fades to black, 'in' fades back up. */
  dip(phase) {
    this.status.dip = { id: crypto.randomBytes(4).toString('hex'), phase, at: Date.now(), ms: DIP_MS };
    this.changed();
  }

  /**
   * Graphics stinger: start the overlay wipe, and once it covers the screen run `whileCovered`
   * (cut to a scene and/or load the next clip). Resolves at the switch point.
   */
  async wipe(whileCovered, session = null) {
    const t = wipeTiming(this.settings.stinger.durationMs);
    this.status.wipe = { id: crypto.randomBytes(4).toString('hex'), at: Date.now(), ...t };
    this.changed();
    await sleep(t.switchAtMs);
    // ABORT pressed while the wipe was coming in: do nothing, the wipe just reveals live again.
    if (session?.aborted) return;
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
      let loadedAt = 0;
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
        if (i === 0) await this.applyVolume();
        const loadClip = () => { loadedAt = Date.now(); return this.mainObs.call('SetInputSettings', {
          inputName: player,
          // clear_on_media_end: false holds the last frame instead of going blank while we transition away
          inputSettings: { is_local_file: true, local_file: clip.path, speed_percent: speed, restart_on_activate: true, close_when_inactive: true, clear_on_media_end: false },
          overlay: true,
        }); };
        const enterScene = async () => {
          await this.mainObs.call('SetCurrentProgramScene', { sceneName: scene });
          current = scene;
          wentToReplay = true;
          session.onReplay = true;
        };
        const between = this.settings.stinger.between || 'fade';
        let leftMs;
        if (current !== scene) {
          // Into the replay (or, OBS-stinger mode with a second scene, the next clip): full stinger.
          await loadClip();
          if (overlayStinger) {
            await this.mainObs.call('SetCurrentSceneTransition', { transitionName: this.settings.stinger.cutTransition });
            await this.wipe(enterScene, session);      // wipe in, cut to REPLAY under it
          } else {
            await this.mainObs.call('SetCurrentSceneTransition', { transitionName: n.transition });
            await enterScene();
          }
          leftMs = await this.seekToTail(player);
        } else if (between === 'fade') {
          // Next clip in Play all: dip to black, swap and seek while black, fade back up.
          this.dip('out');
          await sleep(DIP_MS + 20);
          if (session.aborted) break;
          await loadClip();
          leftMs = await this.seekToTail(player);
          this.dip('in');
        } else if (between === 'stinger' && overlayStinger) {
          await this.wipe(loadClip, session);          // swap the clip under a full wipe
          leftMs = await this.seekToTail(player);
        } else {
          await loadClip();                            // straight cut to the next clip
          leftMs = await this.seekToTail(player);
        }
        if (!this.status.bug.visible) { this.status.bug = { visible: true, speed }; this.changed(); }
        if (session.aborted) break;
        // Start what comes next a little before the clip ends, so the wipe / fade has covered the
        // picture by the time the clip runs out (no blank frame). Lead = time until fully covered.
        const isLast = i === clips.length - 1;
        const t = wipeTiming(this.settings.stinger.durationMs);
        const lead = isLast
          ? (overlayStinger ? t.switchAtMs : 0)
          : between === 'fade' ? DIP_MS : (between === 'stinger' && overlayStinger ? t.switchAtMs : 0);
        const wallLeft = leftMs == null ? null : (leftMs * 100) / speed;
        const ended = this.waitFor('ended', wallLeft == null ? 120000 : wallLeft + 5000,
          name => name === player && Date.now() - loadedAt > 500).catch(() => null);
        const r = wallLeft != null && lead > 0
          ? await Promise.race([ended, sleep(Math.max(0, wallLeft - lead)).then(() => 'early')])
          : await ended;
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
    if (this.status.dip?.phase === 'out') this.dip('in'); // never leave the picture black
    try {
      if (session.manual) {
        // Operator already switched away in OBS: just tidy up.
        if (prevTransition) await this.mainObs.call('SetCurrentSceneTransition', { transitionName: prevTransition });
        this.say('info', `Replay ended: you switched to "${session.manual}" in OBS`);
      } else if (wentToReplay && prevScene) {
        // Normal end and ABORT both go back through the stinger. On ABORT the wipe starts at once
        // and the clip is stopped as soon as we're back on the live scene.
        const stopClip = () => {
          if (!session.aborted) return;
          for (const p of [n.player, this.useB() ? n.playerB : null].filter(Boolean)) {
            this.mainObs.call('TriggerMediaInputAction', { inputName: p, mediaAction: MEDIA_STOP }).catch(() => {});
          }
        };
        if (this.settings.stinger.mode === 'overlay') {
          await this.mainObs.call('SetCurrentSceneTransition', { transitionName: this.settings.stinger.cutTransition });
          await this.wipe(async () => { await this.mainObs.call('SetCurrentProgramScene', { sceneName: prevScene }); stopClip(); });
          const t = wipeTiming(this.settings.stinger.durationMs);
          await sleep(t.totalMs - t.switchAtMs);
          if (prevTransition) await this.mainObs.call('SetCurrentSceneTransition', { transitionName: prevTransition });
        } else {
          await this.mainObs.call('SetCurrentSceneTransition', { transitionName: n.transition });
          const ended = this.waitFor('transitionEnded', 6000).catch(() => null);
          await this.mainObs.call('SetCurrentProgramScene', { sceneName: prevScene });
          await ended;
          stopClip();
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
      if (this.queue.some(c => c.renamePending)) this.scheduleRenameRetry(); // files OBS was playing are free now
    }
  }

  // ------------------------------------------------------------------ replay sound
  /** Set the Replay Player(s) to the replay volume (and unmuted). Never throws. */
  async applyVolume() {
    if (!this.mainObs.status.connected) return;
    const n = this.settings.names;
    const v = Math.max(0, Math.min(100, Number(this.settings.volume ?? 50))) / 100;
    for (const p of [n.player, n.playerB].filter(Boolean)) {
      try {
        await this.mainObs.call('SetInputVolume', { inputName: p, inputVolumeMul: v });
        await this.mainObs.call('SetInputMute', { inputName: p, inputMuted: v === 0 });
      } catch {}
    }
  }

  /** Volume slider: remembered, and applied straight away (also mid-replay). */
  async setVolume(volume) {
    this.settings.volume = clampInt(volume, 0, 100, this.settings.volume ?? 50);
    clearTimeout(this.volumeSaveTimer);
    this.volumeSaveTimer = setTimeout(() => this.persist(), 500);
    this.changed();
    await this.applyVolume();
    return { ok: true, volume: this.settings.volume };
  }

  // ------------------------------------------------------------------ highlights reel
  /**
   * Stitch queued clips into one MP4 (server/highlights.js). Runs in the background at low priority.
   * opts: { only: 'all'|'goals', whole: bool, fade: bool, force: bool }
   */
  async makeHighlights(opts = {}) {
    if (this.reel.running) throw new Error('A highlights reel is already being made');
    const clips = this.queue.filter(c => (opts.only === 'goals' ? c.tag === 'Goal' : true) && fs.existsSync(c.path));
    if (!clips.length) throw new Error(opts.only === 'goals' ? 'No goal clips in the queue' : 'The queue has no clips (or their files are missing)');
    if (!opts.force && this.mainObs.status.connected) {
      try {
        const st = await this.mainObs.call('GetStreamStatus');
        if (st.outputActive) return { ok: false, needsConfirm: true, error: 'OBS is streaming. Making the reel uses some CPU (at low priority).' };
      } catch {}
    }
    const m = (() => { try { return this.getMatch() || {}; } catch { return {}; } })();
    const day = new Date().toISOString().slice(0, 10);
    const title = Replays.fileBase(m.home && m.away ? `${m.home} v ${m.away} - highlights ${day}` : `Highlights ${day}`) || `Highlights ${day}`;
    const dir = clips[0].dir || path.dirname(clips[0].path); // the match folder, next to the clips
    fs.mkdirSync(dir, { recursive: true });
    let out = path.join(dir, `${title}.mp4`);
    for (let n = 2; fs.existsSync(out); n++) out = path.join(dir, `${title} (${n}).mp4`);

    this.reel = { running: true, percent: 0, file: null, error: null, clips: clips.length, startedAt: Date.now() };
    this.changed();
    let lastPush = 0;
    buildReel({
      files: clips.map(c => c.path),
      tailSec: opts.whole ? null : this.settings.lengthSec,
      fade: opts.fade !== false,
      out,
      onChild: child => { this.reelChild = child; },
      onProgress: pct => {
        this.reel.percent = pct;
        if (Date.now() - lastPush > 400 || pct === 100) { lastPush = Date.now(); this.changed(); }
      },
    }).then(r => {
      this.reel = { running: false, percent: 100, file: r.out, error: null, clips: r.clips, seconds: r.seconds, skipped: r.skipped };
      this.say('info', `Highlights reel saved: ${path.basename(r.out)}`);
    }).catch(err => {
      this.reel = { running: false, percent: 0, file: null, error: err.message, clips: 0 };
      if (err.message !== 'Cancelled') this.say('error', `Highlights reel failed: ${err.message}`);
    }).finally(() => { this.reelChild = null; this.changed(); });
    return { ok: true, started: true, clips: clips.length };
  }

  cancelHighlights() {
    try { this.reelChild?.kill(); } catch {}
    return { ok: true };
  }

  /** Open Explorer with the file selected (the server runs on the streaming PC). */
  reveal(file) {
    const target = file || this.reel.file;
    if (!target || !fs.existsSync(target)) throw new Error('File not found');
    if (process.platform !== 'win32') throw new Error(`Saved at ${target}`);
    spawn('explorer.exe', [`/select,"${target}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  }

  // ------------------------------------------------------------------ queue + settings
  rename(id, label, eventId) {
    this.editClip(id, c => { c.label = String(label || '').trim().slice(0, 80); if (eventId) c.goalEventId = String(eventId); this.syncFileName(c); });
  }
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
      if (p.stinger.between !== undefined) s.stinger.between = ['fade', 'stinger', 'cut'].includes(p.stinger.between) ? p.stinger.between : 'fade';
      if (p.stinger.durationMs !== undefined) s.stinger.durationMs = wipeTiming(p.stinger.durationMs).totalMs;
    }
    if (p.autoGoalClip !== undefined) s.autoGoalClip = !!p.autoGoalClip;
    if (p.volume !== undefined) s.volume = clampInt(p.volume, 0, 100, s.volume);
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
      case 'mark': return this.mark(args.tag, { label: args.label, silent: !!args.silent });
      case 'abort': return this.abort();
      case 'play': return this.playClip(args.id, args.speed === 'slow' ? this.settings.slowSpeed : args.speed);
      case 'playAll': return this.playAll(args.speed === 'slow' ? this.settings.slowSpeed : args.speed);
      case 'rename': return this.rename(args.id, args.label, args.eventId);
      case 'tag': return this.tag(args.id, args.tag);
      case 'delete': return this.remove(args.id);
      case 'move': return this.move(args.id, args.dir);
      case 'clearQueue': return this.clearQueue();
      case 'settings': return this.updateSettings(args);
      case 'recheckBuffer': return this.checkBuffer();
      case 'highlights': return this.makeHighlights(args);
      case 'cancelHighlights': return this.cancelHighlights();
      case 'reveal': return this.reveal(args.file);
      case 'volume': return this.setVolume(args.volume);
      default: throw new Error(`Unknown replay command "${op}"`);
    }
  }
}

/** Stand-in used if the replay module fails to start: graphics carry on, replays report the problem. */
export function disabledReplays(reason) {
  const e = new EventEmitter();
  const status = { disabled: reason, queue: [], bug: { visible: false, speed: 100 }, saveBlocked: `Replays unavailable: ${reason}`, playBlocked: `Replays unavailable: ${reason}` };
  return Object.assign(e, {
    start() {}, stop() {}, goalDisallowed() {},
    publicStatus: () => status,
    handle: async () => { throw new Error(`Replays unavailable: ${reason}`); },
  });
}
