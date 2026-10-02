import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation } from '../server/simulation.mjs';
function setup() {
  const sim = createSimulation({ random: () => .5 });
  sim.game.creatures.forEach(c => { c.alive = false; c.respawnTimer = 10000; });
  Object.assign(sim.game.bot, { x: 430, y: 336, shootCooldown: 0, meleeCooldown: 0 });
  return sim;
}
function add(sim, id, color, x) {
  const p = sim.addPlayer(id, { color });
  Object.assign(p, { x, y: 336, vx: 0, vy: 0, invulnerable: 0 });
  return p;
}
function shot(sim, owner, ownerId, color, x, y) {
  sim.game.projectiles.push({ id: 100, owner, ownerId, color, x, y, vx: 0, vy: 0, life: 60 });
}
test('blue bot skips its closest blue ally and pursues a farther enemy; recolor changes allegiance immediately', () => {
  const sim = setup(), ally = add(sim, 'ally', '#4FA3FF', 410), enemy = add(sim, 'enemy', '#e85d5d', 650);
  sim.step(); assert.ok(sim.game.bot.vx > 0, 'pursues right-side enemy rather than closer left-side ally');
  assert.equal(ally.health, 3);
  enemy.color = '#4fa3ff'; sim.game.bot.vx = 0;
  const before = sim.game.projectiles.length;
  for (let n = 0; n < 12; n++) sim.step();
  assert.equal(sim.game.bot.vx, 0); assert.equal(sim.game.projectiles.length, before);
  ally.color = '#e85d5d'; ally.x = sim.game.bot.x - 150;
  sim.step(); assert.ok(sim.game.bot.vx < 0, 'new enemy is immediately eligible');
});
test('bot projectiles pass through allies, and allied player shots pass through the bot', () => {
  const sim = setup(), ally = add(sim, 'ally', '#4fa3ff', 120);
  sim.game.bot.shootCooldown = 1000;
  shot(sim, 'bot', 'bot', '#4fa3ff', ally.x, ally.y - 18);
  sim.step(); assert.equal(ally.health, 3); assert.equal(sim.game.projectiles.length, 1);
  ally.color = '#e85d5d'; sim.step(); assert.equal(ally.health, 2);
  ally.color = '#4fa3ff'; sim.game.bot.shootCooldown = 1000;
  shot(sim, 'player', ally.id, ally.color, sim.game.bot.x, sim.game.bot.y - 18);
  sim.step(); assert.equal(sim.game.bot.health, 3); assert.equal(sim.game.projectiles.length, 1);
  sim.game.projectiles[0].color = '#e85d5d'; ally.color = '#e85d5d';
  sim.step(); assert.equal(sim.game.bot.health, 2);
});
test('allied melee and landing on the bot cannot deal friendly damage', () => {
  const sim = setup(), ally = add(sim, 'ally', '#4fa3ff', 404);
  ally.input = { meleePressed: true }; ally.lastInputTick = sim.game.frame;
  for (let n = 0; n < 12; n++) { ally.input.meleePressed = n === 0; sim.step(); }
  assert.equal(sim.game.bot.health, 3); assert.equal(ally.health, 3);
  Object.assign(ally, { x: sim.game.bot.x, y: sim.game.bot.y - 35, vy: 3, grounded: false });
  for (let n = 0; n < 12; n++) sim.step();
  assert.equal(sim.game.bot.health, 3); assert.equal(ally.health, 3);
  assert.equal(sim.snapshot().bot.color, '#4fa3ff');
});
