# Match day

A short checklist for running a match. Setup and reference are in [README.md](README.md); replay setup is in
[REPLAYS.md](REPLAYS.md).

## Before kick-off (about 15 minutes before)

1. **Start everything**
   - Main OBS, then the Replay OBS (if you're using replays), and click **Start Replay Buffer** in it.
   - Double-click **`start.bat`**. Leave the black server window open all match.
2. **Pick the teams.** In the dock, open the **Lineups** tab:
   - Choose home and away, the competition, and kit colours if there's a clash.
   - Tick **XI / SUB** for each player and pick the captain.
   - Pick the **Formation** and check the small pitch; tap two players to swap them if needed.
   - For a two-legged tie, tick it and enter the first-leg score.
   - Click **Start NEW match**.
3. **Run the check.** **Settings → General → Pre-match check** must say *All good: ready for kick-off*. If anything is amber or red,
   each line says how to fix it (some have a button that fixes it for you).
4. **Optional:** show the **Kick-off board**, then **Lineup** (home, then away) from **Graphics** on the **Live** tab.

## During the match (Live tab)

| When | Do |
|---|---|
| Kick-off | **▶ KICK OFF (1H)**. Hide the kick-off board (or **Hide all**). |
| Goal | **+ GOAL** puts the goal on the scorebug straight away, then asks who scored. Don't know yet? Close the popup and add them later with **Edit**. A replay of the goal is saved to the queue automatically. Goal chalked off by VAR? **− remove** it and its replay is renamed "... - Disallowed". |
| Card / sub | **Cards & subs** → team → player. A second yellow becomes a red by itself. Card and sub graphics wait under **To show**: enter them, then **▶ Show** plays them back to back. |
| Something worth a replay | **REPLAY 100%** / **REPLAY 50%** to show it now, or **Mark as: Chance / Save / Foul…** to save it for later (you'll be asked which team). |
| Replay going wrong | **■ ABORT / BACK TO LIVE** (red bar at the top). |
| Added time | Type the minutes in **Added time** and press Enter. **Hide** / **Show** take it off and back on the scorebug. |
| Mistake | **⟲ Undo** (top right). Wrong scorer or minute: **Edit** in *Match events*. |
| Half time | **HT** (period buttons) → **Half-time board**. Package of chances: **▶ Play all** in the replay queue. |
| Second half | Hide the board → **▶ START 2ND HALF** (the clock jumps to 45:00). |
| Extra time / penalties | **ET1 / ET2** buttons. For penalties pick **PEN**: a *Penalty shootout* tile appears. Log each kick with **✓ Scored / ✗ Missed**, and show the dots with **Penalties lower third**. |
| Full time | **FT** → **Full-time board** (shows scorers, aggregate and penalties if any). |


## After the match

- **Highlights:** reorder the replay queue if you like, then **🎬 Make highlights reel** (under the queue).
  **Show in folder** opens the finished MP4.
- **Event log:** **Settings → Export CSV / JSON** for a minute-by-minute record.
- Close the server window when you're done. Everything is saved and comes back next time.

## If something goes wrong live

- **Dock says DISCONNECTED:** the server window was closed. Run `start.bat` again. Everything comes back as it was, clock included.
- **Graphics missing in OBS:** look at **Settings → Pre-match check**. It says what's wrong, and **Refresh overlay in OBS** fixes an out-of-date overlay.
- **Replay buttons greyed out:** the reason is shown above them (usually the Replay OBS is closed, or its Replay Buffer is stopped). The rest of the graphics carry on as normal.
