// Older Safari (iPads stuck on iOS 12): every page script must come out as code Safari 12 can parse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';
import { isLegacyBrowser, legacyScript } from '../server/legacy.js';

const PUBLIC = path.resolve('public');
const scripts = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
  const p = path.join(dir, d.name);
  if (d.isDirectory()) return d.name === 'assets' ? [] : scripts(p);
  return d.name.endsWith('.js') ? [p] : [];
});

test('who counts as an older browser', () => {
  assert.equal(isLegacyBrowser('Mozilla/5.0 (iPad; CPU OS 12_5_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1'), true);
  assert.equal(isLegacyBrowser('Mozilla/5.0 (iPad; CPU OS 12_5_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/87 Mobile/15E148 Safari/604.1'), true, 'any browser on old iOS');
  assert.equal(isLegacyBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'), false);
  assert.equal(isLegacyBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 OBS/31'), false);
});

test('every page script translates to code Safari 12 can parse (no ?. ?? top-level await etc.)', async () => {
  const files = scripts(PUBLIC);
  assert.ok(files.length > 8);
  for (const f of files) {
    const code = await legacyScript(f);
    // Safari 12 understands ES2018 plus optional catch binding; ecmaVersion 2019 is the closest acorn level.
    assert.doesNotThrow(() => parse(code, { ecmaVersion: 2019, sourceType: 'module' }), `${path.relative(PUBLIC, f)} still has newer syntax`);
  }
});

test('the untranslated sources really do need it (so the check above means something)', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'dock/dock.js'), 'utf8');
  assert.throws(() => parse(src, { ecmaVersion: 2019, sourceType: 'module' }));
});
