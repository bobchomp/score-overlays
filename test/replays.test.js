// End-to-end tests for the replay module against two fake OBS instances.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ObsLink } from '../server/obs.js';
import { Replays } from '../server/replays.js';
import { startMockObs } from './helpers/mock-obs.js';

const MAIN_PORT = 47455;
const REPLAY_PORT = 47456;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < ms) { if (await fn()) return; await wait(25); }
  throw new Error(`timed out waiting for ${label}`);
}

let main, rep, mainObs, replays, dir;

async function setup(mockOpts = {}) {
  main = startMockObs({ port: MAIN_PORT, mediaDurationMs: 2600, ...mockOpts.main });
  rep = startMockObs({ port: REPLAY_PORT, ...mockOpts.replay });
  await Promise.all([main.ready, rep.ready]);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replays-test-'));
  mainObs = new ObsLink({ url: `ws://127.0.0.1:${MAIN_PORT}` }, { mainScene: 'Main' }, 'Main OBS');
  replays = new Replays({
    mainObs,
    mainDefault: { url: `ws://127.0.0.1:${MAIN_PORT}` },
    getMinute: () => '23',
    file: path.join(dir, 'replays.json'),
  });
  replays.settings.replay.url = `ws://127.0.0.1:${REPLAY_PORT}`;
  replays.replayObs.url = replays.settings.replay.url;
  replays.settings.lengthSec = 2;
  replays.settings.stinger.mode = 'obs'; // most tests use an OBS Stinger transition; the graphics wipe is tested separately
  mainObs.start();
  replays.start();
  await until(() => mainObs.status.connected && replays.replayObs.status.connected && replays.status.bufferActive === true, 4000, 'connections');
}

async function teardown() {
  replays?.stop(); await mainObs?.stop();
  await main?.close(); await rep?.close();
}

const idle = () => until(() => !replays.status.playing && !replays.status.saving, 8000, 'replay to finish');

