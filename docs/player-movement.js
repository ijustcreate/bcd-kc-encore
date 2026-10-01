// One deterministic player-movement implementation for authority and prediction.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EncoreMovement = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const STEP = 1 / 60, PLAYER_HALF_W = 9, PLAYER_H = 34, PLAYER_CROUCH_H = 21;
  const MELEE_TIMING = { forward: { duration: 16 }, up: { duration: 28 }, down: { duration: 24 } };
  const noop = () => {};
  function stepPlayer(player, controls, { fixed, ledges, movers, world }, hooks = {}) {
    const game = { player, movers }, input = {
      left: false, right: false, up: false, down: false, jumpPressed: false,
      jumpHeld: false, dashPressed: false, shootHeld: false, shootReleased: false,
      meleePressed: false, aimAxisX: 0, aimAxisY: 0, ...controls
    }, WORLD = world;
    const { spawnProjectile = noop, respawnPlayer = noop, hitPlayer = noop,
      checkHeadStomp = noop, updateMeleeHit = noop, resetGame = noop,
      emitDust = noop, vibrate = noop } = hooks;
    const { collidesSolid, standingSurface, sideSurface, movePlayerX, movePlayerY, approach } =
      collisions(player, { fixed, ledges, movers }, resetGame);
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

  function beginMelee(actor, direction) {
    const timing = MELEE_TIMING[direction] || MELEE_TIMING.forward;
    actor.meleeDirection = direction;
    actor.meleeDuration = timing.duration;
    actor.meleeTimer = timing.duration;
    actor.meleeConnected = false;
  }

  function updatePlayer() {
    const p = game.player;
    const wasGrounded = p.grounded;

    if (p.dropping > 0) p.dropping -= 1;
    p.shootTimer = Math.max(0, p.shootTimer - 1);
    p.shootCooldown = Math.max(0, p.shootCooldown - 1);
    p.meleeTimer = Math.max(0, p.meleeTimer - 1);
    p.meleeCooldown = Math.max(0, p.meleeCooldown - 1);
    p.stompCooldown = Math.max(0, p.stompCooldown - 1);
    p.dashTimer = Math.max(0, p.dashTimer - 1);
    p.dashCooldown = Math.max(0, p.dashCooldown - 1);
    p.hitTimer = Math.max(0, p.hitTimer - 1);
    p.respawnPulse = Math.max(0, p.respawnPulse - 1);

    if (!p.alive) {
      p.respawnTimer = Math.max(0, p.respawnTimer - 1);
      p.animationTime += STEP;
      if (p.respawnTimer <= 0) respawnPlayer();

      input.jumpPressed = input.shootReleased = input.meleePressed = input.dashPressed = false;
      return;
    }

    const movementDirection = Number(input.right) - Number(input.left);
    if (input.shootHeld) {
      const aim = aimVector();
      p.aimX = aim.x;
      p.aimY = aim.y;
      p.aiming = true;
      if (Math.abs(aim.x) > .2) p.facing = Math.sign(aim.x);
    }
    if (input.shootReleased && !p.aiming) {
      const aim = aimVector();
      p.aimX = aim.x;
      p.aimY = aim.y;
      p.aiming = true;
    }
    const direction = p.aiming ? 0 : movementDirection;
    if (!p.aiming && direction) p.facing = direction;

    if (input.shootReleased && p.aiming && p.shootCooldown <= 0) {
      spawnProjectile(p, 'player', p.aimX, p.aimY);
      p.shootTimer = 15;
      p.shootCooldown = 16;
      p.aiming = false;
      p.aimX = p.facing;
      p.aimY = 0;
      vibrate(9);
    }
    if (!input.shootHeld && !input.shootReleased) p.aiming = false;

    if (input.meleePressed && p.meleeCooldown <= 0) {
      const verticalAim = Math.abs(input.aimAxisY) > .15
        ? input.aimAxisY
        : Number(input.down) - Number(input.up);
      const horizontalAim = Math.abs(input.aimAxisX) > .15
        ? input.aimAxisX
        : Number(input.right) - Number(input.left);
      const meleeDirection = verticalAim < -.35 ? 'up' : (verticalAim > .35 ? 'down' : 'forward');
      if (Math.abs(horizontalAim) > .2) p.facing = Math.sign(horizontalAim);
      beginMelee(p, meleeDirection);
      p.meleeCooldown = 24;
      vibrate(11);
    }

    if (input.dashPressed && p.dashCooldown <= 0) {
      let dashX = direction;
      let dashY = Number(input.down) - Number(input.up);
      if (!dashX && !dashY) dashX = p.facing;
      const length = Math.hypot(dashX, dashY) || 1;
      p.dashVX = dashX / length * 6.6;
      p.dashVY = dashY / length * 6.6;
      p.dashTimer = 10;
      p.dashCooldown = 40;
      p.crouching = false;
      emitDust(p.x, p.y, 10);
      vibrate(15);
    }

    p.grounded = standingSurface();
    if (p.grounded) p.coyote = 7;
    else p.coyote = Math.max(0, p.coyote - 1);
    if (input.jumpPressed) p.jumpBuffer = 7;
    else p.jumpBuffer = Math.max(0, p.jumpBuffer - 1);

    // Down is a true crouch. Down + Jump intentionally drops through pink
    // one-way platforms, leaving the joystick's down direction useful on land.
    if (input.down && input.jumpPressed && p.grounded?.kind === 'oneway') {
      p.dropping = 12;
      p.y += 5;
      p.grounded = false;
      p.jumpBuffer = 0;
    }

    const wantsCrouch = Boolean(input.down && p.grounded);
    if (wantsCrouch) p.crouching = true;
    else if (!collidesSolid(p.x, p.y, PLAYER_H)) p.crouching = false;
    p.lookingUp = Boolean(input.up && p.grounded && !p.crouching && direction === 0);

    const wallSide = sideSurface(1) ? 1 : (sideSurface(-1) ? -1 : 0);
    // Clinging is automatic only when Ash is airborne and the player is
    // actively pressing the joystick toward the wall.
    p.clinging = Boolean(wallSide && !p.grounded && direction === wallSide && p.dashTimer <= 0);
    p.clingSide = p.clinging ? wallSide : 0;

    if (p.dashTimer > 0) {
      p.clinging = false;
      p.vx = p.dashVX;
      p.vy = p.dashVY;
    } else if (p.clinging) {
      p.vx = 0;
      p.vy = .12;
      p.yRemainder = 0;
      if (p.jumpBuffer > 0) {
        p.clinging = false;
        p.vx = -wallSide * 3.8;
        p.vy = -7.2;
        p.facing = -wallSide;
        p.jumpBuffer = 0;
        emitDust(p.x + wallSide * 7, p.y - 8, 7);
        vibrate(14);
      }
    } else {
      const topSpeed = p.crouching ? .75 : (p.lookingUp ? 0 : 2.25);
      const targetSpeed = direction * topSpeed;
      const acceleration = p.grounded ? .3 : .16;
      const deceleration = p.grounded ? .38 : .09;
      p.vx = approach(p.vx, targetSpeed, direction ? acceleration : deceleration);
      if (p.jumpBuffer > 0 && p.coyote > 0 && !p.crouching) {
        p.vy = -7.2;
        p.jumpBuffer = 0;
        p.coyote = 0;
        p.squash = 1.16;
        p.stretch = .86;
        emitDust(p.x, p.y, 6);
        vibrate(12);
      } else if (p.grounded) p.vy = 0;
      else p.vy = Math.min(p.vy + .36, 5.2);

      // Releasing Jump trims upward velocity, which gives short and tall
      // jumps without changing the single-button mobile layout.
      if (!input.jumpHeld && p.vy < -3.2) p.vy = approach(p.vy, -3.2, .45);
    }

    const previousFeetY = p.y;
    movePlayerX(p.vx);
    movePlayerY(p.vy);
    checkHeadStomp(previousFeetY);
    updateMeleeHit();
    p.grounded = standingSurface();

    if (!wasGrounded && p.grounded && p.vy === 0) {
      emitDust(p.x, p.y, 8);
      p.squash = .82;
      p.stretch = 1.16;
      vibrate(8);
    }

    p.squash += (1 - p.squash) * .2;
    p.stretch += (1 - p.stretch) * .2;
    p.animationTime += STEP;
    if (p.hitTimer > 0) p.animation = 'hit';
    else if (p.dashTimer > 0) p.animation = 'dash';
    else if (p.meleeTimer > 0) {
      p.animation = p.meleeDirection === 'up' ? 'meleeUp' : (p.meleeDirection === 'down' ? 'meleeDown' : 'melee');
    }
    else if (p.shootTimer > 0) p.animation = 'shoot';
    else if (p.aiming && p.aimY < -.35) p.animation = 'look';
    else if (p.clinging) p.animation = 'cling';
    else if (!p.grounded) p.animation = p.vy < 0 ? 'jump' : 'fall';
    else if (p.crouching) p.animation = 'crouch';
    else if (p.lookingUp) p.animation = 'look';
    else if (Math.abs(p.vx) > .2) p.animation = 'run';
    else p.animation = 'idle';
    p.invulnerable = Math.max(0, p.invulnerable - 1);
    if (p.y > WORLD.height + 40) hitPlayer(0, -3);

    input.jumpPressed = false;
    input.shootReleased = false;
    input.meleePressed = false;
    input.dashPressed = false;
  }

    updatePlayer();
    return player;
  }
  function advanceMovers(movers, player, geometry) {
    for (const platform of movers) {
      const old = { ...platform };
      platform[platform.axis] += platform.speed * platform.dir;
      if (platform[platform.axis] <= platform.min || platform[platform.axis] >= platform.max) {
        platform[platform.axis] = Math.max(platform.min, Math.min(platform.max, platform[platform.axis]));
        platform.dir *= -1;
      }
      if (player.alive && Math.abs(player.y - old.y) <= 1 && player.x - PLAYER_HALF_W < old.x + old.w && player.x + PLAYER_HALF_W > old.x) {
        // Carrying uses the same collision sweeps as the authority.
        carryPlayer(player, platform.x - old.x, platform.y - old.y, { ...geometry, movers });
      }
    }
  }
  function carryPlayer(player, dx, dy, geometry) {
    const { movePlayerX, movePlayerY } = collisions(player, geometry);
    movePlayerX(dx); movePlayerY(dy);
  }
  function collisions(player, { fixed, ledges, movers }, resetGame = noop) {
    const game = { player, movers };
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

    return { collidesSolid, standingSurface, sideSurface, movePlayerX, movePlayerY, approach };
  }
  return { stepPlayer, advanceMovers, carryPlayer };
});
