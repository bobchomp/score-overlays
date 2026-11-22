// Entry point: HTTP server (pages + API) and WebSocket hub.
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { loadEnv, loadTheme, loadObsConfig, themeCss, PUBLIC_DIR } from './config.js';
import { Store } from './store.js';
import { ObsLink } from './obs.js';
import { Demo } from './demo.js';
import { createAuth } from './auth.js';
import { createApi } from './api.js';
import { score, eventMinute, PLAYING_PERIODS } from '../public/shared/match.js';
import { Replays, disabledReplays } from './replays.js';

const env = loadEnv();
let theme = loadTheme();
let themeRev = Date.now();

const store = new Store({ getTheme: () => theme });
const auth = createAuth(env.pin);
const obs = new ObsLink(env.obs, loadObsConfig(), 'Main OBS');
const demo = new Demo(store);

// Replays are isolated: if the module can't start, graphics carry on and the dock shows why.
let replays;
try {
  replays = new Replays({
    mainObs: obs,
    mainDefault: { url: `ws://${env.obs.host}:${env.obs.port}`, password: env.obs.password },
    getMinute: () => (PLAYING_PERIODS.includes(store.state.clock.period) ? eventMinute(store.state.clock, store.state.match, Date.now()) : null),
  });
} catch (err) {
  console.error('[replays] disabled:', err);
  replays = disabledReplays(err.message);
}

function replayStatus() {
  try { return replays.publicStatus(); } catch (err) { return { disabled: err.message, queue: [], bug: { visible: false } }; }
}

function snapshot() {
  return {
    state: store.state,
    score: score(store.state.events),
    undo: store.undoInfo(),
    obs: obs.publicStatus(),
    demo: demo.status(),
    replay: replayStatus(),
    theme,
    themeRev,
    serverTime: Date.now(),
  };
}

// ---------------- HTTP ----------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);

// Lets the server check at startup that "localhost:PORT" really reaches *this* process.
const INSTANCE_ID = crypto.randomBytes(8).toString('hex');
app.get('/__instance', (req, res) => res.type('text/plain').send(INSTANCE_ID));

app.get('/theme.css', (req, res) => {
  res.type('text/css').set('Cache-Control', 'no-cache').send(themeCss(theme));
});

app.use('/api', createApi({
  store, obs, auth, demo, snapshot, replays,
  onThemeChange() { theme = loadTheme(); themeRev = Date.now(); broadcastState(); },
}));

// Uploaded images can be SVG: never let them run scripts.
app.use('/assets/logos', (req, res, next) => { res.set('Content-Security-Policy', "script-src 'none'"); next(); });
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders(res, file) {
    // Pages and scripts must always be fresh after an update; assets can be cached briefly.
    if (/\.(html|js|css)$/.test(file)) res.set('Cache-Control', 'no-cache');
  },
}));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

const server = http.createServer(app);

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ server, path: '/ws' });
// ws re-emits the HTTP server's errors (e.g. port in use); server.on('error') below handles them.
wss.on('error', () => {});

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastState() {
  const msg = JSON.stringify({ type: 'state', ...snapshot() });
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN && ws.hello) ws.send(msg);
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.authed = false;
  ws.ip = req.socket.remoteAddress;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'hello': {
        ws.hello = true;
        ws.role = msg.role === 'control' ? 'control' : 'overlay';
        if (ws.role === 'control') {
          const r = auth.check(msg.pin, ws.ip);
          ws.authed = r.ok;
          send(ws, { type: 'auth', ok: r.ok, error: r.error });
        }
        send(ws, { type: 'state', ...snapshot() });
        break;
      }
      case 'ping':
        send(ws, { type: 'pong', t: msg.t, server: Date.now() });
        break;
      case 'action': {
        if (!ws.authed) { send(ws, { type: 'ack', id: msg.id, ok: false, error: 'PIN required', auth: false }); break; }
        const r = store.dispatch(msg.action, msg.payload, { source: 'ws' });
        send(ws, { type: 'ack', id: msg.id, ...r });
        break;
      }
      case 'scene': {
        if (!ws.authed) { send(ws, { type: 'ack', id: msg.id, ok: false, error: 'PIN required', auth: false }); break; }
        try { await obs.setScene(msg.scene); send(ws, { type: 'ack', id: msg.id, ok: true }); } catch (err) { send(ws, { type: 'ack', id: msg.id, ok: false, error: err.message }); }
        break;
      }
      case 'replay': {
        if (!ws.authed) { send(ws, { type: 'ack', id: msg.id, ok: false, error: 'PIN required', auth: false }); break; }
        try {
          const r = await replays.handle(msg.op, msg.args || {});
          send(ws, { type: 'ack', id: msg.id, ok: r?.ok !== false, ...(r && typeof r === 'object' ? r : {}) });
        } catch (err) {
          send(ws, { type: 'ack', id: msg.id, ok: false, error: err.message });
        }
        break;
      }
      case 'demo': {
        if (!ws.authed) { send(ws, { type: 'ack', id: msg.id, ok: false, error: 'PIN required', auth: false }); break; }
        try { msg.op === 'start' ? demo.start() : demo.stop(); send(ws, { type: 'ack', id: msg.id, ok: true }); } catch (err) { send(ws, { type: 'ack', id: msg.id, ok: false, error: err.message }); }
        break;
      }
    }
  });
});

