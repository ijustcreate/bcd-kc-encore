import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createAuthority } from '../server/index.mjs';
import { createSimulation } from '../server/simulation.mjs';
import { WebSocketServer, WebSocket } from '../server/node_modules/ws/wrapper.mjs';
const require = createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright/package.json') : import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve('docs');
let endpoint;
const staticServer = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  if (name === '/authority-config.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(`window.ENCORE_SERVER_URL=${JSON.stringify(endpoint)};`); }
  const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : decodeURIComponent(name)));
  if (!file.startsWith(root + '/') || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' }[path.extname(file)] || 'text/plain');
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => staticServer.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${staticServer.address().port}`;
const authority = createAuthority({ origins: [base], simulationFactory: () => createSimulation({ random: () => .25 }) });
const addr = await authority.listen();
const proxyHttp = http.createServer(), proxy = new WebSocketServer({ server: proxyHttp });
const timers = new Set();
proxy.on('connection', browserSocket => {
  const serverSocket = new WebSocket(`ws://127.0.0.1:${addr.port}/encore`, { origin: base });
  const incoming = []; let upDue = 0, downDue = 0, jitter = 0;
  const delayed = (socket, text, direction) => {
    const now = performance.now(), wait = [80, 110, 90, 70][jitter++ % 4];
    const due = Math.max(now + wait, (direction === 'up' ? upDue : downDue) + 1);
    if (direction === 'up') upDue = due; else downDue = due;
    const timer = setTimeout(() => { timers.delete(timer); if (socket.readyState === WebSocket.OPEN) socket.send(text); }, due - now);
    timers.add(timer);
  };
  browserSocket.on('message', raw => { const text = raw.toString(); if (serverSocket.readyState === WebSocket.OPEN) delayed(serverSocket, text, 'up'); else incoming.push(text); });
  serverSocket.on('open', () => incoming.splice(0).forEach(text => delayed(serverSocket, text, 'up')));
  serverSocket.on('message', raw => delayed(browserSocket, raw.toString(), 'down'));
  browserSocket.on('close', () => serverSocket.close());
  serverSocket.on('close', () => browserSocket.close());
  browserSocket.on('error', () => {}); serverSocket.on('error', () => {});
});
await new Promise(resolve => proxyHttp.listen(0, '127.0.0.1', resolve));
endpoint = `ws://127.0.0.1:${proxyHttp.address().port}/encore`;
const browser = await chromium.launch({ executablePath: process.env.ENCORE_CHROMIUM || undefined, args: ['--no-sandbox'] });
const errors = [];
const extraPeers = [];
const state = page => page.evaluate(() => JSON.parse(render_game_to_text()));
try {
  const context = await browser.newContext({ viewport: { width: 428, height: 926 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  await context.addInitScript(() => {
    window.__submitted = 0;
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      if (this.canvas.id === 'game' && args[0].width === 1920) window.__submitted++;
      return draw.apply(this, args);
    };
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/?admin=1');
  await page.waitForFunction(() => JSON.parse(render_game_to_text()).room.prediction && JSON.parse(render_game_to_text()).player.rigAnimation);
  const sim = authority.rooms.get('royal').sim, local = [...sim.game.players.values()][0];
  sim.game.bot.alive = false; sim.game.bot.respawnTimer = 9999;
  sim.game.creatures.forEach(c => { c.alive = false; c.respawnTimer = 9999; });
  local.invulnerable = 10000;
  await page.waitForTimeout(350);
  const initial = await state(page), serverX = local.x;
  await page.keyboard.down('ArrowRight'); await page.waitForTimeout(60);
  const immediate = await state(page);
  assert.ok(immediate.player.x > initial.player.x, 'local movement appears before round trip');
  assert.equal(local.x, serverX, 'delayed server has not received Right yet');
  await page.waitForTimeout(450); await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(450);
  const settled = await state(page);
  const convergenceError = Math.abs(settled.player.x - local.x);
  assert.ok(convergenceError <= 3, 'prediction converges after input acknowledgements');
  assert.ok(settled.room.pendingInputs < 30, 'bounded replay history under jitter');
  assert.equal(settled.player.health, local.health);

  const second = await context.newPage(); second.on('pageerror', e => errors.push(e.message));
  await second.goto(base + '/?admin=1');
  await second.waitForFunction(() => JSON.parse(render_game_to_text()).room.prediction);
  await page.waitForFunction(() => JSON.parse(render_game_to_text()).room.players === 2);
  await second.keyboard.down('ArrowRight'); await page.waitForTimeout(350);
  // Use the known remote ID to distinguish remote interpolation from the local actor.
  const remoteId = (await state(page)).room.remotes[0].id;
  const remotePositions = [];
  for (let i = 0; i < 10; i++) {
    remotePositions.push(await page.evaluate(id => __celestefallTest.networkState().players.find(p => p.id === id).x, remoteId));
    await page.waitForTimeout(17);
  }
  assert.ok(new Set(remotePositions.map(x => x.toFixed(2))).size >= 6, 'remote movement advances between 15 Hz snapshots');
  await second.keyboard.up('ArrowRight');
  for (let i = 0; i < 6; i++) {
    const peer = new WebSocket(`ws://127.0.0.1:${addr.port}/encore`, { origin: base }); extraPeers.push(peer);
    await new Promise(resolve => {
      peer.on('open', () => peer.send(JSON.stringify({ type: 'join', protocol: 1, room: 'royal', profile: { name: `Peer ${i}`, character: i % 2 ? 'p2' : 'ash', color: ['#65cf84', '#f2c14e', '#b77bff', '#ef75b5', '#f28a4b', '#4ed1c5'][i] } })));
      peer.on('message', raw => { const msg = JSON.parse(raw); if (msg.type === 'welcome') { Object.assign(sim.game.players.get(msg.id), { x: 200 + i * 5, y: 336, invulnerable: 10000 }); resolve(); } });
    });
  }
  await page.waitForFunction(() => JSON.parse(render_game_to_text()).room.players === 8 && __celestefallTest.networkState().readyRemoteRigs === 7);
  const submitted = await page.evaluate(async () => {
    const start = performance.now(), count = __submitted;
    await new Promise(resolve => setTimeout(resolve, 2000));
    return (__submitted - count) * 1000 / (performance.now() - start);
  });
  assert.ok(submitted > 45, 'eight-player arena retains fast submissions in desktop phone emulation');
  const session = [...authority.rooms.get('royal').sessions.values()].find(s => s.player.id === local.id);
  session.socket.terminate();
  await page.waitForFunction(() => !JSON.parse(render_game_to_text()).room.connected);
  const frozen = (await state(page)).player.x;
  await page.keyboard.down('ArrowLeft'); await page.waitForTimeout(150);
  assert.equal((await state(page)).player.x, frozen, 'prediction freezes while disconnected');
  await page.keyboard.up('ArrowLeft');
  await page.waitForFunction(() => JSON.parse(render_game_to_text()).room.prediction);
  assert.equal(sim.game.players.size, 8, 'reconnect resumes existing entity in a full room');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, oneWayDelayMs: '70–110', initialX: initial.player.x, immediateX: immediate.player.x, serverBeforeInputX: serverX, convergenceError, pendingInputs: settled.room.pendingInputs, remoteDistinctPositions: new Set(remotePositions.map(x => x.toFixed(2))).size, roomPlayers: 8, submittedFps: submitted, errors }));
} finally {
  await browser.close(); for (const timer of timers) clearTimeout(timer);
  for (const peer of extraPeers) peer.terminate();
  for (const socket of proxy.clients) socket.terminate();
  await new Promise(resolve => proxy.close(resolve));
  await new Promise(resolve => proxyHttp.close(resolve));
  await authority.close(); await new Promise(resolve => staticServer.close(resolve));
}
