// Highlights reel: stitches replay clips into one MP4 with ffmpeg.
// Runs as a separate low-priority process (limited threads) so it can't starve OBS, and can be cancelled.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

let ffmpegStatic = null;
try { ffmpegStatic = (await import('ffmpeg-static')).default; } catch {}

/** ffmpeg to use: FFMPEG_PATH, else the bundled ffmpeg-static binary, else "ffmpeg" on PATH. */
export function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  if (ffmpegStatic && fs.existsSync(ffmpegStatic)) return ffmpegStatic;
  return 'ffmpeg';
}

function run(args, { onLine, onStart } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpegPath(), args, { windowsHide: true });
    } catch (err) { return reject(err); }
    let stderr = '';
    let buf = '';
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine?.(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', d => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
    child.on('error', err => reject(err.code === 'ENOENT'
      ? new Error('ffmpeg is not installed. Run update.bat (or "npm install") to get it.') : err));
    child.on('close', code => resolve({ code, stderr }));
    onStart?.(child);
  });
}

/** Duration (s), whether there's audio, and the frame rate of a video file. */
export async function probe(file) {
  const { stderr } = await run(['-hide_banner', '-i', file]);
  const d = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null;
  const fps = Number((stderr.match(/,\s*(\d+(?:\.\d+)?)\s*fps/) || [])[1]) || null;
  return { duration, hasAudio: /Stream #.*Audio:/.test(stderr), fps };
}

/**
 * Build the reel.
 * @param {object} o
 * @param {string[]} o.files        clip files, in order
 * @param {number|null} o.tailSec   use only the last N seconds of each clip (null = whole clip)
 * @param {boolean} o.fade          fade through black between clips
 * @param {string} o.out            output .mp4 path
 * @param {(pct:number)=>void} [o.onProgress]
 * @param {(child)=>void} [o.onChild]  gets the ffmpeg process (to cancel it)
 */
export async function buildReel({ files, tailSec = null, fade = true, out, onProgress, onChild }) {
  const clips = [];
  for (const file of files) {
    const p = await probe(file);
    if (!p.duration || p.duration < 0.3) continue; // unreadable or empty: skip
    const len = tailSec ? Math.min(tailSec, p.duration) : p.duration;
    clips.push({ file, ...p, start: Math.max(0, p.duration - len), len });
  }
  if (!clips.length) throw new Error('None of the clips could be read');
  const fps = Math.round(clips[0].fps || 30);
  const F = fade ? Math.min(0.4, ...clips.map(c => c.len / 4)) : 0; // fade length

  const args = ['-hide_banner', '-y'];
  clips.forEach(c => { args.push('-ss', c.start.toFixed(3), '-t', c.len.toFixed(3), '-i', c.file); });
  const parts = [];
  const chain = [];
  clips.forEach((c, i) => {
    // setpts first: resetting timestamps after fps= would lose the frame rate (ffmpeg falls back to 25)
    const vf = [
      'setpts=PTS-STARTPTS', 'scale=1920:1080:force_original_aspect_ratio=decrease', 'pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
      'setsar=1', `fps=${fps}`, 'format=yuv420p',
    ];
    if (F) vf.push(`fade=t=in:st=0:d=${F}`, `fade=t=out:st=${(c.len - F).toFixed(3)}:d=${F}`);
    parts.push(`[${i}:v]${vf.join(',')}[v${i}]`);
    const af = c.hasAudio
      ? [`[${i}:a]aresample=48000`, 'aformat=channel_layouts=stereo', 'asetpts=PTS-STARTPTS']
      : [`anullsrc=r=48000:cl=stereo`, `atrim=duration=${c.len.toFixed(3)}`];
    if (F) af.push(`afade=t=in:st=0:d=${F}`, `afade=t=out:st=${(c.len - F).toFixed(3)}:d=${F}`);
    parts.push(`${af.join(',')}[a${i}]`);
    chain.push(`[v${i}][a${i}]`);
  });
  parts.push(`${chain.join('')}concat=n=${clips.length}:v=1:a=1[v][a]`);
  const total = clips.reduce((t, c) => t + c.len, 0);
  args.push(
    '-filter_complex', parts.join(';'), '-map', '[v]', '-map', '[a]',
    '-r', String(fps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
    '-threads', String(Math.max(1, Math.min(4, Math.floor(os.cpus().length / 3)))),
    '-progress', 'pipe:1', '-nostats', out,
  );

  const res = await run(args, {
    onStart(child) {
      // Below-normal priority so the stream always wins the CPU.
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
      onChild?.(child);
    },
    onLine(line) {
      const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
      if (m && total) onProgress?.(Math.min(99, Math.round((Number(m[1]) / 1e6 / total) * 100)));
    },
  });
  if (res.code !== 0) {
    try { fs.rmSync(out, { force: true }); } catch {}
    if (res.code === null || res.code === 255) throw new Error('Cancelled');
    const tail = res.stderr.trim().split('\n').slice(-3).join(' ');
    throw new Error(`ffmpeg failed: ${tail}`);
  }
  onProgress?.(100);
  return { out, clips: clips.length, seconds: total, skipped: files.length - clips.length };
}