test('replay flow', async t => {
  await setup({ replay: { bufferActive: false } });
  t.after(teardown);

  await t.test('starts a stopped Replay Buffer on connect and warns', () => {
    assert.equal(rep.calls('StartReplayBuffer').length, 1);
    assert.match(replays.notice.text, /was not running/);
  });

  await t.test('REPLAY 100%: save, stinger to REPLAY, seek to last N s, bug, back to the previous scene', async () => {
    main.st.program = 'Wide';
    main.st.transition = 'Fade';
    const r = await replays.handle('now', { speed: 100 });
    assert.equal(r.ok, true);
    assert.equal(replays.queue.length, 1, 'clip added to queue');
    assert.equal(replays.queue[0].label, '', 'REPLAY clips are unlabelled');
    await until(() => main.st.program === 'REPLAY', 2000, 'REPLAY scene');
    await until(() => replays.status.bug.visible, 2000, 'bug');
    const set = main.calls('SetInputSettings').at(-1).requestData;
    assert.equal(set.inputName, 'Replay Player');
    assert.equal(set.inputSettings.local_file, replays.queue[0].path);
    assert.equal(set.inputSettings.speed_percent, 100);
    assert.equal(set.inputSettings.is_local_file, true);
    const sceneSwitch = main.calls('SetCurrentProgramScene').find(c => c.requestData.sceneName === 'REPLAY');
    assert.equal(sceneSwitch.transition, 'Replay Stinger', 'stinger used on the way in');
    assert.equal(main.calls('SetMediaInputCursor').at(-1).requestData.mediaCursor, 600, '2600ms clip, last 2s');
    await idle();
    assert.equal(main.st.program, 'Wide', 'back to the scene that was live');
    assert.equal(main.st.transition, 'Fade', 'previous transition restored');
    assert.equal(replays.status.bug.visible, false);
    const back = main.calls('SetCurrentProgramScene').at(-1);
    assert.equal(back.transition, 'Replay Stinger', 'stinger used on the way out');
  });

  await t.test('REPLAY 50% plays at half speed', async () => {
    replays.settings.slowSpeed = 50;
    await replays.handle('now', { speed: 'slow' });
    await until(() => main.st.program === 'REPLAY', 2000, 'REPLAY scene');
    assert.equal(main.calls('SetInputSettings').at(-1).requestData.inputSettings.speed_percent, 50);
    assert.equal(replays.status.bug.speed, 50);
    await idle();
  });

  await t.test('MARK saves without changing program, labels with time and minute, and can tag', async () => {
    const before = main.calls('SetCurrentProgramScene').length;
    const r = await replays.handle('mark', { tag: 'Goal' });
    assert.equal(r.ok, true);
    assert.match(r.clip.label, /^\d\d:\d\d:\d\d · 23'$/);
    assert.equal(r.clip.tag, 'Goal');
    assert.equal(main.calls('SetCurrentProgramScene').length, before, 'program untouched');
  });

  await t.test('rapid double tap: second press is ignored while saving', async () => {
    const [a, b] = await Promise.all([replays.handle('now', { speed: 100 }), replays.handle('now', { speed: 100 })]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    assert.equal(b.busy, true);
    await until(() => replays.status.playing, 2000, 'playing');
  });

  await t.test('REPLAY during a replay queues the clip instead of interrupting', async () => {
    const before = replays.queue.length;
    const playingClip = replays.status.playing.clipId;
    const r = await replays.handle('now', { speed: 100 });
    assert.equal(r.queued, true);
    assert.equal(replays.queue.length, before + 1);
    assert.equal(replays.status.playing?.clipId, playingClip, 'still playing the original clip');
    await idle();
  });

  await t.test('ABORT goes back to the previous scene through the stinger and stops the clip', async () => {
    main.st.program = 'Main';
    await replays.handle('now', { speed: 50 });
    await until(() => replays.status.bug.visible, 2000, 'bug');
    const mark = main.st.log.length;
    const t0 = Date.now();
    replays.handle('abort');
    await idle();
    assert.ok(Date.now() - t0 < 1500, 'quick');
    const log = main.st.log.slice(mark);
    const back = log.find(l => l.requestType === 'SetCurrentProgramScene');
    assert.equal(back.requestData.sceneName, 'Main');
    assert.equal(back.transition, 'Replay Stinger', 'stinger used on abort');
    assert.ok(log.some(l => l.requestType === 'TriggerMediaInputAction'), 'clip stopped');
    assert.equal(main.st.program, 'Main');
    assert.equal(main.st.transition, 'Fade', 'normal transition restored');
    assert.equal(replays.status.bug.visible, false);
  });

  await t.test('ABORT with the graphics wipe: wipes back, and pressed during the wipe-in it never cuts to REPLAY', async () => {
    replays.settings.stinger.mode = 'overlay';
    main.st.program = 'Main';
    // abort while on air
    await replays.handle('now', { speed: 50 });
    await until(() => replays.status.bug.visible, 3000, 'bug');
    const before = replays.status.wipe.id;
    const mark = main.st.log.length;
    replays.handle('abort');
    await until(() => replays.status.wipe.id !== before, 500, 'wipe starts at once');
    const wipeAt = replays.status.wipe.at;
    await idle();
    const back = main.st.log.slice(mark).find(l => l.requestType === 'SetCurrentProgramScene');
    assert.equal(back.requestData.sceneName, 'Main');
    assert.equal(back.transition, 'Cut');
    assert.ok(back.at - wipeAt >= 550, 'cut hidden under the wipe');
    // abort during the wipe-in
    const mark2 = main.st.log.length;
    await replays.handle('now', { speed: 100 });
    await until(() => replays.status.wipe && Date.now() - replays.status.wipe.at < 300 && replays.status.playing, 3000, 'wipe-in');
    replays.handle('abort');
    await idle();
    assert.equal(main.st.log.slice(mark2).filter(l => l.requestType === 'SetCurrentProgramScene').length, 0, 'never left the live scene');
    assert.equal(main.st.program, 'Main');
    assert.equal(main.st.transition, 'Fade');
    assert.equal(replays.status.bug.visible, false);
    replays.settings.stinger.mode = 'obs';
  });

  await t.test('switching scenes manually in OBS mid-replay ends it without switching back', async () => {
    main.st.program = 'Main';
    await replays.handle('now', { speed: 50 });
    await until(() => replays.status.bug.visible, 2000, 'bug');
    // simulate the operator clicking "Wide" in OBS
    main.st.program = 'Wide';
    for (const c of main.st.clients) c.send((await import('@msgpack/msgpack')).encode({ op: 5, d: { eventType: 'CurrentProgramSceneChanged', eventIntent: 4, eventData: { sceneName: 'Wide' } } }));
    await idle();
    assert.equal(main.st.program, 'Wide', 'left where the operator put it');
    assert.equal(replays.status.bug.visible, false);
    assert.equal(main.st.transition, 'Fade', 'transition restored');
    assert.match(replays.notice.text, /switched to "Wide"/);
  });

  await t.test('queue: rename, tag, reorder, delete, and it persists to disk', async () => {
    const [c1, c2] = replays.queue;
    await replays.handle('rename', { id: c1.id, label: 'Great save' });
    await replays.handle('tag', { id: c1.id, tag: 'Save' });
    await replays.handle('move', { id: c2.id, dir: -1 });
    assert.equal(replays.queue[0].id, c2.id);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'replays.json'), 'utf8'));
    assert.equal(saved.queue[1].label, 'Great save');
    assert.equal(saved.queue[1].tag, 'Save');
    const n = replays.queue.length;
    await replays.handle('delete', { id: c2.id });
    assert.equal(replays.queue.length, n - 1);
  });

  await t.test('Play all without a second scene: stinger in, clips back to back, stinger out', async () => {
    replays.queue = replays.queue.slice(0, 2);
    main.st.program = 'Main';
    const mark = main.st.log.length;
    await replays.handle('playAll', { speed: 100 });
    await idle();
    const log = main.st.log.slice(mark);
    assert.deepEqual(log.filter(l => l.requestType === 'SetInputSettings').map(l => l.requestData.inputSettings.local_file), replays.queue.map(c => c.path));
    assert.deepEqual(log.filter(l => l.requestType === 'SetCurrentProgramScene').map(l => l.requestData.sceneName), ['REPLAY', 'Main']);
  });

  await t.test('Play all plays the queue in order, alternating scenes so the stinger runs between clips', async () => {
    while (replays.queue.length < 3) replays.addClip(replays.queue[0].path);
    replays.queue = replays.queue.slice(0, 3);
    replays.settings.names.sceneB = 'REPLAY B';
    replays.settings.names.playerB = 'Replay Player B';
    main.st.program = 'Main';
    const mark = main.st.log.length;
    await replays.handle('playAll', { speed: 100 });
    await idle();
    const sets = main.st.log.slice(mark).filter(l => l.requestType === 'SetInputSettings').map(l => l.requestData.inputSettings.local_file);
    assert.deepEqual(sets, replays.queue.map(c => c.path), 'in queue order');
    const scenes = main.st.log.slice(mark).filter(l => l.requestType === 'SetCurrentProgramScene').map(l => [l.requestData.sceneName, l.transition]);
    assert.deepEqual(scenes, [['REPLAY', 'Replay Stinger'], ['REPLAY B', 'Replay Stinger'], ['REPLAY', 'Replay Stinger'], ['Main', 'Replay Stinger']]);
    assert.equal(main.st.transition, 'Fade');
  });

  await t.test('missing replay scene: clear error, program untouched', async () => {
    replays.settings.names.scene = 'NOPE';
    main.st.program = 'Main';
    await replays.handle('playAll', { speed: 100 });
    await idle();
    assert.match(replays.notice.text, /Scene "NOPE" not found/);
    assert.equal(main.st.program, 'Main');
    replays.settings.names.scene = 'REPLAY';
  });

  await t.test('missing file on disk: error, no switch', async () => {
    const c = replays.addClip(path.join(dir, 'does-not-exist.mkv'));
    await replays.handle('play', { id: c.id, speed: 100 });
    await idle();
    assert.match(replays.notice.text, /missing/);
    assert.equal(main.st.program, 'Main');
  });

  await t.test('save timeout falls back to GetLastReplayBufferReplay', async () => {
    rep.st.emitSaved = false;
    replays.settings.saveTimeoutMs = 300;
    const r = await replays.handle('mark', {});
    assert.equal(r.ok, true);
    assert.ok(rep.calls('GetLastReplayBufferReplay').length >= 1);
    assert.equal(r.clip.path, rep.st.lastReplay);
  });

  await t.test('save timeout with no new file reports an error', async () => {
    // The next save "fails": OBS never reports a file and the last replay is one we already have.
    const origLast = rep.st.lastReplay;
    const saveCalls = rep.calls('SaveReplayBuffer').length;
    const p = replays.handle('mark', {});
    await until(() => rep.calls('SaveReplayBuffer').length > saveCalls, 1000, 'save call');
    await wait(80);
    rep.st.lastReplay = origLast;
    await assert.rejects(p, /timed out/);
    rep.st.emitSaved = true;
    replays.settings.saveTimeoutMs = 5000;
  });

  await t.test('graphics wipe: overlay wipes, OBS cuts underneath at the switch point, then restores the transition', async () => {
    replays.settings.stinger.mode = 'overlay';
    replays.settings.names.sceneB = ''; replays.settings.names.playerB = '';
    main.st.program = 'Main';
    main.st.transition = 'Fade';
    const wipes = [];
    const earlier = replays.status.wipe?.id; // left over from previous tests
    const onChange = () => { const w = replays.status.wipe; if (w && w.id !== earlier && w.id !== wipes.at(-1)?.id) wipes.push({ ...w }); };
    replays.on('change', onChange);
    const mark = main.st.log.length;
    while (replays.queue.length < 2) replays.addClip(replays.queue[0].path);
    replays.queue = replays.queue.slice(0, 2);
    await replays.handle('playAll', { speed: 100 });
    await idle();
    replays.off('change', onChange);
    const log = main.st.log.slice(mark);
    const switches = log.filter(l => l.requestType === 'SetCurrentProgramScene');
    assert.deepEqual(switches.map(l => [l.requestData.sceneName, l.transition]), [['REPLAY', 'Cut'], ['Main', 'Cut']], 'cuts only, no OBS stinger');
    assert.equal(wipes.length, 3, 'wipe in, between the two clips, and out');
    assert.ok(switches[0].at - wipes[0].at >= 550, 'cut happens while the wipe covers the screen');
    assert.ok(switches[1].at - wipes[2].at >= 550);
    const loads = log.filter(l => l.requestType === 'SetInputSettings');
    assert.equal(loads.length, 2);
    assert.ok(loads[1].at - wipes[1].at >= 550, 'second clip swapped under the wipe');
    assert.equal(main.st.program, 'Main');
    assert.equal(main.st.transition, 'Fade', 'operator transition restored');
    assert.equal(replays.publicStatus().wipe.id, wipes[2].id, 'overlay gets the wipe in the status');
    replays.settings.stinger.mode = 'obs';
  });

  await t.test('wipe speed setting scales the wipe and the hidden cut', async () => {
    const { wipeTiming } = await import('../server/replays.js');
    assert.deepEqual(wipeTiming(2000), { totalMs: 2000, switchAtMs: 920 });
    assert.deepEqual(wipeTiming(100), { totalMs: 600, switchAtMs: 276 }, 'clamped to the minimum');
    replays.updateSettings({ stinger: { durationMs: 2000 } });
    replays.settings.stinger.mode = 'overlay';
    main.st.program = 'Main';
    const mark = main.st.log.length;
    await replays.handle('play', { id: replays.queue[0].id, speed: 100 });
    await until(() => replays.status.wipe?.totalMs === 2000, 2000, 'slow wipe');
    const w = { ...replays.status.wipe };
    await until(() => main.st.program === 'REPLAY', 3000, 'cut to REPLAY');
    const cut = main.st.log.slice(mark).find(l => l.requestType === 'SetCurrentProgramScene');
    assert.ok(cut.at - w.at >= 900, 'cut waits for the longer wipe to cover the screen');
    await idle();
    replays.updateSettings({ stinger: { durationMs: 1300 } });
    replays.settings.stinger.mode = 'obs';
  });

  await t.test('Replay OBS closed: replay buttons blocked with a reason; nothing else affected', async () => {
    await rep.close();
    await until(() => !replays.replayObs.status.connected, 3000, 'disconnect');
    assert.match(replays.publicStatus().saveBlocked, /Replay OBS not connected/);
    await assert.rejects(replays.handle('now', { speed: 100 }), /Replay OBS not connected/);
    assert.equal(mainObs.status.connected, true, 'main OBS still fine');
    rep = startMockObs({ port: REPLAY_PORT });
    await rep.ready;
    await until(() => replays.replayObs.status.connected, 8000, 'auto-reconnect');
    assert.equal(replays.publicStatus().saveBlocked, null);
  });
});

test('if the replay module cannot start, a stand-in reports why and graphics carry on', async () => {
  const { disabledReplays } = await import('../server/replays.js');
  const r = disabledReplays('boom');
  assert.match(r.publicStatus().saveBlocked, /boom/);
  await assert.rejects(r.handle('now', {}), /Replays unavailable: boom/);
});
