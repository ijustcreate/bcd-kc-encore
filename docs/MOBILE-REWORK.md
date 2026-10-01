# Mobile rendering build 1.3

The default touch/coarse-pointer renderer uses compiled animation sheets. Desktop
keeps Spine 3.7; `?renderer=baked` and `?renderer=spine` select either path explicitly.
The mobile document does not load Spine, JSON skeletons, original character
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

Physical acceptance: test build 1.3 on the affected iPhone both directly and from
BCD, including movement, three sword directions, shooting, bat deaths and color
changes. Target sustained 60 FPS with a practical 30 FPS floor over a ten-minute
session. Compare host rAF, game rAF and submissions; submission counts are not a
hardware measurement of displayed frames. If both clocks still stall, compare
the standalone route with the embedded route before changing the renderer again.

## Multiplayer work remaining

Current deployment remains offline practice until a verified authority endpoint
is configured. The existing server owns outcomes at 60 Hz and broadcasts at 15 Hz.
This rendering release does not add local prediction, input acknowledgement,
reconciliation, or buffered remote interpolation. Those require a shared movement
core and network latency tests, rather than increasing snapshot frequency. Test an
eight-player room with latency/jitter and reconnects before claiming mobile
multiplayer readiness.
