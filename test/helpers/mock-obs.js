// A small fake OBS (obs-websocket v5, msgpack) for tests. Not a test file itself.
// Simulates what the replay module uses: scenes, transitions, a replay buffer and media inputs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { encode, decode } from '@msgpack/msgpack';

export function startMockObs({
  port,
  scenes = ['Main', 'Wide', 'REPLAY', 'REPLAY B'],
  transitions = ['Fade', 'Cut', 'Replay Stinger'],
  inputs = { 'Replay Player': 'REPLAY', 'Replay Player B': 'REPLAY B' }, // input -> scene it lives in
  program = 'Main',
  transition = 'Fade',
  bufferActive = true,
  emitSaved = true,        // false: never send ReplayBufferSaved (tests the fallback)
  mediaDurationMs = 3000,
  stingerMs = 120,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockobs-'));
  const st = {
    program, transition, bufferActive, emitSaved, lastReplay: null, savedCount: 0,
    log: [], inputSettings: {}, media: {}, clients: new Set(), wss: null, dir,
  };
  const wss = new WebSocketServer({ port, handleProtocols: p => [...p][0] });
  st.wss = wss;

  const sendAll = o => { for (const c of st.clients) c.send(encode(o)); };
  const event = (eventType, eventData) => sendAll({ op: 5, d: { eventType, eventIntent: 1, eventData } });

  function startMedia(input) {
    const settings = st.inputSettings[input] || {};
    stopMedia(input);
    st.media[input] = { state: 'OBS_MEDIA_STATE_PLAYING', duration: mediaDurationMs, cursor: 0, since: Date.now(), speed: settings.speed_percent || 100, file: settings.local_file };
    scheduleEnd(input);
  }
  function scheduleEnd(input) {
    const m = st.media[input];
    clearTimeout(m.timer);
    const wall = ((m.duration - m.cursor) * 100) / m.speed;
    m.timer = setTimeout(() => { m.state = 'OBS_MEDIA_STATE_ENDED'; event('MediaInputPlaybackEnded', { inputName: input }); }, wall);
  }
  function stopMedia(input) {
    const m = st.media[input];
    if (m) { clearTimeout(m.timer); m.state = 'OBS_MEDIA_STATE_STOPPED'; }
  }

  const handlers = {
    GetVersion: () => ({ obsVersion: '30.0.0' }),
    GetSceneList: () => ({ currentProgramSceneName: st.program, scenes: scenes.map((s, i) => ({ sceneName: s, sceneIndex: scenes.length - i })) }),
    GetCurrentProgramScene: () => ({ currentProgramSceneName: st.program, sceneName: st.program }),
    SetCurrentProgramScene: ({ sceneName }) => {
      if (!scenes.includes(sceneName)) throw Object.assign(new Error(`No source was found by the name of \`${sceneName}\`.`), { code: 600 });
      const from = st.program;
      st.program = sceneName;
      event('SceneTransitionStarted', { transitionName: st.transition });
      event('CurrentProgramSceneChanged', { sceneName });
      const t = st.transition;
      setTimeout(() => event('SceneTransitionEnded', { transitionName: t }), t === 'Replay Stinger' ? stingerMs : 5);
      for (const [input, scene] of Object.entries(inputs)) {
        if (scene === sceneName && from !== sceneName) startMedia(input);     // restart_on_activate
        if (scene === from && from !== sceneName) stopMedia(input);           // close_when_inactive
      }
      return {};
    },
    GetSceneTransitionList: () => ({ currentSceneTransitionName: st.transition, transitions: transitions.map(t => ({ transitionName: t })) }),
    GetCurrentSceneTransition: () => ({ transitionName: st.transition }),
    SetCurrentSceneTransition: ({ transitionName }) => {
      if (!transitions.includes(transitionName)) throw Object.assign(new Error('No transition'), { code: 600 });
      st.transition = transitionName; return {};
    },
    GetInputSettings: ({ inputName }) => {
      if (!(inputName in inputs)) throw Object.assign(new Error(`No source was found by the name of \`${inputName}\`.`), { code: 600 });
      return { inputSettings: st.inputSettings[inputName] || {}, inputKind: 'ffmpeg_source' };
    },
    SetInputSettings: ({ inputName, inputSettings }) => {
      if (!(inputName in inputs)) throw Object.assign(new Error(`No source was found by the name of \`${inputName}\`.`), { code: 600 });
      st.inputSettings[inputName] = { ...(st.inputSettings[inputName] || {}), ...inputSettings };
      if (inputs[inputName] === st.program) startMedia(inputName); // active source reloads with the new file
      return {};
    },
    GetMediaInputStatus: ({ inputName }) => {
      const m = st.media[inputName];
      if (!m) return { mediaState: 'OBS_MEDIA_STATE_NONE', mediaDuration: null, mediaCursor: null };
      return { mediaState: m.state, mediaDuration: m.duration, mediaCursor: m.cursor };
    },
    SetMediaInputCursor: ({ inputName, mediaCursor }) => {
      const m = st.media[inputName];
      if (m) { m.cursor = mediaCursor; scheduleEnd(inputName); }
      return {};
    },
    TriggerMediaInputAction: ({ inputName }) => { stopMedia(inputName); return {}; },
    GetReplayBufferStatus: () => ({ outputActive: st.bufferActive }),
    StartReplayBuffer: () => { st.bufferActive = true; event('ReplayBufferStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' }); return {}; },
    SaveReplayBuffer: () => {
      if (!st.bufferActive) throw Object.assign(new Error('Replay buffer is not active.'), { code: 501 });
      const file = path.join(dir, `Replay ${++st.savedCount}.mkv`);
      setTimeout(() => {
        fs.writeFileSync(file, 'fake');
        st.lastReplay = file;
        if (st.emitSaved) event('ReplayBufferSaved', { savedReplayPath: file });
      }, 60);
      return {};
    },
    GetLastReplayBufferReplay: () => ({ savedReplayPath: st.lastReplay }),
  };

  wss.on('connection', ws => {
    st.clients.add(ws);
    ws.on('close', () => st.clients.delete(ws));
    ws.send(encode({ op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1 } }));
    ws.on('message', raw => {
      const m = decode(raw);
      if (m.op === 1) return ws.send(encode({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      if (m.op !== 6) return;
      const { requestType, requestId, requestData } = m.d;
      st.log.push({ requestType, requestData: requestData || {}, at: Date.now(), program: st.program, transition: st.transition });
      let status = { result: true, code: 100 };
      let responseData = {};
      try {
        const h = handlers[requestType];
        if (!h) throw Object.assign(new Error(`Unknown request ${requestType}`), { code: 204 });
        responseData = h(requestData || {});
      } catch (err) {
        status = { result: false, code: err.code || 500, comment: err.message };
      }
      ws.send(encode({ op: 7, d: { requestType, requestId, requestStatus: status, responseData } }));
    });
  });

  return {
    st,
    calls: type => st.log.filter(l => l.requestType === type),
    ready: new Promise(r => wss.on('listening', r)),
    async close() {
      for (const c of st.clients) c.terminate();
      for (const m of Object.values(st.media)) clearTimeout(m.timer);
      await new Promise(r => wss.close(r));
    },
  };
}
