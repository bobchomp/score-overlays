// Pre-match health check against simulated OBS setups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ObsLink } from '../server/obs.js';
import { Replays } from '../server/replays.js';
import { runHealth, refreshOverlayInObs } from '../server/health.js';
import { startMockObs } from './helpers/mock-obs.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await wait(25); } throw new Error('timeout'); }
const byId = (rep, id) => rep.items.find(i => i.id === id);

async function rig(browserSources, { replayUp = true, sceneExtras = {}, specialInputs = {} } = {}) {
  const main = startMockObs({ port: 48455, browserSources, sceneExtras, specialInputs });
  const rep = replayUp ? startMockObs({ port: 48456 }) : null;
  await main.ready; if (rep) await rep.ready;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));
  const obs = new ObsLink({ url: 'ws://127.0.0.1:48455' }, { mainScene: 'Main' }, 'Main OBS');
  const replays = new Replays({ mainObs: obs, mainDefault: { url: 'ws://127.0.0.1:48455' }, file: path.join(dir, 'r.json') });
  replays.settings.replay.url = 'ws://127.0.0.1:48456';
  replays.replayObs.url = replays.settings.replay.url;
  obs.start(); replays.start();
  await until(() => obs.status.connected && (!replayUp || replays.status.bufferActive));
  const close = async () => { replays.stop(); await obs.stop(); await main.close(); await rep?.close(); };
  return { main, obs, replays, close };
}

const env = { port: 3080, generatedPin: false };
const good = { 'Match Graphics': { url: 'http://localhost:3080/overlay', width: 1920, height: 1080, scenes: { Main: 'top', REPLAY: 'top' } } };
const overlayPage = (build = 'B1') => [{ role: 'overlay', page: 'overlay', build, width: 1920, height: 1080 }];

test('all good', async t => {
  const r = await rig(good); t.after(r.close);
  const rep = await runHealth({ env, obs: r.obs, replays: r.replays, clients: () => overlayPage(), build: 'B1', commit: 'abc1234', startedAt: Date.now() });
  const bad = rep.items.filter(i => i.status !== 'ok');
  assert.deepEqual(bad, [], JSON.stringify(bad, null, 1));
  assert.equal(rep.status, 'ok');
  assert.match(byId(rep, 'disk').detail, /GB free/);
});

