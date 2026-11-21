// Loading and saving of everything in config/ plus a few paths.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_DIR = path.join(ROOT, 'config');
export const TEAMS_DIR = path.join(CONFIG_DIR, 'teams');
export const DATA_DIR = path.join(ROOT, 'data');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const FONTS_DIR = path.join(PUBLIC_DIR, 'assets', 'fonts');
export const LOGOS_DIR = path.join(PUBLIC_DIR, 'assets', 'logos');

for (const d of [DATA_DIR, TEAMS_DIR, LOGOS_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------- .env ----------
export function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) {
    try { process.loadEnvFile(file); } catch (err) { console.warn('[config] could not read .env:', err.message); }
  }
  let pin = String(process.env.CONTROL_PIN || '').trim();
  let generatedPin = false;
  if (!pin) {
    pin = String(crypto.randomInt(100000, 999999));
    generatedPin = true;
  }
  return {
    port: Number(process.env.PORT) || 3000,
    pin,
    generatedPin,
    obs: {
      host: process.env.OBS_HOST || '127.0.0.1',
      port: Number(process.env.OBS_PORT) || 4455,
      password: process.env.OBS_PASSWORD || undefined,
    },
  };
}

// ---------- JSON helpers ----------
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[config] could not parse ${path.relative(ROOT, file)}: ${err.message}`);
    return fallback;
  }
}

/** Write JSON atomically (temp file + rename), retrying briefly for Windows file locks. */
export function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  const text = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, text);
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, file); return; } catch (err) {
      if (i === 4) { fs.writeFileSync(file, text); try { fs.unlinkSync(tmp); } catch {} return; }
      const until = Date.now() + 20; while (Date.now() < until) { /* brief spin for AV/indexer locks */ }
    }
  }
}

// ---------- theme ----------
export const DEFAULT_THEME = {
  clubName: 'My Club',
  clubLogo: '',
  colors: {
    panel: '#0f1722', panelAlt: '#1b2636', panelText: '#ffffff', muted: '#9fb0c6',
    accent: '#f5c400', accentText: '#0f1722', clock: '#ffffff', clockBg: '#000000',
    yellow: '#ffd200', red: '#e3121b', green: '#20c060',
  },
  fonts: { heading: 'Barlow Condensed', body: 'Barlow' },
  labels: {
    goal: 'GOAL!', ownGoal: 'OWN GOAL', kickOff: 'KICK OFF', halfTime: 'HALF TIME', fullTime: 'FULL TIME',
    startingXI: 'STARTING XI', substitutes: 'SUBSTITUTES', substitution: 'SUBSTITUTION',
    yellowCard: 'YELLOW CARD', redCard: 'RED CARD', secondYellow: 'SECOND YELLOW', versus: 'VS',
    extraTime: 'ET', penalties: 'PENS',
  },
  timings: { lowerThirdSec: 8, stingMs: 2600 },
};

function mergeDeep(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? mergeDeep(base[k], v) : v;
  }
  return out;
}

export function loadTheme() {
  return mergeDeep(DEFAULT_THEME, readJson(path.join(CONFIG_DIR, 'theme.json'), {}));
}

export function saveTheme(theme) {
  const clean = mergeDeep(DEFAULT_THEME, theme);
  writeJsonAtomic(path.join(CONFIG_DIR, 'theme.json'), clean);
  return clean;
}

/** Fonts available locally: public/assets/fonts/<Family>/<weight>.woff2 */
export function listFonts() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(FONTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()); } catch {}
  for (const d of dirs) {
    const files = fs.readdirSync(path.join(FONTS_DIR, d.name)).filter(f => /\.(woff2?|ttf|otf)$/i.test(f));
    const faces = files.map(f => {
      const m = f.match(/^(\d{3})(-italic)?\./i);
      return { file: f, weight: m ? Number(m[1]) : 400, italic: !!(m && m[2]) };
    });
    if (faces.length) out.push({ family: d.name, faces });
  }
  return out.sort((a, b) => a.family.localeCompare(b.family));
}

const cssStr = s => String(s).replace(/[^\w #.,()%-]/g, '');

/** Generated stylesheet: @font-face for local fonts + CSS variables from the theme. */
export function themeCss(theme) {
  const fmt = f => ({ woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' })[f.split('.').pop().toLowerCase()];
  let css = '/* generated from config/theme.json */\n';
  for (const font of listFonts()) {
    for (const face of font.faces) {
      const url = `/assets/fonts/${encodeURIComponent(font.family)}/${encodeURIComponent(face.file)}`;
      css += `@font-face{font-family:"${cssStr(font.family)}";src:url("${url}") format("${fmt(face.file)}");font-weight:${face.weight};font-style:${face.italic ? 'italic' : 'normal'};font-display:block}\n`;
    }
  }
  css += ':root{\n';
  for (const [k, v] of Object.entries(theme.colors)) css += `  --c-${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}:${cssStr(v)};\n`;
  css += `  --font-heading:"${cssStr(theme.fonts.heading)}", "Arial Narrow", sans-serif;\n`;
  css += `  --font-body:"${cssStr(theme.fonts.body)}", Arial, sans-serif;\n`;
  css += '}\n';
  return css;
}

// ---------- OBS ----------
export function loadObsConfig() {
  return { mainScene: '', scenes: [], ...readJson(path.join(CONFIG_DIR, 'obs.json'), {}) };
}

// ---------- teams ----------
const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function normaliseTeam(raw, id) {
  const t = raw || {};
  const used = new Set();
  const squad = (Array.isArray(t.squad) ? t.squad : []).map((p, i) => {
    let pid = p.id ? String(p.id) : `p${p.number ?? i}-${slug(p.name)}`;
    while (used.has(pid)) pid += 'x';
    used.add(pid);
    return {
      id: pid,
      number: p.number === '' || p.number == null ? null : Number(p.number),
      name: String(p.name || '').trim(),
      position: ['GK', 'DEF', 'MID', 'FWD'].includes(p.position) ? p.position : 'MID',
    };
  }).filter(p => p.name);
  return {
    id,
    name: String(t.name || id),
    short: String(t.short || t.name || id).toUpperCase().slice(0, 4),
    colors: { primary: '#333333', secondary: '#ffffff', text: '#ffffff', ...(t.colors || {}) },
    logo: t.logo || '',
    squad,
  };
}

export function listTeams() {
  const files = fs.readdirSync(TEAMS_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => normaliseTeam(readJson(path.join(TEAMS_DIR, f), {}), f.replace(/\.json$/, '')))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function loadTeam(id) {
  const file = path.join(TEAMS_DIR, `${safeId(id)}.json`);
  if (!fs.existsSync(file)) return null;
  return normaliseTeam(readJson(file, {}), safeId(id));
}

export function safeId(id) {
  const s = slug(id);
  if (!s) throw new Error('Invalid team id');
  return s;
}

export function saveTeam(team) {
  const id = safeId(team.id || team.name);
  const clean = normaliseTeam(team, id);
  const { id: _omit, ...toWrite } = clean;
  writeJsonAtomic(path.join(TEAMS_DIR, `${id}.json`), toWrite);
  return clean;
}

export function deleteTeam(id) {
  fs.rmSync(path.join(TEAMS_DIR, `${safeId(id)}.json`), { force: true });
}

// ---------- uploads ----------
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/webp': 'webp', 'image/gif': 'gif' };

export function saveLogo(nameHint, contentType, buffer) {
  const ext = IMAGE_TYPES[String(contentType).split(';')[0].trim()];
  if (!ext) throw new Error('Unsupported image type (use PNG, JPG, SVG, WebP or GIF)');
  if (!buffer?.length) throw new Error('Empty upload');
  const base = slug(String(nameHint || 'logo').replace(/\.[a-z0-9]+$/i, '')) || 'logo';
  let name = `${base}.${ext}`;
  let n = 1;
  while (fs.existsSync(path.join(LOGOS_DIR, name))) name = `${base}-${++n}.${ext}`;
  fs.writeFileSync(path.join(LOGOS_DIR, name), buffer);
  return `/assets/logos/${name}`;
}

export function listLogos() {
  return fs.readdirSync(LOGOS_DIR).filter(f => /\.(png|jpe?g|svg|webp|gif)$/i.test(f)).map(f => `/assets/logos/${f}`);
}
