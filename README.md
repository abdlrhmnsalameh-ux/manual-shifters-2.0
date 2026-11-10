# Apex Loop Multiplayer

3D multiplayer racing in the browser: create or join a room, race up to 8 friends on a 5.7 km circuit,
see a live leaderboard (positions + laps) and a live minimap, and bump into each other.

## Files

```
server.js        Node server (rooms, race start, finish order, serves the game)
package.json     dependency list (only "ws")
render.yaml      optional Render blueprint
.gitignore
public/
  index.html     the whole game (about 11 MB, one file)
```

`index.html` **must** be inside a folder called `public`. If the page says "Not found", that is the reason.

## Put it on GitHub (works from a phone)

1. Create a new repository on github.com (public or private).
2. **Add file > Upload files** and upload `server.js`, `package.json`, `render.yaml` and `.gitignore`. Commit.
3. **Add file > Create new file**, type `public/index.html` as the file name (typing the `/` creates the folder),
   then use **Add file > Upload files** inside that folder to upload `index.html`
   (or upload the whole `public` folder from a computer). GitHub's web upload limit is 25 MB per file; the game is about 11 MB.
4. Commit. The repository must now show `server.js`, `package.json` and a `public` folder.

## Deploy on Render

1. render.com > **New + > Web Service** > connect the GitHub repository.
2. Settings: **Runtime** Node, **Build command** `npm install`, **Start command** `npm start`.
3. Plan **Free** is fine. Under **Advanced** set **Health Check Path** to `/healthz` (optional).
4. Create the service. When the log says `Apex Loop Multiplayer listening on ...`, open the URL Render gives you.
   Everyone plays from that same URL.

Using the `render.yaml` instead: **New + > Blueprint** and pick the repository.

### Free instance sleeps
Render's free plan stops the server after ~15 minutes without visitors. The first visit after that takes up to a minute
to wake it up (the lobby shows "Connecting..."). To keep it awake, point a free uptime monitor (e.g. UptimeRobot)
at `https://YOUR-APP.onrender.com/healthz` every 5 minutes.

## How to play

* Open the URL, type a name, pick a car color.
* **Create room**: choose the number of laps (1, 2, 3, 5 or 8). You get a 4-letter code. Friends tap **Join with code**,
  or tap your room in the "Open rooms" list.
* The host presses **Start race**: everyone gets the same countdown (5 red lights, then green).
* The board (top right) shows positions and laps completed; the minimap next to it shows every driver.
  After finishing, the board shows your finishing time.
* When everybody has finished (or left) a results screen appears; the host can start **Race again**.
* Keyboard: W gas, S brake, A/D steer, E/Q shift up/down (or 1-6, N), arrow keys move the shifter, Space handbrake, M mute.
  On a phone use the on-screen buttons and tap a gear in the shifter.

## How it works (so you can change things)

* The server is a relay. Each browser simulates its own car and sends its position ~30 times per second;
  the server forwards everyone's position to the room, runs the shared start clock and records finishing order.
* **Collisions** are resolved in each browser: every car is 3 circles along its body, and each player's browser applies
  its half of the bump using the other cars' positions. Other cars are drawn ~100 ms in the past, smoothly interpolated.
* This is built for friends: a player could cheat by editing their own browser. There is no accounts or anti-cheat.

Settings at the top of `server.js`: `MAX_PLAYERS` (8), `LAP_OPTIONS`, `COUNTDOWN_MS`, `STATE_HZ`.
Settings inside `public/index.html`: search for `TRACTION` (tyre grip), `CCR` / `CCX` (collision size).

If it runs slowly on phones with many players, lower `MAX_PLAYERS` to 4-6: every extra car adds ~80 meshes to draw.

## Run it on your own computer

```
npm install
npm start
```
then open http://localhost:10000
