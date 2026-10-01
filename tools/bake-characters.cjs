// Run with CODEX_PRIMARY_RUNTIME_NODE_MODULES pointing to a Playwright install.
// Existing Spine 3.7 artwork is compiled once; no mesh renderer runs on phones.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + '/playwright');
const root = path.resolve(__dirname, '../docs');
const colors = ['original', 'e85d5d', '4fa3ff', '65cf84', 'f2c14e', 'b77bff', 'ef75b5', 'f28a4b', '4ed1c5'];
(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/bake') return res.end('<script>window.encoreAssetUrl=x=>x</script><script src="/vendor/spine-3.7/spine-canvas.js"></script><script src="/ash-character.js"></script>');
    const file = path.join(root, decodeURIComponent(pathname));
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ENCORE_CHROMIUM || undefined, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/bake`);
    for (const kind of ['Ash', 'Player2', 'bat', 'Slugger setup']) {
      for (const color of kind === 'Ash' || kind === 'Player2' ? colors : ['original']) {
        const result = await page.evaluate(async ({ kind, color }) => {
          const creature = kind === 'bat' || kind === 'Slugger setup';
          const options = kind === 'Ash' ? {} : kind === 'Player2' ? { assetName: kind, basePath: 'assets/player2' } : {
            assetName: kind, basePath: kind === 'bat' ? 'assets/bat' : 'assets/slug',
            scale: kind === 'bat' ? .12 : .14, skin: kind === 'bat' ? 'Bat' : 'Slug',
            animations: Object.fromEntries(['idle', 'run', 'attack', 'hit', 'death'].map(state => [state, { name: state === 'run' ? kind === 'bat' ? 'fly' : 'walk' : state, loop: state === 'idle' || state === 'run' }]))
          };
          const target = document.createElement('canvas');
          const rig = new BulletAgeCharacter(target.getContext('2d'), options);
          if (!creature && color !== 'original') rig.setTeamChroma(kind === 'Ash' ? 'ash' : 'p2', '#' + color);
          await rig.load();
          rig.state.data.defaultMix = 0;
          const pages = [], animations = {};
          let sheet, ctx, x = 1, y = 1, rowHeight = 0;
          function nextPage() {
            sheet = document.createElement('canvas'); sheet.width = sheet.height = 1024;
            ctx = sheet.getContext('2d'); ctx.imageSmoothingEnabled = false;
            pages.push(sheet); x = y = 1; rowHeight = 0;
          }
          nextPage();
          for (const [logical, config] of Object.entries(rig.animationMap)) {
            const duration = rig.skeleton.data.findAnimation(config.name).duration;
            const count = Math.max(1, Math.ceil(duration * 30) + (config.loop ? 0 : 1));
            const frames = [];
            // Clips are compiled independently, without state left by a sword
            // clip hiding the pistol or a preceding run pose moving bones.
            rig.skeleton.setToSetupPose();
            rig.setState(logical, true);
            for (let i = 0; i < count; i++) {
              rig.update(i ? Math.min(1 / 30, Math.max(0, duration - (i - 1) / 30)) : 0, logical);
              rig.draw(0, 0, 1);
              const source = rig.poseCanvas, pixels = rig.poseContext.getImageData(0, 0, source.width, source.height).data;
              let left = source.width, top = source.height, right = -1, bottom = -1;
              for (let py = 0; py < source.height; py++) for (let px = 0; px < source.width; px++) {
                if (!pixels[(py * source.width + px) * 4 + 3]) continue;
                left = Math.min(left, px); top = Math.min(top, py); right = Math.max(right, px); bottom = Math.max(bottom, py);
              }
              if (right < 0) { left = top = 0; right = bottom = 0; }
              const w = right - left + 1, h = bottom - top + 1;
              if (x + w + 1 > 1024) { x = 1; y += rowHeight + 2; rowHeight = 0; }
              if (y + h + 1 > 1024) nextPage();
              ctx.drawImage(source, left, top, w, h, x, y, w, h);
              frames.push([pages.length - 1, x, y, w, h, left - rig.poseAnchor.x, top - rig.poseAnchor.y]);
              x += w + 2; rowHeight = Math.max(rowHeight, h);
            }
            animations[logical] = { duration, loop: config.loop, frames };
          }
          return { animations, pages: pages.map(p => {
            const pixels = p.getContext('2d').getImageData(0, 0, 1024, 1024).data;
            let right = 0, bottom = 0;
            for (let py = 0; py < 1024; py++) for (let px = 0; px < 1024; px++) {
              if (pixels[(py * 1024 + px) * 4 + 3]) { right = Math.max(right, px); bottom = Math.max(bottom, py); }
            }
            const trimmed = document.createElement('canvas');
            trimmed.width = right + 2; trimmed.height = bottom + 2;
            trimmed.getContext('2d').drawImage(p, 0, 0);
            return trimmed.toDataURL('image/png').split(',')[1];
          }) };
        }, { kind, color });
        const id = kind === 'Slugger setup' ? 'slug' : kind.toLowerCase();
        const directory = path.join(root, 'assets/baked', id, color);
        fs.mkdirSync(directory, { recursive: true });
        result.pages.forEach((bytes, i) => fs.writeFileSync(path.join(directory, `${i}.png`), Buffer.from(bytes, 'base64')));
        fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ fps: 30, pages: result.pages.map((_, i) => `${i}.png`), animations: result.animations }));
        console.log(`${id}/${color}: ${result.pages.length} pages`);
      }
    }
    // Match the game's native background sampling during compilation, keeping
    // 1672x941 source art out of the phone's decoded texture working set.
    for (const section of ['left', 'center', 'right']) {
      const png = await page.evaluate(async section => {
        const image = new Image(); image.src = `/assets/tower-bg-${section}.png`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
        ctx.drawImage(image, 0, 0, 640, 360);
        return canvas.toDataURL('image/png').split(',')[1];
      }, section);
      fs.writeFileSync(path.join(root, `assets/baked/tower-bg-${section}.png`), Buffer.from(png, 'base64'));
    }
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
