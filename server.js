// Apex Loop Multiplayer server
// Node + ws. Serves public/index.html and runs the rooms.
// The server is a relay: every browser simulates its own car and sends its state ~30x/s;
// the server forwards everybody's state to the room, starts races on a shared clock and
// decides the finishing order. Car-to-car collisions are resolved in each browser from
// those positions (see COLLISIONS in public/index.html).

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const PUBLIC = path.join(__dirname, "public");

// ---- settings you may want to change ---------------------------------------
const MAX_PLAYERS = 8;           // drivers per room (the starting grid has 8 slots)
const LAP_OPTIONS = [1, 2, 3, 5, 8]; // laps the host can choose
const COUNTDOWN_MS = 7000;       // from pressing START until the green light (5 red lights + 2 s to get ready)
const STATE_HZ = 30;             // how often positions are sent to the players
const MAX_ROOMS = 200;
// -----------------------------------------------------------------------------

// ---- static file (index.html is ~11 MB, so it is gzipped once and cached) ----
const cache = new Map();
function loadFile(file) {
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  const mtime = fs.statSync(full).mtimeMs;
  const hit = cache.get(full);
  if (hit && hit.mtime === mtime) return hit;
  const raw = fs.readFileSync(full);
  const type = full.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream";
  const entry = {
    mtime,
    raw,
    gz: zlib.gzipSync(raw, { level: 9 }),
    type,
    etag: '"' + crypto.createHash("sha1").update(raw).digest("hex") + '"'
  };
  cache.set(full, entry);
  return entry;
}

const server = http.createServer((req, res) => {
  let pathname = "/";
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {}

  if (pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }

  const file = pathname === "/" ? "index.html" : path.basename(pathname);
  const entry = loadFile(file);
  if (!entry) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found");
  }

  const headers = {
    "Content-Type": entry.type,
    "Cache-Control": "no-cache",
    ETag: entry.etag
  };
  if (req.headers["if-none-match"] === entry.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const gz = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  if (gz) headers["Content-Encoding"] = "gzip";
  headers["Content-Length"] = (gz ? entry.gz : entry.raw).length;
  res.writeHead(200, headers);
  res.end(gz ? entry.gz : entry.raw);
});

// ---- rooms -------------------------------------------------------------------
const wss = new WebSocket.Server({ server, maxPayload: 4096 });
const rooms = new Map();   // code -> room
const clients = new Map(); // ws -> player

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s;
  do {
    s = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(s));
  return s;
}

