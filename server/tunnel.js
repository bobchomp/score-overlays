// Remote access through a Cloudflare Tunnel (optional).
// If .env has CLOUDFLARE_TUNNEL_TOKEN, the server starts `cloudflared` alongside itself and stops it when it
// stops, so start.bat and update.bat need nothing extra. The tunnel (and its public address) is set up once
// in the Cloudflare dashboard; see README "Remote access". Problems here never affect the graphics.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const WINDOWS_PATHS = [
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe',
];

export class Tunnel extends EventEmitter {
  constructor({ token, binary, publicUrl, pidFile, argsPrefix = [] }) {
    super();
    this.token = String(token || '').trim();
    this.binary = binary;
    this.publicUrl = publicUrl || '';
    this.pidFile = pidFile;
    this.argsPrefix = argsPrefix; // tests run a stand-in cloudflared script through node
    this.child = null;
    this.stopping = false;
    this.retryMs = 5000;
    this.status = { enabled: !!this.token, state: this.token ? 'starting' : 'off', connections: 0, error: null, url: this.publicUrl };
  }

  /** The cloudflared program: CLOUDFLARED_PATH, then PATH, then where the Windows installer puts it. */
  findBinary() {
    if (this.binary) return this.binary;
    if (process.platform === 'win32') {
      const found = WINDOWS_PATHS.find(p => fs.existsSync(p));
      if (found) return found;
    }
    return 'cloudflared';
  }

  start() {
    if (!this.token) return;
    this.killOrphan();
    this.launch();
  }

  launch() {
    if (this.stopping) return;
    const bin = this.findBinary();
    // The token goes in the environment (TUNNEL_TOKEN), not on the command line where other programs can see it.
    const child = spawn(bin, [...this.argsPrefix, 'tunnel', '--no-autoupdate', 'run'], {
      env: { ...process.env, TUNNEL_TOKEN: this.token },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.set({ state: 'starting', connections: 0 });
    child.on('error', err => {
      const missing = err.code === 'ENOENT';
      this.set({ state: 'error', error: missing ? 'cloudflared is not installed (run update.bat, or: winget install --id Cloudflare.cloudflared)' : err.message });
      if (!missing) console.warn('[tunnel]', err.message);
    });
    if (child.pid && this.pidFile) { try { fs.writeFileSync(this.pidFile, String(child.pid)); } catch {} }
    const onLine = line => {
      if (/Registered tunnel connection/i.test(line)) {
        this.retryMs = 5000;
        this.set({ state: 'connected', connections: this.status.connections + 1, error: null });
      } else if (/Unregistered tunnel connection|Connection terminated/i.test(line)) {
        const n = Math.max(0, this.status.connections - 1);
        this.set({ connections: n, state: n ? 'connected' : 'starting' });
      } else if (/\bERR\b/.test(line)) {
        this.set({ error: line.replace(/^\S+\s+ERR\s+/, '').slice(0, 200) });
      }
    };
    for (const stream of [child.stdout, child.stderr]) {
      let buf = '';
      stream.on('data', d => {
        buf += d;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        lines.forEach(onLine);
      });
    }
    child.on('exit', code => {
      this.child = null;
      if (this.stopping) return;
      if (/not installed/.test(this.status.error || '')) return; // nothing to retry until it's installed
      this.set({ state: 'error', connections: 0, error: this.status.error || `cloudflared stopped (code ${code})` });
      // Keep trying, a bit slower each time (up to once a minute).
      setTimeout(() => this.launch(), this.retryMs).unref();
      this.retryMs = Math.min(60000, this.retryMs * 2);
    });
  }

  /** A cloudflared left running by a server that was closed abruptly (its window shut, or update.bat). */
  killOrphan() {
    if (!this.pidFile || !fs.existsSync(this.pidFile)) return;
    const pid = Number(fs.readFileSync(this.pidFile, 'utf8'));
    try { fs.rmSync(this.pidFile, { force: true }); } catch {}
    if (!pid || !isCloudflared(pid)) return;
    try { process.kill(pid); } catch {}
  }

  stop() {
    this.stopping = true;
    try { this.child?.kill(); } catch {}
    try { if (this.pidFile) fs.rmSync(this.pidFile, { force: true }); } catch {}
  }

  set(patch) {
    Object.assign(this.status, patch);
    this.emit('change', this.status);
  }
}

/** Is that process cloudflared? (So a reused process number never gets something else killed.) */
function isCloudflared(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      return /cloudflared/i.test(out);
    }
    return /cloudflared/i.test(fs.readFileSync(`/proc/${pid}/comm`, 'utf8'));
  } catch { return false; }
}

export function tunnelPidFile(dataDir) {
  return path.join(dataDir, 'cloudflared.pid');
}
