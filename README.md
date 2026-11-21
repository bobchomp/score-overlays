# Score Overlays

Local football match graphics for OBS. A small Node server holds the match state; OBS shows the overlay as a
Browser Source and you run the match from a control dock inside OBS, or from your phone.

- **Overlay**: scorebug with match clock, half indicator and added time; goal sting with a scorer lower third; yellow,
  red and second-yellow cards; substitutions; kick-off, half-time and full-time boards with goalscorers;
  full-screen lineups; free-text lower thirds.
- **Control dock**: big buttons, squad pickers (no typing names mid-match), multi-level undo, keyboard shortcuts, OBS scene buttons,
  live preview, event export.
- **Setup screen**: pick teams and lineups, and edit squads, kit colours, badges, theme colours, fonts and every on-screen title.
- **Reliable**: the server owns all state and saves it to `data/state.json` on every change. Refresh any page, or
  restart the server, and everything comes back, clock included. The clock is timestamp-based, so it never drifts.
- **No internet needed** at match time. Fonts, logos and code are all served locally.

---

## 1. Install (once)

1. Install **Node.js LTS** (20.12 or newer) from <https://nodejs.org>.
2. Download or clone this folder to your streaming PC.
3. Double-click **`start.bat`**. On the first run it installs dependencies and creates a `.env` file, then starts the server.
   (Or in a terminal: `npm install`, then `npm start`.)
4. Open `.env` in Notepad and set your PIN and OBS password:

   ```ini
   PORT=3000
   CONTROL_PIN=your-pin-here
   OBS_HOST=127.0.0.1
   OBS_PORT=4455
   OBS_PASSWORD=the password from OBS
   ```

   Restart the server after editing `.env` (close the window and run `start.bat` again).

> `.env` is never committed to git, so your PIN and OBS password stay on your PC. If `CONTROL_PIN` is empty, the server
> makes up a temporary PIN and prints it in the console.

When the server is running, the console shows the addresses:

```
 Overlay (OBS Browser Source):  http://localhost:3000/overlay
 Control dock (OBS Custom Dock): http://localhost:3000/dock
 Match setup:                   http://localhost:3000/setup
 From your phone:               http://192.168.1.20:3000/dock
```

## 2. Set up OBS (once)

You need OBS Studio 28 or newer, which has obs-websocket built in.

### Enable obs-websocket
1. **Tools → WebSocket Server Settings**.
2. Tick **Enable WebSocket server**. Leave the port as 4455.
3. Tick **Enable Authentication**, click **Show Connect Info**, and copy the password into `OBS_PASSWORD` in `.env`.
4. Restart the score server. The dock's OBS dot turns green.

If OBS isn't reachable, the graphics keep working. The dock shows a yellow warning and scene buttons are switched
off until OBS comes back; the server retries every 5 seconds.

### Add the overlay (Browser Source)
1. In your main scene: **+ → Browser**, name it `Match Graphics`.
2. URL `http://localhost:3000/overlay`, width **1920**, height **1080**.
3. Leave **Custom CSS** as it is (the page is already transparent).
4. **Untick** "Shutdown source when not visible" and "Refresh browser when scene becomes active".
5. Put it at the top of the source list, above the ATEM capture.

To show graphics in other scenes too, right-click the source → **Copy**, then in the other scene
**Paste (Reference)**. Every scene then shares the same overlay. (Alternatively, put it in a "Graphics" scene and add
that scene as a source wherever you need it.)

### Add the control dock (Custom Browser Dock)
1. **Docks → Custom Browser Docks…** (OBS 28/29: **View → Docks → Custom Browser Docks…**).
2. Dock name `Match Control`, URL `http://localhost:3000/dock`, then **Apply**.
3. Drag the dock where you like. It's designed for 350–400 px wide.
4. Enter your PIN once; the dock remembers it.

### Use it from a phone
Open the "From your phone" address from the console on a phone on the same Wi-Fi. The first time, Windows may ask
whether Node.js can use the network. Allow it on **Private networks**. If the phone can't connect, check Windows
Firewall → *Allow an app* → Node.js → Private.

## 3. Before each match

1. Open **Match setup** (from the dock: *Options → Match setup*, or `http://localhost:3000/setup`).
2. **Match tab**: enter the competition name (and optionally upload its badge), pick the home and away teams, and adjust kit
   colours if there's a clash. Mark each player **XI** or **SUB** and choose the captain (**C**).
3. Click **Start NEW match**. This clears the score, events and clock. (**Apply to current match** keeps them, which is
   useful for fixing a lineup or kit colour mid-match.)

## 4. During the match (dock)

| Action | How |
| --- | --- |
| Goal | **+ GOAL** opens the squad picker (players on the pitch first). Optional *Penalty* / *Own goal* toggles. Or choose *Scorer unknown* and set it later with **Edit** in the events list. The score updates, and the GOAL sting plus a scorer lower third play automatically. |
| Remove a goal | **− remove** (asks first), or **Undo**. |
| Clock | **▶ KICK OFF** starts 1H. Pick **HT** at half time; the button becomes **▶ START 2ND HALF** (the clock jumps to 45:00). Use the period buttons for FT, ET1, ET2 and PEN. |
| Fix the clock | Nudge ±1s / ±10s / ±1m, or **Set time…** (type what the scorebug should show, e.g. `23:15`). |
| Added time | Type the minutes in the *Added time* box and press Enter, or use **+ / −**. This shows the "+3" badge; **Clear** removes it. It clears automatically when the period changes. |
| Cards | Yellow/red per team, then pick the player. A second yellow automatically becomes a red (shown as yellow + red). |
| Subs | Pick the player **off**, then the player **on**. |
| Boards & lineups | Toggle buttons. A green light means the graphic is on air. Showing a board hides the scorebug and lower thirds. |
| Text lower third | Type a title and subtitle (or click a preset, or *From player…*), then **Show**. |
| Re-show a graphic | **Show** next to any event in *Match events*. |
| Undo | **⟲ Undo** at the top (it shows what will be undone). It goes back up to 30 steps of goals, cards, subs and clock changes. |
| OBS scenes | Buttons under *OBS scenes*; the live scene is red. |
| Reset game | **Reset game…** at the bottom of the dock. Choose *Reset score, events & clock* (keeps teams, lineups and competition) or *Reset EVERYTHING* (clears those too). All graphics are hidden. **Undo** brings it all back if pressed by mistake. |

