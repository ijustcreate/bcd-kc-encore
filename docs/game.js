(() => {
  'use strict';

  const BUILD_VERSION = '1.2';
  let disposed = false;
  let animationFrame = 0;

  if (window.parent !== window || new URLSearchParams(location.search).get('embed') === '1') {
    document.body.classList.add('is-embedded');
  }

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = false;

  const STEP = 1 / 60;
  // Remote players are indexed in world-space cells.  The renderer, hit tests,
  // and capture system never need to walk every connected player each frame.
  const REMOTE_CELL_WIDTH = 160;
  const MAX_VISIBLE_REMOTE_SPRITES = 48;
  const MAX_VISIBLE_REMOTE_LABELS = 10;
  // Canvas Spine rendering is substantially more expensive than the fixed-step
  // simulation.  Keep its timeline work tied to visible rendering, at a small
  // cadence, rather than advancing every rig for every catch-up physics step.
  // Desktop local fighters keep a 15 Hz authored-pose cadence; supporting
  // actors update less often. The phone profile below lowers these expensive
  // cache refreshes further while preserving full-resolution pose images.
  const TOUCH_PRESENTATION = Boolean(window.matchMedia?.('(pointer: coarse)').matches && navigator.maxTouchPoints > 0);
  // On a phone, Canvas Spine's mesh compositing is the limiting factor—not the
  // 640x360 pixel-art canvas. Keep the native canvas and every source texture
  // at full quality, but only produce a fresh expensive pose when it can be
  // presented. Input and collision simulation remain at the fixed 60 Hz rate.
  const RIG_UPDATE_INTERVAL = TOUCH_PRESENTATION ? 1 / 6 : 1 / 15;
  const SECONDARY_RIG_UPDATE_INTERVAL = TOUCH_PRESENTATION ? 1 / 3 : 1 / 7;
  const CREATURE_RIG_UPDATE_INTERVAL = TOUCH_PRESENTATION ? 1 / 2 : 1 / 5;
  const rigRenderState = new WeakMap();
  // One display tall and exactly three landscape camera widths wide.
  const WORLD = { width: 1920, height: 360 };
  const VIEW = { width: 640, height: 360 };
  // Fully simulate opponents only where their decisions can affect the local
  // player. Distant AI receives a cadence-preserving heartbeat instead.
  const AI_FULL_SIMULATION_RADIUS = VIEW.width + 96;
  const AI_BACKGROUND_INTERVAL = 12;
  // iPhone browsers can fall behind badly when several weighted Spine meshes
  // are recomposited at desktop cadence. A 15 Hz presentation budget is high
  // enough for responsive touch play and reserves each render slot for the
  // full-quality cached pose instead of dropping into a 1 FPS backlog.
  const RENDER_INTERVAL_MS = 1000 / (TOUCH_PRESENTATION ? 15 : 60);
  // Bounded, opt-in diagnostics. These counters are cheap enough to collect
  // continuously, but are only serialized when the host asks for a report.
  const diagnostics = {
    startedAt: performance.now(), lastFrameAt: 0, frameCount: 0, presentedCount: 0,
    totalFrameMs: 0, maxFrameMs: 0, totalUpdateMs: 0, totalRenderMs: 0,
    maxStallMs: 0, droppedFrameCount: 0
  };

  function resetDiagnostics() {
    diagnostics.startedAt = performance.now(); diagnostics.lastFrameAt = 0;
    diagnostics.frameCount = diagnostics.presentedCount = 0;
    diagnostics.totalFrameMs = diagnostics.maxFrameMs = diagnostics.totalUpdateMs = diagnostics.totalRenderMs = 0;
    diagnostics.maxStallMs = diagnostics.droppedFrameCount = 0;
  }
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

  const imageSources = {
    towerBgLeft: 'assets/tower-bg-left.png',
    towerBgCenter: 'assets/tower-bg-center.png',
    towerBgRight: 'assets/tower-bg-right.png',
    jump: 'assets/player-jump.png',
    fall: 'assets/player-fall.png',
    cling: 'assets/player-cling.png',
    ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`idle${i}`, `assets/player-idle-${i}.png`])),
    ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`run${i}`, `assets/player-run-${i}.png`]))
  };
  const images = {};
  let backgroundLayer = null;
  let nextRoomPublishAt = 0;
  const remoteSpriteCache = new Map();

  function makeNoteSprite(fill, stroke) {
    const surface = document.createElement('canvas');
    surface.width = 32;
    surface.height = 32;
    const context = surface.getContext('2d');
    context.font = 'bold 15px Georgia, serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineWidth = 2;
    context.strokeStyle = stroke;
    context.fillStyle = fill;
    context.strokeText('♪', 16, 16);
    context.fillText('♪', 16, 16);
    return surface;
  }

  function remoteSprite(remote) {
    const key = `${remote.character || 'ash'}:${remote.color || '#ffffff'}`;
    let sprite = remoteSpriteCache.get(key);
    if (sprite) return sprite;
    sprite = document.createElement('canvas');
    sprite.width = 22;
    sprite.height = 38;
    const target = sprite.getContext('2d');
    target.imageSmoothingEnabled = false;
    target.fillStyle = remote.color || '#ffffff'; target.fillRect(2, 8, 18, 28);
    target.fillStyle = '#f5d5bd'; target.fillRect(5, 2, 12, 8);
    target.fillStyle = remote.character === 'p2' ? '#234d9c' : '#932d43'; target.fillRect(1, 6, 20, 4);
    remoteSpriteCache.set(key, sprite);
    return sprite;
  }

  const noteSprites = {
    player: makeNoteSprite('#ce146c', '#363542'),
    bot: makeNoteSprite('#2267c9', '#363542')
  };
  const ash = window.AshCharacter ? new window.AshCharacter(ctx) : null;
  const playerTwoRig = window.BulletAgeCharacter ? new window.BulletAgeCharacter(ctx, {
    assetName: 'Player2',
    basePath: 'assets/player2'
  }) : null;
  const botRig = window.BulletAgeCharacter ? new window.BulletAgeCharacter(ctx, {
    assetName: 'Player2',
    basePath: 'assets/player2'
  }) : null;
  // Custom character construction is intentionally paused. Everyone picks an
  // authored Ash or P2 rig, with a single roster color applied to its red/blue
  // signature material.
  const skinEditor = null;
  const PLAYER_COLORS = Object.freeze([
    '#e85d5d', '#4fa3ff', '#65cf84', '#f2c14e', '#b77bff', '#ef75b5', '#f28a4b', '#4ed1c5'
  ]);
  const PLAYER_RESPAWN_FRAMES = 180;
  const CAPTURE_FRAMES = 180;
  const BAT_ANIMATIONS = {
    idle: { name: 'idle', loop: true },
    run: { name: 'fly', loop: true },
    attack: { name: 'attack', loop: false },
    hit: { name: 'hit', loop: false },
    death: { name: 'death', loop: false }
  };
  const SLUG_ANIMATIONS = {
    idle: { name: 'idle', loop: true },
    run: { name: 'walk', loop: true },
    attack: { name: 'attack', loop: false },
    hit: { name: 'hit', loop: false },
    death: { name: 'death', loop: false }
  };
  const CREATURE_SPECS = [
    { id: 'slug-west', type: 'slug', spawnX: 420, spawnY: 336, patrolMin: 392, patrolMax: 492, health: 2, width: 34, height: 22 },
    { id: 'slug-east', type: 'slug', spawnX: 1380, spawnY: 336, patrolMin: 1308, patrolMax: 1430, health: 2, width: 34, height: 22 },
    { id: 'bat-west', type: 'bat', spawnX: 520, spawnY: 210, patrolMin: 430, patrolMax: 610, health: 1, width: 32, height: 25 },
    { id: 'bat-east', type: 'bat', spawnX: 1080, spawnY: 190, patrolMin: 990, patrolMax: 1170, health: 1, width: 32, height: 25 }
  ];
  const creatureRigs = new Map(CREATURE_SPECS.map(spec => [spec.id,
    window.BulletAgeCharacter ? new window.BulletAgeCharacter(ctx, spec.type === 'bat' ? {
      assetName: 'bat', basePath: 'assets/bat', scale: .12, skin: 'Bat', animations: BAT_ANIMATIONS
    } : {
      assetName: 'Slugger setup', basePath: 'assets/slug', scale: .14, skin: 'Slug', animations: SLUG_ANIMATIONS
    }) : null
  ]));

  function prepareRigForRender(rig, animation, interval = RIG_UPDATE_INTERVAL) {
    if (!rig?.ready) return;
    const now = performance.now();
    const previous = rigRenderState.get(rig);
    if (!previous || previous.animation !== animation) {
      rig.update(0, animation);
      rigRenderState.set(rig, { animation, lastUpdate: now });
      return;
    }
    const elapsed = (now - previous.lastUpdate) / 1000;
    if (elapsed >= interval) {
      rig.update(Math.min(elapsed, .1), animation);
      previous.lastUpdate = now;
    }
  }

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

  // Three readable TowerFall-like combat chambers with 42-58px vertical
  // steps: high enough to reward routing, low enough for a normal jump.
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

  function makeMovers() {
    return [
      { id: 'backstage-lift', x: 276, y: 276, w: 66, h: 8, axis: 'y', min: 206, max: 288, speed: .42, dir: -1, kind: 'oneway' },
      { id: 'opera-carrier', x: 820, y: 270, w: 70, h: 8, axis: 'x', min: 808, max: 1032, speed: .5, dir: 1, kind: 'oneway' },
      { id: 'opera-lift', x: 926, y: 276, w: 68, h: 8, axis: 'y', min: 176, max: 288, speed: .44, dir: -1, kind: 'oneway' },
      { id: 'crystal-carrier', x: 1450, y: 270, w: 68, h: 8, axis: 'x', min: 1390, max: 1700, speed: .48, dir: 1, kind: 'oneway' },
      { id: 'crystal-lift', x: 1576, y: 280, w: 68, h: 8, axis: 'y', min: 204, max: 292, speed: .4, dir: -1, kind: 'oneway' }
    ];
  }

  const input = {
    left: false,
    right: false,
    up: false,
    down: false,
    shootHeld: false,
    shootReleased: false,
    aimAxisX: 0,
    aimAxisY: 0,
    meleePressed: false,
    dashPressed: false,
    jumpPressed: false,
    jumpHeld: false
  };

  const CAPTURE_ZONES = [
    { id: 'backstage', x: 300, y: 168, w: 74, h: 62, label: 'BACKSTAGE' },
    { id: 'opera', x: 924, y: 132, w: 74, h: 62, label: 'OPERA' },
    { id: 'crystal', x: 1610, y: 168, w: 74, h: 62, label: 'CRYSTAL' }
  ];
  // Render markers on the crown surfaces without changing gameplay capture bounds.
  const CAPTURE_MARKER_Y = new Map(CAPTURE_ZONES.map(zone => [
    zone.id, ledges.find(platform => platform.id === `${zone.id}-crown`).y - zone.h
  ]));
  const game = {
    mode: 'playing',
    time: 0,
    frame: 0,
    deaths: 0,
    playerName: 'Climber',
    camera: { x: 0, y: 0 },
    cloudX: 0,
    particles: [],
    projectiles: [],
    kills: 0,
    creatureKills: 0,
    movers: makeMovers(),
    bot: null,
    creatures: [],
    player: null,
    loadout: { character: 'ash', color: PLAYER_COLORS[0] },
    remotePlayers: new Map(),
    remoteCells: new Map(),
    remoteCaptureMembers: new Map(),
    capturedZones: new Map(),
    captureProgress: new Map(),
    respawnBursts: [],
    room: null,
    // null means no verified presence snapshot is available. Never render it
    // as zero: a rejected or disconnected socket has no room occupancy data.
    roomCount: null,
    roomStatusReason: null
  };

  for (const zone of CAPTURE_ZONES) game.remoteCaptureMembers.set(zone.id, new Map());

  function remoteCell(x) {
    return Math.floor((Number.isFinite(x) ? x : SPAWN.x) / REMOTE_CELL_WIDTH);
  }

  function removeRemoteFromIndexes(remote) {
    if (!remote) return;
    const bucket = game.remoteCells.get(remote.__cell);
    if (bucket) {
      bucket.delete(remote.id);
      if (!bucket.size) game.remoteCells.delete(remote.__cell);
    }
    for (const zoneId of remote.__captureZones || []) {
      const colors = game.remoteCaptureMembers.get(zoneId);
      const members = colors?.get(remote.color);
      if (!members) continue;
      members.delete(remote.id);
      if (!members.size) colors.delete(remote.color);
    }
    remote.__captureZones = [];
  }

  function addRemoteToIndexes(remote) {
    if (!remote?.id) return;
    remote.__cell = remoteCell(remote.x);
    let bucket = game.remoteCells.get(remote.__cell);
    if (!bucket) game.remoteCells.set(remote.__cell, bucket = new Set());
    bucket.add(remote.id);
    remote.__captureZones = [];
    if (remote.alive === false || !remote.color) return;
    for (const zone of CAPTURE_ZONES) {
      if (remote.x < zone.x || remote.x > zone.x + zone.w || remote.y < zone.y || remote.y > zone.y + zone.h) continue;
      const colors = game.remoteCaptureMembers.get(zone.id);
      let members = colors.get(remote.color);
      if (!members) colors.set(remote.color, members = new Map());
      members.set(remote.id, { id: remote.id, name: remote.name || 'PLAYER' });
      remote.__captureZones.push(zone.id);
    }
  }

  function upsertRemote(payload) {
    if (!payload?.id) return null;
    const remote = game.remotePlayers.get(payload.id);
    if (remote) {
      removeRemoteFromIndexes(remote);
      Object.assign(remote, payload);
      addRemoteToIndexes(remote);
      return remote;
    }
    const created = { ...payload, x: payload.x ?? SPAWN.x, y: payload.y ?? SPAWN.y, facing: payload.facing || 1, animation: payload.animation || 'idle', health: payload.health ?? 3 };
    game.remotePlayers.set(created.id, created);
    addRemoteToIndexes(created);
    return created;
  }

  function removeRemote(id) {
    const remote = game.remotePlayers.get(id);
    if (!remote) return;
    removeRemoteFromIndexes(remote);
    game.remotePlayers.delete(id);
  }

  function remotePlayersInRange(minX, maxX, limit = Infinity) {
    const players = [];
    for (let cell = remoteCell(minX); cell <= remoteCell(maxX) && players.length < limit; cell += 1) {
      const bucket = game.remoteCells.get(cell);
      if (!bucket) continue;
      for (const id of bucket) {
        const remote = game.remotePlayers.get(id);
        if (!remote || remote.x < minX || remote.x > maxX) continue;
        players.push(remote);
        if (players.length === limit) break;
      }
    }
    return players;
  }

  // Deliberately opt-in local benchmark hook. It lets the mobile benchmark
  // exercise a room-sized render/update load without exposing test controls in
  // ordinary game sessions.
  if (new URLSearchParams(location.search).get('perf') === '1') {
    window.__encorePerformance ||= {};
    window.__encorePerformance.seedRemotePlayers = count => {
      for (let index = 0; index < count; index += 1) {
        upsertRemote({
          id: `perf-${index}`,
          name: `P${index + 1}`,
          x: (index * 73) % WORLD.width,
          y: 336 - (index % 4) * 36,
          facing: index % 2 ? -1 : 1,
          character: index % 2 ? 'p2' : 'ash',
          color: PLAYER_COLORS[index % PLAYER_COLORS.length],
          animation: 'idle',
          health: 3,
          alive: true
        });
      }
      return { players: game.remotePlayers.size, cells: game.remoteCells.size };
    };
    window.__encorePerformance.getFrameStats = () => ({ renders: frame.renderCount || 0, updates: frame.updateCount || 0 });
  }
  // The game can be hosted separately from the karaoke site.  Lock event
  // traffic to the direct parent that supplies the first valid session.
  let parentOrigin = null;

  const localAdminPreview = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).get('admin') === '1';
  void localAdminPreview;

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
      grounded: false,
      corpseSupportId: null,
      respawnTimer: 0,
      hitTimer: 0,
      attackTimer: 0,
      attackDuration: 0,
      attackCooldown: 45 + Math.floor(Math.random() * 45),
      attackConnected: false,
      phase: Math.random() * Math.PI * 2,
      animation: 'idle'
    };
  }

  let offlineHeartDrops;
  function resetGame(countDeath = false) {
    if (countDeath) game.deaths += 1;
    game.player = freshPlayer();
    game.bot = freshBot();
    game.creatures = CREATURE_SPECS.map(freshCreature);
    game.movers = makeMovers();
    game.camera.x = innerHeight > innerWidth ? SPAWN.x - VIEW.width / 2 : 0;
    game.camera.y = 0;
    game.particles.length = 0;
    game.projectiles.length = 0;
    game.respawnBursts.length = 0;
    offlineHeartDrops = window.EncoreHeartDrops?.createHeartDrops();
    game.hearts = [];
    input.jumpPressed = false;
    input.jumpHeld = false;
    input.shootHeld = false;
    input.shootReleased = false;
    input.aimAxisX = input.aimAxisY = 0;
    input.meleePressed = false;
    input.dashPressed = false;
    vibrate(countDeath ? 30 : 12);
  }

  function activePlayerRig() {
    return game.loadout.character === 'p2' ? playerTwoRig : ash;
  }

  function applyLoadout() {
    const color = game.loadout.color;
    activePlayerRig()?.setTeamChroma(game.loadout.character, color);
    localStorage.setItem('bcdkc-encore-loadout', JSON.stringify(game.loadout));
  }

  function emitGameEvent(event, payload = {}) {
    if (window.parent !== window) window.parent.postMessage({ type: 'bcd:encore:event', event, payload }, parentOrigin || '*');
  }

  function setRoomStatus(text, online = false) {
    const node = document.getElementById('roomStatus');
    if (node) { node.textContent = text; node.classList.toggle('is-online', online); }
  }

  function diagnosticReport() {
    const seconds = Math.max(.001, (performance.now() - diagnostics.startedAt) / 1000);
    const rigs = [ash, playerTwoRig, botRig, ...creatureRigs.values()].filter(Boolean);
    const cache = window.BulletAgeCharacter?.getAssetCacheStats?.();
    return {
      type: 'bcd:encore:diagnostics:report', version: BUILD_VERSION,
      report: {
        sampleSeconds: Number(seconds.toFixed(1)),
        presentation: {
          rafFps: Number((diagnostics.frameCount / seconds).toFixed(1)),
          presentedFps: Number((diagnostics.presentedCount / seconds).toFixed(1)),
          averageFrameMs: Number((diagnostics.totalFrameMs / Math.max(1, diagnostics.frameCount)).toFixed(2)),
          maxFrameMs: Number(diagnostics.maxFrameMs.toFixed(2)), maxStallMs: Number(diagnostics.maxStallMs.toFixed(2)),
          droppedFrames: diagnostics.droppedFrameCount
        },
        costs: {
          averageUpdateMs: Number((diagnostics.totalUpdateMs / Math.max(1, diagnostics.frameCount)).toFixed(2)),
          averageRenderMs: Number((diagnostics.totalRenderMs / Math.max(1, diagnostics.presentedCount)).toFixed(2))
        },
        device: {
          viewport: `${innerWidth}x${innerHeight}`, canvas: `${canvas.width}x${canvas.height}`,
          dpr: Number((devicePixelRatio || 1).toFixed(2)), touch: navigator.maxTouchPoints > 0,
          platform: navigator.userAgentData?.platform || navigator.platform || 'unavailable',
          userAgent: navigator.userAgent.slice(0, 180), visibility: document.visibilityState
        },
        runtime: {
          embedded: window.parent !== window, touchPresentation: TOUCH_PRESENTATION,
          renderIntervalMs: RENDER_INTERVAL_MS, renderer: rigs.some(rig => rig?.usesWebGL) ? 'WebGL2' : 'Canvas2D',
          loadedRigs: rigs.filter(rig => rig?.ready).length, failedRigs: rigs.filter(rig => rig?.failed).length,
          sourceCacheEntries: cache?.entries ?? 'unavailable'
        },
        room: {
          mode: game.room?.authoritative ? 'authoritative' : 'offline-practice',
          connected: Boolean(game.room?.connected),
          admission: game.room?.connected ? 'accepted' : (game.room?.authoritative ? (game.roomStatusReason === 'room_full' || game.roomStatusReason === 'server_full' ? 'rejected-full' : 'pending') : 'offline'),
          status: game.roomStatusReason || 'unavailable', players: Number.isFinite(game.roomCount) ? game.roomCount : null,
          visibleRemotes: remotePlayersInRange(game.camera.x - 30, game.camera.x + canvas.width + 30, MAX_VISIBLE_REMOTE_SPRITES).length
        }
      }
    };
  }

  function setLoadout(character, color) {
    game.loadout.character = character === 'p2' ? 'p2' : 'ash';
    game.loadout.color = PLAYER_COLORS.includes(color) ? color : game.loadout.color;
    document.querySelectorAll('[data-character]').forEach(button => button.classList.toggle('is-selected', button.dataset.character === game.loadout.character));
    document.querySelectorAll('[data-color]').forEach(button => button.classList.toggle('is-selected', button.dataset.color === game.loadout.color));
    applyLoadout();
    if (game.room) { game.room.player.character = game.loadout.character; game.room.player.color = game.loadout.color; game.room.track(); }
  }

  function setupLoadoutControls() {
    try {
      const saved = JSON.parse(localStorage.getItem('bcdkc-encore-loadout') || 'null');
      if (saved?.character === 'p2' || saved?.character === 'ash') game.loadout.character = saved.character;
      if (PLAYER_COLORS.includes(saved?.color)) game.loadout.color = saved.color;
    } catch (_) {}
    const colors = document.getElementById('colorOptions');
    if (colors) colors.innerHTML = PLAYER_COLORS.map(color => `<button type="button" data-color="${color}" aria-label="Select ${color}" style="--player-color:${color}"></button>`).join('');
    document.querySelectorAll('[data-character]').forEach(button => button.addEventListener('click', () => setLoadout(button.dataset.character, game.loadout.color)));
    document.querySelectorAll('[data-color]').forEach(button => button.addEventListener('click', () => setLoadout(game.loadout.character, button.dataset.color)));
    setLoadout(game.loadout.character, game.loadout.color);
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

  function movePlatforms() {
    const p = game.player;
    for (const platform of game.movers) {
      const old = { x: platform.x, y: platform.y, w: platform.w, h: platform.h };
      const wasRiding = Math.abs(p.y - old.y) <= 1 && rectAt().x < old.x + old.w && rectAt().x + rectAt().w > old.x;

      if (platform.axis === 'x') platform.x += platform.speed * platform.dir;
      else platform.y += platform.speed * platform.dir;

      const value = platform.axis === 'x' ? platform.x : platform.y;
      if (value <= platform.min || value >= platform.max) {
        if (platform.axis === 'x') platform.x = Math.max(platform.min, Math.min(platform.max, platform.x));
        else platform.y = Math.max(platform.min, Math.min(platform.max, platform.y));
        platform.dir *= -1;
      }

      const dx = platform.x - old.x;
      const dy = platform.y - old.y;
      if (wasRiding) {
        movePlayerX(dx);
        movePlayerY(dy);
      } else if (platform.kind === 'solid' && overlap(rectAt(), platform)) {
        if (dx > 0) movePlayerX(platform.x + platform.w - rectAt().x, true);
        else if (dx < 0) movePlayerX(platform.x - (rectAt().x + rectAt().w), true);
        if (dy > 0) movePlayerY(platform.y + platform.h - rectAt().y, true);
        else if (dy < 0) movePlayerY(platform.y - (rectAt().y + rectAt().h), true);
      }
    }
  }

  function emitDust(x, y, amount = 5) {
    for (let i = 0; i < amount; i += 1) {
      game.particles.push({
        x: x + (Math.random() - .5) * 12,
        y,
        vx: (Math.random() - .5) * 1.4,
        vy: -Math.random() * 1.3,
        life: 16 + Math.random() * 14
      });
    }
  }

  function updateParticles() {
    let write = 0;
    for (const particle of game.particles) {
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.vy += .07;
      particle.life -= 1;
      if (particle.life > 0) game.particles[write++] = particle;
    }
    game.particles.length = write;
    write = 0;
    for (const burst of game.respawnBursts) {
      burst.life -= 1;
      if (burst.life > 0) game.respawnBursts[write++] = burst;
    }
    game.respawnBursts.length = write;
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

  function spawnProjectile(actor, owner, aimX = actor.facing, aimY = 0) {
    const length = Math.hypot(aimX, aimY) || 1;
    const directionX = aimX / length;
    const directionY = aimY / length;
    const speed = owner === 'player' ? 6.2 : 4.3;
    game.projectiles.push({
      owner,
      x: actor.x + directionX * 15,
      y: actor.y - 22 + directionY * 8,
      vx: directionX * speed,
      vy: directionY * speed,
      trailX: directionX,
      trailY: directionY,
      life: 105
    });
    emitDust(actor.x + directionX * 12, actor.y - 21 + directionY * 8, 3);
  }

  function damageBot(amount, knockbackX, knockbackY, effectX = game.bot.x, effectY = game.bot.y - 17) {
    const bot = game.bot;
    if (!bot.alive) return false;
    bot.health -= amount;
    bot.vx = knockbackX;
    bot.vy = knockbackY;
    bot.hitTimer = 16;
    emitDust(effectX, effectY, bot.health > 0 ? 9 : 18);
    vibrate(bot.health > 0 ? 18 : [24, 24, 32]);
    if (bot.health <= 0) {
      bot.alive = false;
      bot.respawnTimer = 105;
      bot.animation = 'death';
      game.kills += 1;
    }
    return true;
  }

  function hitPlayer(knockbackX, knockbackY) {
    const player = game.player;
    if (!player.alive || player.invulnerable > 0) return false;
    player.health -= 1;
    player.invulnerable = 45;
    player.vx = knockbackX;
    player.vy = knockbackY;
    player.hitTimer = 14;
    emitDust(player.x, player.y - 17, 8);
    vibrate([16, 24, 16]);
    if (player.health <= 0) {
      game.deaths += 1;
      player.alive = false;
      player.health = 0;
      player.respawnTimer = PLAYER_RESPAWN_FRAMES;
      player.animation = 'death';
      player.animationTime = 0;
      player.vx = knockbackX * .35;
      player.vy = Math.min(knockbackY, -2.8);
      emitDust(player.x, player.y - 17, 20);
      game.room?.send('eliminated', { victimId: game.room.player.id, killerId: game.lastAttacker || null });
    }
    return true;
  }

  function respawnPlayer() {
    const spawn = window.EncoreSpawn?.chooseRespawn?.({ world: WORLD, fixed, ledges, movers: game.movers, player: game.player, actors: [game.bot, ...game.creatures], projectiles: game.projectiles });
    game.player = freshPlayer();
    if (spawn) Object.assign(game.player, spawn);
    game.player.invulnerable = 90;
    game.player.respawnPulse = 32;
    emitRespawnBurst(game.player.x, game.player.y, game.loadout.color);
    vibrate([10, 18, 12]);
  }

  function creatureRect(creature) {
    return {
      x: creature.x - creature.width / 2,
      y: creature.y - creature.height,
      w: creature.width,
      h: creature.height
    };
  }

  function damageCreature(creature, amount, knockbackX, knockbackY) {
    if (!creature.alive) return false;
    creature.health -= amount;
    creature.vx = knockbackX;
    creature.vy = knockbackY;
    creature.hitTimer = 14;
    creature.animation = creature.health > 0 ? 'hit' : 'death';
    emitDust(creature.x, creature.y - creature.height / 2, creature.health > 0 ? 7 : 15);
    vibrate(creature.health > 0 ? 14 : [20, 20, 28]);
    if (creature.health <= 0) {
      creature.alive = false;
      creature.respawnTimer = 120;
      game.creatureKills += 1;
      offlineHeartDrops?.drop(creature);
    }
    return true;
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
      ? 110 + Math.floor(Math.random() * 45)
      : 80 + Math.floor(Math.random() * 35);
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
        window.CelestefallCorpsePhysics.stepBatCorpse(creature, fixed.concat(ledges, game.movers));
      }
      if (creature.type !== 'bat' || creature.grounded) creature.respawnTimer -= 1;
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

  function creatureNeedsFullSimulation(creature) {
    return (!creature.alive && creature.type === 'bat') || creature.hitTimer > 0 || creature.attackTimer > 0 || Math.abs(game.player.x - creature.x) <= AI_FULL_SIMULATION_RADIUS;
  }

  function updateBackgroundCreature(creature) {
    if (!creature.alive) {
      creature.respawnTimer -= AI_BACKGROUND_INTERVAL;
      creature.animation = 'death';
      if (creature.respawnTimer <= 0) respawnCreature(creature);
      return;
    }
    creature.attackCooldown = Math.max(0, creature.attackCooldown - AI_BACKGROUND_INTERVAL);
    creature.phase += (creature.type === 'bat' ? .045 : .02) * AI_BACKGROUND_INTERVAL;
    // Preserve the authored idle/run state for the next visible frame without
    // evaluating steering, collision, or attack geometry offscreen.
    creature.animation = creature.type === 'bat' || Math.abs(creature.vx) > .12 ? 'run' : 'idle';
  }

  function updateCreatures() {
    for (let index = 0; index < game.creatures.length; index += 1) {
      const creature = game.creatures[index];
      if (creatureNeedsFullSimulation(creature)) updateCreature(creature);
      else if ((game.frame + index) % AI_BACKGROUND_INTERVAL === 0) updateBackgroundCreature(creature);
    }
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
    game.bot = freshBot(desiredX, floor?.y || BOT_SPAWN.y);
  }

  function updateBot() {
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

    const distance = game.player.x - bot.x;
    const verticalDistance = (game.player.y - PLAYER_H / 2) - (bot.y - PLAYER_H / 2);
    const direction = Math.abs(distance) > 78 ? Math.sign(distance) : 0;
    if (direction) bot.facing = direction;

    if (bot.meleeCooldown <= 0 && Math.abs(distance) < 48 && Math.abs(verticalDistance) < 62) {
      const requestedDirection = verticalDistance < -14 ? 'up' : (verticalDistance > 14 ? 'down' : 'forward');
      let commit = true;
      if (requestedDirection === 'up') {
        // An overhead player creates one anti-air decision, not a new dice
        // roll every frame. The bot sometimes contests a stomp, but most
        // descending attempts remain a viable way to damage it.
        commit = false;
        if (bot.antiAirCooldown <= 0) {
          bot.antiAirCooldown = 72 + Math.floor(Math.random() * 30);
          const defenseChance = game.player.vy > .5 ? .28 : .42;
          commit = Math.random() < defenseChance;
        }
      }
      if (commit) {
        if (Math.abs(distance) > 3) bot.facing = Math.sign(distance);
        beginMelee(bot, requestedDirection);
        bot.meleeCooldown = 105 + Math.floor(Math.random() * 35);
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
    if (overlap(botRect(), rectAt())) {
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

    if (Math.abs(distance) > 90 && Math.abs(distance) < 380 && bot.shootCooldown <= 0) {
      spawnProjectile(bot, 'bot');
      bot.shootTimer = 15;
      bot.shootCooldown = 150 + Math.floor(Math.random() * 55);
    }

    if (meleeCanHit(bot) && !bot.meleeConnected && overlap(meleeHitbox(bot, bot.meleeDirection), rectAt())) {
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

  function updateProjectiles() {
    const player = game.player;
    const bot = game.bot;
    for (const note of game.projectiles) {
      note.x += note.vx;
      note.y += note.vy;
      note.life -= 1;
      if (collidesSolid(note.x, note.y + PLAYER_H / 2, 2)) note.life = 0;

      if (note.owner === 'player' && bot.alive && overlap({ x: note.x - 4, y: note.y - 4, w: 8, h: 8 }, botRect())) {
        note.life = 0;
        damageBot(1, Math.sign(note.vx || game.player.facing) * 3.4, -2.5);
      }

      if (note.owner === 'player' && note.life > 0) {
        for (const remote of remotePlayersInRange(note.x - 24, note.x + 24)) {
          if (remote.alive !== false && remote.color !== game.loadout.color && overlap({ x: note.x - 4, y: note.y - 4, w: 8, h: 8 }, { x: remote.x - 9, y: remote.y - 34, w: 18, h: 34 })) {
            note.life = 0;
            game.room?.send('hit', { targetId: remote.id, attackerId: game.room.player.id, attackerColor: game.loadout.color, x: Math.sign(note.vx || game.player.facing) * 2.8, y: -2.5 });
            break;
          }
        }
        const creature = game.creatures.find(enemy => enemy.alive && overlap(
          { x: note.x - 4, y: note.y - 4, w: 8, h: 8 },
          creatureRect(enemy)
        ));
        if (creature) {
          note.life = 0;
          damageCreature(creature, 1, Math.sign(note.vx || game.player.facing) * 2.7, note.vy * .25);
        }
      }

      if (note.owner === 'bot' && overlap({ x: note.x - 4, y: note.y - 4, w: 8, h: 8 }, rectAt())) {
        note.life = 0;
        hitPlayer(Math.sign(note.vx) * 2.8, -2.5);
      }
    }
    let write = 0;
    for (const note of game.projectiles) {
      if (note.life > 0 && note.x > 0 && note.x < WORLD.width && note.y > 0 && note.y < WORLD.height) game.projectiles[write++] = note;
    }
    game.projectiles.length = write;
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

  function updateMeleeHit() {
    const p = game.player;
    if (!meleeCanHit(p) || p.meleeConnected) return;
    const hitbox = meleeHitbox(p, p.meleeDirection);
    const botTarget = game.bot.alive && overlap(hitbox, botRect()) ? game.bot : null;
    const creatureTarget = game.creatures.find(creature => creature.alive && overlap(hitbox, creatureRect(creature)));
    const target = botTarget || creatureTarget;
    if (!target) return;
    p.meleeConnected = true;
    const knockbackX = p.meleeDirection === 'forward' ? p.facing * 4.2 : Math.sign(target.x - p.x) * 1.8;
    const knockbackY = p.meleeDirection === 'up' ? -4.2 : (p.meleeDirection === 'down' ? 3.4 : -2.8);
    if (target === game.bot) damageBot(1, knockbackX, knockbackY, target.x, target.y - 15);
    else damageCreature(target, 1, knockbackX, knockbackY);
  }

  function checkHeadStomp(previousFeetY) {
    const p = game.player;
    if (p.stompCooldown > 0 || p.vy < 0) return;
    const targets = [];
    if (game.bot.alive) targets.push({ actor: game.bot, rect: botRect(), isBot: true });
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

  function captureRoster(zone, color) {
    const members = [];
    const player = game.player;
    if (player.alive && game.loadout.color === color && player.x >= zone.x && player.x <= zone.x + zone.w && player.y >= zone.y && player.y <= zone.y + zone.h) {
      members.push({ id: game.room?.player.id || 'local', name: game.playerName });
    }
    const remotes = game.remoteCaptureMembers.get(zone.id)?.get(color);
    if (remotes) members.push(...remotes.values());
    return members;
  }

  function captureContributorCount(zone, color) {
    const player = game.player;
    const local = player.alive && game.loadout.color === color && player.x >= zone.x && player.x <= zone.x + zone.w && player.y >= zone.y && player.y <= zone.y + zone.h ? 1 : 0;
    return local + (game.remoteCaptureMembers.get(zone.id)?.get(color)?.size || 0);
  }

  function updateCaptureZones() {
    const player = game.player;
    if (!player.alive) return;
    for (const zone of CAPTURE_ZONES) {
      const captured = game.capturedZones.get(zone.id);
      // Player color is the team assignment. Friendly zones stay captured;
      // another color must hold the room to replace its color and roster.
      if (captured?.color === game.loadout.color) { game.captureProgress.set(zone.id, 0); continue; }
      const contributorCount = captureContributorCount(zone, game.loadout.color);
      const progress = contributorCount ? Math.min(CAPTURE_FRAMES, (game.captureProgress.get(zone.id) || 0) + contributorCount) : Math.max(0, (game.captureProgress.get(zone.id) || 0) - 2);
      game.captureProgress.set(zone.id, progress);
      if (progress === CAPTURE_FRAMES) {
        const contributors = captureRoster(zone, game.loadout.color);
        const nextCapture = { id: zone.id, color: game.loadout.color, contributors, capturedAt: Date.now() };
        game.capturedZones.set(zone.id, nextCapture);
        game.room?.send('capture', nextCapture);
        emitGameEvent('capture_point', { zone: zone.id });
      }
    }
  }

  function emitRespawnBurst(x, y, color) {
    game.respawnBursts.push({ x, y, color, life: 32, maxLife: 32 });
    emitDust(x, y - 18, 18);
  }

  function publishRoomState() {
    if (!game.room?.connected) return;
    const now = performance.now();
    if (now < nextRoomPublishAt) return;
    nextRoomPublishAt = now + 80;
    const p = game.player;
    game.room.publishState({ x: p.x, y: p.y, facing: p.facing, animation: p.animation, health: p.health, name: game.playerName, character: game.loadout.character, color: game.loadout.color, alive: p.alive, respawnTimer: p.respawnTimer });
  }

  let authorityEpoch = null;
  let lastAuthorityEvent = null;

  function applyAuthoritySnapshot(snapshot) {
    const local = snapshot.players.find(player => player.id === game.room.player.id);
    if (!local) return;
    if (snapshot.epoch !== authorityEpoch) {
      authorityEpoch = snapshot.epoch;
      lastAuthorityEvent = null;
      game.particles.length = 0;
      game.respawnBursts.length = 0;
    }
    // Positions, damage, deaths, scores, projectiles and pickups are all
    // hydrated from the same server tick. Rendering cannot mutate outcomes.
    Object.assign(game.player, local);
    game.playerName = local.name;
    game.bot = { ...snapshot.bot };
    game.creatures = snapshot.creatures.map(creature => ({ ...creature }));
    game.projectiles = snapshot.projectiles.map(note => ({ ...note }));
    game.movers = snapshot.movers.map(mover => ({ ...mover }));
    game.hearts = (snapshot.hearts || []).map(heart => ({ ...heart }));
    game.time = snapshot.time;
    game.frame = snapshot.tick;
    game.kills = local.kills;
    game.deaths = local.deaths;
    game.creatureKills = local.creatureKills;
    game.capturedZones = new Map(snapshot.captures.map(capture => [capture.id, capture]));
    game.captureProgressByColor = new Map(snapshot.captureProgress.map(progress => [progress.id, progress.colors]));
    game.captureContested = new Set(snapshot.captureContested || []);
    game.captureProgress = new Map(snapshot.captureProgress.map(progress => [progress.id, progress.colors[local.color] || 0]));
    const currentIds = new Set(snapshot.players.map(player => player.id));
    for (const id of game.remotePlayers.keys()) if (!currentIds.has(id)) removeRemote(id);
    for (const player of snapshot.players) if (player.id !== local.id) upsertRemote(player);
    const events = snapshot.events || [];
    if (lastAuthorityEvent !== null) {
      for (const event of events) {
        if (event.id <= lastAuthorityEvent) continue;
        if (event.type === 'respawn') emitRespawnBurst(event.x, event.y, event.color);
        if (['hit', 'death', 'heal'].includes(event.type)) emitDust(event.x, event.y - 16, event.type === 'death' ? 16 : 7);
        if (event.targetId === local.id && event.type === 'hit') vibrate(16);
        if (event.type === 'death' && event.attackerId === local.id && snapshot.players.some(p => p.id === event.targetId)) emitGameEvent('first_pk', { victimId: event.targetId });
        if (event.type === 'capture' && event.contributors?.some(p => p.id === local.id)) emitGameEvent('capture_point', { zone: event.zoneId });
      }
    }
    if (events.length) lastAuthorityEvent = Math.max(lastAuthorityEvent || 0, ...events.map(event => event.id));
    else lastAuthorityEvent ??= 0;
  }

  function connectRoom(config) {
    if (!window.EncoreRoom || game.room) return;
    let guestId;
    try {
      guestId = sessionStorage.getItem('encore-guest-id');
      if (!guestId) { guestId = `guest-${crypto.randomUUID()}`; sessionStorage.setItem('encore-guest-id', guestId); }
    } catch { guestId = `guest-${crypto.randomUUID()}`; }
    const id = String(config.playerId || guestId);
    const serverUrl = config.serverUrl || window.ENCORE_SERVER_URL || '';
    game.room = new window.EncoreRoom({ serverUrl, roomId: config.roomId || 'royal' }, { id, name: game.playerName, character: game.loadout.character, color: game.loadout.color });
    game.room.setInputSource(() => {
      const controls = { ...input };
      input.jumpPressed = input.shootReleased = input.meleePressed = input.dashPressed = false;
      return controls;
    });
    game.room.addEventListener('status', event => {
      const { connected, reason } = event.detail;
      game.roomStatusReason = reason || (connected ? 'live' : 'unknown');
      // EncoreRoom owns these fields; the HUD and diagnostics both consume
      // the same admission/status contract rather than inferring from count.
      const labels = { offline: 'OFFLINE PRACTICE', connecting: 'CONNECTING', reconnecting: 'RECONNECTING · PAUSED', room_full: 'ROOM FULL', server_full: 'SERVER FULL', invalid_server: 'SERVER UNAVAILABLE', session_replaced: 'SESSION OPEN ELSEWHERE', version_mismatch: 'RELOAD REQUIRED', left: 'DISCONNECTED' };
      const count = Number.isSafeInteger(event.detail.count) && event.detail.count >= 0 && event.detail.count <= 8 ? event.detail.count : null;
      const fullLabel = reason === 'room_full' && count !== null ? `ROOM FULL · ${count}/8` : labels[reason] || 'SERVER UNAVAILABLE';
      setRoomStatus(connected ? (game.roomCount === null ? 'LIVE' : `LIVE · ${game.roomCount}/8`) : fullLabel, connected);
      if (!connected) {
        game.roomCount = count;
        for (const id of [...game.remotePlayers.keys()]) removeRemote(id);
        if (game.room.authoritative) { game.projectiles.length = 0; game.hearts = []; }
      }
    });
    game.room.addEventListener('presence', event => {
      const count = Number.isSafeInteger(event.detail.count) && event.detail.count >= 0 && event.detail.count <= 8 ? event.detail.count : null;
      game.roomCount = count;
      if (event.detail.connected) setRoomStatus(count === null ? 'LIVE' : `LIVE · ${count}/8`, true);
    });
    game.room.addEventListener('snapshot', event => applyAuthoritySnapshot(event.detail));
    game.room.addEventListener('leave', event => removeRemote(event.detail?.id));
    game.room.connect();
  }

  function updateOfflineHearts() {
    if (!offlineHeartDrops) return;
    game.player.connected = true;
    offlineHeartDrops.update({ players: [game.player], surfaces: [...fixed, ...ledges, ...game.movers], emit: (_type, event) => emitDust(event.x, event.y, 7) });
    game.hearts = offlineHeartDrops.snapshot();
  }

  function update() {
    if (game.mode !== 'playing') return;
    if (game.room?.authoritative) {
      // Shared simulation runs only on the server. This remains true during
      // reconnect/full-room rejection, so no private replacement world forms.
      game.cloudX = (game.cloudX + .25) % 448;
      updateParticles();
      updateCamera();
      return;
    }
    const p = game.player;
    const wasGrounded = p.grounded;
    game.time += STEP;
    game.frame += 1;
    game.cloudX = (game.cloudX + .25) % 448;
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

    movePlatforms();
    updateOfflineHearts();

    if (!p.alive) {
      p.respawnTimer = Math.max(0, p.respawnTimer - 1);
      p.animationTime += STEP;
      if (p.respawnTimer <= 0) respawnPlayer();
      updateParticles();
      updateBot();
      updateCreatures();
      updateProjectiles();
      publishRoomState();
      updateCamera();
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
    updateParticles();
    updateBot();
    updateCreatures();
    updateProjectiles();
    updateCaptureZones();
    publishRoomState();
    updateCamera();
    input.jumpPressed = false;
    input.shootReleased = false;
    input.meleePressed = false;
    input.dashPressed = false;
  }

  function updateCamera(force = false) {
    const p = game.player;
    const lookAhead = p.facing * Math.min(46, Math.abs(p.vx) * 18);
    const portrait = innerHeight > innerWidth;
    // Portrait CSS deliberately crops the wide canvas to create the requested
    // zoom. Let the logical camera travel beyond the level bounds there so the
    // player stays in that central crop at both ends of the map.
    const minX = portrait ? -VIEW.width / 2 + 24 : 0;
    const maxX = portrait ? WORLD.width - VIEW.width / 2 - 24 : WORLD.width - VIEW.width;
    const targetX = Math.max(minX, Math.min(maxX, p.x - VIEW.width / 2 + lookAhead));
    if (force) game.camera.x = targetX;
    else game.camera.x += (targetX - game.camera.x) * .075;
    game.camera.y = 0;
  }

  function recenterAfterLayoutChange() {
    requestAnimationFrame(() => {
      updateCamera(true);
      render();
    });
  }

  window.addEventListener('resize', recenterAfterLayoutChange);
  screen.orientation?.addEventListener?.('change', recenterAfterLayoutChange);

  function drawBackdrop() {
    if (backgroundLayer) {
      const cameraX = Math.round(game.camera.x);
      const sourceX = Math.max(0, cameraX);
      const destinationX = Math.max(0, -cameraX);
      const visibleWidth = Math.min(VIEW.width - destinationX, WORLD.width - sourceX);
      ctx.fillStyle = '#090914';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (visibleWidth > 0) ctx.drawImage(backgroundLayer, sourceX, 0, visibleWidth, VIEW.height, destinationX, 0, visibleWidth, VIEW.height);
      return;
    }
    ctx.fillStyle = '#090914';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const panels = [images.towerBgLeft, images.towerBgCenter, images.towerBgRight];
    ctx.save();
    // Generated source panels are high-resolution pixel art. Smooth only the
    // one-time downscale; gameplay sprites return to nearest-neighbor below.
    ctx.imageSmoothingEnabled = true;
    panels.forEach((image, section) => {
      const x = Math.round(section * VIEW.width - game.camera.x);
      if (!image || x > canvas.width || x + VIEW.width < 0) return;
      ctx.drawImage(image, x, 0, VIEW.width, VIEW.height);
    });
    ctx.restore();
    ctx.imageSmoothingEnabled = false;

    // A restrained selective veil quiets only the lower combat band; the
    // rose window, curtains, torches and crystal depth stay luminous.
    const combatVeil = ctx.createLinearGradient(0, 170, 0, 360);
    combatVeil.addColorStop(0, 'rgba(6,5,13,0)');
    combatVeil.addColorStop(.55, 'rgba(6,5,13,.14)');
    combatVeil.addColorStop(1, 'rgba(6,5,13,.32)');
    ctx.fillStyle = combatVeil;
    ctx.fillRect(0, 160, canvas.width, 200);

    const vignette = ctx.createLinearGradient(0, 0, canvas.width, 0);
    vignette.addColorStop(0, 'rgba(3,2,9,.35)');
    vignette.addColorStop(.12, 'rgba(3,2,9,0)');
    vignette.addColorStop(.88, 'rgba(3,2,9,0)');
    vignette.addColorStop(1, 'rgba(3,2,9,.35)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function drawRockBlock(block, target = ctx, cameraX = game.camera.x) {
    const x = Math.round(block.x - cameraX);
    const y = Math.round(block.y - game.camera.y);
    if (x + block.w < -24 || x > target.canvas.width + 24) return;
    target.fillStyle = '#171522';
    target.fillRect(x, y, block.w, block.h);
    target.fillStyle = '#322b42';
    for (let py = y + 2; py < y + block.h; py += 10) {
      for (let px = x + ((py / 10) % 2 ? 2 : 8); px < x + block.w; px += 14) {
        target.fillRect(px, py, 5, 4);
        target.fillStyle = '#59445f';
        target.fillRect(px + 1, py, 3, 1);
        target.fillStyle = '#322b42';
      }
    }
    if (block.w > block.h) {
      target.fillStyle = '#c08a3f';
      target.fillRect(x, y, block.w, 2);
      target.fillStyle = '#6d203d';
      target.fillRect(x, y + 2, block.w, 4);
      target.fillStyle = '#d8aa57';
      for (let px = x + 4; px < x + block.w; px += 14) target.fillRect(px, y + 2, 3, 2);
    }
  }

  function drawThinPlatform(platform, target = ctx, cameraX = game.camera.x) {
    const x = Math.round(platform.x - cameraX);
    const y = Math.round(platform.y - game.camera.y);
    if (x + platform.w < -20 || x > target.canvas.width + 20) return;
    target.fillStyle = '#160f1b';
    target.fillRect(x - 1, y - 1, platform.w + 2, platform.h + 3);
    target.fillStyle = '#d2a04e';
    target.fillRect(x, y, platform.w, 2);
    target.fillStyle = '#7f254a';
    target.fillRect(x, y + 2, platform.w, Math.max(3, platform.h - 2));
    target.fillStyle = '#b64d6f';
    target.fillRect(x + 4, y + 3, Math.max(1, platform.w - 8), 1);
    target.fillStyle = '#3b2039';
    for (let px = x + 6; px < x + platform.w - 4; px += 16) target.fillRect(px, y + platform.h, 5, 2);
  }

  function buildStaticRenderLayers() {
    backgroundLayer = document.createElement('canvas');
    backgroundLayer.width = WORLD.width;
    backgroundLayer.height = WORLD.height;
    const background = backgroundLayer.getContext('2d', { alpha: false });
    background.fillStyle = '#090914';
    background.fillRect(0, 0, WORLD.width, WORLD.height);
    background.imageSmoothingEnabled = true;
    [images.towerBgLeft, images.towerBgCenter, images.towerBgRight].forEach((image, section) => {
      if (image) background.drawImage(image, section * VIEW.width, 0, VIEW.width, VIEW.height);
    });
    const combatVeil = background.createLinearGradient(0, 170, 0, 360);
    combatVeil.addColorStop(0, 'rgba(6,5,13,0)');
    combatVeil.addColorStop(.55, 'rgba(6,5,13,.14)');
    combatVeil.addColorStop(1, 'rgba(6,5,13,.32)');
    background.fillStyle = combatVeil;
    background.fillRect(0, 160, WORLD.width, 200);
    background.imageSmoothingEnabled = false;
    fixed.forEach(block => drawRockBlock(block, background, 0));
    ledges.forEach(platform => drawThinPlatform(platform, background, 0));
  }

  function drawPlatforms() {
    if (!backgroundLayer) {
      fixed.forEach(block => drawRockBlock(block));
      ledges.forEach(platform => drawThinPlatform(platform));
    }
    game.movers.forEach(platform => drawThinPlatform(platform));
  }

  function drawCaptureZones() {
    for (const zone of CAPTURE_ZONES) {
      const x = Math.round(zone.x - game.camera.x), y = CAPTURE_MARKER_Y.get(zone.id) - game.camera.y;
      if (x + zone.w < 0 || x > canvas.width) continue;
      const captured = game.capturedZones.get(zone.id);
      // Use all server colors so remote progress never takes the viewer's color.
      const colors = { ...(game.captureProgressByColor?.get(zone.id) || {}) };
      // Offline practice advances the legacy local counter directly; merge it
      // into the color map so the marker fills before ownership completes.
      const localFrames = game.captureProgress.get(zone.id) || 0;
      colors[game.loadout.color] = Math.max(colors[game.loadout.color] || 0, localFrames);
      const challengers = Object.entries(colors)
        .filter(([color, frames]) => color !== captured?.color && Number.isFinite(frames) && frames > 0)
        .sort(([a], [b]) => a.localeCompare(b));
      const contested = game.captureContested?.has(zone.id) || false;
      ctx.save();
      ctx.fillStyle = captured?.color || '#e5bb58';
      ctx.globalAlpha = captured ? .22 : .08;
      ctx.fillRect(x, y, zone.w, zone.h);
      // Preserve the owner border until capture completes. Multiple teams with
      // remaining progress get equal-width lanes, each filled bottom-to-top.
      const laneWidth = (zone.w - 4) / Math.max(1, challengers.length);
      for (let index = 0; index < challengers.length; index += 1) {
        const [color, frames] = challengers[index];
        const height = (zone.h - 4) * Math.min(1, frames / CAPTURE_FRAMES);
        const left = x + 2 + index * laneWidth, top = y + zone.h - 2 - height;
        ctx.fillStyle = color; ctx.globalAlpha = .72;
        ctx.fillRect(left, top, laneWidth, height);
        ctx.globalAlpha = 1;
        ctx.fillRect(left, top, laneWidth, Math.min(1, height));
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = captured?.color || '#e5bb58';
      ctx.setLineDash(captured ? [] : [3, 3]);
      ctx.strokeRect(x + .5, y + .5, zone.w - 1, zone.h - 1);
      ctx.setLineDash([]);
      ctx.textAlign = 'center'; ctx.font = 'bold 7px ui-monospace, monospace';
      // Outline text instead of covering the fill, including its first few pixels.
      ctx.strokeStyle = '#0c0a16'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
      ctx.fillStyle = '#fff6d5';
      ctx.strokeText(zone.label, x + zone.w / 2, y + 10);
      ctx.fillText(zone.label, x + zone.w / 2, y + 10);
      const percent = Math.round(Math.max(0, ...challengers.map(([, frames]) => Math.min(1, frames / CAPTURE_FRAMES))) * 100);
      const status = contested ? 'CONTESTED' : challengers.length ? `${percent}%` : captured ? '✓' : '0%';
      ctx.strokeText(status, x + zone.w / 2, y + 20);
      ctx.fillText(status, x + zone.w / 2, y + 20);
      if (captured?.contributors?.length) {
        const names = captured.contributors.map(member => member.name).join(' + ');
        const label = names.length > 15 ? `${names.slice(0, 14)}…` : names;
        ctx.fillStyle = '#fff6d5'; ctx.font = 'bold 6px ui-monospace, monospace';
        ctx.strokeText(label, x + zone.w / 2, y + zone.h - 6);
        ctx.fillText(label, x + zone.w / 2, y + zone.h - 6);
      }
      ctx.restore();
    }
  }

  function drawRespawnEffects() {
    for (const burst of game.respawnBursts) {
      const progress = 1 - burst.life / burst.maxLife;
      const x = burst.x - game.camera.x;
      const y = burst.y - 17;
      if (x < -48 || x > canvas.width + 48) continue;
      ctx.save();
      ctx.globalAlpha = (1 - progress) * .85;
      ctx.strokeStyle = burst.color;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 8 + progress * 30, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }

  function drawRemotePlayers() {
    const remotes = remotePlayersInRange(game.camera.x - 30, game.camera.x + canvas.width + 30, MAX_VISIBLE_REMOTE_SPRITES);
    let labelled = 0;
    for (const remote of remotes) {
      const x = Math.round(remote.x - game.camera.x), y = Math.round(remote.y);
      ctx.save();
      if (remote.alive === false) ctx.globalAlpha = .3;
      else if (remote.hitTimer > 0) ctx.globalAlpha = .65;
      ctx.translate(x, y); ctx.scale(remote.facing || 1, 1);
      ctx.drawImage(remoteSprite(remote), -11, -36);
      ctx.restore();
      if (remote.alive !== false && remote.meleeTimer > 0) {
        const box = meleeHitbox(remote, remote.meleeDirection);
        ctx.save(); ctx.strokeStyle = remote.color || '#ffffff'; ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(box.x - game.camera.x, box.y + box.h);
        ctx.quadraticCurveTo(box.x + box.w / 2 - game.camera.x, box.y - 8, box.x + box.w - game.camera.x, box.y + box.h / 2);
        ctx.stroke(); ctx.restore();
      }
      for (let index = 0; index < (remote.maxHealth || 3); index++) {
        ctx.fillStyle = index < remote.health ? remote.color : '#5d586c';
        ctx.fillRect(x - 10 + index * 8, y - 41, 6, 3);
      }
      if (labelled >= MAX_VISIBLE_REMOTE_LABELS) continue;
      labelled += 1;
      ctx.fillStyle = '#fff1c2'; ctx.font = 'bold 8px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.fillText(remote.name || 'PLAYER', x, y - 47);
    }
  }

  function playerFrame() {
    const p = game.player;
    if (p.animation === 'run') return images[`run${Math.floor(p.animationTime * 8.5) % 6}`];
    if (p.animation === 'idle') return images[`idle${Math.floor(p.animationTime * 10) % 5}`];
    if (p.animation === 'crouch' || p.animation === 'look') return images.idle0;
    return images[p.animation];
  }

  function drawPlayer() {
    const p = game.player;
    const x = Math.round((p.x - game.camera.x) * 2) / 2;
    const y = Math.round(p.y - game.camera.y);
    if (!p.alive) {
      ctx.save();
      ctx.globalAlpha = .78;
      ctx.strokeStyle = game.loadout.color;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(x, y - 17, 18, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff1c2'; ctx.font = 'bold 8px ui-monospace, monospace'; ctx.textAlign = 'center';
      ctx.fillText(`RETURNING ${Math.max(1, Math.ceil(p.respawnTimer / 60))}`, x, y - 50);
      ctx.restore();
      return;
    }
    const selectedRig = activePlayerRig();
    if (selectedRig?.ready) {
      prepareRigForRender(selectedRig, p.animation);
      selectedRig.draw(x, y, p.facing, p.stretch, p.squash);
    } else {
      const image = playerFrame();
      if (image) {
        ctx.save(); ctx.translate(x, y);
        if (p.animation === 'crouch') ctx.scale(p.facing * p.stretch * 1.12, p.squash * .7);
        else if (p.animation === 'look') ctx.scale(p.facing * p.stretch * .96, p.squash * 1.04);
        else ctx.scale(p.facing * p.stretch, p.squash);
        ctx.drawImage(image, -image.width / 2, -image.height); ctx.restore();
      }
    }
    for (let index = 0; index < p.maxHealth; index += 1) {
      ctx.fillStyle = index < p.health ? game.loadout.color : '#5d586c';
      ctx.fillRect(x - 10 + index * 8, y - 41, 6, 3);
    }
  }

  function drawBot() {
    const bot = game.bot;
    if (!bot || (!bot.alive && bot.respawnTimer < 75)) return;
    const x = Math.round((bot.x - game.camera.x) * 2) / 2;
    const y = Math.round(bot.y - game.camera.y);
    if (x < -60 || x > canvas.width + 60) return;

    if (botRig?.ready) {
      prepareRigForRender(botRig, bot.animation, SECONDARY_RIG_UPDATE_INTERVAL);
      botRig.draw(x, y, bot.facing, 1, 1);
    }
    else {
      ctx.fillStyle = '#2267c9';
      ctx.fillRect(x - 9, y - 27, 18, 27);
      ctx.fillStyle = '#f4ecd7';
      ctx.fillRect(x - 4, y - 22, 8, 5);
    }

    if (bot.alive) {
      ctx.fillStyle = '#363542';
      ctx.fillRect(x - 13, y - 43, 26, 7);
      for (let index = 0; index < bot.maxHealth; index += 1) {
        ctx.fillStyle = index < bot.health ? '#62b6ff' : '#5d586c';
        ctx.fillRect(x - 10 + index * 8, y - 41, 6, 3);
      }
    }
  }

  function drawCreatures() {
    for (const creature of game.creatures) {
      if (!creature.alive && creature.respawnTimer < 88 && (creature.type !== 'bat' || creature.grounded)) continue;
      const x = Math.round((creature.x - game.camera.x) * 2) / 2;
      const y = Math.round(creature.y - game.camera.y);
      if (x < -70 || x > canvas.width + 70) continue;
      const rig = creatureRigs.get(creature.id);
      if (rig?.ready) {
        prepareRigForRender(rig, creature.animation, CREATURE_RIG_UPDATE_INTERVAL);
        let drawY = y;
        if (creature.type === 'bat' && !creature.alive) {
          // This rig hangs below its origin. Anchor the intact death pose's
          // visible bottom to the corpse feet used by collision physics.
          const skeleton = rig.skeleton;
          skeleton.x = rig.poseAnchor.x;
          skeleton.y = rig.poseAnchor.y;
          skeleton.scaleX = 1;
          skeleton.scaleY = -1;
          skeleton.updateWorldTransform();
          const offset = new spine.Vector2(), size = new spine.Vector2();
          skeleton.getBounds(offset, size, []);
          drawY -= offset.y + size.y - rig.poseAnchor.y;
        }
        rig.draw(x, drawY, creature.type === 'bat' ? -creature.facing : creature.facing, 1, 1);
      } else if (creature.type === 'bat') {
        ctx.fillStyle = '#53355f';
        ctx.beginPath();
        ctx.moveTo(x, y - 10);
        ctx.lineTo(x - 18, y - 21);
        ctx.lineTo(x - 12, y - 4);
        ctx.lineTo(x, y - 14);
        ctx.lineTo(x + 12, y - 4);
        ctx.lineTo(x + 18, y - 21);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = '#7aa83b';
        ctx.beginPath();
        ctx.ellipse(x, y - 8, 17, 10, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      if (creature.alive && creature.maxHealth > 1) {
        ctx.fillStyle = '#363542';
        ctx.fillRect(x - 10, y - creature.height - 8, 20, 5);
        for (let index = 0; index < creature.maxHealth; index += 1) {
          ctx.fillStyle = index < creature.health ? '#a8d95b' : '#5d586c';
          ctx.fillRect(x - 8 + index * 8, y - creature.height - 7, 6, 2);
        }
      }
    }
  }

  function drawHearts() {
    ctx.save();
    for (const heart of game.hearts || []) {
      const x = Math.round(heart.x - game.camera.x), y = Math.round(heart.y - game.camera.y);
      if (x < -12 || x > VIEW.width + 12 || y < -12 || y > VIEW.height + 12) continue;
      if (heart.life < 180 && Math.floor(heart.life / 10) % 2 === 0) continue;
      ctx.fillStyle = '#ff668a'; ctx.strokeStyle = '#542039'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y + 5);
      ctx.lineTo(x - 6, y - 1); ctx.lineTo(x - 6, y - 4); ctx.lineTo(x - 3, y - 6);
      ctx.lineTo(x, y - 3); ctx.lineTo(x + 3, y - 6); ctx.lineTo(x + 6, y - 4);
      ctx.lineTo(x + 6, y - 1); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  function drawProjectiles() {
    ctx.save();
    for (const note of game.projectiles) {
      const x = Math.round(note.x - game.camera.x);
      const y = Math.round(note.y - game.camera.y);
      if (x < -24 || x > canvas.width + 24 || y < -24 || y > canvas.height + 24) continue;
      const trailX = note.trailX ?? Math.sign(note.vx);
      const trailY = note.trailY ?? 0;
      ctx.strokeStyle = note.owner === 'player' ? '#fff3b0' : '#8ed7ff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x - trailX * 15, y - trailY * 15);
      ctx.lineTo(x - trailX * 5, y - trailY * 5);
      ctx.stroke();
      ctx.drawImage(noteSprites[note.owner === 'player' ? 'player' : 'bot'], x - 16, y - 16);
    }
    ctx.restore();
  }

  function drawAimGuide() {
    const p = game.player;
    if (!p.aiming) return;
    const originX = p.x - game.camera.x + p.aimX * 10;
    const originY = p.y - game.camera.y - 22 + p.aimY * 6;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 243, 176, .82)';
    ctx.fillStyle = '#ce146c';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(originX, originY);
    ctx.lineTo(originX + p.aimX * 70, originY + p.aimY * 70);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = 'bold 13px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('♪', originX + p.aimX * 76, originY + p.aimY * 76);
    ctx.restore();
  }

  function drawParticles() {
    ctx.fillStyle = '#f4ecd7';
    for (const particle of game.particles) {
      const x = Math.round(particle.x - game.camera.x);
      const y = Math.round(particle.y - game.camera.y);
      if (x < -2 || x > canvas.width + 2 || y < -2 || y > canvas.height + 2) continue;
      const alpha = Math.min(1, particle.life / 10);
      ctx.globalAlpha = alpha;
      ctx.fillRect(x, y, 2, 2);
    }
    ctx.globalAlpha = 1;
  }

  function render() {
    ctx.imageSmoothingEnabled = false;
    drawBackdrop();
    drawPlatforms();
    drawCaptureZones();
    drawRespawnEffects();
    drawParticles();
    drawProjectiles();
    drawHearts();
    drawCreatures();
    drawBot();
    drawRemotePlayers();
    drawPlayer();
    drawAimGuide();
  }

  function vibrate(pattern) {
    if (!navigator.userActivation?.hasBeenActive) return;
    try { navigator.vibrate?.(pattern); } catch (_) {}
  }

  const keyMap = new Map([
    ['ArrowLeft', 'left'], ['KeyA', 'left'],
    ['ArrowRight', 'right'], ['KeyD', 'right'],
    ['ArrowUp', 'up'], ['KeyW', 'up'],
    ['ArrowDown', 'down'], ['KeyS', 'down']
  ]);

  window.addEventListener('keydown', event => {
    if (document.body.classList.contains('skin-editor-open')) return;
    if (keyMap.has(event.code)) {
      input[keyMap.get(event.code)] = true;
      event.preventDefault();
    }
    if (!event.repeat && event.code === 'Space') {
      input.jumpPressed = true;
      input.jumpHeld = true;
      event.preventDefault();
    }
    if (!event.repeat && ['ShiftLeft', 'ShiftRight', 'KeyX', 'KeyJ'].includes(event.code)) {
      input.shootHeld = true;
      event.preventDefault();
    }
    if (!event.repeat && ['KeyV', 'KeyL', 'KeyM'].includes(event.code)) {
      input.meleePressed = true;
      event.preventDefault();
    }
    if (!event.repeat && ['KeyB', 'KeyC', 'KeyK'].includes(event.code)) {
      input.dashPressed = true;
      event.preventDefault();
    }
    if (!event.repeat && event.code === 'KeyF') {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
    }
    hideHelpSoon();
  });

  window.addEventListener('keyup', event => {
    if (document.body.classList.contains('skin-editor-open')) return;
    if (keyMap.has(event.code)) input[keyMap.get(event.code)] = false;
    if (event.code === 'Space') input.jumpHeld = false;
    if (['ShiftLeft', 'ShiftRight', 'KeyX', 'KeyJ'].includes(event.code) && input.shootHeld) {
      input.shootHeld = false;
      input.shootReleased = true;
    }
  });

  window.addEventListener('blur', () => {
    input.left = input.right = input.up = input.down = input.jumpHeld = input.shootHeld = false;
    input.aimAxisX = input.aimAxisY = 0;
  });

  const joystick = document.getElementById('joystick');
  const joystickKnob = document.getElementById('joystickKnob');
  let joystickPointer = null;

  function updateJoystick(event) {
    const box = joystick.getBoundingClientRect();
    const centerX = box.left + box.width / 2;
    const centerY = box.top + box.height / 2;
    const max = box.width * .27;
    const rawX = event.clientX - centerX;
    const rawY = event.clientY - centerY;
    const length = Math.hypot(rawX, rawY) || 1;
    const scale = Math.min(1, max / length);
    const x = rawX * scale;
    const y = rawY * scale;
    input.aimAxisX = Math.max(-1, Math.min(1, rawX / max));
    input.aimAxisY = Math.max(-1, Math.min(1, rawY / max));
    joystickKnob.style.transform = `translate(${x}px, ${y}px)`;
    input.left = rawX < -box.width * .12;
    input.right = rawX > box.width * .12;
    input.up = rawY < -box.height * .16;
    input.down = rawY > box.height * .16;
  }

  joystick.addEventListener('pointerdown', event => {
    joystickPointer = event.pointerId;
    joystick.setPointerCapture(event.pointerId);
    updateJoystick(event);
    hideHelpSoon();
  });
  joystick.addEventListener('pointermove', event => {
    if (event.pointerId === joystickPointer) updateJoystick(event);
  });
  function releaseJoystick(event) {
    if (event.pointerId !== joystickPointer) return;
    joystickPointer = null;
    input.left = input.right = input.up = input.down = false;
    input.aimAxisX = input.aimAxisY = 0;
    joystickKnob.style.transform = 'translate(0, 0)';
  }
  joystick.addEventListener('pointerup', releaseJoystick);
  joystick.addEventListener('pointercancel', releaseJoystick);

  function bindTapButton(button, property) {
    const release = event => {
      if (button.hasPointerCapture?.(event.pointerId)) button.releasePointerCapture(event.pointerId);
      button.classList.remove('is-active');
    };
    button.addEventListener('pointerdown', event => {
      button.setPointerCapture(event.pointerId);
      input[property] = true;
      button.classList.add('is-active');
      hideHelpSoon();
      event.preventDefault();
    });
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
  }

  const shootButton = document.getElementById('shootButton');
  const meleeButton = document.getElementById('meleeButton');
  const dashButton = document.getElementById('dashButton');
  const jumpButton = document.getElementById('jumpButton');
  let shootPointer = null;
  shootButton.addEventListener('pointerdown', event => {
    shootPointer = event.pointerId;
    shootButton.setPointerCapture(event.pointerId);
    shootButton.classList.add('is-active');
    input.shootHeld = true;
    hideHelpSoon();
    event.preventDefault();
  });
  shootButton.addEventListener('pointerup', event => {
    if (event.pointerId !== shootPointer) return;
    shootPointer = null;
    if (shootButton.hasPointerCapture?.(event.pointerId)) shootButton.releasePointerCapture(event.pointerId);
    shootButton.classList.remove('is-active');
    input.shootHeld = false;
    input.shootReleased = true;
  });
  shootButton.addEventListener('pointercancel', event => {
    if (event.pointerId !== shootPointer) return;
    shootPointer = null;
    shootButton.classList.remove('is-active');
    input.shootHeld = false;
  });
  bindTapButton(meleeButton, 'meleePressed');
  bindTapButton(dashButton, 'dashPressed');
  jumpButton.addEventListener('pointerdown', event => {
    input.jumpPressed = true;
    input.jumpHeld = true;
    jumpButton.classList.add('is-active');
    jumpButton.setPointerCapture(event.pointerId);
    hideHelpSoon();
    event.preventDefault();
  });
  const releaseJump = event => {
    if (jumpButton.hasPointerCapture?.(event.pointerId)) jumpButton.releasePointerCapture(event.pointerId);
    jumpButton.classList.remove('is-active');
    input.jumpHeld = false;
  };
  jumpButton.addEventListener('pointerup', releaseJump);
  jumpButton.addEventListener('pointercancel', releaseJump);

  canvas.addEventListener('pointerdown', () => {
    canvas.focus({ preventScroll: true });
    hideHelpSoon();
  });
  document.getElementById('helpButton').addEventListener('click', () => {
    const help = document.getElementById('help');
    help.classList.toggle('is-hidden');
  });

  let helpTimer = 0;
  function hideHelpSoon() {
    clearTimeout(helpTimer);
    helpTimer = setTimeout(() => document.getElementById('help').classList.add('is-hidden'), 1300);
  }

  window.addEventListener('message', event => {
    const trustedParent = event.source === window.parent && (!parentOrigin || event.origin === parentOrigin);
    if (event.data?.type === 'bcd:encore:init') {
      if (!trustedParent || disposed) return;
      parentOrigin = event.origin;
      const name = typeof event.data.payload?.playerName === 'string' ? event.data.payload.playerName.trim().slice(0, 32) : '';
      game.playerName = name || 'Climber';
      // Repeat handshakes and account renames refresh the existing room.
      if (game.room && game.room.player.name !== game.playerName) {
        game.room.player.name = game.playerName;
        game.room.track();
      }
      connectRoom(event.data.payload || {});
    }
    if (trustedParent && event.data?.type === 'bcd:encore:command' && event.data.payload?.command === 'close') {
      shutdown().finally(() => window.parent.postMessage({ type: 'bcd:encore:disposed' }, event.origin));
    }
    if (trustedParent && event.data?.type === 'bcd:encore:diagnostics:request') {
      const report = diagnosticReport();
      resetDiagnostics();
      window.parent.postMessage(report, event.origin);
    }
  });

  let shutdownPromise;
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    disposed = true;
    cancelAnimationFrame(animationFrame);
    clearTimeout(helpTimer);
    shutdownPromise = Promise.resolve(game.room?.leave()).catch(() => {});
    return shutdownPromise;
  }
  window.addEventListener('pagehide', () => { shutdown(); });

  window.render_game_to_text = () => JSON.stringify({
    buildVersion: BUILD_VERSION,
    disposed,
    coordinateSystem: 'origin top-left; x increases right; y increases down; world units are pixels',
    mode: game.mode,
    world: WORLD,
    camera: { x: Math.round(game.camera.x), y: Math.round(game.camera.y), width: VIEW.width, height: VIEW.height },
    player: {
      name: game.playerName,
      x: Math.round(game.player.x),
      y: Math.round(game.player.y),
      vx: Number(game.player.vx.toFixed(2)),
      vy: Number(game.player.vy.toFixed(2)),
      grounded: Boolean(game.player.grounded),
      clinging: game.player.clinging,
      crouching: game.player.crouching,
      lookingUp: game.player.lookingUp,
      facing: game.player.facing,
      animation: game.player.animation,
      character: game.loadout.character === 'p2' ? 'P2' : 'Ash',
      color: game.loadout.color,
      health: game.player.health,
      alive: game.player.alive,
      respawnTimer: game.player.respawnTimer,
      rigAnimation: activePlayerRig()?.currentAnimation || null,
      shooting: game.player.shootTimer > 0,
      aiming: game.player.aiming,
      aim: { x: Number(game.player.aimX.toFixed(2)), y: Number(game.player.aimY.toFixed(2)) },
      melee: game.player.meleeTimer > 0,
      meleeDirection: game.player.meleeDirection,
      dashing: game.player.dashTimer > 0,
      dashCooldown: game.player.dashCooldown,
      section: Math.min(3, Math.floor(game.player.x / VIEW.width) + 1)
    },
    bot: game.bot ? {
      character: botRig?.ready ? 'Player2' : 'Programmatic fallback',
      x: Math.round(game.bot.x),
      y: Math.round(game.bot.y),
      health: game.bot.health,
      alive: game.bot.alive,
      respawnTimer: game.bot.respawnTimer,
      animation: game.bot.animation,
      melee: game.bot.meleeTimer > 0,
      meleeDirection: game.bot.meleeDirection,
      rigAnimation: botRig?.currentAnimation || null
    } : null,
    creatures: game.creatures.map(creature => {
      const rig = creatureRigs.get(creature.id);
      return {
        id: creature.id,
        type: creature.type,
        x: Math.round(creature.x),
        y: Math.round(creature.y),
        health: creature.health,
        alive: creature.alive,
        respawnTimer: creature.respawnTimer,
        animation: creature.animation,
        rigAnimation: rig?.currentAnimation || null
      };
    }),
    projectiles: game.projectiles.map(note => ({ owner: note.owner, x: Math.round(note.x), y: Math.round(note.y), vx: Number(note.vx.toFixed(2)), vy: Number(note.vy.toFixed(2)) })),
    movingPlatforms: game.movers.map(m => ({ id: m.id, x: Math.round(m.x), y: Math.round(m.y), width: m.w, height: m.h, kind: m.kind })),
    deaths: game.deaths,
    botKnockouts: game.kills,
    creatureKnockouts: game.creatureKills,
    hearts: (game.hearts || []).map(heart => ({ id:heart.id, x:heart.x, y:heart.y })),
    room: { players: game.roomCount, connected: Boolean(game.room?.connected), authoritative: Boolean(game.room?.authoritative), tick: game.room?.tick ?? null, epoch: game.room?.epoch ?? null, remotes: [...game.remotePlayers.values()].map(player => ({ id:player.id, name:player.name, x:Math.round(player.x), y:Math.round(player.y), health:player.health, alive:player.alive, animation:player.animation })) },
    captureZones: CAPTURE_ZONES.map(zone => {
      const captured = game.capturedZones.get(zone.id);
      const colors = { ...(game.captureProgressByColor?.get(zone.id) || {}) };
      colors[game.loadout.color] = Math.max(colors[game.loadout.color] || 0, game.captureProgress.get(zone.id) || 0);
      return { id:zone.id, color:captured?.color || null, progress:Math.round((game.captureProgress.get(zone.id) || 0) / 1.8), progressByColor:Object.fromEntries(Object.entries(colors).map(([color, frames]) => [color, Math.round(Math.max(0, Math.min(100, frames / 1.8)))])), contested:game.captureContested?.has(zone.id) || false, capturedBy:captured?.contributors?.map(member => member.name) || [] };
    })
  });

  // Local-only deterministic combat hooks keep production closed while the
  // browser QA loop can verify every creature's death and respawn lifecycle.
  if (localAdminPreview) {
    window.__celestefallTest = {
      damageCreature(id, amount = 1) {
        const creature = game.creatures.find(enemy => enemy.id === id);
        return creature ? damageCreature(creature, amount, 0, 0) : false;
      },
      setPlayerPosition(x, y) {
        game.player.x = x;
        game.player.y = y;
        game.player.vx = 0;
        game.player.vy = 0;
        updateCamera(true);
      },
      hitPlayer(amount = 1) {
        let result = false;
        for (let index = 0; index < amount; index += 1) {
          game.player.invulnerable = 0;
          result = hitPlayer(-2, -2.5) || result;
        }
        return result;
      },
      setColor(color) {
        setLoadout(game.loadout.character, color);
      },
      captureZone(id) {
        const zone = CAPTURE_ZONES.find(candidate => candidate.id === id);
        if (!zone) return false;
        game.player.invulnerable = 999;
        // Keep the player inside only for deterministic QA; live capture is
        // still driven one frame at a time by normal physics above.
        for (let frame = 0; frame < CAPTURE_FRAMES; frame += 1) {
          game.player.x = zone.x + zone.w / 2;
          game.player.y = zone.y + zone.h / 2;
          updateCaptureZones();
        }
        return true;
      }
    };
  }

  window.advanceTime = milliseconds => {
    const steps = Math.max(1, Math.round(milliseconds / (1000 / 60)));
    for (let i = 0; i < steps; i += 1) update();
    render();
  };

  function frame(now) {
    if (disposed) return;
    const frameStarted = performance.now();
    if (!frame.last) frame.last = now;
    if (diagnostics.lastFrameAt) {
      const gap = now - diagnostics.lastFrameAt;
      diagnostics.maxStallMs = Math.max(diagnostics.maxStallMs, gap);
      if (gap > (1000 / (TOUCH_PRESENTATION ? 15 : 60)) * 1.5) diagnostics.droppedFrameCount++;
    }
    diagnostics.lastFrameAt = now;
    diagnostics.frameCount++;
    frame.accumulator = Math.min(.1, (frame.accumulator || 0) + (now - frame.last) / 1000);
    frame.last = now;
    let steps = 0;
    const updateStarted = performance.now();
    while (frame.accumulator >= STEP && steps < 2) {
      update();
      frame.updateCount = (frame.updateCount || 0) + 1;
      frame.accumulator -= STEP;
      steps += 1;
    }
    diagnostics.totalUpdateMs += performance.now() - updateStarted;
    // Presentation is independent from fixed simulation. Rendering only when
    // a physics step lands can skip alternating 60 Hz frames due to fractional
    // clock deltas; cap high-refresh displays at 60 instead of painting twice.
    if (!frame.lastRender || now - frame.lastRender >= RENDER_INTERVAL_MS - .5) {
      const renderStarted = performance.now();
      render();
      diagnostics.totalRenderMs += performance.now() - renderStarted;
      diagnostics.presentedCount++;
      frame.renderCount = (frame.renderCount || 0) + 1;
      frame.lastRender = now;
    }
    // Never enter an unbounded catch-up spiral after a suspended/backgrounded
    // tab, but retain two steps so 30 Hz displays keep full-speed simulation.
    if (steps === 2 && frame.accumulator >= STEP) frame.accumulator = 0;
    const frameMs = performance.now() - frameStarted;
    diagnostics.totalFrameMs += frameMs;
    diagnostics.maxFrameMs = Math.max(diagnostics.maxFrameMs, frameMs);
    animationFrame = requestAnimationFrame(frame);
  }

  async function boot() {
    // Start physics and controls immediately. The high-resolution Spine rigs
    // can finish streaming without leaving the canvas or input loop inert.
    setupLoadoutControls();
    resetGame();
    if (window.parent === window && window.ENCORE_SERVER_URL) connectRoom({});
    else if (window.parent === window) setRoomStatus('OFFLINE PRACTICE', false);
    render();
    animationFrame = requestAnimationFrame(frame);

    const fallbackImages = Promise.all(Object.entries(imageSources).map(([key, source]) => new Promise(resolve => {
      const image = new Image();
      image.onload = () => { images[key] = image; resolve(); };
      image.onerror = () => resolve();
      image.src = window.encoreAssetUrl(source);
    })));
    const ashRig = ash?.load().catch(error => {
      ash.failed = true;
      console.error('Ash character failed to load; using the pirate fallback.', error);
    });
    const selectableBlueRig = playerTwoRig?.load().catch(error => {
      playerTwoRig.failed = true;
      console.error('Selectable Player 2 failed to load; custom fighters and Ash still work.', error);
    });
    const blueRig = botRig?.load().catch(error => {
      botRig.failed = true;
      console.error('Player 2 bot failed to load; using the programmatic fallback.', error);
    });
    const creatureLoads = [...creatureRigs.values()].filter(Boolean).map(rig => rig.load().catch(error => {
      rig.failed = true;
      console.error(`${rig.assetName} creature rig failed to load; using the programmatic fallback.`, error);
    }));
    await Promise.all([fallbackImages, ashRig, selectableBlueRig, blueRig, ...creatureLoads]);
    if (disposed) return;
    buildStaticRenderLayers();
    activePlayerRig()?.update(0, game.player.animation);
    botRig?.update(0, game.bot.animation);
    game.creatures.forEach(creature => creatureRigs.get(creature.id)?.update(0, creature.animation));
    render();
    window.parent?.postMessage({ type: 'bcd:encore:ready', version: BUILD_VERSION }, '*');
  }

  boot();
})();
