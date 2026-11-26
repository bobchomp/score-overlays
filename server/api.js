// REST API: used by the setup screen, the dock (uploads/exports) and Stream Deck / Companion.
import express from 'express';
import {
  listTeams, saveTeam, deleteTeam, loadTheme, saveTheme, listFonts, saveLogo, listLogos, loadTeam,
} from './config.js';
import { pinFromRequest } from './auth.js';
import { exportJson, exportCsv } from './export.js';

export function createApi({ store, obs, auth, demo, onThemeChange, snapshot, replays, health, streamDeck = false }) {
  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));

  const requirePin = (req, res, next) => {
    const r = auth.check(pinFromRequest(req), req.ip);
    if (!r.ok) return res.status(401).json({ ok: false, error: r.error });
    next();
  };

  const run = (res, action, payload) => {
    const r = store.dispatch(action, payload, { source: 'http' });
    res.status(r.ok ? 200 : 400).json(r);
  };

  // ---------- public reads ----------
  api.get('/state', (req, res) => res.json(snapshot()));
  api.get('/teams', (req, res) => res.json(listTeams()));
  api.get('/theme', (req, res) => res.json(loadTheme()));
  api.get('/fonts', (req, res) => res.json(listFonts().map(f => f.family)));
  api.get('/logos', (req, res) => res.json(listLogos()));

  api.post('/auth', (req, res) => {
    const r = auth.check(req.body?.pin, req.ip);
    res.status(r.ok ? 200 : 401).json(r);
  });

  // Everything below needs the PIN.
  api.use(requirePin);

  // ---------- pre-match health check ----------
  api.get('/health', async (req, res) => {
    try { res.json(await health()); } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ---------- generic action ----------
  api.post('/action', (req, res) => run(res, req.body?.action, req.body?.payload));
  api.post('/undo', (req, res) => run(res, 'undo'));

  // ---------- simple endpoints for Stream Deck / Companion ----------
  // Kept up to date but OFF unless .env has STREAM_DECK_API=on (nothing uses them yet).
  const deckOn = (req, res, next) => (streamDeck ? next()
    : res.status(404).json({ ok: false, error: 'The Stream Deck API is turned off. Set STREAM_DECK_API=on in .env and restart the server to use it.' }));
  const deck = { post: (path, ...handlers) => api.post(path, deckOn, ...handlers) };
  deck.post('/goal/:team', (req, res) => {
    const r = store.dispatch('goal.add', { team: req.params.team, playerId: req.body?.playerId }, { source: 'http' });
    res.status(r.ok ? 200 : 400).json(r);
    // Save a replay of the goal into the queue (replay problems never affect the goal itself).
    if (r.ok && replays?.goalClip) replays.goalClip(`${store.state.teams[r.result.event.team].name} ${r.result.teamGoals}`, r.result.event.id).catch(() => {});
  });
  deck.post('/goal/:team/remove', (req, res) => run(res, 'goal.removeLast', { team: req.params.team }));
  deck.post('/clock/:op', (req, res) => {
    const map = { toggle: 'clock.toggle', start: 'clock.start', pause: 'clock.pause', reset: 'clock.reset' };
    if (!map[req.params.op]) return res.status(404).json({ ok: false, error: 'Unknown clock operation' });
    run(res, map[req.params.op]);
  });
  deck.post('/period/:period', (req, res) => run(res, 'clock.period', { period: req.params.period.toUpperCase() }));
  deck.post('/added-time/show', (req, res) => run(res, 'added.show', { visible: true }));
  deck.post('/added-time/hide', (req, res) => run(res, 'added.show', { visible: false }));
  deck.post('/added-time/:minutes', (req, res) => run(res, 'clock.addedTime', { minutes: req.params.minutes }));
  deck.post('/board/:kind', (req, res) => run(res, 'board.show', { kind: req.params.kind.toUpperCase(), toggle: true }));
  deck.post('/lineup/:team', (req, res) => run(res, 'lineup.show', { team: req.params.team, toggle: true }));
  deck.post('/scorebug/toggle', (req, res) => run(res, 'scorebug.set', {}));
  deck.post('/scorebug/clock/toggle', (req, res) => run(res, 'scorebug.clock', {}));
  deck.post('/pens/:team/:result', (req, res) => {
    if (!['scored', 'missed'].includes(req.params.result)) return res.status(404).json({ ok: false, error: 'Use scored or missed' });
    run(res, 'shootout.kick', { team: req.params.team, scored: req.params.result === 'scored' });
  });
  deck.post('/pens/toggle', (req, res) => run(res, 'shootout.show', {}));
  // replays (Stream Deck / Companion)
  const replay = (op, args) => async (req, res) => {
    try { const r = await replays.handle(op, typeof args === 'function' ? args(req) : args); res.status(r?.ok === false ? 409 : 200).json({ ok: r?.ok !== false, ...(r || {}) }); }
    catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  };
  deck.post('/replay/now', replay('now', { speed: 100 }));
  deck.post('/replay/slow', replay('now', { speed: 'slow' }));
  deck.post('/replay/mark', replay('mark', req => ({ tag: req.body?.tag || req.query.tag })));
  deck.post('/replay/abort', replay('abort'));
  deck.post('/replay/play-all', replay('playAll', { speed: 100 }));
  deck.post('/queue/show', (req, res) => run(res, 'eventQueue.show'));
  deck.post('/queue/clear', (req, res) => run(res, 'eventQueue.clear'));
  deck.post('/hide-all', (req, res) => run(res, 'graphics.hideAll'));
  deck.post('/scene/:name', async (req, res) => {
    try { await obs.setScene(req.params.name); res.json({ ok: true }); } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  // ---------- config editing ----------
  api.post('/teams', (req, res) => {
    try {
      const team = saveTeam(req.body || {});
      store.dispatch('team.refresh', { teamId: team.id });
      res.json({ ok: true, team });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });
  api.delete('/teams/:id', (req, res) => {
    const s = store.state;
    if (s.teams.home.id === req.params.id || s.teams.away.id === req.params.id) {
      return res.status(400).json({ ok: false, error: 'That team is in the current match. Pick different teams first.' });
    }
    if (!loadTeam(req.params.id)) return res.status(404).json({ ok: false, error: 'Team not found' });
    deleteTeam(req.params.id);
    res.json({ ok: true });
  });
  api.put('/theme', (req, res) => {
    try { const theme = saveTheme(req.body || {}); onThemeChange(); res.json({ ok: true, theme }); } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });
  api.post('/upload', express.raw({ type: 'image/*', limit: '10mb' }), (req, res) => {
    try { res.json({ ok: true, url: saveLogo(req.query.name, req.get('content-type'), req.body) }); } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  // ---------- demo ----------
  api.post('/demo/start', (req, res) => { try { demo.start(); res.json({ ok: true }); } catch (err) { res.status(400).json({ ok: false, error: err.message }); } });
  api.post('/demo/stop', (req, res) => { demo.stop(); res.json({ ok: true }); });

  // ---------- export ----------
  api.get('/export.json', (req, res) => {
    res.attachment(`match-${dateStamp()}.json`).json(exportJson(store.state));
  });
  api.get('/export.csv', (req, res) => {
    res.attachment(`match-${dateStamp()}.csv`).type('text/csv').send(exportCsv(store.state));
  });

  api.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));
  return api;
}

function dateStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
