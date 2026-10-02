# BCD KC Encore authority

Run a **single persistent Node 22+ process**. GitHub Pages serves only the game assets; Supabase Broadcast is no longer a gameplay authority or fallback. This server simulates every player, bot, bat, slug, platform, projectile, capture and heart. Clients send buttons/aim and profile changes, never positions, hits, health, kills, captures or drops.

```powershell
npm ci --prefix server
$env:ALLOWED_ORIGINS = 'https://ijustcreate.github.io'
node server/index.mjs
```

The listener uses `PORT` (default 8787) and `HOST` (default 0.0.0.0). Terminate TLS at the host/proxy, forward WebSocket upgrades on `/encore`, and expose `/health`. Set `docs/authority-config.js` to the verified `wss://HOST/encore` URL only after the server is live. A trusted BCD parent can instead supply `serverUrl` in the init payload. For local tests, `ws://127.0.0.1:PORT/encore` is accepted only on localhost pages.

No database or secret client key is required. Room admission and server-issued random resume tokens prevent clients from choosing another player's entity ID. Names are display labels supplied by the BCD launcher, not server-verified account claims. Do not use them for authorization or awards. The existing BCD achievement bridge is separate from room authority.

The blue AI fighter belongs to team `#4fa3ff`. It chooses only living, connected players of other colors; allied melee, stomps and projectiles cannot damage either side. Changing a player's color immediately changes targeting and damage eligibility. Bats and slugs remain hostile creatures.

For the Dell v1.5 update, fetch the latest `main`, preserve any local Windows runner configuration and test-path fixes, run `node --test tests/*.test.mjs`, and update the runner's actual deployed source directory. Restart only the authority process through its supervisor, leaving `cloudflared` running so the current Quick Tunnel URL stays available. Verify `/health`, one authority process, and blue-player immunity/red-player hostility through the public connection. An authority restart resets the match and reconnects clients. The browser assets update independently through GitHub Pages.

## Operational limits

- One replica/process; no cluster mode, horizontal autoscaling or overlapping deployments. Stop the old process before starting its replacement. Scaling beyond one process needs a room directory with exclusive ownership leases first.
- 60 Hz fixed simulation, 15 Hz complete snapshots, 30 Hz client input. WebSocket compression reduces repeated snapshot data on mobile connections; compression context and concurrency are bounded. Clients predict their local movement using shared collision code; damage, shared AI and pickup outcomes remain server-owned. Input commands run at 60 Hz and travel in bounded 30 Hz batches, with consumed-command acknowledgements for reconciliation. Remote positions interpolate between snapshots. Remote melee, facing, damage, health and death presentation derives from snapshots.
- Eight slots per room. Admission is first-come and never evicts existing players. Transient disconnections reserve a slot for 15 seconds; voluntary leave releases it immediately. Held input expires after 0.5 seconds without controls. A socket with no client traffic is closed after 10 seconds.
- Full snapshots support late join and reconnect without event-history replay. A server restart creates a new epoch and **resets the match**. Match state is currently in memory; there are no durable scores or match checkpoints.
- Slow sockets are disconnected before queuing large stale snapshots. Client status/remote indexes clear immediately on disconnect or rejection; online simulation freezes until a new server snapshot arrives.
- Max 32 rooms and bounded payload/message rates. Start with at least 512 MB RAM and profile actual concurrent room load before raising capacity. No hosting resource is automatically created by this repository.

Free Render can host a hobby demonstration with managed TLS, but it sleeps after 15 minutes without inbound traffic, cold starts in about a minute, and may restart at any time. Configure no payment method/spending controls to avoid overage charges; see https://render.com/docs/free. A continuously available deployment needs an existing host or an explicitly approved paid plan. Supabase hosted Edge Functions have a 150/400-second worker lifetime and are not a replacement for this process.

## Verification

```powershell
npm test --prefix server
node --test tests/heart-drops.test.mjs tests/corpse-physics.test.mjs
node tests/authority-browser.mjs
node tests/prediction-browser.mjs
```

The network suite uses real WebSocket clients and tests late joins, shared bot targeting, simultaneous lethal attacks, exactly one heart roll/kill credit, falling hearts, one pickup/one heal, death/respawn, reconnect, 8-slot admission/cleanup, forged/replayed inputs, profiles, same-player recolor and contested capture. The headless browser test covers desktop and mobile presentation, actual keyboard controls, snapshots, disabled client simulation, reconnect cleanup and rejection. Physical-phone FPS and public latency still require real-device verification after deployment.

The authority and online prediction share movement/collision rules in `docs/player-movement.js`. Server combat/outcomes live in `simulation.mjs`. Offline practice retains its existing client simulation. Pure respawn, corpse and heart helpers are shared where applicable.
