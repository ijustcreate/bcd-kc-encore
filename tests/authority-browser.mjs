import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createAuthority } from '../server/index.mjs';
import { createSimulation } from '../server/simulation.mjs';
import { WebSocket } from '../server/node_modules/ws/wrapper.mjs';
const require = createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright/package.json') : import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve('docs');
const out = path.resolve('output/authority-browser'); fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let authorityUrl;
const staticServer = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://local').pathname;
  if (pathname === '/authority-config.js') { res.setHeader('Content-Type','text/javascript'); res.end(`window.ENCORE_SERVER_URL=${JSON.stringify(authorityUrl)};`); return; }
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', ({'.html':'text/html','.js':'text/javascript','.json':'application/json','.png':'image/png','.css':'text/css'})[path.extname(file)] || 'text/plain');
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => staticServer.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${staticServer.address().port}`;
const server = createAuthority({ origins: [base], autoTick: false, enablePrediction: false, simulationFactory: () => createSimulation({ random: () => .25 }) });
const addr = await server.listen(); authorityUrl = `ws://127.0.0.1:${addr.port}/encore`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.ENCORE_CHROMIUM || undefined, args: ['--no-sandbox'] });
const errors = [];
const clients = [];
async function open(name, mobile = false) {
  const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : { viewport: { width: 1024, height: 700 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/?perf=1');
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text?.() || '{}').room?.connected);
  await page.evaluate(name => window.postMessage({ type:'bcd:encore:init', payload:{playerName:name} }, location.origin), name);
  clients.push(page); return page;
}
const state = page => page.evaluate(() => {
  window.advanceTime(0);
  const result = JSON.parse(window.render_game_to_text());
  // Rig poses are buffered presentation; compare authoritative creature state.
  result.creatures.forEach(creature => { delete creature.rigAnimation; });
  return result;
});
async function advance(frames) {
  for (let i = 0; i < frames; i++) server.tick();
  const tick = server.rooms.get('royal').sim.game.frame;
  const published = tick - tick % 4;
  await Promise.all(clients.map(page => page.waitForFunction(tick => JSON.parse(window.render_game_to_text()).room.tick >= tick, published)));
}
try {
  const desktop = await open('Felix');
  const phone = await open('00Codex', true);
  await sleep(100); await advance(4);
  assert.equal((await state(desktop)).room.players, 2);
  assert.equal((await state(desktop)).room.remotes[0].name, '00Codex');
  assert.equal((await state(phone)).room.remotes[0].name, 'Felix');
  const before = await state(desktop);
  await desktop.evaluate(() => window.advanceTime(3000));
  const after = await state(desktop);
  for (const key of ['bot','creatures','projectiles','movingPlatforms','hearts']) assert.deepEqual(after[key], before[key], `browser cannot advance shared ${key}`);
  const sim = server.rooms.get('royal').sim;
  const p = [...sim.game.players.values()].find(p => p.name === 'Felix');
  const q = [...sim.game.players.values()].find(p => p.name === '00Codex');
  Object.assign(p,{ x:399,y:336,vx:0,vy:0 }); Object.assign(q,{x:500,y:336});
  sim.game.bot.x = 900;
  const slug = sim.game.creatures.find(c => c.id === 'slug-west'); slug.health = 1; slug.x = 420;
  await advance(4);
  await desktop.keyboard.press('KeyV');
  await sleep(80); await advance(16);
  assert.equal(slug.alive, false, 'actual keyboard melee reaches server and kills');
  const d = await state(desktop), m = await state(phone);
  for (const key of ['bot','creatures','projectiles','movingPlatforms','hearts','captureZones']) assert.deepEqual(d[key], m[key]);
  assert.equal(d.hearts.length, 1);
  const late = await open('Late'); await sleep(80); await advance(4);
  assert.deepEqual((await state(late)).hearts, (await state(desktop)).hearts);
  // Wounded overlapping actors compete for the same server-owned heart.
  const heart = sim.snapshot().hearts[0];
  for (const player of [p,q]) Object.assign(player,{x:heart.x,y:336,health:1,invulnerable:1000});
  await advance(24);
  assert.equal(p.health + q.health, 3);
  for (const page of clients) assert.equal((await state(page)).hearts.length, 0);
  await desktop.screenshot({path:path.join(out,'desktop.png')});
  await phone.screenshot({path:path.join(out,'phone.png')});
  // Drop the transport, retain its resume token, and verify cleanup + resync.
  const session = [...server.rooms.get('royal').sessions.values()].find(s => s.player.id === p.id);
  session.socket.terminate();
  await desktop.waitForFunction(() => !JSON.parse(window.render_game_to_text()).room.connected);
  const disconnected = await state(desktop);
  assert.equal(disconnected.room.players,null); assert.equal(disconnected.room.remotes.length,0);
  await desktop.waitForFunction(() => JSON.parse(window.render_game_to_text()).room.connected);
  assert.equal(sim.game.players.size,3);
  assert.equal((await state(desktop)).player.health,p.health);
  assert.equal((await state(desktop)).room.epoch, before.room.epoch);
  // Server rejected browsers cannot show phantom accepted members.
  for (let i = 0; i < 5; i++) {
    const ws = new WebSocket(authorityUrl, { origin: base });
    await new Promise(resolve => { ws.on('open', () => ws.send(JSON.stringify({ type:'join', protocol:1, room:'royal', profile:{name:`Extra${i}`} }))); ws.on('message', raw => { if (JSON.parse(raw).type === 'welcome') resolve(); }); });
  }
  const extra = await browser.newPage();
  extra.on('pageerror', e => errors.push(e.message)); await extra.goto(base);
  await extra.waitForFunction(() => document.getElementById('roomStatus').textContent.includes('ROOM FULL'));
  const full = await state(extra);
  assert.equal(full.room.connected,false); assert.equal(full.room.players,8); assert.deepEqual(full.room.remotes,[]);
  assert.equal(sim.game.players.size,8);
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({passed:true,desktop:d,phone:m,disconnected,full,errors},null,2));
  console.log('PASS: desktop + mobile snapshots, input, late join, heal, reconnect, room full, no client simulation or browser errors');
} finally { await browser.close(); await server.close(); await new Promise(resolve => staticServer.close(resolve)); }
