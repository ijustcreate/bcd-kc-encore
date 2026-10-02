import movement from '../docs/player-movement.js';
import spawnSelector from '../docs/spawn-selector.js';
import { createHeartDrops } from './heart-drops.mjs';
import { stepBatCorpse } from './corpse-physics.mjs';
// Server-only outcomes and AI; player movement is shared with online prediction.
// A room owns this closure; selected player context never leaves a synchronous tick.
// No DOM, browser clients, timers or networking can advance this simulation.
  const STEP = 1 / 60;
  const WORLD = { width: 1920, height: 360 };
  const PLAYER_HALF_W = 9;
  const PLAYER_H = 34;
  const PLAYER_CROUCH_H = 21;
  const SPAWN = { x: 120, y: 328 };
  const BOT_SPAWN = { x: 430, y: 328 };
  const MELEE_TIMING = Object.freeze({
    forward: { duration: 16, hitStart: 4, hitEnd: 11 },
    // The authored upward slash effect begins at 0.17s and runs until 0.33s.
    up: { duration: 28, hitStart: 10, hitEnd: 20 },
    down: { duration: 24, hitStart: 4, hitEnd: 18 }
  });
  const PLAYER_RESPAWN_FRAMES = 180;
  const CAPTURE_FRAMES = 180;
  const CREATURE_SPECS = [
    { id: 'slug-west', type: 'slug', spawnX: 420, spawnY: 336, patrolMin: 392, patrolMax: 492, health: 2, width: 34, height: 22 },
    { id: 'slug-east', type: 'slug', spawnX: 1380, spawnY: 336, patrolMin: 1308, patrolMax: 1430, health: 2, width: 34, height: 22 },
    { id: 'bat-west', type: 'bat', spawnX: 520, spawnY: 210, patrolMin: 430, patrolMax: 610, health: 1, width: 32, height: 25 },
    { id: 'bat-east', type: 'bat', spawnX: 1080, spawnY: 190, patrolMin: 990, patrolMax: 1170, health: 1, width: 32, height: 25 }
  ];
  const fixed = [
    { x: 0, y: 0, w: 20, h: 360, kind: 'solid' },
    { x: 0, y: 336, w: 1920, h: 24, kind: 'solid' },
    // Low plinths give every chamber a wall-jump anchor without dividing it.
    { x: 270, y: 304, w: 100, h: 32, kind: 'solid' },
    { x: 608, y: 288, w: 32, h: 48, kind: 'solid' },
    { x: 930, y: 304, w: 60, h: 32, kind: 'solid' },
    { x: 1264, y: 288, w: 32, h: 48, kind: 'solid' },
    { x: 1550, y: 304, w: 100, h: 32, kind: 'solid' },
    { x: 1900, y: 0, w: 20, h: 360, kind: 'solid' }
  ];
  const ledges = [
    { id: 'backstage-low-west', x: 54, y: 292, w: 118, h: 8, kind: 'oneway' },
    { id: 'backstage-low-east', x: 446, y: 292, w: 116, h: 8, kind: 'oneway' },
    { id: 'backstage-mid-west', x: 126, y: 238, w: 122, h: 8, kind: 'oneway' },
    { id: 'backstage-mid-east', x: 370, y: 238, w: 122, h: 8, kind: 'oneway' },
    { id: 'backstage-crown', x: 252, y: 180, w: 116, h: 8, kind: 'oneway' },

    { id: 'opera-low-west', x: 688, y: 292, w: 118, h: 8, kind: 'oneway' },
    { id: 'opera-low-east', x: 1114, y: 292, w: 118, h: 8, kind: 'oneway' },
    { id: 'opera-mid-west', x: 770, y: 238, w: 124, h: 8, kind: 'oneway' },
    { id: 'opera-mid-east', x: 1026, y: 238, w: 124, h: 8, kind: 'oneway' },
    { id: 'opera-gallery-west', x: 704, y: 184, w: 104, h: 8, kind: 'oneway' },
    { id: 'opera-gallery-east', x: 1112, y: 184, w: 104, h: 8, kind: 'oneway' },
    { id: 'opera-crown', x: 886, y: 144, w: 148, h: 8, kind: 'oneway' },

    { id: 'crystal-low-west', x: 1358, y: 292, w: 116, h: 8, kind: 'oneway' },
    { id: 'crystal-low-east', x: 1748, y: 292, w: 116, h: 8, kind: 'oneway' },
    { id: 'crystal-mid-west', x: 1428, y: 238, w: 122, h: 8, kind: 'oneway' },
    { id: 'crystal-mid-east', x: 1672, y: 238, w: 122, h: 8, kind: 'oneway' },
    { id: 'crystal-crown', x: 1550, y: 180, w: 122, h: 8, kind: 'oneway' }
  ];
  const CAPTURE_ZONES = [
    { id: 'backstage', x: 300, y: 168, w: 74, h: 62, label: 'BACKSTAGE' },
    { id: 'opera', x: 924, y: 132, w: 74, h: 62, label: 'OPERA' },
    { id: 'crystal', x: 1610, y: 168, w: 74, h: 62, label: 'CRYSTAL' }
  ];

