// Pre-match health check: one list of everything that has to be right before kick-off,
// each with a plain-English fix. Read-only (except the explicit "refresh overlay" action),
// and every check is isolated so one failing check never stops the rest.
import fs from 'node:fs';

const OK = 'ok', WARN = 'warn', BAD = 'bad', SKIP = 'skip';
const GB = 1024 ** 3;

function item(id, label, status, detail = '', fix = '', action = null) {
  return { id, label, status, detail, fix, action };
}

/** Browser Sources in the main OBS that show our overlay, with their effective settings. */
async function overlaySources(obs) {
  const { inputs } = await obs.call('GetInputList', { inputKind: 'browser_source' });
  let defaults = {};
  try { defaults = (await obs.call('GetInputDefaultSettings', { inputKind: 'browser_source' })).defaultInputSettings || {}; } catch {}
  const out = [];
  for (const i of inputs || []) {
    try {
      const { inputSettings } = await obs.call('GetInputSettings', { inputName: i.inputName });
      const s = { ...defaults, ...inputSettings };
      const url = String(s.url || '');
      if (/\/overlay\/?(\?|#|$)/.test(url) && !/preview=1/.test(url)) out.push({ name: i.inputName, settings: s, url });
    } catch {}
  }
  return out;
}

// Inputs that never carry the live sound (graphics, clips, text...).
// Inputs that never carry live sound: still pictures, text, screen captures.
const NO_SOUND = /^(image_source|slideshow|color_source|text_|monitor_capture|window_capture|game_capture|xcomposite|xshm|display_capture|screen_capture)/;
// Video/audio files: their sound stopping during a replay is usually fine (adverts, clips).
const MEDIA_FILE = /^(ffmpeg_source|vlc_source)/;

/** Every source shown in a scene, looking inside groups and nested scenes. via = where it was found. */
async function sceneSources(obs, sceneName, via = [], seen = new Set()) {
  if (seen.has(sceneName)) return [];
  seen.add(sceneName);
  const out = [];
  let items = [];
  try { items = (await obs.call('GetSceneItemList', { sceneName })).sceneItems || []; } catch { return out; }
  for (const it of items) {
    if (it.sceneItemEnabled === false) continue; // hidden in this scene
    if (it.isGroup) {
      let kids = [];
      try { kids = (await obs.call('GetGroupSceneItemList', { sceneName: it.sourceName })).sceneItems || []; } catch {}
      for (const k of kids) if (k.sceneItemEnabled !== false) out.push({ name: k.sourceName, kind: k.inputKind, via: [...via, `group "${it.sourceName}"`] });
    } else if (it.sourceType === 'OBS_SOURCE_TYPE_SCENE') {
      out.push(...await sceneSources(obs, it.sourceName, [...via, `scene "${it.sourceName}"`], seen));
    } else {
      out.push({ name: it.sourceName, kind: it.inputKind, via });
    }
  }
  return out;
}

async function hasAudibleSound(obs, name) {
  try {
    await obs.call('GetInputVolume', { inputName: name }); // fails if the source has no audio at all
    return !(await obs.call('GetInputMute', { inputName: name })).inputMuted;
  } catch { return false; }
}

/**
 * What viewers hear during a replay vs. what goes silent.
 *  global:  Desktop Audio / Mic/Aux devices from Settings > Audio (play in every scene)
 *  heard:   live-scene sound sources that are also in the replay scene
 *  missing: live sound sources only in the live scene -> stop during replays (fixable)
 *  media:   video/audio files only in the live scene -> stop during replays (info only)
 */
export async function analyzeLiveAudio(obs, liveScene, replayScene, ignore = []) {
  const res = { global: [], heard: [], missing: [], media: [] };
  try {
    const special = await obs.call('GetSpecialInputs');
    for (const name of Object.values(special || {})) if (name && await hasAudibleSound(obs, name)) res.global.push(name);
  } catch {}
  const live = await sceneSources(obs, liveScene);
  const inReplay = new Set((await sceneSources(obs, replayScene)).map(s => s.name));
  const done = new Set(res.global);
  for (const src of live) {
    if (done.has(src.name) || ignore.includes(src.name) || !src.kind || NO_SOUND.test(src.kind)) continue;
    done.add(src.name);
    if (src.kind === 'browser_source') {
      // Only counts if its sound goes through OBS ("Control audio via OBS").
      try {
        const { inputSettings } = await obs.call('GetInputSettings', { inputName: src.name });
        if (!inputSettings?.reroute_audio) continue;
      } catch { continue; }
    }
    if (!await hasAudibleSound(obs, src.name)) continue;
    const entry = { name: src.name, via: src.via };
    if (inReplay.has(src.name)) res.heard.push(entry);
    else if (MEDIA_FILE.test(src.kind)) res.media.push(entry);
    else res.missing.push(entry);
  }
  return res;
}

/** Back-compat helper: names of live sound sources that would go silent during a replay. */
export async function liveAudioMissingFromReplay(obs, liveScene, replayScene, ignore = []) {
  return (await analyzeLiveAudio(obs, liveScene, replayScene, ignore)).missing.map(m => m.name);
}

/** Fix: add those sources to the replay scene(s) at the bottom (hidden behind the replay, sound keeps playing). */
export async function addLiveAudioToReplay(obs, replays) {
  const live = obs.status.currentScene;
  const n = replays.settings.names;
  const scenes = [n.scene, replays.settings.stinger.mode === 'obs' && n.sceneB ? n.sceneB : null].filter(Boolean);
  let added = 0;
  for (const scene of scenes) {
    if (!live || live === scene) continue;
    for (const sourceName of await liveAudioMissingFromReplay(obs, live, scene, [n.player, n.playerB].filter(Boolean))) {
      const { sceneItemId } = await obs.call('CreateSceneItem', { sceneName: scene, sourceName });
      await obs.call('SetSceneItemIndex', { sceneName: scene, sceneItemId, sceneItemIndex: 0 });
      added++;
    }
  }
  return added;
}

async function sceneHasOnTop(obs, sceneName, sourceNames) {
  const { sceneItems } = await obs.call('GetSceneItemList', { sceneName });
  const items = sceneItems || [];
  const mine = items.filter(it => sourceNames.includes(it.sourceName));
  if (!mine.length) return 'missing';
  const top = Math.max(...items.map(it => it.sceneItemIndex));
  return mine.some(it => it.sceneItemIndex === top) ? 'top' : 'below';
}

export async function runHealth({ env, obs, replays, clients, build, commit, startedAt, state = null, tunnel = null }) {
  const items = [];
  const safe = async (fn, fallbackLabel) => {
    try { await fn(); } catch (err) { items.push(item(`err-${items.length}`, fallbackLabel, WARN, `Check failed: ${err.message}`)); }
  };
  const port = env.port;
  const pages = clients();

  // ---- server
  items.push(item('server', 'Graphics server', OK,
    `Running on port ${port}${commit ? ` · version ${commit}` : ''} · up ${Math.round((Date.now() - startedAt) / 60000)} min`));
  items.push(env.generatedPin
    ? item('pin', 'Control PIN', WARN, 'No CONTROL_PIN in .env, so a temporary PIN is used (shown in the server window). It changes every restart.', 'Set CONTROL_PIN=… in .env and restart.')
    : item('pin', 'Control PIN', OK, 'Set in .env'));

  // ---- overlay pages actually connected (i.e. loaded in OBS)
  const overlays = pages.filter(p => p.page === 'overlay' || (p.role === 'overlay' && !p.page));
  if (!overlays.length) {
    items.push(item('overlay', 'Overlay loaded in OBS', BAD, 'No overlay is connected to the server.',
      `In OBS, the Browser Source URL must be http://localhost:${port}/overlay (and OBS must be open).`));
  } else {
    const stale = overlays.filter(p => p.build !== build);
    items.push(stale.length
      ? item('overlay', 'Overlay loaded in OBS', WARN, `${overlays.length} connected, but ${stale.length} ${stale.length === 1 ? 'is' : 'are'} showing an older version.`,
        'Press "Refresh overlay in OBS" (or in OBS: Browser Source properties → Refresh cache of current page).', 'refreshOverlay')
      : item('overlay', 'Overlay loaded in OBS', OK, `${overlays.length} connected, up to date`));
    const wrongSize = overlays.filter(p => p.width && (p.width !== 1920 || p.height !== 1080));
    if (wrongSize.length) {
      const p = wrongSize[0];
      items.push(item('overlay-size', 'Overlay size', WARN, `The overlay is ${p.width}×${p.height}.`, 'Set the Browser Source Width to 1920 and Height to 1080.'));
    } else if (overlays.some(p => p.width)) {
      items.push(item('overlay-size', 'Overlay size', OK, '1920×1080'));
    }
  }
  const staleDocks = pages.filter(p => (p.page === 'dock' || p.page === 'setup') && p.build && p.build !== build);
  if (staleDocks.length) items.push(item('docks', 'Control pages', WARN, `${staleDocks.length} dock/setup page(s) are an older version.`, 'Reload them (they normally reload on their own after an update).'));

  // ---- remote access (only when a tunnel token is set)
  if (tunnel?.enabled) {
    items.push(tunnel.state === 'connected'
      ? item('tunnel', 'Remote access', OK, `Connected${tunnel.url ? `: ${tunnel.url}/dock` : ''}`)
      : item('tunnel', 'Remote access', WARN, tunnel.error || 'The Cloudflare tunnel is still connecting.',
        'Check the internet connection and the CLOUDFLARE_TUNNEL_TOKEN in .env. The graphics work without it.'));
  }

  // ---- teams and lineups
  if (state) items.push(...lineupChecks(state));

  // ---- main OBS
  if (!obs.status.connected) {
    items.push(item('main-obs', 'Main OBS connection', BAD, obs.status.error || 'Not connected',
      'Open OBS, enable Tools → WebSocket Server Settings (port 4455), and check OBS_PASSWORD in .env (or Settings → Replay settings → Main OBS).'));
  } else {
    items.push(item('main-obs', 'Main OBS connection', OK, `Connected · live scene: ${obs.status.currentScene || '?'}`));
    let sources = [];
    await safe(async () => {
      sources = await overlaySources(obs);
      if (!sources.length) {
        items.push(item('obs-source', 'Overlay Browser Source', BAD, 'No Browser Source in OBS points at /overlay.',
          `Add a Browser Source with URL http://localhost:${port}/overlay, 1920×1080.`));
        return;
      }
      const problems = [];
      for (const s of sources) {
        const m = s.url.match(/:\/\/[^/:]+(?::(\d+))?/);
        const srcPort = Number(m?.[1] || 80);
        if (srcPort !== port) problems.push(`"${s.name}" points at port ${srcPort}, but the server is on ${port}: change its URL to http://localhost:${port}/overlay`);
        if (Number(s.settings.width) !== 1920 || Number(s.settings.height) !== 1080) problems.push(`"${s.name}" is ${s.settings.width}×${s.settings.height}: set it to 1920×1080`);
        if (s.settings.shutdown) problems.push(`"${s.name}": untick "Shutdown source when not visible"`);
        if (s.settings.restart_when_active) problems.push(`"${s.name}": untick "Refresh browser when scene becomes active"`);
      }
      items.push(problems.length
        ? item('obs-source', 'Overlay Browser Source', problems.some(p => p.includes('port')) ? BAD : WARN, problems.join(' · '), 'Fix in OBS: right-click the source → Properties.')
        : item('obs-source', 'Overlay Browser Source', OK, sources.map(s => `"${s.name}"`).join(', ')));
    }, 'Overlay Browser Source');

    // overlay on top of the live scene and the replay scene
    if (sources.length) {
      const names = sources.map(s => s.name);
      const live = obs.status.currentScene;
      const replayScene = replays?.settings?.names?.scene;
      for (const [label, scene] of [['live scene', live], ['replay scene', replayScene]]) {
        if (!scene || (label === 'live scene' && scene === replayScene)) continue;
        await safe(async () => {
          const where = await sceneHasOnTop(obs, scene, names);
          items.push(where === 'top'
            ? item(`top-${label}`, `Overlay on the ${label}`, OK, `On top in "${scene}"`)
            : where === 'missing'
              ? item(`top-${label}`, `Overlay on the ${label}`, label === 'live scene' ? BAD : WARN, `The overlay isn't in "${scene}".`, 'Copy the overlay source, then in that scene right-click → Paste (Reference).')
              : item(`top-${label}`, `Overlay on the ${label}`, WARN, `The overlay is in "${scene}" but not at the top, so other sources can cover the graphics${label === 'replay scene' ? ' and the replay wipe' : ''}.`, 'Drag it to the top of the Sources list.'));
        }, `Overlay on the ${label}`);
      }
    }
  }

  // ---- live sound keeps playing during replays
  const replaySceneName = replays?.settings?.names?.scene;
  if (obs.status.connected && replaySceneName && obs.status.currentScene && obs.status.currentScene !== replaySceneName) {
    await safe(async () => {
      const n = replays.settings.names;
      const a = await analyzeLiveAudio(obs, obs.status.currentScene, replaySceneName, [n.player, n.playerB].filter(Boolean));
      const label = e => `"${e.name}"${e.via.length ? ` (in ${e.via.join(' > ')})` : ''}`;
      const heard = [...a.global.map(g => `${g} (global)`), ...a.heard.map(label)];
      const parts = [
        `Heard during replays: ${heard.length ? heard.join(', ') : 'nothing from the live scene'}, plus the replay at ${replays.settings.volume ?? 50}%.`,
        `Stops during replays: ${a.missing.length ? a.missing.map(label).join(', ') : 'none'}.`,
      ];
      if (a.media.length) parts.push(`Video files in "${obs.status.currentScene}" also go quiet (usually fine): ${a.media.map(label).join(', ')}.`);
      if (!heard.length && !a.missing.length) parts.push('No live sound found at all: is your live audio muted or not added to OBS yet?');
      const detail = parts.join(' ');
      items.push(a.missing.length
        ? item('live-audio', 'Live sound during replays', WARN, detail,
          `Press the button to add ${a.missing.length === 1 ? 'it' : 'them'} to the bottom of "${replaySceneName}" (hidden behind the replay, sound keeps playing).`, 'addLiveAudio')
        : item('live-audio', 'Live sound during replays', !heard.length ? WARN : OK, detail,
          !heard.length ? 'Check the live audio source is in OBS and not muted in the Audio Mixer.' : ''));
    }, 'Live sound during replays');
  }

  // ---- replays
  if (replays && !replays.publicStatus().disabled && replays.replayObs) {
    const ro = replays.replayObs;
    if (!ro.status.connected) {
      items.push(item('replay-obs', 'Replay OBS', BAD, ro.status.error || 'Not connected',
        `Open the portable Replay OBS and enable its WebSocket on ${replays.settings.replay.url} (Settings → Replay settings).`));
    } else {
      items.push(item('replay-obs', 'Replay OBS', OK, `Connected (${ro.url})`));
      items.push(replays.status.bufferActive
        ? item('buffer', 'Replay Buffer', OK, 'Running')
        : item('buffer', 'Replay Buffer', BAD, 'Not running', 'In the Replay OBS: Settings → Output → Enable Replay Buffer, then Start Replay Buffer.'));
      await safe(async () => {
        const { recordDirectory } = await ro.call('GetRecordDirectory');
        if (!recordDirectory || !fs.existsSync(recordDirectory)) {
          items.push(item('disk', 'Replay folder', BAD, `The recording folder "${recordDirectory || '?'}" doesn't exist.`, 'Set a valid Recording Path in the Replay OBS: Settings → Output.'));
          return;
        }
        const st = fs.statfsSync(recordDirectory);
        const free = st.bavail * st.bsize;
        const txt = `${(free / GB).toFixed(1)} GB free in ${recordDirectory}`;
        items.push(free < 2 * GB ? item('disk', 'Replay folder disk space', BAD, txt, 'Free up space or choose another Recording Path.')
          : free < 10 * GB ? item('disk', 'Replay folder disk space', WARN, txt, 'Getting low: free some space before a long match.')
            : item('disk', 'Replay folder disk space', OK, txt));
      }, 'Replay folder');
    }
    if (obs.status.connected) {
      await safe(async () => {
        try {
          await replays.preflight();
          const n = replays.settings.names;
          items.push(item('replay-setup', 'Replay scene, source & transition', OK,
            `"${n.scene}", "${n.player}", ${replays.settings.stinger.mode === 'overlay' ? `graphics wipe (cut: "${replays.settings.stinger.cutTransition}")` : `stinger "${n.transition}"`}`));
        } catch (err) {
          items.push(item('replay-setup', 'Replay scene, source & transition', BAD, err.message));
        }
      }, 'Replay setup');
    }
  } else {
    items.push(item('replays', 'Replays', SKIP, 'Replay module not available'));
  }

  const rank = { bad: 3, warn: 2, ok: 1, skip: 0 };
  const worst = items.reduce((w, i) => (rank[i.status] > rank[w] ? i.status : w), OK);
  return {
    at: Date.now(),
    status: worst,
    counts: { bad: items.filter(i => i.status === BAD).length, warn: items.filter(i => i.status === WARN).length },
    items,
  };
}

// ---------------------------------------------------------------- grouping for the dock
// The checks above stay separate (and tested one by one); the dock shows them as a few lines.
const GROUPS = [
  { id: 'g-server', label: 'Graphics server', ids: ['server', 'pin', 'docks', 'tunnel'] },
  { id: 'g-obs', label: 'Main OBS & overlay', ids: ['main-obs', 'overlay', 'overlay-size', 'obs-source', 'top-live scene', 'top-replay scene'] },
  { id: 'g-sound', label: 'Live sound during replays', ids: ['live-audio'] },
  { id: 'g-replays', label: 'Replays', ids: ['replay-obs', 'buffer', 'disk', 'replay-setup', 'replays'] },
  { id: 'g-lineups', label: 'Lineups', ids: ['teams', 'lineup-home', 'lineup-away', 'kits'] },
];

/** Short wording for a check that passed, used in its group's one-line summary ('' = leave out). */
function okText(i) {
  switch (i.id) {
    case 'server': return i.detail.replace(/^Running on /, '').replace(/ · up .*$/, '');
    case 'pin': return 'PIN set';
    case 'tunnel': return 'remote access on';
    case 'main-obs': return i.detail;
    case 'overlay': return 'overlay loaded';
    case 'overlay-size': return i.detail;
    case 'top-live scene': return 'on top in the live scene';
    case 'top-replay scene': return 'and the replay scene';
    case 'replay-obs': return 'Replay OBS connected';
    case 'buffer': return 'buffer running';
    case 'disk': return i.detail.replace(/ in .*$/, '');
    case 'replay-setup': return 'scene & source ready';
    case 'lineup-home': case 'lineup-away': return `${i.label.replace(/^Lineup: /, '')} ${i.detail.split(' · ')[1] || ''}`.trim();
    case 'live-audio': return i.detail;
    default: return '';
  }
}

export function groupHealth(report) {
  const rank = { bad: 3, warn: 2, ok: 1, skip: 0 };
  const used = new Set();
  const items = [];
  for (const g of GROUPS) {
    const parts = report.items.filter(i => g.ids.includes(i.id));
    if (!parts.length) continue;
    parts.forEach(p => used.add(p));
    const status = parts.reduce((w, i) => (rank[i.status] > rank[w] ? i.status : w), 'skip');
    const problems = parts.filter(p => p.status === 'bad' || p.status === 'warn');
    const summary = parts.filter(p => p.status === 'ok').map(okText).filter(Boolean).join(' · ');
    items.push({
      id: g.id, label: g.label, status,
      detail: problems.length ? '' : summary || parts.map(p => p.detail).filter(Boolean).join(' · '),
      problems: problems.map(p => ({ label: p.label, status: p.status, detail: p.detail, fix: p.fix, action: p.action })),
    });
  }
  // anything not in a group (e.g. a check that failed to run) stays as its own line
  for (const i of report.items) if (!used.has(i)) items.push({ ...i, problems: [] });
  return { ...report, items };
}

/** Teams picked, an XI of 11 in its formation, a captain, and kits that can be told apart. */
export function lineupChecks(state) {
  const out = [];
  const { home, away } = state.teams;
  if (!home.id || !away.id) {
    out.push(item('teams', 'Teams', WARN, 'Both teams aren\'t picked yet.', 'Open the Lineups tab and choose the home and away teams.'));
    return out;
  }
  for (const [side, t] of [['home', home], ['away', away]]) {
    const lu = t.lineup || {};
    const n = (lu.starting || []).length;
    const problems = [];
    if (!n) problems.push('no starting XI picked');
    else if (n !== 11) problems.push(`the starting XI has ${n} players`);
    if (n && !lu.captain) problems.push('no captain');
    if (!lu.formation) problems.push('no formation (the lineup graphic will be a list)');
    else if (n && (lu.slots || []).filter(Boolean).length < Math.min(n, 11)) problems.push('not everyone is placed in the formation');
    const name = t.name || side;
    out.push(problems.length
      ? item(`lineup-${side}`, `Lineup: ${name}`, WARN, problems.join(' · ').replace(/^./, c => c.toUpperCase()) + '.', 'Fix it on the Lineups tab (changes save by themselves).')
      : item(`lineup-${side}`, `Lineup: ${name}`, OK, `XI 11/11 · ${lu.formation} · captain set`));
  }
  const d = colourDistance(home.colors?.primary, away.colors?.primary);
  if (d != null && d < 60) {
    out.push(item('kits', 'Team colours', WARN, `${home.name} and ${away.name} have very similar main colours, so their graphics will look alike.`,
      'On the Lineups tab, change one team\'s Primary colour for this match (e.g. to their away kit).'));
  }
  return out;
}

function colourDistance(a, b) {
  const rgb = h => (/^#[0-9a-f]{6}$/i.test(h || '') ? [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) : null);
  const x = rgb(a), y = rgb(b);
  if (!x || !y) return null;
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** Fix action: press "Refresh cache of current page" on every overlay Browser Source. */
export async function refreshOverlayInObs(obs) {
  const sources = await overlaySources(obs);
  if (!sources.length) throw new Error('No overlay Browser Source found in OBS');
  for (const s of sources) await obs.call('PressInputPropertiesButton', { inputName: s.name, propertyName: 'refreshnocache' });
  return sources.length;
}
