// Older Safari (e.g. iPads stuck on iOS 12) can't run some of the newer JavaScript the pages use, such as
// `a?.b` and `a ?? b`, so nothing would work there. For those browsers only, the server translates each
// script on the way out (with esbuild) into code Safari 12 understands. The files themselves stay as they
// are, and every other browser (including OBS) gets them untouched.
import fs from 'node:fs';
import path from 'node:path';

const TARGET = 'safari12';
const cache = new Map(); // file -> { mtimeMs, code }
let esbuild = null;

/** Safari / iOS WebKit older than 14 (every browser on iOS uses WebKit, so the iOS version is what counts). */
export function isLegacyBrowser(ua = '') {
  const ios = /\b(?:iPhone|iPad|iPod)\b.*?\bOS (\d+)_(\d+)/.exec(ua);
  if (ios) return Number(ios[1]) < 14;
  if (/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(ua)) return false;
  const safari = /\bVersion\/(\d+)(?:\.(\d+))?.*\bSafari\//.exec(ua);
  return !!safari && Number(safari[1]) < 14;
}

/** Translate one script for old Safari (cached until the file changes). */
export async function legacyScript(file) {
  const { mtimeMs } = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.code;
  esbuild ??= await import('esbuild');
  const src = fs.readFileSync(file, 'utf8');
  const { code } = await esbuild.transform(src, { loader: 'js', format: 'esm', target: TARGET, sourcefile: path.basename(file) });
  cache.set(file, { mtimeMs, code });
  return code;
}

/** Express middleware: old Safari gets translated .js files; everyone else falls through to the normal files. */
export function legacyScripts(publicDir) {
  const root = path.resolve(publicDir);
  return async (req, res, next) => {
    if (!req.path.endsWith('.js') || req.path.startsWith('/assets/')) return next();
    res.vary('User-Agent');
    if (!isLegacyBrowser(req.get('user-agent'))) return next();
    const file = path.resolve(root, `.${decodeURIComponent(req.path)}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return next();
    try {
      const code = await legacyScript(file);
      res.set('Cache-Control', 'no-cache').type('application/javascript').send(code);
    } catch (err) {
      console.warn(`[legacy] could not translate ${req.path} for an older browser: ${err.message}`);
      next(); // send it as it is: better than nothing
    }
  };
}
