// A fingerprint of the page files (overlay, dock, setup). Pages remember the fingerprint they
// loaded with; if the server comes back with a different one after an update, they reload
// themselves, and the health check can tell when OBS is still showing an old overlay.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, PUBLIC_DIR } from './config.js';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'assets') walk(p, out); } else if (/\.(js|css|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

export function computeBuild() {
  const h = crypto.createHash('sha1');
  for (const f of walk(PUBLIC_DIR).sort()) {
    h.update(path.relative(PUBLIC_DIR, f).replace(/\\/g, '/'));
    h.update(fs.readFileSync(f));
  }
  return h.digest('hex').slice(0, 10);
}

/** Current git commit (read straight from .git, no git needed), or null. */
export function gitCommit() {
  try {
    const gitDir = path.join(ROOT, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head.slice(0, 7);
    const ref = head.slice(5).trim();
    const refFile = path.join(gitDir, ref);
    if (fs.existsSync(refFile)) return fs.readFileSync(refFile, 'utf8').trim().slice(0, 7);
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find(l => l.endsWith(` ${ref}`));
    return line ? line.slice(0, 7) : null;
  } catch { return null; }
}
