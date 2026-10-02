import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from '../server/node_modules/ws/wrapper.mjs';
import { createAuthority } from '../server/index.mjs';
import { createSimulation } from '../server/simulation.mjs';

const origin = 'http://127.0.0.1:4193';
test('batched commands acknowledge consumed input only, reject replay and cannot buy extra simulation time', async t => {
  const { server, join, advance } = await setup(t);
  const client = await join();
  assert.equal(client.hello.predictionVersion, 1);
  const sim = server.rooms.get('qa').sim, p = sim.game.players.get(client.hello.id);
  const commands = Array.from({ length: 12 }, (_, seq) => ({ seq, input: {
    left: false, right: true, up: false, down: false, jumpPressed: false,
    jumpHeld: false, dashPressed: false, shootHeld: false, shootReleased: false,
    meleePressed: false, aimAxisX: .123456789, aimAxisY: .987654321,
    health: 999, x: 99999
  } }));
  assert.ok(Buffer.byteLength(JSON.stringify({ type: 'inputs', commands })) > 2048,
    'a real full command batch needs the bounded 4 KiB packet allowance');
  client.ws.send(JSON.stringify({ type: 'inputs', commands }));
  await until(() => p.inputQueue.length === 12);
  assert.equal(p.ackInputSeq, -1, 'receipt is not simulation acknowledgement');
  await advance(4);
  assert.equal(p.ackInputSeq, 3); assert.equal(p.inputQueue.length, 8);
  assert.equal(sim.game.frame, 4); assert.ok(p.x < 130); assert.equal(p.health, 3);
  assert.equal(client.snapshot().players[0].ackInputSeq, 3);
  client.ws.send(JSON.stringify({ type: 'inputs', commands }));
  await pause(); assert.equal(p.inputQueue.length, 8, 'replays cannot enqueue again');
  await advance(8); assert.equal(p.ackInputSeq, 11);
  const before = p.x; await advance(4);
  assert.ok(p.x > before, 'held controls bridge a short packet gap');
});
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(fn) {
  for (let i = 0; i < 400; i++) { const value = fn(); if (value) return value; await pause(); }
  throw new Error('Timed out waiting for server/client state');
}
async function setup(t) {
  let clock = 0;
  const server = createAuthority({ origins: [origin], autoTick: false, now: () => clock, simulationFactory: () => createSimulation({ random: () => .25 }) });
  const address = await server.listen();
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${address.port}/encore`;
  const peers = [];
  async function join(profile = {}, resumeToken, room = 'qa') {
    const ws = new WebSocket(url, { origin });
    const messages = [];
    ws.on('message', raw => messages.push(JSON.parse(raw)));
    ws.on('error', () => {});
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'join', protocol: 1, room, profile, resumeToken }));
    const hello = await until(() => messages.find(m => ['welcome','rejected'].includes(m.type)));
    if (hello.type === 'welcome') await until(() => messages.find(m => m.type === 'snapshot'));
    const peer = { ws, messages, hello, room, snapshot: () => messages.findLast(m => m.type === 'snapshot') };
    peers.push(peer); return peer;
  }
  const advance = async frames => {
    for (let i = 0; i < frames; i++) {
      clock += 1000 / 60; server.tick();
      if (i % 4 === 3 || i === frames - 1) {
        await until(() => peers.every(peer => {
          if (peer.hello.type !== 'welcome' || peer.ws.readyState !== WebSocket.OPEN) return true;
          const room = server.rooms.get(peer.room);
          if (!room?.sim.game.players.has(peer.hello.id)) return true;
          return peer.snapshot()?.tick >= room.sim.game.frame - room.sim.game.frame % 4;
        }));
      }
    }
  };
  return { server, join, advance, jumpClock: ms => { clock += ms; } };
}

test('two clients see the same bot targeting, slug kill, falling heart, late join and one pickup', async t => {
  const { server, join, advance } = await setup(t);
  const a = await join({ name: 'Felix', color: '#e85d5d' });
  const b = await join({ name: '00Codex', color: '#65cf84' });
  const sim = server.rooms.get('qa').sim;
  const pa = sim.game.players.get(a.hello.id), pb = sim.game.players.get(b.hello.id);
  pa.x = 100; pb.x = 550;
  const startBotX = sim.game.bot.x;
  await advance(12);
  assert.ok(sim.game.bot.x > startBotX, 'bot targets nearby second player, not first client');
  await until(() => a.snapshot().tick === b.snapshot().tick);
  assert.deepEqual(a.snapshot(), b.snapshot());
  sim.game.bot.x = 1700;
  const slug = sim.game.creatures.find(c => c.id === 'slug-west');
  Object.assign(slug, { x: 420, y: 336, health: 1, attackCooldown: 9999 });
  Object.assign(pa, { x: 399, y: 336, facing: 1, vx: 0, vy: 0 });
  Object.assign(pb, { x: 441, y: 336, facing: -1, vx: 0, vy: 0 });
  for (const client of [a,b]) client.ws.send(JSON.stringify({ type: 'input', seq: 1, input: { meleePressed: true } }));
  await until(() => [...server.rooms.get('qa').sessions.values()].every(s => s.seq === 1));
  await advance(12);
  assert.equal(slug.alive, false);
  assert.equal(sim.game.events.filter(e => e.type === 'death' && e.targetId === slug.id).length, 1);
  assert.equal(pa.creatureKills + pb.creatureKills, 1);
  assert.equal(a.snapshot().hearts.length, 1);
  assert.deepEqual(a.snapshot(), b.snapshot());
  const late = await join({ name: 'Late' });
  for (const key of ['tick','bot','creatures','hearts','captures']) assert.deepEqual(late.snapshot()[key], a.snapshot()[key], `late join receives current ${key}`);
  const oldHeartY = a.snapshot().hearts[0].y;
  await advance(8);
  assert.notEqual(a.snapshot().hearts[0].y, oldHeartY);
  assert.deepEqual(a.snapshot().hearts, b.snapshot().hearts);
  assert.deepEqual(a.snapshot().hearts, late.snapshot().hearts);
  const heart = sim.snapshot().hearts[0];
  for (const p of [pa,pb]) Object.assign(p, { x: heart.x, y: 336, health: 1, invulnerable: 1000 });
  await advance(24);
  assert.equal(sim.snapshot().hearts.length, 0);
  assert.equal(pa.health + pb.health, 3, 'one heart restores exactly one actual health point');
  assert.equal(sim.game.events.filter(e => e.type === 'heal').length, 1);
  assert.deepEqual(a.snapshot().hearts, []); assert.deepEqual(b.snapshot().hearts, []); assert.deepEqual(late.snapshot().hearts, []);
  assert.deepEqual(a.snapshot().players, b.snapshot().players);
});

test('death and random respawn survive reconnect; forged outcomes and repeated controls do not', async t => {
  const { server, join, advance } = await setup(t);
  const a = await join({ name: 'Felix' }); const b = await join({ name: '00Codex', color: '#65cf84' });
  const sim = server.rooms.get('qa').sim, p = sim.game.players.get(a.hello.id);
  a.ws.send(JSON.stringify({ type: 'hit', targetId: b.hello.id, amount: 999 }));
  a.ws.send(JSON.stringify({ type: 'state', x: 9999, health: 999, alive: false }));
  a.ws.send(JSON.stringify({ type: 'input', seq: 10, input: { right: true, x: 9999, health: 999, aimAxisX: 'NaN' } }));
  a.ws.send(JSON.stringify({ type: 'input', seq: 10, input: { left: true } }));
  await until(() => [...server.rooms.get('qa').sessions.values()].find(s => s.player === p).seq === 10);
  await advance(4);
  assert.ok(p.x > 120 && p.x < 130); assert.equal(p.health, 3);
  p.health = 1; p.invulnerable = 0; p.input = {};
  sim.game.projectiles.push({ id: 10000, owner: 'bot', ownerId: 'bot', x: p.x, y: p.y - 16, vx: 0, vy: 0, life: 10 });
  await advance(4);
  assert.equal(p.alive, false); assert.equal(p.health, 0);
  assert.deepEqual(a.snapshot().players, b.snapshot().players);
  a.ws.terminate(); await until(() => !p.connected);
  const resumed = await join({ name: 'Felix' }, a.hello.resumeToken);
  assert.equal(resumed.hello.id, a.hello.id);
  assert.equal(resumed.snapshot().players.find(v => v.id === p.id).alive, false);
  assert.equal(sim.game.players.size, 2);
  const deathX = p.x;
  await advance(p.respawnTimer + 4);
  assert.equal(p.alive, true); assert.equal(p.health, 3); assert.notEqual(p.x, deathX);
  assert.equal(p.deaths, 1);
  assert.deepEqual(resumed.snapshot().players, b.snapshot().players);
});

test('admission never evicts existing members, full rejection has no snapshot, leave and expiry release slots', async t => {
  const { server, join, advance, jumpClock } = await setup(t);
  const clients = [];
  for (let i = 0; i < 8; i++) clients.push(await join({ name: `P${i}` }));
  const ids = [...server.rooms.get('qa').sim.game.players.keys()];
  const rejected = await join({ name: 'Ninth' });
  assert.equal(rejected.hello.reason, 'room_full'); assert.equal(rejected.snapshot(), undefined);
  assert.deepEqual([...server.rooms.get('qa').sim.game.players.keys()], ids);
  clients[0].ws.send(JSON.stringify({ type: 'leave' }));
  await until(() => server.rooms.get('qa').sessions.size === 7);
  const replacement = await join({ name: 'Replacement' });
  assert.equal(replacement.hello.type, 'welcome');
  await advance(4);
  assert.equal(clients[1].snapshot().players.length, 8);
  assert.ok(!clients[1].snapshot().players.some(p => p.id === clients[0].hello.id));
  clients[2].ws.terminate(); await until(() => !server.rooms.get('qa').sim.game.players.get(clients[2].hello.id).connected);
  jumpClock(15001); await advance(4);
  assert.ok(!server.rooms.get('qa').sim.game.players.has(clients[2].hello.id));
});

test('capture ownership, same-player recolor, remote profile, and contest share a single result', async t => {
  const { server, join, advance } = await setup(t);
  const a = await join({ name: 'Felix' }); const b = await join({ name: 'Remote', color: '#4fa3ff' });
  const sim = server.rooms.get('qa').sim;
  const pa = sim.game.players.get(a.hello.id), pb = sim.game.players.get(b.hello.id);
  sim.game.bot.alive = false; sim.game.bot.respawnTimer = 99999;
  for (const c of sim.game.creatures) { c.alive = false; c.respawnTimer = 99999; }
  Object.assign(pa, { x: 330, y: 180 }); Object.assign(pb, { x: 1100, y: 336 });
  await advance(184);
  assert.equal(sim.snapshot().captures[0].color, '#e85d5d');
  a.ws.send(JSON.stringify({ type: 'profile', profile: { name: 'Renamed', color: '#65cf84', character: 'p2' } }));
  await until(() => pa.color === '#65cf84');
  await advance(184);
  assert.equal(sim.snapshot().captures[0].color, '#65cf84');
  assert.equal(sim.snapshot().captures[0].contributors[0].id, a.hello.id);
  assert.equal(b.snapshot().players.find(p => p.id === a.hello.id).name, 'Renamed');
  Object.assign(pb, { x: 335, y: 180 });
  pa.color = '#b77bff';
  await advance(100);
  assert.ok(sim.snapshot().captureContested.includes('backstage'));
  assert.equal(sim.snapshot().captures[0].color, '#65cf84');
  assert.deepEqual(a.snapshot().captures, b.snapshot().captures);
  assert.ok(sim.snapshot().events.every(e => Number.isInteger(e.id)), 'capture does not overwrite ordered event ID');
});
