// PIN check with a simple per-IP lockout against guessing.
import crypto from 'node:crypto';

const MAX_FAILS = 8;
const WINDOW_MS = 60_000;
const LOCK_MS = 60_000;

export function createAuth(pin) {
  const expected = Buffer.from(String(pin));
  const fails = new Map(); // ip -> { count, first, lockedUntil }

  function locked(ip) {
    const f = fails.get(ip);
    return !!(f && f.lockedUntil && f.lockedUntil > Date.now());
  }

  function check(candidate, ip = 'unknown') {
    if (locked(ip)) return { ok: false, error: 'Too many wrong PINs. Wait a minute and try again.' };
    const given = Buffer.from(String(candidate ?? ''));
    const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (ok) { fails.delete(ip); return { ok: true }; }
    const now = Date.now();
    let f = fails.get(ip);
    if (!f || now - f.first > WINDOW_MS) f = { count: 0, first: now, lockedUntil: 0 };
    f.count += 1;
    if (f.count >= MAX_FAILS) f.lockedUntil = now + LOCK_MS;
    fails.set(ip, f);
    return { ok: false, error: candidate ? 'Wrong PIN' : 'PIN required' };
  }

  return { check };
}

export function pinFromRequest(req) {
  return req.get('x-pin') || req.query.pin || req.body?.pin || '';
}
