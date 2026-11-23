# Score Overlays

Local football match graphics and instant replays for OBS. A small Node server on the streaming PC holds the match;
OBS shows the graphics as a Browser Source, and you run everything from a control dock in OBS, a browser window,
or your phone.

**Running a match? Use [MATCHDAY.md](MATCHDAY.md).** This page is setup and reference. Replays are set up in
[REPLAYS.md](REPLAYS.md).

- **Graphics:** scorebug (clock, added time, red cards, aggregate), goal sting and scorer, cards, subs, kick-off /
  half-time / full-time boards, lineups, text lower thirds, penalty shootout tracker, REPLAY bug and wipe.
- **Control dock:** squad pickers (no typing names mid-match), undo, keyboard shortcuts, pre-match check.
- **Replays** (optional): instant replays from a second OBS, a clip queue, and a highlights reel after the match.
- **Reliable:** all state is saved on every change. Refresh any page or restart the server and everything comes
  back, clock included. **No internet needed** at match time.

---

## 1. Install (once)

1. Install **Node.js LTS** (20.12 or newer) from <https://nodejs.org> and **Git** from <https://git-scm.com/download/win>.
2. Get the app with git (so it can update itself). In PowerShell:
   ```
   cd $HOME\Documents
   git clone https://github.com/bobchomp/score-overlays.git
   ```
3. Double-click **`start.bat`** in the new folder. The first run installs everything and creates a `.env` file.
4. Open `.env` in Notepad, set these, then restart (close the server window and run `start.bat` again):
   ```ini
   PORT=3000                  # change if another program uses 3000 (the server warns you)
   CONTROL_PIN=your-pin-here  # needed for the dock, setup screen and Stream Deck
   OBS_HOST=127.0.0.1
   OBS_PORT=4455
   OBS_PASSWORD=the password from OBS
   ```
   `.env` stays on your PC and is never uploaded.

The server window lists the addresses to use:
```
 Overlay (OBS Browser Source):  http://localhost:3000/overlay
 Control dock (OBS Custom Dock): http://localhost:3000/dock
 Match setup:                   http://localhost:3000/setup
 From your phone:               http://192.168.1.20:3000/dock
```

### Updating
Double-click **`update.bat`**. It stops the server, downloads the latest version, installs anything new, and starts the
server again. The overlay in OBS and the dock reload themselves. If you've edited files that came with the app (such
as an example team), they're backed up to `data\update-backup\<date>\` first. Your teams, theme, match and replays
are kept. If anything goes wrong, it stops and says why, without changing anything else.

## 2. Set up OBS (once)

OBS Studio 28 or newer.

1. **WebSocket:** **Tools → WebSocket Server Settings** → tick *Enable WebSocket server* (port 4455) and *Enable
   Authentication*. **Show Connect Info** shows the password: put it in `OBS_PASSWORD` in `.env`.
2. **Overlay:** in your live scene, **+ → Browser**, name it `Match Graphics`:
   - URL `http://localhost:3000/overlay`, width **1920**, height **1080**.
   - **Untick** *Shutdown source when not visible* and *Refresh browser when scene becomes active*.
   - Put it at the **top** of the source list.
   - For other scenes (including the REPLAY scene): right-click it → **Copy**, then in that scene right-click →
     **Paste (Reference)**, so every scene shares the same overlay.
3. **Dock:** **Docks → Custom Browser Docks…** (OBS 28/29: *View → Docks*). Name `Match Control`, URL
   `http://localhost:3000/dock`. It works narrow (one column) or wide (four columns). A big browser window on a second
   screen is the most comfortable. Enter your PIN once; it's remembered.
4. **Phone (optional):** open the "From your phone" address on the same Wi-Fi. If it won't connect, allow Node.js on
   *Private networks* in Windows Firewall.

Then open **Settings → Pre-match check** in the dock: it checks all of the above and says what to fix.

## 3. The dock

**Live tab** (during the match): score and clock · graphics, cards & subs, text lower third · replays and the replay
queue · match events. On a narrow window it stacks, with score, clock and replay buttons first.

**Settings tab:** pre-match check, overlay preview, options (auto-show graphics, GOAL! sting for home/away goals),
match setup, exports, demo, lock, **Reset game**, and replay settings.

