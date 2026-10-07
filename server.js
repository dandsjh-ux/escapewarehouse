// Escape Warehouse – multiplayer server (Express + Socket.IO)
// Run locally:  npm install && npm start   → http://localhost:3000
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import * as M from './public/shared/map.js';
import * as WD from './public/shared/words.js';
import { DEFAULT_SETTINGS, sanitizeSettings, sanitizeLook } from './public/shared/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const TICK_MS = 66;          // ~15 updates per second
const MAX_PLAYERS = 12;
const TAG_DIST = 1.35;
const ROUND_END_PAUSE = 9000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three')));
app.get('/health', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });
const rooms = new Map();

// ---------- helpers ----------
const r2 = (v) => Math.round(v * 100) / 100;
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
// close enough horizontally AND on the same floor
const near = (a, b, r) => dist2(a, b) < r * r && Math.abs((a.y || 0) - (b.y || 0)) < 2.2;
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const cleanName = (n) => String(n || '').replace(/[<>&"]/g, '').trim().slice(0, 16) || 'Player';

function makeCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => L[Math.floor(Math.random() * L.length)]).join(''); } while (rooms.has(c));
  return c;
}

function newPlayer(id, name, look) {
  return {
    id, name: cleanName(name), look: sanitizeLook(look), score: 0,
    role: 'hider', status: 'lobby',
    x: 0, y: 0, z: 0, ry: 0, aim: 0, pitch: 0, flags: 0,
    sentence: null, filled: [], immuneUntil: 0,
    hiddenIn: null, hideStart: 0, hideCooldown: 0,
  };
}

function lobbyPayload(room) {
  return {
    code: room.code, hostId: room.hostId, phase: room.phase, settings: room.settings, round: room.round,
    players: room.order.map(id => {
      const p = room.players.get(id);
      return { id, name: p.name, look: p.look, score: p.score, role: p.role, status: p.status };
    }),
  };
}
function rosterPayload(room) {
  return room.order.map(id => {
    const p = room.players.get(id);
    return {
      id, name: p.name, look: p.look, role: p.role, status: p.status, score: p.score,
      got: p.filled.filter(Boolean).length, need: p.filled.length,
    };
  });
}
const broadcastLobby = (room) => io.to(room.code).emit('lobby', lobbyPayload(room));
const broadcastRoster = (room) => io.to(room.code).emit('roster', rosterPayload(room));
const emitEvent = (room, ev) => io.to(room.code).emit('event', ev);
function teleport(p, pt, reason) {
  p.x = pt.x; p.z = pt.z; p.y = pt.y;
  io.to(p.id).emit('teleport', { x: pt.x, y: pt.y, z: pt.z, reason });
}

// ---------- sentences & word tables ----------
function makeRoundSentences(level, count) {
  const out = [];
  const need = { noun: new Set(), verb: new Set(), adjective: new Set() };
  const cap = { noun: 0, verb: 0, adjective: 0 };
  for (const t of M.TABLES) if (cap[t.room] !== undefined) cap[t.room]++;
  const roomOf = { N: 'noun', V: 'verb', J: 'adjective' };
  for (let i = 0; i < count; i++) {
    let chosen = null;
    for (let tries = 0; tries < 40 && !chosen; tries++) {
      const s = WD.makeSentence(level);
      if (out.some(o => o.text === s.text)) continue;
      const fits = Object.keys(need).every(room => {
        const set = new Set(need[room]);
        s.tokens.forEach(t => { if (roomOf[t.t] === room) set.add(t.w); });
        return set.size <= cap[room];
      });
      if (fits) chosen = s;
    }
    if (!chosen) chosen = out.length ? out[Math.floor(Math.random() * out.length)] : WD.makeSentence(level);
    chosen.tokens.forEach(t => { if (roomOf[t.t]) need[roomOf[t.t]].add(t.w); });
    out.push(chosen);
  }
  return { sentences: out, need };
}

