// Highlights reel: real ffmpeg on generated test clips, and the full flow through the replay module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildReel, probe, ffmpegPath } from '../server/highlights.js';
import { ObsLink } from '../server/obs.js';
import { Replays } from '../server/replays.js';
import { startMockObs } from './helpers/mock-obs.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-'));
function makeClip(name, { size = '1920x1080', rate = 50, dur = 5, audio = true } = {}) {
  const f = path.join(dir, name);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${dur}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', ...(audio ? ['-c:a', 'aac'] : []), f);
  const r = spawnSync(ffmpegPath(), args);
  assert.equal(r.status, 0, String(r.stderr));
  return f;
}
const frames = f => {
  const r = spawnSync(ffmpegPath(), ['-hide_banner', '-i', f, '-map', '0:v', '-f', 'null', '-'], { encoding: 'utf8' });
  return Number((r.stderr.match(/frame=\s*(\d+)/g) || []).pop()?.match(/\d+/)[0]);
};

test('reel: last N seconds of each clip, mixed sizes/rates/audio, unreadable files skipped', async () => {
  const a = makeClip('a.mkv');
  const b = makeClip('b.mkv', { size: '1280x720', rate: 25, audio: false });
  const out = path.join(dir, 'reel.mp4');
  const progress = [];
  const r = await buildReel({ files: [a, b, path.join(dir, 'missing.mkv')], tailSec: 2, fade: true, out, onProgress: p => progress.push(p) });
  assert.equal(r.clips, 2);
  assert.equal(r.skipped, 1);
  const p = await probe(out);
  assert.ok(Math.abs(p.duration - 4) < 0.15, `duration ${p.duration}`);
  assert.equal(p.hasAudio, true, 'silent clip gets silence so audio stays in sync');
  assert.equal(p.fps, 50);
  assert.ok(Math.abs(frames(out) - 200) <= 3, 'really 50 fps');
  assert.equal(progress.at(-1), 100);
});

test('reel: whole clips', async () => {
  const a = makeClip('w.mkv', { dur: 3 });
  const out = path.join(dir, 'whole.mp4');
  await buildReel({ files: [a, a], tailSec: null, fade: false, out });
  assert.ok(Math.abs((await probe(out)).duration - 6) < 0.15);
});

test('replay module: makes the reel from the queue into a Highlights folder, asks first while streaming', async t => {
  const src = makeClip('cam.mkv', { dur: 4 });
  const main = startMockObs({ port: 49455, streaming: true });
  const rep = startMockObs({ port: 49456, replayFile: src });
  await Promise.all([main.ready, rep.ready]);
  const obs = new ObsLink({ url: 'ws://127.0.0.1:49455' }, {}, 'Main OBS');
  const replays = new Replays({
    mainObs: obs, mainDefault: { url: 'ws://127.0.0.1:49455' }, file: path.join(dir, 'r.json'),
    getMatch: () => ({ home: 'Ross County', away: 'Hillcrest Athletic' }), getTimerMinute: () => '23',
  });
  replays.settings.replay.url = 'ws://127.0.0.1:49456';
  replays.replayObs.url = replays.settings.replay.url;
  replays.settings.lengthSec = 2;
  obs.start(); replays.start();
  t.after(async () => { replays.stop(); await obs.stop(); await main.close(); await rep.close(); });
  const until = async (fn, ms = 20000) => { const s = Date.now(); while (Date.now() - s < ms) { if (fn()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('timeout'); };
  await until(() => obs.status.connected && replays.status.bufferActive);

  await replays.mark('Goal', { label: 'Ross County 1' });
  await replays.mark('Chance');
  await replays.mark('Goal', { label: 'Hillcrest Athletic 1' });

  const r1 = await replays.handle('highlights', { only: 'goals' });
  assert.equal(r1.needsConfirm, true, 'asks first while OBS is streaming');
  const r2 = await replays.handle('highlights', { only: 'goals', force: true });
  assert.equal(r2.clips, 2);
  await until(() => !replays.reel.running);
  assert.equal(replays.reel.error, null);
  assert.match(path.basename(replays.reel.file), /^Ross County v Hillcrest Athletic - highlights \d{4}-\d\d-\d\d\.mp4$/);
  assert.equal(path.basename(path.dirname(replays.reel.file)), 'Highlights');
  assert.ok(Math.abs((await probe(replays.reel.file)).duration - 4) < 0.2, 'two goal clips x 2s');
  assert.equal(replays.publicStatus().reel.percent, 100);

  // deleting the reel in Explorer clears it from the dock
  fs.rmSync(replays.reel.file);
  replays.checkReelFile();
  assert.equal(replays.publicStatus().reel.file, null);
});
