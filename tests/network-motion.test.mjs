import test from 'node:test';
import assert from 'node:assert/strict';
import motion from '../docs/network-motion.js';
import { createSimulation } from '../server/simulation.mjs';

test('prediction replays delayed acknowledgements with identical movement, jump, dash and moving-platform collision', () => {
  const sim = createSimulation({ random: () => .25 });
  const player = sim.addPlayer('local'); player.ackInputSeq = -1;
  Object.assign(player, { x: 276, y: 276, vx: 0, vy: 0, invulnerable: 10000 });
  sim.game.bot.alive = false; sim.game.bot.respawnTimer = 10000;
  sim.game.creatures.forEach(c => { c.alive = false; c.respawnTimer = 10000; });
  const predictor = new motion.Predictor(sim.geometry);
  predictor.reconcile(sim.snapshot().players[0], sim.snapshot().movers, 'room');
  const snapshots = [];
  const keys = ['x', 'y', 'vx', 'vy', 'xRemainder', 'yRemainder', 'dashTimer', 'dashCooldown', 'jumpBuffer', 'coyote', 'crouching', 'clinging', 'animation'];
  for (let tick = 0; tick < 180; tick++) {
    const input = { right: tick > 15 && tick < 150, left: tick >= 150, jumpPressed: tick === 35 || tick === 110, jumpHeld: tick >= 35 && tick < 52, dashPressed: tick === 85, down: tick === 110 };
    const command = { seq: tick, input };
    predictor.step(command); player.inputQueue = [command]; player.lastInputTick = sim.game.frame;
    sim.step(); snapshots.push(sim.snapshot());
    if (tick >= 12 && tick % 4 === 0) {
      const old = snapshots[tick - 12];
      predictor.reconcile(old.players[0], old.movers, 'room');
    }
    for (const key of keys) assert.equal(predictor.actor[key], player[key], `${key} at tick ${tick}`);
    assert.equal(predictor.actor.health, 3, 'prediction cannot award health or damage');
  }
  assert.ok(predictor.pending.length <= 16);
});

test('death, respawn and epoch changes discard old commands and cosmetic correction', () => {
  const sim = createSimulation(); const player = sim.addPlayer('local'); player.ackInputSeq = -1;
  const predictor = new motion.Predictor(sim.geometry), snap = sim.snapshot();
  predictor.reconcile(snap.players[0], snap.movers, 'one');
  predictor.step({ seq: 0, input: { dashPressed: true } });
  predictor.reconcile({ ...snap.players[0], alive: false, health: 0, ackInputSeq: 0 }, snap.movers, 'one');
  assert.equal(predictor.pending.length, 0); assert.equal(predictor.actor.health, 0);
  predictor.reconcile({ ...snap.players[0], x: 1400, spawnSerial: 1, ackInputSeq: 1 }, snap.movers, 'one');
  assert.equal(predictor.actor.x, 1400); assert.deepEqual(predictor.offset, { x: 0, y: 0 });
  predictor.step({ seq: 2, input: { right: true } });
  predictor.reconcile({ ...snap.players[0], ackInputSeq: -1 }, snap.movers, 'two');
  assert.equal(predictor.pending.length, 0); assert.equal(predictor.actor.x, snap.players[0].x);
});

const snapshot = (tick, x, extra = {}) => ({ epoch: 'a', tick, players: [{ id: 'remote', x, y: 100, alive: true, health: 3, ...extra }], bot: { id: 'bot', x: 0, y: 0 }, creatures: [], projectiles: [], movers: [], hearts: [] });
test('remote interpolation is continuous between snapshots and holds instead of extrapolating stale state', () => {
  const buffer = new motion.SnapshotBuffer();
  buffer.push(snapshot(0, 0), 0); buffer.push(snapshot(4, 40), 1000 / 15);
  buffer.delayMs = 100;
  const middle = buffer.sample(100 + 1000 / 30);
  assert.ok(Math.abs(middle.players[0].x - 20) < .001);
  assert.equal(middle.players[0].health, 3);
  assert.equal(buffer.sample(1000).players[0].x, 40);
  for (let i = 5; i < 100; i++) buffer.push(snapshot(i * 4, i), i * 1000 / 15);
  assert.ok(buffer.samples.length <= 16);
});
test('respawns never interpolate across the map; epoch reset clears old positions', () => {
  const buffer = new motion.SnapshotBuffer();
  buffer.push(snapshot(0, 100, { spawnSerial: 0 }), 0);
  buffer.push(snapshot(4, 1200, { spawnSerial: 1 }), 1000 / 15);
  buffer.delayMs = 100;
  assert.equal(buffer.sample(130).players[0].x, 100);
  assert.equal(buffer.sample(200).players[0].x, 1200);
  buffer.push({ ...snapshot(0, 5), epoch: 'b' }, 250);
  assert.equal(buffer.sample(260).players[0].x, 5);
});