function assignTables(need) {
  const words = new Array(M.TABLES.length);
  for (const room of ['article', 'noun', 'verb', 'adjective']) {
    const tables = M.TABLES.filter(t => t.room === room);
    let list;
    if (room === 'article') {
      list = [];
      while (list.length < tables.length) list.push(...WD.ARTICLES);
      list = list.slice(0, tables.length);
    } else {
      list = [...need[room]];
      // near-miss distractors first: if "runs" is needed, put "run" in the room too (careful reading!)
      for (const w of need[room]) {
        const tw = WD.twinOf(w);
        if (tw && !list.includes(tw) && list.length < tables.length && Math.random() < 0.7) list.push(tw);
      }
      const fill = shuffle(WD.ROOM_POOLS[room].filter(w => !list.includes(w)));
      while (list.length < tables.length && fill.length) list.push(fill.pop());
    }
    shuffle(list);
    tables.forEach((t, i) => { words[t.id] = list[i % list.length]; });
  }
  return words;
}

// ---------- rounds ----------
function clearTimers(room) { room.timers.forEach(clearTimeout); room.timers = []; }

function startGame(room) {
  room.round = 0;
  room.seekerTurn = Math.floor(Math.random() * Math.max(1, room.order.length));
  for (const p of room.players.values()) p.score = 0;
  startRound(room);
}

function startRound(room) {
  clearTimers(room);
  const s = room.settings;
  const ids = [...room.order];
  const n = ids.length;
  if (n === 0) return;
  room.round++;
  const level = s.ramp ? Math.min(5, s.startLevel + room.round - 1) : s.startLevel;
  const nSeek = n === 1 ? 0 : (s.seekers === 2 && n >= 5 ? 2 : 1);
  const seekers = [];
  for (let i = 0; i < nSeek; i++) seekers.push(ids[(room.seekerTurn + i) % n]);
  room.seekerTurn = (room.seekerTurn + Math.max(1, nSeek)) % n;
  const hiders = ids.filter(id => !seekers.includes(id));

  const { sentences, need } = makeRoundSentences(level, hiders.length);
  // Article words always available
  const tables = assignTables(need);
  const hints = s.hints === 'always' || (s.hints === 'early' && room.round <= 2);
  const now = Date.now();
  const headEnd = now + (nSeek ? s.headStart * 1000 : 3000);
  room.g = {
    level, hints, tables, seekers, hiders,
    mode: n === 1 ? 'practice' : n === 2 ? 'duel' : 'prison',
    start: now, headEnd, end: headEnd + s.roundTime * 1000,
    nextPing: headEnd + s.pingInterval * 1000,
    lockers: {}, tags: {}, prisonSlot: 0, ended: false,
  };
  room.phase = 'playing';

  hiders.forEach((id, i) => {
    const p = room.players.get(id);
    const sp = M.HIDER_SPAWNS[i % M.HIDER_SPAWNS.length];
    Object.assign(p, {
      role: 'hider', status: 'free', sentence: sentences[i], filled: sentences[i].tokens.map(() => false),
      x: sp.x, z: sp.z, y: sp.y, ry: 0, flags: 0, hiddenIn: null, immuneUntil: headEnd, hideCooldown: 0,
    });
  });
  seekers.forEach((id, i) => {
    const p = room.players.get(id);
    const sp = M.SEEKER_SPAWNS[i % M.SEEKER_SPAWNS.length];
    Object.assign(p, { role: 'seeker', status: 'free', sentence: null, filled: [], x: sp.x, z: sp.z, y: sp.y, ry: Math.PI, flags: 0, hiddenIn: null });
    room.g.tags[id] = 0;
  });

  for (const id of ids) {
    const p = room.players.get(id);
    const sock = io.sockets.sockets.get(id);
    if (sock) {
      sock.leave(room.code + ':seek'); sock.leave(room.code + ':hide');
      sock.join(room.code + (p.role === 'seeker' ? ':seek' : ':hide'));
    }
    io.to(id).emit('roundStart', roundPayloadFor(room, p));
  }
  broadcastRoster(room);
}

function roundPayloadFor(room, p) {
  const g = room.g, now = Date.now();
  return {
    round: room.round, rounds: room.settings.rounds, level: g.level, hints: g.hints, mode: g.mode,
    tables: g.tables, role: p.role, sentence: p.sentence, filled: p.filled,
    spawn: { x: p.x, y: p.y, z: p.z }, headStart: g.headEnd - now, duration: g.end - now,
    settings: room.settings, roster: rosterPayload(room), hostId: room.hostId,
  };
}

