# BCD Encore Royale mobile performance acceptance criteria

Run `tests/baked-character.browser.cjs` before merging any rendering or
asset-loading change. See `MOBILE-REWORK.md` for the build workflow and physical
iPhone acceptance. The older `tests/mobile-performance.mjs` remains a
supplementary desktop emulation harness. Keep raw JSON and screenshots under
`output/performance/` out of Git.

| Area | Acceptance criterion |
| --- | --- |
| Phone orientation | At 390x844 portrait and 844x390 landscape, both normal and iframe runs render Ash, Player2, the four creature rigs, visible floor, and touch controls with no console errors. |
| High refresh | The arena targets 60 FPS even on a 120 Hz phone; refresh rate must not increase simulation speed. Target p95 render intervals of 20 ms in 60 FPS mode, with a practical sustained 30 FPS floor under thermal load. Desktop Chromium normally reports a 60 Hz cadence; use its `observedRefreshHz` field to label that result as a 60 Hz regression sample, not a high-refresh pass. |
| Startup/decode | DOM-ready plus all authored rigs loaded must complete without a long task over 100 ms on the target phone. Touch mode loads compiled sheets and native-size backgrounds; no original Spine source bundle is fetched. Actors sharing a sheet reuse its decoded image. Desktop live rigs share immutable source images. |
| Frame pacing | During five seconds of active arena simulation, no frame exceeds 50 ms and fewer than 2% of frames exceed 120% of the display-frame budget. |
| Long tasks and heap | The run records no more than one long task over 50 ms after startup, and used JS heap must settle (less than 10% growth over a second five-second run without changing costumes). |
| Iframe | `?embed=1` and a real iframe both set embedded layout, reserve the parent Close-button area, and preserve the same playable/rendered state as standalone. |
| Thermal and culling | Run the matrix three times consecutively on physical phones. The third run's p95 must not regress more than 20% from the first. Traversing all three chambers must retain offscreen culling and not create an increasing heap trend. |
| Authored-rig parity | Compare portrait screenshots for idle, run, jump, wall cling, forward/up/down sword, and creature attack/death. No source rig may fall back to a programmatic shape while its asset is available; costume color changes must leave face, hair, weapon, and slash art intact. |

The harness uses a desktop Chromium profile to catch regressions. It is not a
substitute for Safari/Chrome device measurements or thermal testing; record
those device results alongside the generated matrix before release.

## Desktop live-rig architecture

For the default touch renderer, the compiled-sheet architecture in
`MOBILE-REWORK.md` supersedes the following live-rig implementation.

The renderer is designed so device cost is bounded by what is visible, not by
the total room population:

1. **Shared source assets:** immutable Spine JSON, atlas text, and decoded
   bitmaps are fetched and decoded once per distinct character bundle. Each
   actor still owns its skeleton state, so animation and costume behavior stay
   independent.
2. **Pose and world compositing:** dense Spine meshes are cached into small
   pose canvases only when their timeline advances, while static arena art is
   composited into a world layer. Normal frames blit those prepared surfaces.
3. **Spatial remote simulation:** remote players live in 160px world cells.
   Rendering and projectile hit tests query only intersecting cells; capture
   occupancy is updated on incoming network state rather than scanning every
   player on every fixed tick. The visible remote draw budget prevents a dense
   crowd from stealing frame time from the local player.
