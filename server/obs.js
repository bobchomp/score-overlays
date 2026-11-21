// obs-websocket (v5) connection. Graphics never depend on this: if OBS is unreachable
// we keep retrying in the background and only scene switching is unavailable.
import { EventEmitter } from 'node:events';
import OBSWebSocket from 'obs-websocket-js';

const RETRY_MS = 5000;

export class ObsLink extends EventEmitter {
  constructor({ host, port, password }, obsConfig = {}) {
    super();
    this.url = `ws://${host}:${port}`;
    this.password = password;
    this.config = obsConfig;
    this.obs = new OBSWebSocket();
    this.status = { connected: false, connecting: false, error: null, currentScene: null, scenes: [], url: this.url };
    this.retryTimer = null;
    this.stopped = false;

    this.obs.on('ConnectionClosed', err => {
      const wasConnected = this.status.connected;
      this.update({ connected: false, connecting: false, error: err?.message || (wasConnected ? 'Connection closed' : this.status.error) });
      this.scheduleRetry();
    });
    this.obs.on('CurrentProgramSceneChanged', ({ sceneName }) => this.update({ currentScene: sceneName }));
    this.obs.on('SceneListChanged', ({ scenes }) => this.update({ scenes: sceneNames(scenes) }));
    this.obs.on('SceneNameChanged', () => this.refreshScenes());
  }

  update(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.publicStatus());
  }

  publicStatus() {
    const configured = (this.config.scenes || []).filter(Boolean);
    return {
      ...this.status,
      // Scenes the dock offers as buttons: the configured list, or every OBS scene.
      buttons: configured.length ? configured : this.status.scenes,
      mainScene: this.config.mainScene || null,
    };
  }

  async start() {
    this.stopped = false;
    await this.connect();
  }

  async connect() {
    if (this.stopped || this.status.connected || this.status.connecting) return;
    this.update({ connecting: true });
    try {
      await this.obs.connect(this.url, this.password, { rpcVersion: 1 });
      this.update({ connected: true, connecting: false, error: null });
      console.log(`[obs] connected to ${this.url}`);
      await this.refreshScenes();
    } catch (err) {
      const msg = friendlyError(err);
      if (msg !== this.status.error) console.warn(`[obs] not connected (${msg}). Graphics still work; retrying every ${RETRY_MS / 1000}s.`);
      this.update({ connected: false, connecting: false, error: msg });
      this.scheduleRetry();
    }
  }

  scheduleRetry() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), RETRY_MS);
  }

  async refreshScenes() {
    try {
      const res = await this.obs.call('GetSceneList');
      this.update({ scenes: sceneNames(res.scenes), currentScene: res.currentProgramSceneName });
    } catch (err) {
      console.warn('[obs] GetSceneList failed:', err.message);
    }
  }

  async setScene(sceneName) {
    if (!this.status.connected) throw new Error('OBS is not connected, so scene switching is unavailable');
    if (!sceneName) throw new Error('No scene name given');
    await this.obs.call('SetCurrentProgramScene', { sceneName });
    this.update({ currentScene: sceneName });
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    try { await this.obs.disconnect(); } catch {}
  }
}

function sceneNames(scenes = []) {
  // OBS returns scenes bottom-to-top; reverse so they match the order shown in OBS.
  return [...scenes].sort((a, b) => b.sceneIndex - a.sceneIndex).map(s => s.sceneName);
}

function friendlyError(err) {
  const m = err?.message || String(err);
  if (/ECONNREFUSED/i.test(m)) return 'OBS not running or WebSocket server disabled';
  if (/auth/i.test(m) || err?.code === 4009) return 'OBS WebSocket password incorrect';
  return m || 'Unknown error';
}