function checkEnd(room) {
  const g = room.g;
  if (!g || g.ended) return;
  const anyFree = g.hiders.some(id => room.players.get(id)?.status === 'free');
  if (!anyFree) endRound(room, 'done');
}

function endRound(room, reason) {
  const g = room.g;
  if (!g || g.ended) return;
  g.ended = true;
  room.phase = 'roundEnd';
  const hiders = g.hiders.map(id => room.players.get(id)).filter(Boolean);
  const seekers = g.seekers.map(id => room.players.get(id)).filter(Boolean);
  hiders.forEach(h => { h.hiddenIn = null; });

  let winner;
  const escaped = hiders.filter(h => h.status === 'escaped').length;
  if (reason === 'seekerLeft' || reason === 'noHiders') winner = 'none';
  else if (g.mode === 'practice') winner = escaped ? 'hiders' : 'none';
  else if (g.mode === 'duel') winner = reason === 'escape' ? 'hiders' : 'seekers';
  else winner = hiders.length && escaped >= Math.ceil(hiders.length / 2) ? 'hiders' : 'seekers';
  const winners = winner === 'hiders' ? hiders : winner === 'seekers' ? seekers : [];
  winners.forEach(p => { p.score += 3; });

  const isLast = room.round >= room.settings.rounds;
  io.to(room.code).emit('roundEnd', {
    winner, reason, round: room.round, rounds: room.settings.rounds, mode: g.mode, isLast,
    hiders: hiders.map(h => ({ id: h.id, name: h.name, status: h.status, sentence: h.sentence.text, tokens: h.sentence.tokens, filled: h.filled })),
    seekers: seekers.map(sk => ({ id: sk.id, name: sk.name, tags: g.tags[sk.id] || 0 })),
    scores: rosterPayload(room).sort((a, b) => b.score - a.score),
    pause: ROUND_END_PAUSE,
  });
  room.timers.push(setTimeout(() => {
    if (!rooms.has(room.code) || room.phase !== 'roundEnd') return;
    if (isLast || room.players.size === 0) gameOver(room); else startRound(room);
  }, ROUND_END_PAUSE));
}

function gameOver(room) {
  room.phase = 'gameOver';
  room.g = null;
  io.to(room.code).emit('gameOver', { scores: rosterPayload(room).sort((a, b) => b.score - a.score), hostId: room.hostId });
}

function backToLobby(room) {
  clearTimers(room);
  room.phase = 'lobby'; room.g = null; room.round = 0;
  for (const p of room.players.values()) { p.status = 'lobby'; p.role = 'hider'; p.filled = []; p.sentence = null; p.hiddenIn = null; }
  broadcastLobby(room);
}

function tag(room, sk, h, viaLocker = false) {
  const g = room.g;
  sk.score += 3;
  g.tags[sk.id] = (g.tags[sk.id] || 0) + 1;
  if (h.hiddenIn !== null) { delete g.lockers[h.hiddenIn]; h.hiddenIn = null; }
  h.status = 'jailed';
  emitEvent(room, { type: 'tag', seeker: sk.name, hider: h.name, hid: h.id, sid: sk.id, locker: viaLocker });
  if (g.mode === 'duel') { endRound(room, 'tag'); return; }
  const spot = M.PRISON_SPOTS[g.prisonSlot++ % M.PRISON_SPOTS.length];
  teleport(h, spot, 'jailed');
  broadcastRoster(room);
  checkEnd(room);
}

function unhide(room, p, reason) {
  if (!room.g || p.hiddenIn === null) return;
  const id = p.hiddenIn;
  delete room.g.lockers[id];
  p.hiddenIn = null;
  p.hideCooldown = Date.now() + 4000;
  io.to(p.id).emit('unhidden', { id, reason });
  io.to(room.code).emit('lockerFx', { id });
}