// Drop dead connections so clients notice and reconnect.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 10_000);
wss.on('close', () => clearInterval(heartbeat));

store.on('change', broadcastState);
obs.on('status', broadcastState);
demo.on('change', broadcastState);
replays.on('change', broadcastState);

// A live show must keep going: log unexpected errors (e.g. from an OBS callback) instead of exiting.
process.on('unhandledRejection', err => console.error('[server] unhandled rejection (ignored):', err));
process.on('uncaughtException', err => {
  // A port problem at startup is fatal: say so plainly and stop, rather than sit there doing nothing.
  if (err?.code === 'EADDRINUSE' || err?.code === 'EACCES') return onListenError(err);
  console.error('[server] unexpected error (ignored):', err);
});

// ---------------- start ----------------
/**
 * On Windows another program can listen on 127.0.0.1:PORT alongside us on 0.0.0.0:PORT, and it
 * then receives every "localhost" request (OBS, the dock) while we sit unused. Detect that loudly.
 */
function checkLocalhostReachesUs() {
  const req = http.get({ host: '127.0.0.1', port: env.port, path: '/__instance', timeout: 3000 }, res => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => { if (body.trim() !== INSTANCE_ID) warnPortClash(); });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', () => warnPortClash());
}

function warnPortClash() {
  const line = '!'.repeat(72);
  console.error(`\n${line}`);
  console.error(` ANOTHER PROGRAM IS USING PORT ${env.port} ON THIS PC.`);
  console.error(` http://localhost:${env.port} goes to that program, not to the score server,`);
  console.error(' so OBS and the dock will not work.');
  console.error(` Fix: close the other program, or set PORT=3080 (any free number) in .env,`);
  console.error(' restart, and update the URLs in OBS. To see what it is, run:');
  console.error(`   netstat -ano | findstr :${env.port}     then   tasklist /FI "PID eq <number>"`);
  console.error(`${line}\n`);
}

server.listen(env.port, '0.0.0.0', () => {
  setTimeout(checkLocalhostReachesUs, 500);
  const lan = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  const line = '-'.repeat(60);
  console.log(line);
  console.log(' Score Overlays running');
  console.log(`  Overlay (OBS Browser Source):  http://localhost:${env.port}/overlay`);
  console.log(`  Control dock (OBS Custom Dock): http://localhost:${env.port}/dock`);
  console.log(`  Match setup:                   http://localhost:${env.port}/setup`);
  for (const ip of lan) console.log(`  From your phone:               http://${ip}:${env.port}/dock`);
  if (env.generatedPin) {
    console.log('');
    console.log(`  !! CONTROL_PIN is not set in .env. Temporary PIN for this run: ${env.pin}`);
  }
  console.log(line);
  obs.start();
  try { replays.start(); } catch (err) { console.error('[replays] could not start:', err.message); }
  if (process.argv.includes('--demo')) {
    try { demo.start(); } catch (err) { console.warn('[demo]', err.message); }
  }
});

function onListenError(err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${env.port} is already in use: the score server may already be running in another window,`);
    console.error('or another program is using it. Close the other window, or set a different PORT in .env.');
    console.error(`To see what's using it:  netstat -ano | findstr :${env.port}   then   tasklist /FI "PID eq <number>"\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
}
server.on('error', onListenError);

function shutdown() {
  console.log('\nSaving and shutting down…');
  store.save();
  obs.stop();
  try { replays.stop(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
