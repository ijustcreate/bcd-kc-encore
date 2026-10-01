# Rendering and multiplayer movement build 1.4

The default renderer uses compiled animation sheets on both phones and desktop.
Spine 3.7 remains available as a diagnostic comparison; `?renderer=baked` and `?renderer=spine` select either path explicitly.
The default document does not load Spine, JSON skeletons, original character
textures, or original high-resolution backgrounds. No mesh or recoloring work
runs during a mobile match. Available art is shared by actors using the same sheet.

`tools/bake-characters.cjs` compiles all 14 player clips, both characters, all eight
roster costume colors, and the bat/slug clips at 30 animation frames per second.
Frame rectangles retain offsets relative to the authored foot anchor (112,176).
Faces, hair, weapons and slash effects use the existing material replacement
rules. Clip sampling starts from setup pose and includes a non-looping clip's
terminal frame. One-shot clips hold that frame. Color changes load asynchronously;
stale requests cannot replace the most recently selected color.

The arena submits up to 60 frames per second. Compiled animation playback uses
elapsed time and is independent of submission frequency. Live Spine pose caching
also advances by actual elapsed time, fixing the former 0.1 second clamp that made
low-cadence animation slow down. Offline physics allows at most six fixed steps
per callback, sustaining full speed through 15 Hz scheduling without unbounded
catch-up after background suspension. The server simulation is unchanged.

The initial decoded baked character/background image area is approximately
6.36 MiB at four RGBA bytes per pixel, excluding the main/world canvas and browser
copies. The original source images occupied approximately 42.5 MiB before runtime
costume clones. Actual GPU/process memory is not measured by these calculations.

## Rebuild and validation

Install Playwright, then set `CODEX_PRIMARY_RUNTIME_NODE_MODULES` to the directory
containing its package. Optionally set `ENCORE_CHROMIUM` to a Chromium executable.

```
node tools/bake-characters.cjs
node tests/baked-character.browser.cjs
node --test tests/*.test.mjs
```

The browser regression runs standalone mobile, embedded mobile, and desktop. It
checks source-asset exclusion, actual arena submissions separately from rAF,
animation timing, ground offsets, asynchronous color races, P2 selection, bat
corpse rendering and pixel comparisons with the original Spine renderer. Desktop
emulation is a regression check, not a measurement of physical iPhone performance.

Physical acceptance: test build 1.4 on the affected iPhone both directly and from
BCD, including movement, three sword directions, shooting, bat deaths and color
changes. Target sustained 60 FPS with a practical 30 FPS floor over a ten-minute
session. Compare host rAF, game rAF and submissions; submission counts are not a
hardware measurement of displayed frames. If both clocks still stall, compare
the standalone route with the embedded route before changing the renderer again.

## Multiplayer motion

`player-movement.js` contains the shared collision/movement implementation used by
both authority and prediction. The browser predicts its local actor only. Server
snapshots acknowledge **consumed** input commands and include the fractional
movement, jump/dash and cooldown state needed for deterministic replay. The client
rebases on that state and replays only unacknowledged commands. Small corrections
fade visually; death, respawn, disconnect and epoch changes reset prediction.

Commands are generated at fixed 60 Hz and sent in bounded batches at 30 Hz. The
server consumes at most one command per simulation tick, rejects replayed command
numbers and bounds each input queue to 120 entries. Flooding commands cannot buy
simulation time. Profiles and positions supplied inside commands are ignored.
Legacy clients continue using held-button packets. Prediction is negotiated in
welcome, so updated clients remain compatible with an older deployed authority.

Remote players, bot, creatures, projectiles and hearts are presented from a bounded
snapshot buffer (100–200 ms adaptive delay). Positions interpolate; discrete
health and attack state remains authoritative. Teleports and respawns never slide
across the arena. Moving platforms under the predicted local actor use the matching
predicted movement timeline. Rendering restores the authoritative world after
its synchronous presentation pass. Remote fighters use the same compiled authored
art as the local fighter, with decoded sheets shared where possible.

Snapshot JSON is serialized once per room broadcast, rather than once per client.
Damage, kills, pickup ownership, AI, captures and respawn selection stay server-owned.

Validation:

```
node --test tests/*.test.mjs
node tests/baked-character.browser.cjs
node tests/authority-browser.mjs
node tests/prediction-browser.mjs
```

The network browser suite introduces ordered 70–110 ms one-way delay and jitter,
checks immediate local response before server receipt, acknowledgement convergence,
remote interpolation, eight-player rendering and reconnect into a full room.
These are desktop phone emulation checks; physical-device thermal and public
internet latency testing still requires the live server.

## Live deployment requirement

GitHub Pages publishes the client only. `authority-config.js` remains empty until
a persistent host with TLS/WebSocket support is deployed and publicly verified.
The updated Dockerfile includes the shared movement module. The server can be
built from the repository root:

```
docker build -f server/Dockerfile -t encore-authority .
docker run --rm -p 8787:8787 -e ALLOWED_ORIGINS=https://ijustcreate.github.io encore-authority
```

Terminate TLS at the host, forward `/encore` WebSocket upgrades, then configure the
verified `wss://HOST/encore` endpoint. Use exactly one replica. No paid resources
or hosting accounts are created by this release. An empty endpoint intentionally
retains offline practice rather than falsely presenting an online room.