function doPing(room) {
  const g = room.g;
  const targets = g.hiders.map(id => room.players.get(id)).filter(h => h && h.status === 'free')
    .map(h => ({ id: h.id, x: r2(h.x), y: r2(h.y), z: r2(h.z) }));
  if (!targets.length) return;
  const dur = room.settings.pingDuration * 1000;
  io.to(room.code + ':seek').emit('ping', { targets, dur });
  // fair play: the ping also shows hiders where the seeker(s) are
  const seekers = room.settings.pingShowsSeeker
    ? g.seekers.map(id => room.players.get(id)).filter(Boolean).map(p => ({ id: p.id, x: r2(p.x), y: r2(p.y), z: r2(p.z) }))
    : [];
  for (const t of targets) io.to(t.id).emit('pinged', { dur, seekers });
}

function tick(room) {
  if (room.phase !== 'playing' || !room.g) return;
  const g = room.g, s = room.settings, now = Date.now();

  if (now >= g.headEnd) {
    for (const sid of g.seekers) {
      const sk = room.players.get(sid);
      if (!sk) continue;
      for (const hid of g.hiders) {
        const h = room.players.get(hid);
        if (!h || h.status !== 'free' || h.hiddenIn !== null || now < h.immuneUntil) continue;
        if (dist2(sk, h) < TAG_DIST * TAG_DIST && Math.abs(sk.y - h.y) < 1.5) {
          tag(room, sk, h);
          if (room.phase !== 'playing') return;
        }
      }
    }
    if (s.pingInterval > 0 && g.seekers.length && now >= g.nextPing) {
      g.nextPing = now + s.pingInterval * 1000;
      doPing(room);
    }
  }
  for (const hid of g.hiders) {
    const h = room.players.get(hid);
    if (h && h.hiddenIn !== null && now - h.hideStart > s.lockerTime * 1000) unhide(room, h, 'time');
  }
  if (now >= g.end) { endRound(room, 'time'); return; }

  const full = [], seen = [];
  for (const p of room.players.values()) {
    if (p.status === 'waiting' || p.status === 'lobby') continue;
    const hidden = p.hiddenIn !== null;
    const row = [p.id, r2(p.x), r2(p.y), r2(p.z), r2(p.ry), r2(p.aim), r2(p.pitch), (p.flags & 15) | (hidden ? 16 : 0)];
    full.push(row);
    if (!hidden) seen.push(row);
  }
  const base = { t: Math.max(0, g.end - now), h: Math.max(0, g.headEnd - now) };
  io.to(room.code + ':hide').emit('snap', { ...base, p: full });
  io.to(room.code + ':seek').emit('snap', { ...base, np: s.pingInterval ? Math.max(0, g.nextPing - now) : -1, p: seen });
}