function clean(str, max, fallback) {
  const s = String(str == null ? "" : str).replace(/[\u0000-\u001f<>&"'`]/g, "").trim().slice(0, max);
  return s || fallback;
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function playerInfo(p, room) {
  return { id: p.id, name: p.name, slot: p.slot, paint: p.paint, host: room.hostId === p.id };
}

function roomInfo(room) {
  return {
    code: room.code,
    name: room.name,
    laps: room.laps,
    players: room.players.size,
    max: MAX_PLAYERS,
    started: room.started,
    done: room.done
  };
}

function broadcastRoom(room) {
  const payload = {
    t: "room",
    room: roomInfo(room),
    hostId: room.hostId,
    players: [...room.players.values()].map(p => playerInfo(p, room))
  };
  room.players.forEach(p => send(p.ws, payload));
}

function openRooms() {
  return [...rooms.values()]
    .filter(r => r.players.size > 0 && !r.started)
    .map(roomInfo);
}

function broadcastRooms() {
  const list = { t: "rooms", rooms: openRooms() };
  clients.forEach((p, ws) => {
    if (!p.room) send(ws, list);
  });
}

function leaveRoom(p) {
  const room = p.room;
  if (!room) return;
  room.players.delete(p.id);
  p.room = null;
  p.slot = -1;
  resetState(p);

  if (room.players.size === 0) {
    rooms.delete(room.code);
  } else {
    if (room.hostId === p.id) room.hostId = room.players.keys().next().value;
    room.players.forEach(o => send(o.ws, { t: "left", id: p.id }));
    checkDone(room);
    broadcastRoom(room);
  }
  broadcastRooms();
}

function resetState(p) {
  p.s = { x: 0, z: 0, th: 0, vx: 0, vy: 0, st: 0, br: 0, lap: 0, prog: -1, best: 0 };
  p.fin = false;
  p.finT = 0;
}

function checkDone(room) {
  if (!room.started || room.done) return;
  if (room.players.size > 0 && [...room.players.values()].every(p => p.fin)) {
    room.done = true;
    room.players.forEach(p => send(p.ws, { t: "done" }));
    broadcastRoom(room);
  }
}

function freeSlot(room) {
  const used = new Set([...room.players.values()].map(q => q.slot));
  let slot = 0;
  while (used.has(slot) && slot < MAX_PLAYERS) slot++;
  return slot;
}

function joined(p, room) {
  send(p.ws, {
    t: "joined",
    id: p.id,
    slot: p.slot,
    host: room.hostId === p.id,
    laps: room.laps,
    room: roomInfo(room),
    players: [...room.players.values()].map(q => playerInfo(q, room))
  });
}

wss.on("connection", ws => {
  const p = {
    id: crypto.randomUUID().slice(0, 8),
    ws,
    name: "Driver",
    paint: 0,
    slot: -1,
    room: null,
    alive: true,
    lastCreate: 0,
    msgs: 0,
    msgT: Date.now()
  };
  resetState(p);
  clients.set(ws, p);
  send(ws, { t: "hi", id: p.id, rooms: openRooms(), now: Date.now() });

  ws.on("pong", () => { p.alive = true; });

  ws.on("message", raw => {
    // simple flood protection: max ~80 messages / second
    const now = Date.now();
    if (now - p.msgT > 1000) { p.msgT = now; p.msgs = 0; }
    if (++p.msgs > 80) return;

    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m.t !== "string") return;

    const room = p.room;

    if (m.t === "s") {            // my car's state
      if (!room) return;
      const s = p.s;
      for (const k of ["x", "z", "th", "vx", "vy", "st", "lap", "prog", "best"]) {
        const n = Number(m[k]);
        if (Number.isFinite(n)) s[k] = n;
      }
      s.br = m.br ? 1 : 0;
      return;
    }

    if (m.t === "ping") {
      send(ws, { t: "pong", ts: m.ts, now: Date.now() });
      return;
    }

    if (m.t === "list") {
      send(ws, { t: "rooms", rooms: openRooms() });
      return;
    }

    if (m.t === "create") {
      if (p.room) return send(ws, { t: "error", message: "Leave your current room first." });
      if (now - p.lastCreate < 1000) return;
      p.lastCreate = now;
      if (rooms.size >= MAX_ROOMS) return send(ws, { t: "error", message: "The server is full. Try again in a minute." });

      const laps = LAP_OPTIONS.includes(Number(m.laps)) ? Number(m.laps) : 3;
      const r = {
        code: makeCode(),
        name: clean(m.roomName, 24, "Apex race"),
        laps,
        hostId: p.id,
        players: new Map(),
        started: false,
        done: false,
        startAt: 0
      };
      rooms.set(r.code, r);
      p.room = r;
      p.name = clean(m.name, 14, "Driver");
      p.paint = Math.max(0, Math.min(5, Number(m.paint) | 0));
      p.slot = 0;
      resetState(p);
      r.players.set(p.id, p);
      joined(p, r);
      broadcastRoom(r);
      broadcastRooms();
      return;
    }

    if (m.t === "join") {
      if (p.room) return send(ws, { t: "error", message: "You are already in a room." });
      const r = rooms.get(String(m.code || "").toUpperCase().trim());
      if (!r) return send(ws, { t: "error", message: "Room not found. Check the code." });
      if (r.started) return send(ws, { t: "error", message: "That race has already started." });
      if (r.players.size >= MAX_PLAYERS) return send(ws, { t: "error", message: "That room is full." });

      p.room = r;
      p.name = clean(m.name, 14, "Driver");
      p.paint = Math.max(0, Math.min(5, Number(m.paint) | 0));
      p.slot = freeSlot(r);
      resetState(p);
      r.players.set(p.id, p);
      joined(p, r);
      broadcastRoom(r);
      broadcastRooms();
      return;
    }

    if (m.t === "leave") {
      leaveRoom(p);
      send(ws, { t: "rooms", rooms: openRooms() });
      return;
    }

    if (m.t === "start") {
      if (!room || room.hostId !== p.id) return send(ws, { t: "error", message: "Only the host can start the race." });
      if (room.started) return;
      room.started = true;
      room.done = false;
      room.startAt = Date.now() + COUNTDOWN_MS;
      room.players.forEach(q => { resetState(q); });
      room.players.forEach(q => send(q.ws, { t: "race", startAt: room.startAt, now: Date.now(), laps: room.laps }));
      broadcastRoom(room);
      broadcastRooms();
      return;
    }

    if (m.t === "fin") {
      // a driver reports that they completed all laps
      if (!room || !room.started || p.fin) return;
      if (Date.now() < room.startAt) return;
      if (Number(m.lap) < room.laps) return;
      p.fin = true;
      p.finT = Date.now() - room.startAt;
      checkDone(room);
      return;
    }

    if (m.t === "again") {
      // host sends everybody back to the lobby for another race
      if (!room || room.hostId !== p.id || !room.started) return;
      room.started = false;
      room.done = false;
      room.startAt = 0;
      room.players.forEach(q => { resetState(q); send(q.ws, { t: "lobby" }); });
      broadcastRoom(room);
      broadcastRooms();
      return;
    }
  });

  ws.on("close", () => {
    leaveRoom(p);
    clients.delete(ws);
  });
  ws.on("error", () => {
    try { ws.terminate(); } catch {}
  });
});

// positions: everybody's state goes to everybody in the room
setInterval(() => {
  const ts = Date.now();
  rooms.forEach(room => {
    if (room.players.size < 2) return;
    const list = [...room.players.values()].map(p => ({
      id: p.id,
      x: p.s.x, z: p.s.z, th: p.s.th, vx: p.s.vx, vy: p.s.vy, st: p.s.st, br: p.s.br,
      lap: p.s.lap, prog: p.s.prog, best: p.s.best,
      fin: p.fin ? 1 : 0, finT: p.finT
    }));
    const snap = JSON.stringify({ t: "snap", ts, p: list });
    room.players.forEach(p => {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(snap);
    });
  });
}, Math.round(1000 / STATE_HZ));

// drop dead connections (phones that went to sleep, etc.)
setInterval(() => {
  clients.forEach((p, ws) => {
    if (!p.alive) { try { ws.terminate(); } catch {} return; }
    p.alive = false;
    try { ws.ping(); } catch {}
  });
}, 20000);

server.listen(PORT, "0.0.0.0", () => {
  console.log("Apex Loop Multiplayer listening on " + PORT);
});
