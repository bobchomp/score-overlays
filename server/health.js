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

async function sceneHasOnTop(obs, sceneName, sourceNames) {
  const { sceneItems } = await obs.call('GetSceneItemList', { sceneName });
  const items = sceneItems || [];
  const mine = items.filter(it => sourceNames.includes(it.sourceName));
  if (!mine.length) return 'missing';
  const top = Math.max(...items.map(it => it.sceneItemIndex));
  return mine.some(it => it.sceneItemIndex === top) ? 'top' : 'below';
}

export async function runHealth({ env, obs, replays, clients, build, commit, startedAt }) {
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

/** Fix action: press "Refresh cache of current page" on every overlay Browser Source. */
export async function refreshOverlayInObs(obs) {
  const sources = await overlaySources(obs);
  if (!sources.length) throw new Error('No overlay Browser Source found in OBS');
  for (const s of sources) await obs.call('PressInputPropertiesButton', { inputName: s.name, propertyName: 'refreshnocache' });
  return sources.length;
}