// ---------- connections ----------
io.on('connection', (socket) => {
  let room = null;
  const me = () => (room ? room.players.get(socket.id) : null);
  const isHost = () => room && room.hostId === socket.id;

  function addTo(r, name, look) {
    room = r;
    const p = newPlayer(socket.id, name, look);
    r.players.set(socket.id, p);
    r.order.push(socket.id);
    socket.join(r.code);
    if (r.phase !== 'lobby') { p.status = 'waiting'; p.role = 'spectator'; }
    return p;
  }

  socket.on('create', (d, ack) => {
    if (typeof ack !== 'function') return;
    leave();
    const code = makeCode();
    const r = {
      code, hostId: socket.id, players: new Map(), order: [], settings: { ...DEFAULT_SETTINGS },
      phase: 'lobby', round: 0, g: null, seekerTurn: 0, timers: [],
    };
    r.loop = setInterval(() => tick(r), TICK_MS);
    rooms.set(code, r);
    addTo(r, d?.name, d?.look);
    ack({ ok: true, code, id: socket.id });
    broadcastLobby(r);
  });

  socket.on('join', (d, ack) => {
    if (typeof ack !== 'function') return;
    const code = String(d?.code || '').toUpperCase().trim();
    const r = rooms.get(code);
    if (!r) return ack({ ok: false, error: 'Room not found – check the code!' });
    if (r.players.size >= MAX_PLAYERS) return ack({ ok: false, error: 'That room is full (12 players).' });
    leave();
    const p = addTo(r, d?.name, d?.look);
    ack({ ok: true, code, id: socket.id });
    broadcastLobby(r);
    if (r.phase !== 'lobby') {
      broadcastRoster(r);
      emitEvent(r, { type: 'joined', name: p.name });
    }
  });

  socket.on('settings', (s) => {
    if (!isHost() || room.phase !== 'lobby') return;
    room.settings = sanitizeSettings({ ...room.settings, ...s });
    broadcastLobby(room);
  });

  socket.on('look', (l) => {
    const p = me(); if (!p) return;
    p.look = sanitizeLook(l);
    if (room.phase === 'lobby') broadcastLobby(room);
  });

  socket.on('rename', (n) => {
    const p = me(); if (!p || room.phase !== 'lobby') return;
    p.name = cleanName(n); broadcastLobby(room);
  });

  socket.on('start', () => {
    if (!isHost() || room.phase !== 'lobby') return;
    startGame(room);
  });

  socket.on('toLobby', () => {
    if (!isHost() || room.phase !== 'gameOver') return;
    backToLobby(room);
  });

  socket.on('endGame', () => {
    if (!isHost() || room.phase === 'lobby') return;
    backToLobby(room);
  });

  socket.on('kick', (id) => {
    if (!isHost() || id === socket.id) return;
    const s = io.sockets.sockets.get(id);
    if (s && room.players.has(id)) { s.emit('kicked'); s.disconnect(true); }
  });

  // Position updates: [x, y, z, ry, aim, pitch, flags]
  socket.on('s', (a) => {
    const p = me();
    if (!p || room.phase !== 'playing' || !Array.isArray(a) || p.status === 'waiting') return;
    const [x, y, z, ry, aim, pitch, flags] = a.map(Number);
    if (![x, y, z, ry, aim, pitch].every(Number.isFinite)) return;
    if (p.hiddenIn !== null) return; // frozen while in a locker
    if (p.status === 'jailed' && !M.inPrison(x, z, y)) return;
    if (p.status === 'escaped') {
      const Y = M.YARD_RECT;
      if (x < Y.x0 - 1 || x > Y.x1 + 1 || z < Y.z0 - 1 || z > Y.z1 + 1) return;
    }
    Object.assign(p, { x, y, z, ry, aim, pitch, flags: (flags | 0) & 15 });
  });

  socket.on('collect', (id) => {
    const p = me(); if (!p || room.phase !== 'playing') return;
    const g = room.g;
    if (p.role !== 'hider' || p.status !== 'free' || p.hiddenIn !== null) return;
    const t = M.TABLES[id | 0];
    if (!t || !near(p, t, 2.9)) return;
    const word = g.tables[t.id];
    const idx = p.sentence.tokens.findIndex((tk, i) => !p.filled[i] && tk.w === word);
    if (idx < 0) {
      const has = p.sentence.tokens.some(tk => tk.w === word);
      const twin = p.sentence.tokens.find((tk, i) => !p.filled[i] && WD.twinOf(word) === tk.w);
      socket.emit('collectResult', { ok: false, word, reason: has ? 'already' : twin ? 'twin' : 'notNeeded', want: twin ? twin.w : null });
      return;
    }
    p.filled[idx] = true;
    p.score += 1;
    const done = p.filled.every(Boolean);
    socket.emit('collectResult', { ok: true, word, index: idx, done });
    broadcastRoster(room);
  });

  socket.on('escape', () => {
    const p = me(); if (!p || room.phase !== 'playing') return;
    const g = room.g;
    if (p.role !== 'hider' || p.status !== 'free' || p.hiddenIn !== null) return;
    if (!p.filled.length || !p.filled.every(Boolean)) return;
    if (!M.EXITS.some(e => near(p, e.point, 3.0))) return; // either exit works
    p.status = 'escaped';
    p.score += 5;
    const escapedCount = g.hiders.filter(id => room.players.get(id)?.status === 'escaped').length;
    const sp = M.YARD_SPOTS[(escapedCount - 1) % M.YARD_SPOTS.length];
    teleport(p, sp, 'escaped');
    emitEvent(room, { type: 'escape', name: p.name, id: p.id, sentence: p.sentence.text });
    broadcastRoster(room);
    if (g.mode === 'duel' || g.mode === 'practice') endRound(room, 'escape'); else checkEnd(room);
  });

  socket.on('rescue', () => {
    const p = me(); if (!p || room.phase !== 'playing') return;
    const g = room.g;
    if (!room.settings.rescue || p.role !== 'hider' || p.status !== 'free' || p.hiddenIn !== null) return;
    if (!near(p, M.RESCUE_POINT, 3.0)) return;
    const jailed = g.hiders.map(id => room.players.get(id)).filter(h => h && h.status === 'jailed');
    if (!jailed.length) return;
    const now = Date.now();
    jailed.forEach((h, i) => {
      h.status = 'free';
      h.immuneUntil = now + 4000;
      const sp = M.RELEASE_SPOTS[i % M.RELEASE_SPOTS.length];
      teleport(h, sp, 'released');
    });
    p.score += 2 * jailed.length;
    emitEvent(room, { type: 'rescue', name: p.name, count: jailed.length });
    broadcastRoster(room);
  });

  socket.on('hide', (id) => {
    const p = me(); if (!p || room.phase !== 'playing') return;
    const g = room.g, now = Date.now();
    if (!room.settings.lockers || p.role !== 'hider' || p.status !== 'free' || p.hiddenIn !== null) return;
    const L = M.LOCKERS[id | 0];
    if (!L || !near(p, L, 2.4)) return;
    if (now < p.hideCooldown) { socket.emit('toast', 'Catch your breath first!'); return; }
    if (g.lockers[L.id]) { socket.emit('toast', 'This locker is jammed!'); return; }
    g.lockers[L.id] = p.id;
    p.hiddenIn = L.id;
    p.hideStart = now;
    socket.emit('hidden', { id: L.id, max: room.settings.lockerTime });
    io.to(room.code).emit('lockerFx', { id: L.id });
  });

  socket.on('unhide', () => { const p = me(); if (p && room.g) unhide(room, p, 'self'); });

  socket.on('search', (id) => {
    const p = me(); if (!p || room.phase !== 'playing') return;
    const g = room.g;
    if (p.role !== 'seeker' || Date.now() < g.headEnd) return;
    const L = M.LOCKERS[id | 0];
    if (!L || !near(p, L, 2.4)) return;
    io.to(room.code).emit('lockerFx', { id: L.id });
    const hid = g.lockers[L.id];
    const h = hid && room.players.get(hid);
    if (h && h.status === 'free') tag(room, p, h, true);
    else socket.emit('searchResult', { found: false });
  });

  function leave() {
    if (!room) return;
    const r = room;
    room = null;
    const p = r.players.get(socket.id);
    r.players.delete(socket.id);
    r.order = r.order.filter(i => i !== socket.id);
    socket.leave(r.code); socket.leave(r.code + ':seek'); socket.leave(r.code + ':hide');
    if (r.players.size === 0) {
      clearInterval(r.loop); clearTimers(r); rooms.delete(r.code);
      return;
    }
    if (r.hostId === socket.id) r.hostId = r.order[0];
    if (r.phase === 'playing' && r.g && p) {
      const g = r.g;
      if (p.hiddenIn !== null) delete g.lockers[p.hiddenIn];
      const wasSeeker = g.seekers.includes(socket.id);
      g.seekers = g.seekers.filter(i => i !== socket.id);
      g.hiders = g.hiders.filter(i => i !== socket.id);
      if (p.name) emitEvent(r, { type: 'left', name: p.name });
      if (wasSeeker && g.seekers.length === 0 && g.mode !== 'practice') endRound(r, 'seekerLeft');
      else if (g.hiders.length === 0) endRound(r, 'noHiders');
      else checkEnd(r);
    }
    broadcastLobby(r);
    if (r.phase !== 'lobby') broadcastRoster(r);
  }

  socket.on('leave', leave);
  socket.on('disconnect', leave);
});

server.listen(PORT, () => console.log(`Escape Warehouse running on http://localhost:${PORT}`));