test('catches the usual setup mistakes, each with a fix', async t => {
  const r = await rig({ 'Match Graphics': { url: 'http://localhost:3000/overlay', width: 1280, height: 720, shutdown: true, scenes: { Main: 'below' } } });
  t.after(r.close);
  const rep = await runHealth({
    env: { port: 3080, generatedPin: true }, obs: r.obs, replays: r.replays,
    clients: () => [{ role: 'overlay', page: 'overlay', build: 'OLD', width: 1280, height: 720 }], build: 'B2', commit: null, startedAt: Date.now(),
  });
  assert.equal(rep.status, 'bad');
  assert.equal(byId(rep, 'pin').status, 'warn');
  assert.equal(byId(rep, 'overlay').status, 'warn');
  assert.equal(byId(rep, 'overlay').action, 'refreshOverlay', 'offers the refresh button for an old overlay');
  assert.equal(byId(rep, 'overlay-size').status, 'warn');
  const src = byId(rep, 'obs-source');
  assert.equal(src.status, 'bad');
  assert.match(src.detail, /port 3000, but the server is on 3080/);
  assert.match(src.detail, /1280×720/);
  assert.match(src.detail, /Shutdown source when not visible/);
  assert.match(byId(rep, 'top-live scene').detail, /not at the top/);
  assert.match(byId(rep, 'top-replay scene').detail, /isn't in "REPLAY"/);
});

test('no overlay page connected, replay OBS down', async t => {
  const r = await rig(good, { replayUp: false }); t.after(r.close);
  const rep = await runHealth({ env, obs: r.obs, replays: r.replays, clients: () => [], build: 'B1', startedAt: Date.now() });
  assert.equal(byId(rep, 'overlay').status, 'bad');
  assert.match(byId(rep, 'overlay').fix, /localhost:3080\/overlay/);
  assert.equal(byId(rep, 'replay-obs').status, 'bad');
});

test('main OBS not running: clear message, no crash', async () => {
  const obs = new ObsLink({ url: 'ws://127.0.0.1:48499' }, {}, 'Main OBS');
  obs.status.error = 'OBS not running or WebSocket server disabled';
  const rep = await runHealth({ env, obs, replays: null, clients: () => overlayPage(), build: 'B1', startedAt: Date.now() });
  assert.equal(byId(rep, 'main-obs').status, 'bad');
  assert.match(byId(rep, 'main-obs').fix, /WebSocket/);
});

test('refresh overlay fix presses "Refresh cache of current page" in OBS', async t => {
  const r = await rig(good); t.after(r.close);
  assert.equal(await refreshOverlayInObs(r.obs), 1);
  assert.deepEqual(r.main.st.pressed, [['Match Graphics', 'refreshnocache']]);
});

test('live sound: warns when a live audio source would go silent during replays, and the fix adds it under the replay', async t => {
  const r = await rig(good, { sceneExtras: {
    Main: [
      { name: 'ATEM USB', kind: 'dshow_input' },                 // live picture + sound: only in Main
      { name: 'Commentary mic', kind: 'wasapi_input_capture' },  // audio input in the scene
      { name: 'Muted thing', kind: 'wasapi_input_capture', muted: true },
      { name: 'Sponsor video', kind: 'ffmpeg_source' },          // a clip, not live sound
    ],
  } });
  t.after(r.close);
  const run = () => runHealth({ env, obs: r.obs, replays: r.replays, clients: () => overlayPage(), build: 'B1', startedAt: Date.now() });
  let rep = await run();
  const it = byId(rep, 'live-audio');
  assert.equal(it.status, 'warn');
  assert.match(it.detail, /Stops during replays: "ATEM USB", "Commentary mic"\./);
  assert.match(it.detail, /Video files in "Main" also go quiet \(usually fine\): "Sponsor video"/);
  assert.equal(it.action, 'addLiveAudio');
  const { addLiveAudioToReplay } = await import('../server/health.js');
  assert.equal(await addLiveAudioToReplay(r.obs, r.replays), 2);
  assert.deepEqual(r.main.st.created, [['REPLAY', 'ATEM USB'], ['REPLAY', 'Commentary mic']]);
  assert.ok(r.main.st.reordered.every(([, , idx]) => idx === 0), 'put at the bottom, hidden behind the replay');
  rep = await run();
  assert.equal(byId(rep, 'live-audio').status, 'ok');
  assert.match(byId(rep, 'live-audio').detail, /Heard during replays: .*"ATEM USB".*plus the replay at 50%/);
  assert.match(byId(rep, 'live-audio').detail, /Stops during replays: none/);
});

test('live sound: global devices, groups, nested scenes, browser sources with OBS audio', async t => {
  const r = await rig({
    ...good,
    'time.is': { url: 'https://time.is', width: 1920, height: 1080, scenes: { Main: 'below' } },          // no OBS audio: ignored
    'Web stream': { url: 'https://example.com/stream', reroute_audio: true, width: 1920, height: 1080 },   // OBS audio: counts
  }, {
    specialInputs: { desktop1: 'Desktop Audio', mic1: 'Mic/Aux' },
    sceneExtras: {
      Main: [
        { name: 'Cameras', group: [{ name: 'ATEM USB', kind: 'dshow_input' }, { name: 'Still', kind: 'image_source' }] },
        { name: 'Audio scene', scene: true },
        { name: 'Web stream', kind: 'browser_source' },
        { name: 'Hidden cam', kind: 'dshow_input', enabled: false },
      ],
      'Audio scene': [{ name: 'Crowd mic', kind: 'wasapi_input_capture' }],
    },
  });
  t.after(r.close);
  const rep = await runHealth({ env, obs: r.obs, replays: r.replays, clients: () => overlayPage(), build: 'B1', startedAt: Date.now() });
  const it = byId(rep, 'live-audio');
  assert.equal(it.status, 'warn');
  assert.match(it.detail, /Heard during replays: Desktop Audio \(global\), Mic\/Aux \(global\)/);
  assert.match(it.detail, /"ATEM USB" \(in group "Cameras"\)/, 'looks inside groups');
  assert.match(it.detail, /"Crowd mic" \(in scene "Audio scene"\)/, 'looks inside nested scenes');
  assert.match(it.detail, /"Web stream"/, 'browser source with OBS audio counts');
  assert.doesNotMatch(it.detail, /time\.is|Match Graphics|Hidden cam|Still/, 'silent browser sources, the overlay, hidden items and pictures are ignored');
});

test('live sound: only global audio -> green with the reason', async t => {
  const r = await rig(good, { specialInputs: { mic1: 'Mic/Aux' } });
  t.after(r.close);
  const rep = await runHealth({ env, obs: r.obs, replays: r.replays, clients: () => overlayPage(), build: 'B1', startedAt: Date.now() });
  const it = byId(rep, 'live-audio');
  assert.equal(it.status, 'ok');
  assert.match(it.detail, /Heard during replays: Mic\/Aux \(global\)/);
});

test('pre-match check: lineups and kit colours', async () => {
  const { lineupChecks } = await import('../server/health.js');
  const team = (name, primary, lineup) => ({ id: name.toLowerCase(), name, colors: { primary }, lineup });
  const ids = Array.from({ length: 11 }, (_, i) => `p${i}`);
  const good = { starting: ids, captain: 'p5', formation: '4-4-2', slots: ids };
  let r = lineupChecks({ teams: { home: team('Ross', '#0b1f5c', good), away: team('Ayr', '#c8102e', good) } });
  assert.deepEqual(r.map(i => i.status), ['ok', 'ok']);
  r = lineupChecks({ teams: { home: team('Ross', '#0b1f5c', { starting: ids.slice(0, 10), formation: null }), away: team('Ayr', '#0c2060', good) } });
  assert.equal(r[0].status, 'warn');
  assert.match(r[0].detail, /10 players.*no captain.*no formation/i);
  assert.equal(r.find(i => i.id === 'kits')?.status, 'warn', 'similar blues flagged');
  r = lineupChecks({ teams: { home: { id: null, lineup: {} }, away: team('Ayr', '#c8102e', good) } });
  assert.equal(r[0].id, 'teams');
});
