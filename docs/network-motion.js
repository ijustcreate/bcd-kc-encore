// Shared, testable presentation layer. It cannot award damage or advance AI.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./player-movement.js'));
  else root.EncoreMotion = factory(root.EncoreMovement);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (movement) {
  const STEP_MS = 1000 / 60;
  class Predictor {
    constructor(geometry) { this.geometry = geometry; this.clear(); }
    clear() {
      this.actor = null; this.movers = []; this.pending = []; this.epoch = null;
      this.offset = { x: 0, y: 0 }; this.lastAck = -1; this.corrections = 0; this.maxError = 0;
    }
    step(command) {
      if (!this.actor || this.pending.length >= 120) return false;
      this.pending.push({ seq: command.seq, input: { ...command.input } });
      this.advance(command.input);
      return true;
    }
    advance(input) {
      if (!this.actor.alive) return;
      movement.advanceMovers(this.movers, this.actor, this.geometry);
      movement.stepPlayer(this.actor, input, { ...this.geometry, movers: this.movers });
    }
    reconcile(actor, movers, epoch) {
      if (!Number.isSafeInteger(actor.ackInputSeq)) return false;
      const previous = this.actor;
      const reset = this.epoch !== epoch || !previous || previous.alive !== actor.alive || previous.spawnSerial !== actor.spawnSerial;
      if (!reset && actor.ackInputSeq < this.lastAck) return false;
      this.epoch = epoch; this.lastAck = actor.ackInputSeq;
      this.pending = reset ? [] : this.pending.filter(command => command.seq > actor.ackInputSeq);
      this.actor = { ...actor };
      this.movers = movers.map(mover => ({ ...mover }));
      for (const command of this.pending) this.advance(command.input);
      const error = previous ? Math.hypot(previous.x - this.actor.x, previous.y - this.actor.y) : 0;
      this.maxError = Math.max(this.maxError, error); this.corrections++;
      if (!reset && error < 64) {
        this.offset.x += previous.x - this.actor.x; this.offset.y += previous.y - this.actor.y;
      } else this.offset.x = this.offset.y = 0;
      return true;
    }
    decay(deltaMs) {
      const factor = Math.exp(-Math.max(0, deltaMs) / 65);
      this.offset.x *= factor; this.offset.y *= factor;
    }
  }

  class SnapshotBuffer {
    constructor() { this.clear(); }
    clear() { this.samples = []; this.offset = null; this.delayMs = 120; this.lastArrival = null; this.lastTarget = -Infinity; this.epoch = null; }
    push(snapshot, now) {
      if (snapshot.epoch !== this.epoch) { this.clear(); this.epoch = snapshot.epoch; }
      if (this.samples.length && snapshot.tick <= this.samples[this.samples.length - 1].tick) return;
      const offset = now - snapshot.tick * STEP_MS;
      this.offset = this.offset === null ? offset : this.offset + (offset - this.offset) * .1;
      if (this.lastArrival !== null) {
        const gap = Math.max(0, now - this.lastArrival);
        this.delayMs += (Math.max(100, Math.min(200, gap * 2)) - this.delayMs) * .1;
      }
      this.lastArrival = now;
      this.samples.push(snapshot);
      if (this.samples.length > 16) this.samples.shift();
    }
    sample(now) {
      if (!this.samples.length) return null;
      const target = Math.max(this.lastTarget, (now - this.offset - this.delayMs) / STEP_MS);
      this.lastTarget = target;
      let a = this.samples[0], b = a;
      for (const item of this.samples) { if (item.tick <= target) a = item; if (item.tick >= target) { b = item; break; } b = item; }
      if (a.tick === b.tick || target >= b.tick) return b;
      const t = Math.max(0, Math.min(1, (target - a.tick) / (b.tick - a.tick)));
      function actor(before, after) {
        if (!after || before.alive !== after.alive || before.spawnSerial !== after.spawnSerial || Math.hypot(before.x - after.x, before.y - after.y) > 128) return { ...before };
        // Discrete health/attack state follows the older sample; interpolate
        // positions only. Never slide between deaths or respawn locations.
        return { ...before, x: before.x + (after.x - before.x) * t, y: before.y + (after.y - before.y) * t };
      }
      const list = (before = [], after = []) => {
        const next = new Map(after.map(item => [item.id, item]));
        return before.map(item => actor(item, next.get(item.id)));
      };
      return { ...a, players: list(a.players, b.players), bot: actor(a.bot, b.bot), creatures: list(a.creatures, b.creatures), projectiles: list(a.projectiles, b.projectiles), movers: list(a.movers, b.movers), hearts: list(a.hearts, b.hearts) };
    }
  }
  return { Predictor, SnapshotBuffer };
});
