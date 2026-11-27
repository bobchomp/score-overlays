// Remote access: the server runs cloudflared alongside itself. A stand-in script plays cloudflared here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Tunnel } from '../server/tunnel.js';
import { clientIp } from '../server/auth.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-'));
const fake = path.join(dir, 'fake-cloudflared.mjs');
fs.writeFileSync(fake, `
  import fs from 'node:fs';
  if (process.argv.includes('--version')) { console.log('cloudflared version 2025.11.1 (built 2025-11-10)'); process.exit(0); }
  fs.writeFileSync(${JSON.stringify(path.join(dir, 'seen.json'))}, JSON.stringify({ args: process.argv.slice(2), token: process.env.TUNNEL_TOKEN }));
  console.error('2026-01-01T00:00:00Z INF Registered tunnel connection connIndex=0');
  setInterval(() => {}, 1000);
`);
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 50)); } };

test('no token: nothing runs', () => {
  const t = new Tunnel({ token: '', pidFile: path.join(dir, 'a.pid') });
  t.start();
  assert.equal(t.status.enabled, false);
  assert.equal(t.child, null);
});

test('starts cloudflared with the token in its environment (not the command line), reports connected, stops cleanly', async () => {
  const pidFile = path.join(dir, 'b.pid');
  const t = new Tunnel({ token: 'secret-token', binary: process.execPath, argsPrefix: [fake], publicUrl: 'https://scores.example.com/', pidFile });
  t.start();
  await until(() => t.status.state === 'connected');
  const seen = JSON.parse(fs.readFileSync(path.join(dir, 'seen.json'), 'utf8'));
  assert.equal(seen.token, 'secret-token');
  assert.deepEqual(seen.args, ['tunnel', '--no-autoupdate', 'run']);
  assert.equal(t.status.version, '2025.11.1', 'version shown in the pre-match check');
  assert.equal(Number(fs.readFileSync(pidFile, 'utf8')), t.child.pid);
  const child = t.child;
  t.stop();
  await until(() => child.exitCode !== null || child.signalCode !== null);
  assert.equal(fs.existsSync(pidFile), false);
});

test('missing cloudflared: a clear message and no endless retrying', async () => {
  const t = new Tunnel({ token: 'x', binary: path.join(dir, 'no-such-cloudflared'), pidFile: path.join(dir, 'c.pid') });
  t.start();
  await until(() => t.status.state === 'error');
  assert.match(t.status.error, /not installed/);
  t.stop();
});

test('PIN lockout: visitors through the tunnel are told apart; the header is ignored from other machines', () => {
  const req = (remote, cf) => ({ socket: { remoteAddress: remote }, headers: cf ? { 'cf-connecting-ip': cf } : {} });
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.5')), 'cf:203.0.113.5');
  assert.equal(clientIp(req('::1', '198.51.100.7')), 'cf:198.51.100.7');
  assert.equal(clientIp(req('127.0.0.1')), '127.0.0.1');
  assert.equal(clientIp(req('192.168.1.20', '203.0.113.5')), '192.168.1.20', 'a phone on the LAN cannot pretend');
});

test('"Bad gateway": cloudflared connected but cannot reach the server is reported, not shown as fine', async () => {
  const bad = path.join(dir, 'fake-bad.mjs');
  fs.writeFileSync(bad, `
    if (process.argv.includes('--version')) { console.log('cloudflared version 2025.8.1'); process.exit(0); }
    console.error('2026-01-01T00:00:00Z INF Registered tunnel connection connIndex=0');
    setTimeout(() => console.error('2026-01-01T00:00:01Z ERR Unable to reach the origin service. The service may be down or it may not be responding to traffic from cloudflared: dial tcp [::1]:3080: connectex: No connection could be made'), 100);
    setInterval(() => {}, 1000);
  `);
  const t = new Tunnel({ token: 't', binary: process.execPath, argsPrefix: [bad], pidFile: path.join(dir, 'd.pid') });
  t.start();
  await until(() => t.status.originErrorAt);
  assert.equal(t.status.state, 'connected');
  assert.match(t.status.originError, /Unable to reach the origin/);
  const { runHealth } = await import('../server/health.js');
  const r = await runHealth({ env: { port: 3080 }, obs: { status: { connected: false } }, replays: null, clients: () => [], startedAt: Date.now(), tunnel: t.status });
  const item = r.items.find(i => i.id === 'tunnel');
  assert.equal(item.status, 'warn');
  assert.match(item.fix, /127\.0\.0\.1:3080/);
  t.stop();
});
