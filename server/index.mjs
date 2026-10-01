import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createSimulation } from './simulation.mjs';

export const PROTOCOL = 1;
const MAX_PLAYERS = 8;
const INPUT_BUTTONS = ['left','right','up','down','shootHeld','shootReleased','meleePressed','dashPressed','jumpPressed','jumpHeld'];
const EDGES = new Set(['shootReleased','meleePressed','dashPressed','jumpPressed']);
const COLORS = ['#e85d5d','#4fa3ff','#65cf84','#f2c14e','#b77bff','#ef75b5','#f28a4b','#4ed1c5'];

function profile(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  return {
    name: typeof value.name === 'string' ? value.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 32) : 'PLAYER',
    character: value.character === 'p2' ? 'p2' : 'ash',
    color: COLORS.includes(value.color) ? value.color : COLORS[0]
  };
}

// Exactly one process owns each room. Deploy ONE replica; multi-process routing
// requires a room directory/lease system before increasing that replica count.
export function createAuthority({ origins = [], maxRooms = 32, reconnectMs = 15000, emptyRoomMs = 60000, autoTick = true, enablePrediction = true, now = () => performance.now(), simulationFactory = createSimulation } = {}) {
  const rooms = new Map();
  const sockets = new Set();
  const httpServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/health') res.end(JSON.stringify({ ok: true, protocol: PROTOCOL, rooms: rooms.size }));
    else { res.statusCode = 404; res.end('{"error":"not_found"}'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: {
    serverNoContextTakeover: true, clientNoContextTakeover: true,
    threshold: 1024, concurrencyLimit: 4, zlibDeflateOptions: { level: 3 }
  } });
  httpServer.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    if (req.url !== '/encore' || !origins.includes(origin) || sockets.size >= maxRooms * MAX_PLAYERS + 16) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });

  function send(ws, value) {
    if (ws.readyState !== WebSocket.OPEN) return;
    // Slow/background phones get a new complete snapshot after reconnect;
    // never accumulate seconds of stale gameplay in the browser's TCP queue.
    if (ws.bufferedAmount > 128 * 1024) { ws.close(4008, 'slow_connection'); return; }
    ws.send(typeof value === 'string' ? value : JSON.stringify(value));
  }
  function reject(ws, reason, details = {}) { send(ws, { type: 'rejected', reason, ...details }); ws.close(4000, reason); }
  function roomSnapshot(room) { return { type: 'snapshot', protocol: PROTOCOL, epoch: room.epoch, ...room.sim.snapshot() }; }

  function disconnect(ws) {
    sockets.delete(ws);
    const session = ws.session;
    if (!session || session.socket !== ws) return;
    session.socket = null; session.disconnectedAt = now();
    session.player.connected = false; session.player.input = {};
    if (ws.voluntary) {
      ws.room.sessions.delete(session.token);
      ws.room.sim.removePlayer(session.player.id);
    }
  }

  wss.on('connection', ws => {
    sockets.add(ws);
    ws.openedAt = now(); ws.lastMessageAt = now(); ws.windowAt = now(); ws.messageCount = 0;
    ws.on('error', () => {});
    ws.on('close', () => disconnect(ws));
    ws.on('message', raw => {
      const timestamp = now();
      if (timestamp - ws.windowAt >= 1000) { ws.windowAt = timestamp; ws.messageCount = 0; }
      if (++ws.messageCount > 90) { reject(ws, 'rate_limit'); return; }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { reject(ws, 'invalid_message'); return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { reject(ws, 'invalid_message'); return; }
      ws.lastMessageAt = timestamp;
      if (!ws.session) {
        if (msg.type !== 'join' || msg.protocol !== PROTOCOL || typeof msg.room !== 'string' || !/^[a-zA-Z0-9_-]{1,60}$/.test(msg.room)) { reject(ws, 'incompatible_join'); return; }
        let room = rooms.get(msg.room);
        if (!room) {
          if (rooms.size >= maxRooms) { reject(ws, 'server_full'); return; }
          room = { id: msg.room, epoch: randomUUID(), sim: simulationFactory(), sessions: new Map(), emptySince: timestamp };
          rooms.set(msg.room, room);
        }
        let session = typeof msg.resumeToken === 'string' ? room.sessions.get(msg.resumeToken) : null;
        if (session && !session.socket && timestamp - session.disconnectedAt > reconnectMs) {
          room.sessions.delete(session.token); room.sim.removePlayer(session.player.id); session = null;
        }
        if (!session) {
          if (room.sessions.size >= MAX_PLAYERS) { reject(ws, 'room_full', { count: room.sessions.size }); return; }
          const id = randomUUID();
          session = { token: randomBytes(32).toString('base64url'), player: room.sim.addPlayer(id, profile(msg.profile)), socket: null, seq: -1, disconnectedAt: null };
          room.sessions.set(session.token, session);
        }
        const previousSocket = session.socket;
        session.socket = ws; session.seq = -1; session.disconnectedAt = null;
        session.player.connected = true; session.player.input = {};
        session.player.inputQueue = []; session.player.lastQueuedInputSeq = -1; session.player.ackInputSeq = -1;
        Object.assign(session.player, profile(msg.profile));
        ws.session = session; ws.room = room;
        if (previousSocket && previousSocket !== ws) previousSocket.close(4001, 'session_replaced');
        send(ws, { type: 'welcome', protocol: PROTOCOL, predictionVersion: enablePrediction ? 1 : 0, epoch: room.epoch, id: session.player.id, resumeToken: session.token, maxPlayers: MAX_PLAYERS, snapshotHz: 15 });
        send(ws, roomSnapshot(room));
        return;
      }
      if (ws.session.socket !== ws) return;
      if (msg.type === 'leave') { ws.voluntary = true; disconnect(ws); ws.close(1000, 'left'); return; }
      if (msg.type === 'profile') { Object.assign(ws.session.player, profile(msg.profile)); return; }
      if (msg.type === 'inputs') {
        if (!enablePrediction) return;
        const p = ws.session.player;
        if (!Array.isArray(msg.commands) || !msg.commands.length || msg.commands.length > 12) return;
        const accepted = [], pending = p.inputQueue || [];
        let last = p.lastQueuedInputSeq ?? -1;
        for (const command of msg.commands) {
          if (!Number.isSafeInteger(command?.seq) || command.seq < 0 || command.seq <= last || !command.input || typeof command.input !== 'object') continue;
          const input = {};
          for (const key of INPUT_BUTTONS) input[key] = command.input[key] === true;
          for (const key of ['aimAxisX', 'aimAxisY']) input[key] = Number.isFinite(command.input[key]) ? Math.max(-1, Math.min(1, command.input[key])) : 0;
          accepted.push({ seq: command.seq, input }); last = command.seq;
        }
        // Inputs never buy simulation time: at most one command is consumed
        // per server tick. Reject an unbounded sender instead of a huge backlog.
        if (pending.length + accepted.length > 120) { reject(ws, 'input_overflow'); return; }
        p.inputQueue = pending.concat(accepted); p.lastQueuedInputSeq = last;
        p.lastInputTick = ws.room.sim.game.frame;
        return;
      }
      if (msg.type !== 'input') return; // No client state, damage, spawn or outcome messages.
      if (!Number.isSafeInteger(msg.seq) || msg.seq < 0 || msg.seq <= ws.session.seq || !msg.input || typeof msg.input !== 'object') return;
      ws.session.seq = msg.seq;
      const p = ws.session.player;
      for (const key of INPUT_BUTTONS) {
        const held = msg.input[key] === true;
        p.input[key] = EDGES.has(key) ? Boolean(p.input[key] || held) : held;
      }
      for (const key of ['aimAxisX','aimAxisY']) p.input[key] = typeof msg.input[key] === 'number' && Number.isFinite(msg.input[key]) ? Math.max(-1, Math.min(1, msg.input[key])) : 0;
      p.lastInputTick = ws.room.sim.game.frame;
    });
  });

  function tick() {
    const timestamp = now();
    for (const ws of sockets) {
      if ((!ws.session && timestamp - ws.openedAt > 5000) || timestamp - ws.lastMessageAt > 10000) { ws.terminate(); disconnect(ws); }
    }
    for (const [id, room] of rooms) {
      for (const [token, session] of room.sessions) {
        if (!session.socket && timestamp - session.disconnectedAt >= reconnectMs) { room.sessions.delete(token); room.sim.removePlayer(session.player.id); }
      }
      if (!room.sessions.size) {
        if (timestamp - room.emptySince > emptyRoomMs) rooms.delete(id);
        continue;
      }
      room.emptySince = timestamp;
      room.sim.step();
      if (room.sim.game.frame % 4 === 0) {
        const snapshot = JSON.stringify(roomSnapshot(room));
        for (const session of room.sessions.values()) if (session.socket) send(session.socket, snapshot);
      }
    }
  }

  // Monotonic fixed steps; bound catch-up after a host stall without allowing
  // client clocks or message frequency to speed up the simulation.
  let lastTick = now(), accumulator = 0;
  const timer = autoTick ? setInterval(() => {
    const current = now(); accumulator += Math.min(100, current - lastTick); lastTick = current;
    while (accumulator >= 1000 / 60) { tick(); accumulator -= 1000 / 60; }
  }, 8) : null;
  return {
    rooms, tick, httpServer,
    listen: (port = 0, host = '127.0.0.1') => new Promise(resolve => httpServer.listen(port, host, () => resolve(httpServer.address()))),
    close: async () => {
      clearInterval(timer);
      for (const ws of sockets) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => httpServer.close(resolve));
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const origins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!origins.length) throw new Error('Set ALLOWED_ORIGINS to the exact game origins (comma separated).');
  const server = createAuthority({ origins });
  const address = await server.listen(Number(process.env.PORT || 8787), process.env.HOST || '0.0.0.0');
  console.log(`Encore authority listening on ${address.port}; one process, 60 Hz simulation, 15 Hz snapshots.`);
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => server.close().then(() => process.exit(0)));
}