Lower thirds for goals, cards and subs hide themselves after 8 seconds (change this in *Theme → Timings*). Text lower thirds stay
until you hide them. Each type can be set not to show automatically in *Options*.

### Keyboard shortcuts (when the dock has focus)
`G` home goal · `H` away goal · `Space` start/pause clock · `Esc` hide all graphics (or close a picker) · `Ctrl+Z` undo

## 5. Demo mode

Check every graphic without a real game: **Options → Run demo match** in the dock, or start the server with `npm run demo`.
It plays a simulated match (lineups, goals including a penalty and an own goal, cards including a second yellow,
subs, added time, HT/FT boards) over about 3 minutes. Your real match state is backed up first and restored when you
press **Stop demo**, or the next time the server starts.

## 6. Teams, theme and badges

Everything can be edited in the **setup screen**; it writes these files for you:

- `config/teams/<id>.json`: one file per team:
  ```json
  {
    "name": "Riverside FC",
    "short": "RIV",
    "colors": { "primary": "#0b3d91", "secondary": "#ffffff", "text": "#ffffff" },
    "logo": "/assets/logos/riverside.svg",
    "squad": [ { "id": "p9", "number": 9, "name": "Dan Kerr", "position": "FWD" } ]
  }
  ```
  `position` is `GK`, `DEF`, `MID` or `FWD`. The **Teams** tab can also import a pasted list, one player per line, e.g. `9 Dan Kerr FWD`.
- `config/theme.json`: club name and badge, all graphic colours, fonts, every on-screen title ("GOAL!", "HALF TIME",
  "STARTING XI"…) and timings. Saving the theme updates the live overlay immediately.
- `config/obs.json`: `scenes`, an optional list of scene names to show as dock buttons, e.g. `["Main", "Wide", "Half time"]`.
  When it's empty, every OBS scene gets a button.
- `public/assets/logos/`: badges. Uploads from the setup screen land here; PNG, JPG, SVG, WebP and GIF all work.
- `public/assets/fonts/<Font Name>/<weight>.woff2`: bundled fonts are Barlow, Barlow Condensed, Oswald, Teko and
  Roboto Condensed (all SIL Open Font License). Drop in another font folder and restart to make it selectable.

## 7. Stream Deck / Bitfocus Companion

Every call needs the PIN, either as header `X-Pin: <pin>` or as `?pin=<pin>`. Use **POST**:

| Endpoint | Does |
| --- | --- |
| `/api/goal/home`, `/api/goal/away` | Goal (scorer can be set later in the dock) |
| `/api/goal/home/remove` | Remove last home goal |
| `/api/clock/toggle` · `/start` · `/pause` · `/reset` | Clock |
| `/api/period/2H` | Set period (`PRE 1H HT 2H FT ET1 ET2 PEN`) |
| `/api/added-time/3` | Added time badge |
| `/api/board/HT` | Toggle board (`KO`, `HT`, `FT`) |
| `/api/lineup/home` | Toggle lineup |
| `/api/scorebug/toggle` · `/api/hide-all` · `/api/undo` | |
| `/api/scene/Wide%20Shot` | Switch OBS scene |
| `/api/action` | Any action: JSON body `{ "action": "card.add", "payload": { "team": "away", "playerId": "p4", "card": "yellow" } }` |

In Companion, use the *Generic HTTP* module → POST, e.g. `http://192.168.1.20:3000/api/goal/home?pin=1234`.

## 8. After the match

**Options → Export JSON / Export CSV** in the dock (or `GET /api/export.csv?pin=…`) gives a minute-by-minute event log for
highlights and match reports.

## Troubleshooting

- **Dock shows "DISCONNECTED"**: the server isn't running. Start `start.bat`. Pages reconnect on their own.
- **Overlay blank in OBS**: check the URL, then right-click the source → *Interact* or *Refresh*. Make sure the scorebug toggle is on.
- **"Port 3000 already in use"**: the server is already running in another window, or change `PORT` in `.env`.
- **OBS warning in the dock**: OBS is closed, WebSocket is disabled, or the password in `.env` is wrong. Graphics still work.
- **Shortcuts don't work in OBS**: click inside the dock first, so it has keyboard focus.
- **Reset everything**: stop the server and delete `data/state.json`.

## Project layout

```
server/      index.js (HTTP + WebSocket), store.js (state, undo, persistence), actions.js (match logic),
             obs.js (obs-websocket), api.js (REST), demo.js, export.js, auth.js, config.js
public/      overlay/ (Browser Source), dock/ (control panel), setup/ (setup screen),
             shared/ (clock maths + socket client used by server and browsers), assets/ (fonts, logos)
config/      theme.json, obs.json, teams/*.json
data/        state.json (live match state, not committed)
test/        npm test
```