export function createSimulation({ random = Math.random } = {}) {
  const heartDrops = createHeartDrops({ random });
  const game = { frame: 0, time: 0, players: new Map(), movers: makeMovers(), bot: null, creatures: [], projectiles: [], capturedZones: new Map(), captureProgress: new Map(), events: [] };
  const neutralInput = () => ({ left: false, right: false, up: false, down: false, shootHeld: false, shootReleased: false, meleePressed: false, dashPressed: false, jumpPressed: false, jumpHeld: false, aimAxisX: 0, aimAxisY: 0 });
  let input = neutralInput();
  let attackerId = null;
  let projectileId = 0;
  let eventId = 0;
  const emitDust = () => {};
  const vibrate = () => {};
  game.bot = { ...freshBot(), id: 'bot' };
  game.creatures = CREATURE_SPECS.map(freshCreature);
  function makeMovers() {
    return [
      { id: 'backstage-lift', x: 276, y: 276, w: 66, h: 8, axis: 'y', min: 206, max: 288, speed: .42, dir: -1, kind: 'oneway' },
      { id: 'opera-carrier', x: 820, y: 270, w: 70, h: 8, axis: 'x', min: 808, max: 1032, speed: .5, dir: 1, kind: 'oneway' },
      { id: 'opera-lift', x: 926, y: 276, w: 68, h: 8, axis: 'y', min: 176, max: 288, speed: .44, dir: -1, kind: 'oneway' },
      { id: 'crystal-carrier', x: 1450, y: 270, w: 68, h: 8, axis: 'x', min: 1390, max: 1700, speed: .48, dir: 1, kind: 'oneway' },
      { id: 'crystal-lift', x: 1576, y: 280, w: 68, h: 8, axis: 'y', min: 204, max: 292, speed: .4, dir: -1, kind: 'oneway' }
    ];
  }

  function freshPlayer() {
    return {
      x: SPAWN.x,
      y: SPAWN.y,
      vx: 0,
      vy: 0,
      xRemainder: 0,
      yRemainder: 0,
      facing: 1,
      grounded: false,
      clinging: false,
      clingSide: 0,
      crouching: false,
      lookingUp: false,
      coyote: 0,
      jumpBuffer: 0,
      dropping: 0,
      shootTimer: 0,
      shootCooldown: 0,
      aiming: false,
      aimX: 1,
      aimY: 0,
      meleeTimer: 0,
      meleeDuration: 0,
      meleeCooldown: 0,
      meleeConnected: false,
      meleeDirection: 'forward',
      stompCooldown: 0,
      dashTimer: 0,
      dashCooldown: 0,
      dashVX: 0,
      dashVY: 0,
      hitTimer: 0,
      health: 3,
      maxHealth: 3,
      alive: true,
      respawnTimer: 0,
      respawnPulse: 0,
      invulnerable: 0,
      animation: 'idle',
      animationTime: 0,
      squash: 1,
      stretch: 1
    };
  }

  function freshBot(x = BOT_SPAWN.x, y = BOT_SPAWN.y) {
    return {
      color: '#4fa3ff',
      x,
      y,
      vx: 0,
      vy: 0,
      facing: -1,
      grounded: false,
      health: 3,
      maxHealth: 3,
      alive: true,
      respawnTimer: 0,
      shootCooldown: 150,
      shootTimer: 0,
      meleeTimer: 0,
      meleeDuration: 0,
      meleeCooldown: 70,
      meleeConnected: false,
      meleeDirection: 'forward',
      antiAirCooldown: 90,
      hitTimer: 0,
      animation: 'idle'
    };
  }

  function freshCreature(spec) {
    return {
      id: spec.id,
      type: spec.type,
      spawnX: spec.spawnX,
      spawnY: spec.spawnY,
      patrolMin: spec.patrolMin,
      patrolMax: spec.patrolMax,
      width: spec.width,
      height: spec.height,
      x: spec.spawnX,
      y: spec.spawnY,
      vx: 0,
      vy: 0,
      facing: spec.id.endsWith('west') ? 1 : -1,
      health: spec.health,
      maxHealth: spec.health,
      alive: true,
      respawnTimer: 0,
      hitTimer: 0,
      attackTimer: 0,
      attackDuration: 0,
      attackCooldown: 45 + Math.floor(random() * 45),
      attackConnected: false,
      grounded: false,
      corpseSupportId: null,
      phase: random() * Math.PI * 2,
      animation: 'idle'
    };
  }

  function rectAt(x = game.player.x, y = game.player.y, height = game.player.crouching ? PLAYER_CROUCH_H : PLAYER_H) {
    return { x: x - PLAYER_HALF_W, y: y - height, w: PLAYER_HALF_W * 2, h: height };
  }

  function overlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function firstCollision(list, left, top, right, bottom, solidOnly = false) {
    for (const surface of list) {
      if (solidOnly && surface.kind !== 'solid') continue;
      if (left < surface.x + surface.w && right > surface.x && top < surface.y + surface.h && bottom > surface.y) return surface;
    }
    return null;
  }

  function collidesSolid(x, y, height) {
    const resolvedHeight = height ?? (game.player.crouching ? PLAYER_CROUCH_H : PLAYER_H);
    const left = x - PLAYER_HALF_W, right = x + PLAYER_HALF_W, top = y - resolvedHeight;
    return firstCollision(fixed, left, top, right, y) || firstCollision(game.movers, left, top, right, y, true);
  }

  function standingSurface(x = game.player.x, y = game.player.y) {
    const left = x - PLAYER_HALF_W, right = x + PLAYER_HALF_W, bottom = y + 1;
    for (const list of [fixed, ledges, game.movers]) {
      for (const surface of list) {
        if (surface.kind === 'oneway' && game.player.dropping > 0) continue;
        if (bottom < surface.y || bottom > surface.y + 2) continue;
        if (left < surface.x + surface.w && right > surface.x) return surface;
      }
    }
    return null;
  }

  function sideSurface(side) {
    return collidesSolid(game.player.x + side, game.player.y);
  }

  function movePlayerX(amount, squashed = false) {
    const p = game.player;
    p.xRemainder += amount;
    let move = Math.trunc(p.xRemainder);
    p.xRemainder -= move;
    const direction = Math.sign(move);
    while (move !== 0) {
      if (collidesSolid(p.x + direction, p.y)) {
        p.vx = 0;
        p.xRemainder = 0;
        if (squashed) resetGame(true);
        break;
      }
      p.x += direction;
      move -= direction;
    }
  }

  function movePlayerY(amount, squashed = false) {
    const p = game.player;
    p.yRemainder += amount;
    let move = Math.trunc(p.yRemainder);
    p.yRemainder -= move;
    const direction = Math.sign(move);
    while (move !== 0) {
      const solid = collidesSolid(p.x, p.y + direction);
      let oneWay = null;
      if (!solid && direction > 0 && p.dropping <= 0) {
        const previousBottom = p.y;
        const nextBottom = p.y + direction;
        const left = p.x - PLAYER_HALF_W, right = p.x + PLAYER_HALF_W;
        for (const list of [ledges, game.movers]) {
          oneWay = list.find(surface => surface.kind === 'oneway' && previousBottom <= surface.y + 1 && nextBottom > surface.y && left < surface.x + surface.w && right > surface.x) || null;
          if (oneWay) break;
        }
      }
      if (solid || oneWay) {
        p.vy = 0;
        p.yRemainder = 0;
        if (squashed) resetGame(true);
        break;
      }
      p.y += direction;
      move -= direction;
    }
  }

  function approach(value, target, amount) {
    if (value < target) return Math.min(value + amount, target);
    if (value > target) return Math.max(value - amount, target);
    return target;
  }

  function botRect(x = game.bot.x, y = game.bot.y) {
    return { x: x - PLAYER_HALF_W, y: y - PLAYER_H, w: PLAYER_HALF_W * 2, h: PLAYER_H };
  }

  function botSolidAt(x, y) {
    const left = x - PLAYER_HALF_W, right = x + PLAYER_HALF_W, top = y - PLAYER_H;
    return firstCollision(fixed, left, top, right, y) || firstCollision(game.movers, left, top, right, y, true);
  }

  function botStandingSurface() {
    const bot = game.bot;
    return fixed.concat(ledges, game.movers).find(surface =>
      Math.abs(bot.y - surface.y) <= 2 &&
      bot.x + PLAYER_HALF_W > surface.x &&
      bot.x - PLAYER_HALF_W < surface.x + surface.w
    ) || null;
  }

  function groundAtX(x) {
    return fixed
      .filter(surface => surface.w > 30 && x > surface.x + PLAYER_HALF_W && x < surface.x + surface.w - PLAYER_HALF_W)
      .sort((a, b) => a.y - b.y)[0] || null;
  }

  function landingSurface(actor, nextY) {
    return fixed.concat(ledges, game.movers).find(surface =>
      actor.y <= surface.y + 1 &&
      nextY >= surface.y &&
      actor.x + PLAYER_HALF_W > surface.x &&
      actor.x - PLAYER_HALF_W < surface.x + surface.w
    ) || null;
  }

  function creatureRect(creature) {
    return {
      x: creature.x - creature.width / 2,
      y: creature.y - creature.height,
      w: creature.width,
      h: creature.height
    };
  }

  function respawnCreature(creature) {
    const spec = CREATURE_SPECS.find(candidate => candidate.id === creature.id);
    if (!spec) return;
    Object.assign(creature, freshCreature(spec));
  }

  function startCreatureAttack(creature, duration) {
    creature.attackDuration = duration;
    creature.attackTimer = duration;
    creature.attackConnected = false;
    creature.attackCooldown = creature.type === 'bat'
      ? 110 + Math.floor(random() * 45)
      : 80 + Math.floor(random() * 35);
  }

  function creatureAttackCanHit(creature) {
    const elapsed = creature.attackDuration - creature.attackTimer;
    return creature.type === 'bat'
      ? elapsed >= 8 && elapsed <= 21
      : elapsed >= 7 && elapsed <= 15;
  }

  function creatureAttackRect(creature) {
    if (creature.type === 'bat') {
      const rect = creatureRect(creature);
      return { x: rect.x - 12, y: rect.y - 12, w: rect.w + 24, h: rect.h + 24 };
    }
    return {
      x: creature.facing > 0 ? creature.x + 2 : creature.x - 38,
      y: creature.y - 22,
      w: 36,
      h: 22
    };
  }

  function updateCreature(creature) {
    if (!creature.alive) {
      if (creature.type === 'bat') {
        stepBatCorpse(creature, [...fixed, ...ledges, ...game.movers]);
        if (!creature.grounded) { creature.animation = 'death'; return; }
      }
      creature.respawnTimer -= 1;
      creature.animation = 'death';
      if (creature.respawnTimer <= 0) respawnCreature(creature);
      return;
    }

    creature.hitTimer = Math.max(0, creature.hitTimer - 1);
    creature.attackTimer = Math.max(0, creature.attackTimer - 1);
    creature.attackCooldown = Math.max(0, creature.attackCooldown - 1);
    creature.phase += creature.type === 'bat' ? .045 : .02;
    const player = game.player;
    const dx = player.x - creature.x;
    const dy = (player.y - PLAYER_H / 2) - (creature.y - creature.height / 2);

    if (creature.type === 'slug') {
      if (creature.attackCooldown <= 0 && Math.abs(dx) < 39 && Math.abs(dy) < 34) {
        creature.facing = Math.sign(dx) || creature.facing;
        startCreatureAttack(creature, 24);
      }
      if (creature.hitTimer > 0) {
        creature.x = Math.max(creature.patrolMin, Math.min(creature.patrolMax, creature.x + creature.vx));
        creature.vx *= .82;
      } else if (creature.attackTimer > 0) {
        creature.vx = 0;
      } else {
        const chasing = Math.abs(dx) < 190 && Math.abs(dy) < 48;
        let direction = chasing ? Math.sign(dx) : creature.facing;
        if (creature.x <= creature.patrolMin + 2) direction = 1;
        if (creature.x >= creature.patrolMax - 2) direction = -1;
        creature.facing = direction || creature.facing;
        creature.vx = approach(creature.vx, creature.facing * .52, .08);
        creature.x = Math.max(creature.patrolMin, Math.min(creature.patrolMax, creature.x + creature.vx));
      }
      creature.y = creature.spawnY;
    } else {
      const playerNear = Math.abs(dx) < 270 && Math.abs(dy) < 180;
      if (creature.attackCooldown <= 0 && playerNear && Math.hypot(dx, dy) < 105) {
        creature.facing = Math.sign(dx) || creature.facing;
        startCreatureAttack(creature, 30);
      }
      if (creature.hitTimer > 0) {
        creature.x += creature.vx;
        creature.y += creature.vy;
        creature.vx *= .9;
        creature.vy *= .9;
      } else if (creature.attackTimer > 0) {
        creature.facing = Math.sign(dx) || creature.facing;
        creature.vx = approach(creature.vx, Math.sign(dx) * 2.2, .22);
        creature.vy = approach(creature.vy, Math.sign(dy) * 1.65, .18);
        creature.x += creature.vx;
        creature.y += creature.vy;
      } else {
        const targetX = playerNear
          ? Math.max(creature.patrolMin, Math.min(creature.patrolMax, player.x))
          : creature.spawnX + Math.sin(creature.phase * .72) * 62;
        const targetY = playerNear ? player.y - 62 : creature.spawnY + Math.sin(creature.phase) * 24;
        creature.facing = Math.sign(targetX - creature.x) || creature.facing;
        creature.vx = approach(creature.vx, Math.sign(targetX - creature.x) * 1.05, .08);
        creature.vy = approach(creature.vy, Math.sign(targetY - creature.y) * .72, .07);
        creature.x += creature.vx;
        creature.y += creature.vy;
      }
      creature.x = Math.max(creature.patrolMin, Math.min(creature.patrolMax, creature.x));
      creature.y = Math.max(76, Math.min(WORLD.height - 48, creature.y));
    }

    if (creatureAttackCanHit(creature) && !creature.attackConnected && player.alive) {
      // A diving bat's artwork is broader than its old collision box. This
      // impact radius makes a visible dive reliably connect once per attack.
      const batContact = creature.type === 'bat' && Math.hypot(player.x - creature.x, (player.y - 18) - (creature.y - 12)) < 45;
      if (batContact || overlap(creatureAttackRect(creature), rectAt())) {
        creature.attackConnected = true;
        hitPlayer(creature.facing * (creature.type === 'bat' ? 2.9 : 2.5), creature.type === 'bat' ? 2.4 : -2.2);
      }
    }

    if (creature.hitTimer > 0) creature.animation = 'hit';
    else if (creature.attackTimer > 0) creature.animation = 'attack';
    else if (Math.abs(creature.vx) > .12 || creature.type === 'bat') creature.animation = 'run';
    else creature.animation = 'idle';
  }

  function meleeHitbox(actor, direction) {
    const reach = 31;
    if (direction === 'up') return { x: actor.x - 14, y: actor.y - 62, w: 28, h: 39 };
    if (direction === 'down') return { x: actor.x - 14, y: actor.y - 9, w: 28, h: 38 };
    return {
      x: actor.facing > 0 ? actor.x + 5 : actor.x - reach - 5,
      y: actor.y - 30,
      w: reach,
      h: 28
    };
  }

  function beginMelee(actor, direction) {
    const timing = MELEE_TIMING[direction] || MELEE_TIMING.forward;
    actor.meleeDirection = direction;
    actor.meleeDuration = timing.duration;
    actor.meleeTimer = timing.duration;
    actor.meleeConnected = false;
  }

  function meleeCanHit(actor) {
    const timing = MELEE_TIMING[actor.meleeDirection] || MELEE_TIMING.forward;
    const elapsed = actor.meleeDuration - actor.meleeTimer;
    return elapsed >= timing.hitStart && elapsed <= timing.hitEnd;
  }

  function respawnBot() {
    const desiredX = Math.max(48, Math.min(WORLD.width - 48, game.player.x + game.player.facing * 190));
    const floor = groundAtX(desiredX) || groundAtX(BOT_SPAWN.x);
    game.bot = { ...freshBot(desiredX, floor?.y || BOT_SPAWN.y), id: 'bot' };
  }

  function updateBot(hasEnemy = true) {
    const bot = game.bot;
    if (!bot.alive) {
      bot.respawnTimer -= 1;
      bot.animation = 'death';
      if (bot.respawnTimer <= 0) respawnBot();
      return;
    }

    bot.shootCooldown = Math.max(0, bot.shootCooldown - 1);
    bot.shootTimer = Math.max(0, bot.shootTimer - 1);
    bot.meleeTimer = Math.max(0, bot.meleeTimer - 1);
    bot.meleeCooldown = Math.max(0, bot.meleeCooldown - 1);
    bot.antiAirCooldown = Math.max(0, bot.antiAirCooldown - 1);
    bot.hitTimer = Math.max(0, bot.hitTimer - 1);
    bot.grounded = botStandingSurface();

    const distance = hasEnemy ? game.player.x - bot.x : 0;
    const verticalDistance = (game.player.y - PLAYER_H / 2) - (bot.y - PLAYER_H / 2);
    const direction = Math.abs(distance) > 78 ? Math.sign(distance) : 0;
    if (direction) bot.facing = direction;

    if (hasEnemy && bot.meleeCooldown <= 0 && Math.abs(distance) < 48 && Math.abs(verticalDistance) < 62) {
      const requestedDirection = verticalDistance < -14 ? 'up' : (verticalDistance > 14 ? 'down' : 'forward');
      let commit = true;
      if (requestedDirection === 'up') {
        // An overhead player creates one anti-air decision, not a new dice
        // roll every frame. The bot sometimes contests a stomp, but most
        // descending attempts remain a viable way to damage it.
        commit = false;
        if (bot.antiAirCooldown <= 0) {
          bot.antiAirCooldown = 72 + Math.floor(random() * 30);
          const defenseChance = game.player.vy > .5 ? .28 : .42;
          commit = random() < defenseChance;
        }
      }
      if (commit) {
        if (Math.abs(distance) > 3) bot.facing = Math.sign(distance);
        beginMelee(bot, requestedDirection);
        bot.meleeCooldown = 105 + Math.floor(random() * 35);
      }
    }

    if (bot.hitTimer > 0) bot.vx *= .93;
    else if (bot.meleeTimer > 0) bot.vx = approach(bot.vx, 0, .28);
    else bot.vx = approach(bot.vx, direction * 1.35, direction ? .11 : .18);

    if (bot.grounded && direction) {
      const aheadX = bot.x + direction * 20;
      const aheadGround = groundAtX(aheadX);
      const blocked = botSolidAt(bot.x + direction * 3, bot.y);
      if (blocked || !aheadGround || aheadGround.y < bot.y - 8) bot.vy = -6.2;
    }

    const nextX = bot.x + bot.vx;
    if (!botSolidAt(nextX, bot.y)) bot.x = Math.max(24, Math.min(WORLD.width - 24, nextX));
    else {
      bot.vx = 0;
      if (bot.grounded) bot.vy = -6.2;
    }
    if (hasEnemy && overlap(botRect(), rectAt())) {
      const side = Math.sign(distance) || -bot.facing || 1;
      bot.x = game.player.x - side * 34;
      bot.vx = -side * .7;
    }

    if (!bot.grounded || bot.vy < 0) bot.vy = Math.min(5.2, bot.vy + .36);
    else bot.vy = 0;
    const nextY = bot.y + bot.vy;
    const landing = bot.vy >= 0 ? landingSurface(bot, nextY) : null;
    if (landing) {
      bot.y = landing.y;
      bot.vy = 0;
      bot.grounded = landing;
    } else bot.y = nextY;

    if (hasEnemy && Math.abs(distance) > 90 && Math.abs(distance) < 380 && bot.shootCooldown <= 0) {
      spawnProjectile(bot, 'bot');
      bot.shootTimer = 15;
      bot.shootCooldown = 150 + Math.floor(random() * 55);
    }

    if (hasEnemy && meleeCanHit(bot) && !bot.meleeConnected && overlap(meleeHitbox(bot, bot.meleeDirection), rectAt())) {
      bot.meleeConnected = true;
      const knockbackX = bot.meleeDirection === 'forward' ? bot.facing * 3.8 : Math.sign(game.player.x - bot.x) * 1.6;
      const knockbackY = bot.meleeDirection === 'up' ? -4 : (bot.meleeDirection === 'down' ? 3.1 : -2.5);
      hitPlayer(knockbackX, knockbackY);
    }

    if (bot.y > WORLD.height + 45) {
      respawnBot();
      return;
    }

    if (bot.hitTimer > 0) bot.animation = 'hit';
    else if (bot.meleeTimer > 0) {
      bot.animation = bot.meleeDirection === 'up' ? 'meleeUp' : (bot.meleeDirection === 'down' ? 'meleeDown' : 'melee');
    }
    else if (bot.shootTimer > 0) bot.animation = 'shoot';
    else if (!bot.grounded) bot.animation = bot.vy < 0 ? 'jump' : 'fall';
    else if (Math.abs(bot.vx) > .18) bot.animation = 'run';
    else bot.animation = 'idle';
  }

  function aimVector() {
    const p = game.player;
    let x = input.aimAxisX;
    let y = input.aimAxisY;
    if (Math.hypot(x, y) < .12) {
      x = Number(input.right) - Number(input.left);
      y = Number(input.down) - Number(input.up);
    }
    if (Math.hypot(x, y) < .12) return { x: p.facing, y: 0 };
    const length = Math.hypot(x, y);
    return { x: x / length, y: y / length };
  }

  function checkHeadStomp(previousFeetY) {
    const p = game.player;
    if (p.stompCooldown > 0 || p.vy < 0) return;
    const targets = [];
    if (game.bot.alive && !sameTeam(p, game.bot)) targets.push({ actor: game.bot, rect: botRect(), isBot: true });
    for (const creature of game.creatures) {
      if (creature.alive) targets.push({ actor: creature, rect: creatureRect(creature), isBot: false });
    }
    const target = targets.find(candidate => {
      const top = candidate.rect.y;
      const horizontal = p.x + PLAYER_HALF_W > candidate.rect.x && p.x - PLAYER_HALF_W < candidate.rect.x + candidate.rect.w;
      return horizontal && previousFeetY <= top + 3 && p.y >= top && p.y <= top + 12;
    });
    if (target) {
      const top = target.rect.y;
      p.y = top;
      p.vy = -6.7;
      p.yRemainder = 0;
      p.stompCooldown = 18;
      p.squash = .82;
      p.stretch = 1.16;
      const knockbackX = Math.sign(target.actor.x - p.x || p.facing) * 2.2;
      if (target.isBot) damageBot(1, knockbackX, 2.3, target.actor.x, top + 5);
      else damageCreature(target.actor, 1, knockbackX, 2.3);
      emitDust(p.x, p.y, 7);
    }
  }

  function updatePlayer() {
    movement.stepPlayer(game.player, input, { fixed, ledges, movers: game.movers, world: WORLD }, {
      spawnProjectile, respawnPlayer, hitPlayer, checkHeadStomp, updateMeleeHit,
      resetGame, emitDust, vibrate
    });
    input.jumpPressed = input.shootReleased = input.meleePressed = input.dashPressed = false;
  }

  function select(player) {
    game.player = player;
    input = player.input;
  }

  function emit(type, detail) {
    game.events.push({ ...detail, id: ++eventId, tick: game.frame, type });
    if (game.events.length > 64) game.events.shift();
  }

  const sameTeam = (a, b) => Boolean(a?.color && b?.color && a.color.toLowerCase() === b.color.toLowerCase());

  function nearest(actor) {
    let chosen = null, best = Infinity;
    for (const p of game.players.values()) {
      if (!p.alive || !p.connected || sameTeam(actor, p)) continue;
      const distance = Math.hypot(p.x - actor.x, p.y - actor.y);
      if (distance < best) { chosen = p; best = distance; }
    }
    return chosen;
  }

  function addPlayer(id, profile = {}) {
    if (game.players.has(id)) return game.players.get(id);
    const player = { ...freshPlayer(), id, name: profile.name || 'PLAYER', character: profile.character || 'ash', color: profile.color || '#e85d5d', input: neutralInput(), connected: true, kills: 0, deaths: 0, creatureKills: 0, invulnerable: 90, lastInputTick: game.frame };
    game.players.set(id, player);
    return player;
  }

  function resetGame() { // A crushed player cannot reset the shared world.
    game.player.invulnerable = 0;
    game.player.health = 1;
    hitPlayer(0, -3);
  }

  function respawnPlayer() {
    game.player.spawnSerial = (game.player.spawnSerial || 0) + 1;
    const p = game.player;
    const spawn = spawnSelector.chooseRespawn({ world: WORLD, fixed, ledges, movers: game.movers, player: p, actors: [...game.players.values(), game.bot, ...game.creatures], projectiles: game.projectiles, random });
    const identity = { id: p.id, name: p.name, character: p.character, color: p.color, input: p.input, connected: p.connected, kills: p.kills, deaths: p.deaths, creatureKills: p.creatureKills, lastInputTick: p.lastInputTick };
    Object.assign(p, freshPlayer(), identity, spawn, { invulnerable: 90, respawnPulse: 32 });
    emit('respawn', { targetId: p.id, x: p.x, y: p.y, color: p.color });
  }

  function hitPlayer(kx, ky) {
    const p = game.player;
    if (!p.alive || p.invulnerable > 0) return false;
    const attacker = attackerId === 'bot' ? game.bot : game.players.get(attackerId);
    if (attacker && attacker !== p && sameTeam(attacker, p)) return false;
    p.health = Math.max(0, p.health - 1);
    Object.assign(p, { invulnerable: 45, vx: kx, vy: ky, hitTimer: 14 });
    if (!p.health) {
      Object.assign(p, { alive: false, respawnTimer: PLAYER_RESPAWN_FRAMES, animation: 'death', animationTime: 0, vx: kx * .35, vy: Math.min(ky, -2.8) });
      p.deaths++;
      if (attacker && attacker !== p && game.players.has(attacker.id)) attacker.kills++;
    }
    emit(p.alive ? 'hit' : 'death', { targetId: p.id, attackerId, x: p.x, y: p.y });
    return true;
  }

  function damageBot(amount, kx, ky) {
    const b = game.bot;
    if (!b.alive || sameTeam(game.players.get(attackerId), b)) return false;
    b.health = Math.max(0, b.health - amount);
    Object.assign(b, { vx: kx, vy: ky, hitTimer: 16, animation: b.health ? 'hit' : 'death' });
    if (!b.health) {
      b.alive = false; b.respawnTimer = 105;
      const killer = game.players.get(attackerId);
      if (killer) killer.kills++;
    }
    emit(b.alive ? 'hit' : 'death', { targetId: b.id, attackerId, x: b.x, y: b.y });
    return true;
  }

  function damageCreature(c, amount, kx, ky) {
    if (!c.alive) return false;
    c.health = Math.max(0, c.health - amount);
    Object.assign(c, { vx: kx, vy: ky, hitTimer: 14, animation: c.health ? 'hit' : 'death' });
    if (!c.health) {
      c.alive = false; c.respawnTimer = 120;
      c.grounded = false; c.corpseSupportId = null;
      heartDrops.drop(c);
      const killer = game.players.get(attackerId);
      if (killer) killer.creatureKills++;
    }
    emit(c.alive ? 'hit' : 'death', { targetId: c.id, attackerId, x: c.x, y: c.y });
    return true;
  }

  function spawnProjectile(actor, owner, aimX = actor.facing, aimY = 0) {
    const length = Math.hypot(aimX, aimY) || 1;
    const dx = aimX / length, dy = aimY / length;
    const speed = owner === 'player' ? 6.2 : 4.3;
    game.projectiles.push({ id: ++projectileId, owner, ownerId: actor.id, color: actor.color || '#4fa3ff', x: actor.x + dx * 15, y: actor.y - 22 + dy * 8, vx: dx * speed, vy: dy * speed, trailX: dx, trailY: dy, life: 105 });
  }

  function updateMeleeHit() {
    const p = game.player;
    if (!meleeCanHit(p) || p.meleeConnected) return;
    const box = meleeHitbox(p, p.meleeDirection);
    let target = game.bot.alive && !sameTeam(p, game.bot) && overlap(box, botRect()) ? game.bot : null;
    target ||= game.creatures.find(c => c.alive && overlap(box, creatureRect(c)));
    target ||= [...game.players.values()].find(other => other !== p && other.alive && other.color !== p.color && overlap(box, rectAt(other.x, other.y, other.crouching ? PLAYER_CROUCH_H : PLAYER_H)));
    if (!target) return;
    p.meleeConnected = true;
    const kx = p.meleeDirection === 'forward' ? p.facing * 4.2 : Math.sign(target.x - p.x) * 1.8;
    const ky = p.meleeDirection === 'up' ? -4.2 : (p.meleeDirection === 'down' ? 3.4 : -2.8);
    if (target === game.bot) damageBot(1, kx, ky);
    else if (target.type) damageCreature(target, 1, kx, ky);
    else { select(target); hitPlayer(kx, ky); select(p); }
  }

  function movePlatforms() {
    for (const platform of game.movers) {
      const old = { ...platform };
      platform[platform.axis] += platform.speed * platform.dir;
      if (platform[platform.axis] <= platform.min || platform[platform.axis] >= platform.max) {
        platform[platform.axis] = Math.max(platform.min, Math.min(platform.max, platform[platform.axis]));
        platform.dir *= -1;
      }
      const dx = platform.x - old.x, dy = platform.y - old.y;
      for (const p of game.players.values()) {
        if (!p.alive) continue;
        select(p);
        const riding = Math.abs(p.y - old.y) <= 1 && p.x - PLAYER_HALF_W < old.x + old.w && p.x + PLAYER_HALF_W > old.x;
        if (riding) { movePlayerX(dx); movePlayerY(dy); }
      }
    }
  }

  function updateProjectiles() {
    for (const note of game.projectiles) {
      note.x += note.vx; note.y += note.vy; note.life--;
      const box = { x: note.x - 4, y: note.y - 4, w: 8, h: 8 };
      if (fixed.some(s => overlap(box, s))) { note.life = 0; continue; }
      if (note.life <= 0) continue;
      attackerId = note.ownerId;
      if (note.owner === 'player') {
        if (game.bot.alive && !sameTeam(note, game.bot) && overlap(box, botRect())) {
          damageBot(1, Math.sign(note.vx) * 3.4, -2.5); note.life = 0; continue;
        }
        const creature = game.creatures.find(c => c.alive && overlap(box, creatureRect(c)));
        if (creature) { damageCreature(creature, 1, Math.sign(note.vx) * 2.7, note.vy * .25); note.life = 0; continue; }
      }
      for (const p of game.players.values()) {
        if (!p.alive || p.id === note.ownerId || sameTeam(p, note)) continue;
        if (!overlap(box, rectAt(p.x, p.y, p.crouching ? PLAYER_CROUCH_H : PLAYER_H))) continue;
        select(p); hitPlayer(Math.sign(note.vx) * 2.8, -2.5); note.life = 0; break;
      }
    }
    game.projectiles = game.projectiles.filter(n => n.life > 0 && n.x > 0 && n.x < WORLD.width && n.y > 0 && n.y < WORLD.height);
  }

  function updateCaptureZones() {
    game.captureContested = [];
    for (const zone of CAPTURE_ZONES) {
      const byColor = new Map();
      for (const p of game.players.values()) {
        if (!p.alive || !p.connected || p.x < zone.x || p.x > zone.x + zone.w || p.y < zone.y || p.y > zone.y + zone.h) continue;
        if (!byColor.has(p.color)) byColor.set(p.color, []);
        byColor.get(p.color).push({ id: p.id, name: p.name });
      }
      let progress = game.captureProgress.get(zone.id);
      if (!progress) game.captureProgress.set(zone.id, progress = new Map());
      const activeColor = byColor.size === 1 ? byColor.keys().next().value : null;
      if (byColor.size > 1) game.captureContested.push(zone.id);
      for (const color of new Set([...progress.keys(), ...byColor.keys()])) {
        const previous = progress.get(color) || 0;
        const own = game.capturedZones.get(zone.id)?.color === color;
        const next = own ? 0 : activeColor === color ? Math.min(CAPTURE_FRAMES, previous + byColor.get(color).length) : Math.max(0, previous - 2);
        progress.set(color, next);
        if (next === CAPTURE_FRAMES) {
          const capture = { id: zone.id, color, contributors: byColor.get(color), capturedAt: game.frame };
          game.capturedZones.set(zone.id, capture); progress.clear();
          emit('capture', { ...capture, zoneId: zone.id });
          break;
        }
      }
    }
  }

  function step() {
    game.frame++; game.time = game.frame * STEP;
    attackerId = null;
    movePlatforms();
    // Rotate the first mover every tick so simultaneous attacks have a stable,
    // bounded tie-break, without permanently favoring the first joiner.
    const players = [...game.players.values()];
    for (let i = 0; i < players.length; i++) {
      const p = players[(i + game.frame) % players.length];
      if (!p.connected || game.frame - p.lastInputTick > 30) { p.input = neutralInput(); p.inputQueue = []; }
      else p.input = { ...neutralInput(), ...p.input };
      if (p.connected && p.inputQueue?.length) {
        const command = p.inputQueue.shift();
        p.input = command.input; p.ackInputSeq = command.seq;
      }
      select(p); attackerId = p.id; updatePlayer();
    }
    const fallback = players[0];
    const target = nearest(game.bot);
    if (target || fallback) {
      select(target || fallback); attackerId = 'bot';
      updateBot(Boolean(target));
    }
    for (const creature of game.creatures) {
      const target = nearest(creature);
      if (!target && !fallback) continue;
      select(target || fallback); attackerId = creature.id;
      if (target || !creature.alive) updateCreature(creature);
      else creature.animation = creature.type === 'bat' ? 'run' : 'idle';
    }
    updateProjectiles(); updateCaptureZones();
    heartDrops.update({ players: game.players.values(), surfaces: [...fixed, ...ledges, ...game.movers], emit });
    attackerId = null;
  }

  const publicFields = ['ackInputSeq','spawnSerial','xRemainder','yRemainder','clingSide','coyote','jumpBuffer','dropping','shootCooldown','meleeCooldown','meleeConnected','stompCooldown','dashVX','dashVY','id','name','character','color','x','y','vx','vy','facing','health','maxHealth','alive','respawnTimer','animation','animationTime','meleeTimer','meleeDirection','meleeDuration','shootTimer','dashTimer','dashCooldown','hitTimer','invulnerable','respawnPulse','squash','stretch','aiming','aimX','aimY','crouching','clinging','lookingUp','kills','deaths','creatureKills','width','height','type','connected'];
  function actorSnapshot(actor) {
    const result = {};
    for (const key of publicFields) if (actor[key] !== undefined) result[key] = actor[key];
    result.grounded = Boolean(actor.grounded);
    return result;
  }

  function snapshot() {
    return {
      tick: game.frame, time: game.time, hearts: heartDrops.snapshot(),
      players: [...game.players.values()].map(actorSnapshot),
      bot: actorSnapshot(game.bot), creatures: game.creatures.map(actorSnapshot),
      projectiles: game.projectiles.map(n => ({ ...n })), movers: game.movers.map(m => ({ ...m })),
      captures: [...game.capturedZones.values()].map(c => ({ ...c, contributors: c.contributors.map(p => ({ ...p })) })),
      captureProgress: [...game.captureProgress].map(([id, values]) => ({ id, colors: Object.fromEntries(values) })),
      captureContested: [...(game.captureContested || [])],
      events: game.events.map(e => ({ ...e }))
    };
  }

  return { addPlayer, removePlayer: id => game.players.delete(id), step, snapshot, game, geometry: { fixed, ledges, world: WORLD } };

}