| Action | How |
| --- | --- |
| Goal | **+ GOAL** → pick the scorer (players on the pitch first; *Penalty* / *Own goal* toggles). **⚽ Goal now, scorer later** updates the score and plays GOAL! straight away, then you pick the scorer when you know. *Scorer unknown* can be fixed later with **Edit**. Home goals get the big GOAL! sting; away goals don't, unless you switch that on in Options. A replay of the goal is saved to the queue as e.g. "Ross County 2". |
| Remove a goal | **− remove**, or **Undo**. |
| Clock | **▶ KICK OFF** starts 1H. **HT**, then **▶ START 2ND HALF** (jumps to 45:00). Period buttons for FT, ET1, ET2, PEN. Nudge ±1s/10s/1m or **Set time…** to correct it. |
| Added time | Type minutes in *Added time* and press Enter (or **+ / −**); **Clear** removes the "+3". **Hide** takes it off the scorebug but keeps the number; **Show** puts it back. It clears (and goes back to shown) when the period changes. |
| Cards | Per team, then pick the player. A second yellow becomes a red. Each red raises a small red card above that team on the scorebug. |
| Subs | Player **off**, then player **on**. |
| Boards & lineups | Toggles in *Graphics* (green light = on air). Boards hide the scorebug while shown. |
| Hide the clock | **Scorebug clock** toggle. The clock keeps running underneath. |
| Text lower third | Title + subtitle (or a preset, or *From player…*), then **Show**. |
| Penalties | Period **PEN** → *Penalty shootout* tile: **✓ Scored / ✗ Missed** per kick; **Penalties lower third** shows the dots. The scorebug and full-time board show the result. |
| Two-legged tie | **Match setup → Match** → *Two-legged tie* + first-leg score: AGG tab on the scorebug, and an aggregate line on the boards. |
| Re-show a graphic | **Show** next to any event in *Match events*. |
| Undo | **⟲ Undo** (shows what it will undo), up to 30 steps. |
| Reset game | **Settings → Reset game…**: score/events/clock only, or everything including teams. Undo brings it back. |

Lower thirds for goals, cards and subs hide after 8 seconds (set in **Match setup → Theme → Timings**).

**Shortcuts** (click inside the dock first): `G` home goal · `H` away goal · `Space` start/pause · `Esc` hide all
graphics · `Ctrl+Z` undo · `R` replay · `T` slow-mo replay · `M` mark · `B` abort replay (replay keys can be
changed in Replay settings).

**Demo:** **Settings → Run demo match** plays a 3-minute simulated match to check every graphic. Your real match is
put back when you press **Stop demo**.

## 4. Teams, theme and badges

All editable in **Match setup** (`/setup`):
- **Teams tab:** name, short name, colours, badge upload, squad (number, name, position). You can paste a list, one
  player per line: `9 Dan Kerr FWD`. Saved as `config/teams/<id>.json`.
- **Theme tab:** club badge, all graphic colours, fonts, every on-screen word ("GOAL!", "HALF TIME", "REPLAY"…) and
  timings. Saved to `data/theme.json`; delete that file to return to the default `config/theme.json`.
- Badges are stored in `public/assets/logos/`. Fonts live in `public/assets/fonts/<Font Name>/<weight>.woff2`: drop in a
  folder and restart to add one.

## 5. Stream Deck / Bitfocus Companion

**POST** with the PIN (`X-Pin` header or `?pin=…`), e.g. `http://192.168.1.20:3000/api/goal/home?pin=1234`:

| Endpoint | Does |
| --- | --- |
| `/api/goal/home` · `/api/goal/away` · `/api/goal/home/remove` | Goal / remove last goal |
| `/api/clock/toggle` · `/start` · `/pause` · `/reset` | Clock |
| `/api/period/2H` | Period (`PRE 1H HT 2H FT ET1 ET2 PEN`) |
| `/api/added-time/3` | Added time |
| `/api/added-time/show`, `/api/added-time/hide` | Show or hide the added-time badge |
| `/api/board/HT` · `/api/lineup/home` | Toggle a board (`KO HT FT`) / lineup |
| `/api/scorebug/toggle` · `/api/scorebug/clock/toggle` · `/api/hide-all` · `/api/undo` | |
| `/api/pens/home/scored` · `/api/pens/away/missed` · `/api/pens/toggle` | Penalty shootout |
| `/api/replay/now` · `/slow` · `/mark?tag=Goal` · `/abort` · `/play-all` | Replays |
| `/api/scene/<name>` | Switch OBS scene |
| `/api/action` | Any action, JSON body `{ "action": "card.add", "payload": { … } }` |

`GET /api/export.csv?pin=…` and `/api/export.json` give the event log, and `GET /api/health?pin=…` gives the pre-match check.

## Troubleshooting

Start with **Settings → Pre-match check**: it catches most setup problems and says how to fix them.

- **Dock shows DISCONNECTED:** the server isn't running. Run `start.bat`. Pages reconnect by themselves.
- **"ANOTHER PROGRAM IS USING PORT" in the server window,** or "connection was reset" in the browser: another app is on
  that port. Set e.g. `PORT=3080` in `.env`, restart, and change the overlay/dock URLs in OBS to `:3080`.
- **"Port … is already in use":** the server is already running in another window.
- **Shortcuts do nothing:** click inside the dock first so it has keyboard focus.
- **Start completely fresh:** stop the server and delete `data/state.json`.

## For developers

```
server/    index.js (HTTP + WebSocket), store.js + actions.js (match state, undo), obs.js (obs-websocket),
           replays.js + highlights.js (replays, reel), health.js (pre-match check), api.js, demo.js, build.js
public/    overlay/, dock/, setup/, shared/ (code used by server and pages), assets/ (fonts, logos)
config/    default theme, example teams        data/  live state, theme, replays (not in git)
scripts/   update.ps1 (used by update.bat)     test/  npm test, plus updater.ps1 (Windows dry run)
```

`npm test` runs the test suite (simulated OBS instances, real ffmpeg). GitHub Actions runs it on Windows and Linux on
every push, along with a dry run of the updater in Windows PowerShell.
