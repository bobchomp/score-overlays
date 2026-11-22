// obs-websocket (v5) connection. Graphics never depend on this: if OBS is unreachable
// we keep retrying in the background and only OBS features (scene switching, replays) are unavailable.
// Used twice: the main (streaming) OBS and the Replay OBS.
import { EventEmitter } from 'node:events';
import OBSWebSocket from 'obs-websocket-js';

const RETRY_MS = 5000;

export class ObsLink extends EventEmitter {
  /**
   * @param {{url?: string, host?: string, port?: number, password?: string}} opts
   * @param {object} obsConfig  config/obs.json (main OBS only)
   * @param {string} label      shown in logs and error messages, e.g. "Main OBS"
   */
  constructor(opts, obsConfig = {}, label = 'OBS') {
    super();
    this.label = label;
    this.url = opts.url || `ws://${opts.host}:${opts.port}`;
    this.password = opts.password || undefined;
    this.config = obsConfig;
    this.obs = new OBSWebSocket();
    this.status = { connected: false, connecting: false, error: null, currentScene: null, scenes: [], url: this.url };
    this.retryTimer = null;
    this.stopped = false;

    this.obs.on('ConnectionClosed', err => {
      const wasConnected = this.status.connected;
      this.update({ connected: false, connecting: false, error: friendlyError(err) || (wasConnected ? 'Connection closed' : this.status.error) });
      if (wasConnected) this.emit('disconnected');
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
    this.update({ connecting: true, url: this.url });
    try {
      await this.obs.connect(this.url, this.password, { rpcVersion: 1 });
      this.update({ connected: true, connecting: false, error: null });
      console.log(`[obs] ${this.label} connected (${this.url})`);
      await this.refreshScenes();
      this.emit('connected');
    } catch (err) {
      const msg = friendlyError(err);
      if (msg !== this.status.error) console.warn(`[obs] ${this.label} not connected (${msg}). Graphics still work; retrying every ${RETRY_MS / 1000}s.`);
      this.update({ connected: false, connecting: false, error: msg });
      this.scheduleRetry();
    }
  }

  scheduleRetry() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), RETRY_MS);
  }

  /** Change URL/password (from the dock's settings) and reconnect if they differ. */
  reconfigure({ url, password }) {
    const nextPw = password || undefined;
    if (url === this.url && nextPw === this.password) return;
    this.url = url;
    this.password = nextPw;
    this.update({ url });
    clearTimeout(this.retryTimer);
    const reconnect = () => { this.update({ connecting: false }); this.connect(); };
    if (this.status.connected || this.status.connecting) {
      this.obs.disconnect().catch(() => {}).finally(() => setTimeout(reconnect, 200));
    } else {
      reconnect();
    }
  }

  async refreshScenes() {
    try {
      const res = await this.obs.call('GetSceneList');
      this.update({ scenes: sceneNames(res.scenes), currentScene: res.currentProgramSceneName });
    } catch (err) {
      console.warn(`[obs] ${this.label} GetSceneList failed:`, err.message);
    }
  }

  /** obs.call with a clear error when not connected. */
  async call(requestType, requestData) {
    if (!this.status.connected) throw new Error(`${this.label} is not connected`);
    return this.obs.call(requestType, requestData);
  }

  async setScene(sceneName) {
    if (!this.status.connected) throw new Error(`${this.label} is not connected, so scene switching is unavailable`);
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
  if (!err) return null;
  const m = err?.message || String(err);
  if (/ECONNREFUSED/i.test(m)) return 'OBS not running or WebSocket server disabled';
  if (/auth/i.test(m) || err?.code === 4009) return 'OBS WebSocket password incorrect';
  return m || 'Unknown error';
}
