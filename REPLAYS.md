# Replays

The **Replays** section of the control dock (on the **Live** tab, next to the match controls) does instant replays using a second OBS. It saves the last few seconds
of the clean camera, plays them in the main OBS behind a stinger with a **REPLAY** bug on screen, and then
returns to live on its own.

```
ATEM program ──► Main OBS  (ws://127.0.0.1:4455)  stream + graphics overlay + "REPLAY" scene
Clean camera ──► Replay OBS (ws://127.0.0.1:4456) Replay Buffer only
                        ▲
                        └── both are controlled by the score server (npm start), which the dock talks to
```

The replay logic runs in the score server, not in the dock page. A replay always finishes and returns to live,
even if the dock is reloaded mid-replay, and you can also trigger replays from your phone.

**Replays never affect the graphics.** The replay module is kept separate from the match state, has its own
file (`data/replays.json`), and catches every OBS error. If the Replay OBS is closed or something goes wrong,
the replay buttons grey out with the reason, and the scorebug, lower thirds and stream carry on as normal.

---

## 1. Set up the Replay OBS (second instance)

1. Make a **portable** copy of OBS in its own folder, and start it with:
   ```
   obs64.exe --portable --multi
   ```
   (Make a shortcut with those arguments. `--multi` stops OBS warning that it's already running.)
2. Add **one source**: your clean-camera capture card (Video Capture Device).
3. **Settings → Output → Replay Buffer**: tick *Enable Replay Buffer*, and set *Maximum Replay Time* to **20 s**.
   Note the **Recording Path** (Settings → Output → Recording). Replays are saved there, and the main OBS
   reads them from that folder, so both must be on the same PC.
4. **Tools → WebSocket Server Settings**: enable it, set **port 4456**, and set a password.
5. Click **Start Replay Buffer**, or let the dock do it: if the buffer is stopped when the server connects, it's
   started automatically and the dock shows a warning.

> Recording format: MKV or MP4 both work. Hybrid MP4 / fragmented formats are fine too.

## 2. Set up the main OBS

Create these yourself. The names can be changed in the dock under **Settings → Replay settings**; these are the defaults:

| What | Default name | Notes |
|---|---|---|
| Scene | **REPLAY** | Contains the media source below, plus your graphics overlay Browser Source (as a *reference* copy) so the REPLAY bug and scorebug show. |
| Media Source | **Replay Player** | *Local file*, with any file to start. The dock sets the file, speed, *Restart playback when source becomes active* and *Close file when inactive* on every replay. |
| Transition | **Replay Stinger** | *Only if you choose the OBS Stinger option* (see below). A *Stinger* transition with your replay wipe video; set its *Transition Point* to when the wipe fully covers the screen. Not needed with the default graphics wipe. |

The **REPLAY bug** is part of the graphics overlay, so make sure the overlay Browser Source is in the REPLAY scene.

### The stinger: graphics wipe (default) or your own video
**Graphics wipe (default, no video needed).** The graphics overlay plays a full-screen wipe in the **home
team's colours** with their badge and "REPLAY". The server *cuts* OBS to the replay scene at the exact moment
the wipe covers the screen, so viewers never see the cut. Set how fast it plays with the **Wipe speed** slider (0.6–3 s, default 1.3 s) under *Settings → Stinger*. The same happens on the way back, and between every
clip in **Play all**. You don't need the *Replay Stinger* transition at all. It uses OBS's built-in **Cut**
transition, and the name can be changed under *Settings → Stinger* if your OBS is in another language.
For this to work, the overlay Browser Source must be in **both** your live scene(s) and the REPLAY scene
(*Paste (Reference)*), at the **top** of the source list in each.

**OBS Stinger transition (your own video).** Choose it under *Settings → Stinger* and enter the transition name
(default **Replay Stinger**). OBS can't transition a scene into itself, so to get the stinger *between* queued
clips, also create a scene called **REPLAY 2** with a second media source **Replay Player 2** (plus the overlay),
and enter both names under *Stinger between clips*. Without them, Play all cuts between clips.

## 3. Connect the dock

Open the dock's **Settings** tab and find **Replay settings**:

- **Main OBS**: leave the URL blank to use `OBS_HOST` / `OBS_PORT` / `OBS_PASSWORD` from `.env`, or enter
  another address and password.
- **Replay OBS**: `ws://127.0.0.1:4456` and the password from step 1.4.
- Replay length (default **8 s**), slow-motion speed (default **50 %**) and keyboard shortcuts.

**Save settings.** The dots at the top of the Replays section (Live tab) turn green: **Main OBS**, **Replay OBS**, and **Buffer: running**.
Both connections retry every 5 seconds, so restarting either OBS reconnects on its own.

Settings and the queue are stored in `data/replays.json` on the server PC. The passwords in it are plain
text, so keep that folder private. It's never committed to git.

## 4. Using it

| Button | What happens |
|---|---|
| **REPLAY 100%** / **REPLAY 50%** | One tap: saves the buffer → wipes (or stingers) into the last N seconds with the REPLAY bug → wipes back to whatever scene was live and restores your normal transition. The clip is also added to the queue (unlabelled). |
| **● MARK** | Saves the clip to the queue **without** changing the program. It's labelled with the time and match minute, e.g. `14:32:05 · 23'`. Use the **Mark as: Goal / Chance / Save / Foul / Other** buttons to mark and tag in one tap. |
| **■ ABORT / BACK TO LIVE** | Goes straight back to the previous scene through the stinger (the wipe starts the moment you press it) and stops the clip. Pressed while the wipe into a replay is still playing, it never cuts to the replay; the wipe just reveals live again. While a replay is on air it's also in a red bar at the top of the dock on **both** tabs. |
| Queue: **▶ 100 / ▶ 50** | Play one clip. |
| Queue: **✎ ↑ ↓ ✕**, tag menu | Rename, reorder, remove from the queue (the file stays on disk), or change the tag. |
| **▶ Play all** | Plays the whole queue in order (half-time / full-time packages), then returns to live. |

Safety rules:
- **There are no confirmation dialogs on live actions.**
- **While a clip is being saved**, extra REPLAY/MARK presses are ignored and the buttons pulse. A double tap can't
  break anything.
- **If a replay is already on air**, pressing REPLAY saves the new clip to the queue instead of interrupting.
- **If something's missing**, the dock says exactly what, and the program is left alone. That covers a
  scene/source/transition name that doesn't exist, a deleted file, a save that timed out, and the Replay OBS
  being disconnected.

### Keyboard shortcuts (dock focused, either tab)
Defaults: **R** replay 100 % · **T** replay slow-mo · **M** mark · **B** abort. Change them under Settings: click
the box and press a key (Backspace clears it). G, H, Space, Esc and Z are reserved for the match controls.

### Stream Deck / Companion
POST with the PIN (`X-Pin` header or `?pin=`):
`/api/replay/now` · `/api/replay/slow` · `/api/replay/mark` (optional `?tag=Goal`) · `/api/replay/abort` · `/api/replay/play-all`

## 5. Troubleshooting

| Message | Fix |
|---|---|
| *Replay OBS not connected* | Is the portable OBS running? Check the WebSocket is enabled on port 4456, and the password in Replay settings. |
| *Replay Buffer is not running* / *could not be started* | In the Replay OBS: Settings → Output → tick *Enable Replay Buffer*, then click *Start Replay Buffer*. |
| *Saving the replay timed out* | The Replay OBS didn't produce a file within 5 s. Check its recording path exists and the disk isn't full. |
| Graphics wipe plays but you can see the cut | The overlay must be on top in both scenes, and must be the *same* source (Paste (Reference)). Untick "Shutdown source when not visible" on it. |
| *Scene "REPLAY" not found* (or source / transition) | Create it in the main OBS, or fix the name in Replay settings. Names are case-sensitive. |
| *Replay file is missing* | The file was moved or deleted. Remove it from the queue. |
| Replay plays but there's no REPLAY bug | Add the graphics overlay Browser Source to the REPLAY scene. |
| Stuck on the REPLAY scene | Press **ABORT / BACK TO LIVE**, or switch scenes in OBS. Nothing in the dock fights a manual switch. |

## Testing checklist

- [ ] Both connections show green, and reconnect after restarting either OBS
- [ ] REPLAY 100% and 50% play the last N seconds, then return to the correct scene
- [ ] Stinger and REPLAY bug fire on the way in and out
- [ ] MARK saves without changing program
- [ ] Queue persists after a dock reload (and a server restart); Play all runs in order
- [ ] ABORT works at any point during a replay (including while saving), with the stinger
- [ ] Rapid double-tapping REPLAY doesn't break anything
- [ ] Replay OBS closed: buttons disabled with a clear message, and the stream and graphics are unaffected

The automated tests (`npm test`) cover these against a simulated OBS (`test/replays.test.js`). The real-OBS
checks above still need doing once on your PC.
