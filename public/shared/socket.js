// Auto-reconnecting WebSocket client shared by the overlay, dock and setup pages.
// Also estimates the offset between this device's clock and the server's, so the
// match clock is identical on every screen even if a phone's clock is wrong.

export class MatchSocket {
  constructor({ role = 'overlay', page = 'page', pin = '', onState, onStatus, onAuth } = {}) {
    this.role = role;
    this.page = page;     // 'overlay', 'overlay-preview', 'dock', 'setup' (shown in the health check)
    this.build = null;    // version of the page files this page was loaded with
    this.pin = pin;
    this.onState = onState || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onAuth = onAuth || (() => {});
    this.offset = 0;          // serverTime - localTime (ms)
    this.bestRtt = Infinity;
    this.rev = -1;
    this.pending = new Map();
    this.seq = 0;
    this.connected = false;
    this.backoff = 500;
    this.connect();
    setInterval(() => this.ping(), 5000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !this.connected) this.connect(); });
  }

  now() { return Date.now() + this.offset; }

  connect() {
    clearTimeout(this.retryTimer);
    try { this.ws?.close(); } catch {}
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.lastPong = Date.now();
      this.bestRtt = Infinity;
      ws.send(JSON.stringify({ type: 'hello', role: this.role, pin: this.pin }));
      for (let i = 0; i < 3; i++) setTimeout(() => this.ping(), i * 150);
    };
    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'state') {
        // After an update the server comes back with new page files: reload to pick them up.
        if (msg.build && this.build && msg.build !== this.build && !this.reloading) {
          this.reloading = true;
          console.log('[socket] page files updated on the server, reloading');
          setTimeout(() => location.reload(), 300);
          return;
        }
        if (msg.build && !this.build) this.build = msg.build;
        if (!this.connected) {
          this.connected = true;
          this.onStatus(true);
          this.sendInfo();
        }
        if (this.bestRtt === Infinity && msg.serverTime) this.offset = msg.serverTime - Date.now();
        // Messages on one socket arrive in order, so the latest is always the truth.
        this.onState(msg);
      } else if (msg.type === 'pong') {
        this.lastPong = Date.now();
        const rtt = Date.now() - msg.t;
        if (rtt <= this.bestRtt * 1.5 || rtt < 50) {
          this.bestRtt = Math.min(this.bestRtt, rtt);
          this.offset = msg.server - (msg.t + rtt / 2);
        }
      } else if (msg.type === 'auth') {
        this.onAuth(msg);
      } else if (msg.type === 'ack') {
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg); }
        if (msg.auth === false) this.onAuth({ ok: false, error: msg.error });
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (this.connected) { this.connected = false; this.onStatus(false); }
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'Disconnected' }); this.pending.delete(id); }
      this.retryTimer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 4000);
    };
    ws.onerror = () => {};
  }

  /** Tell the server what this page is (for the health check). */
  sendInfo() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'info', page: this.page, build: this.build, width: window.innerWidth, height: window.innerHeight }));
  }

  ping() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // No pong for 12s means the link is dead even if the browser hasn't noticed.
    if (this.lastPong && Date.now() - this.lastPong > 12000) { this.ws.close(); return; }
    this.ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
  }

  request(msg) {
    return new Promise(resolve => {
      if (this.ws?.readyState !== WebSocket.OPEN) return resolve({ ok: false, error: 'Not connected to server' });
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: 'Server did not respond' }); }, 5000);
      this.pending.set(id, { resolve, timer });
      this.ws.send(JSON.stringify({ ...msg, id }));
    });
  }

  action(action, payload = {}) { return this.request({ type: 'action', action, payload }); }
  scene(scene) { return this.request({ type: 'scene', scene }); }
  demo(op) { return this.request({ type: 'demo', op }); }

  setPin(pin) {
    this.pin = pin;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'hello', role: this.role, pin }));
  }
}

/** Keep /theme.css in sync with the server's theme (swap the stylesheet when it changes). */
export function syncThemeCss(themeRev) {
  const link = document.getElementById('theme-css');
  if (!link || link.dataset.rev === String(themeRev)) return;
  if (!link.dataset.rev) { link.dataset.rev = String(themeRev); return; }
  const fresh = link.cloneNode();
  fresh.href = `/theme.css?v=${themeRev}`;
  fresh.dataset.rev = String(themeRev);
  fresh.onload = () => link.remove();
  link.after(fresh);
  fresh.id = 'theme-css';
  link.id = '';
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
