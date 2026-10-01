const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + '/playwright');
const root = path.resolve(__dirname, '../docs');
(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/embed') return res.end('<iframe style="width:100%;height:100vh;border:0" src="/?embed=1&admin=1"></iframe>');
    if (url.pathname === '/parity') return res.end('<script>window.encoreAssetUrl=x=>x</script><script src="/vendor/spine-3.7/spine-canvas.js"></script><script src="/ash-character.js"></script><script>window.LiveCharacter=BulletAgeCharacter</script><script src="/baked-character.js"></script>');
    const file = path.join(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', { '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.html': 'text/html', '.css': 'text/css' }[path.extname(file)] || 'text/plain');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.ENCORE_CHROMIUM || undefined, args: ['--no-sandbox'] });
  try {
    for (const mode of ['phone', 'embedded', 'desktop']) {
      const context = await browser.newContext({ viewport: { width: 428, height: 926 }, deviceScaleFactor: 3, isMobile: mode !== 'desktop', hasTouch: mode !== 'desktop' });
      const page = await context.newPage(), errors = [], requests = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('request', r => requests.push(r.url()));
      await page.addInitScript(() => {
        window.__ready = false; window.__renders = 0;
        addEventListener('message', e => { if (e.data?.type === 'bcd:encore:ready') window.__ready = true; });
        const draw = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (...args) { if (this.canvas.id === 'game' && args[0].width === 1920) window.__renders++; return draw.apply(this, args); };
      });
      await page.goto(base + (mode === 'embedded' ? '/embed' : '/?admin=1'));
      await page.waitForFunction(() => window.__ready);
      const frame = mode === 'embedded' ? page.frames()[1] : page.mainFrame();
      assert.equal(await frame.evaluate(() => JSON.parse(render_game_to_text()).buildVersion), '1.3');
      if (mode !== 'desktop') {
        assert.equal(await frame.evaluate(() => typeof spine), 'undefined');
        assert.equal(requests.some(url => /\/assets\/(ash|player2|bat|slug)\//.test(url)), false);
        assert.equal(requests.some(url => /\/assets\/tower-bg-/.test(url)), false);
        const result = await frame.evaluate(async () => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 224;
          const ctx = canvas.getContext('2d');
          const rig = new AshCharacter(ctx); await rig.load();
          rig.update(.5, 'idle');
          if (Math.abs(rig.time - .5) > .001) throw new Error('Animation clock slowed down');
          rig.update(0, 'run'); if (rig.time !== 0) throw new Error('New animation did not reset');
          for (const [state, clip] of Object.entries(rig.sheet.manifest.animations)) {
            rig.setState(state, true); rig.update(100, state);
            if (!clip.loop && rig.time !== clip.duration) throw new Error('One-shot did not hold its final frame');
            const frame = clip.frames[!clip.loop ? clip.frames.length - 1 : Math.min(clip.frames.length - 1, Math.floor(rig.time * 30 + 1e-6))];
            let args; const draw = ctx.drawImage.bind(ctx); ctx.drawImage = (...values) => { args = values; draw(...values); };
            rig.draw(112, 176, -1);
            if (args[5] !== frame[5] || args[6] !== frame[6]) throw new Error('Ground anchor mismatch');
          }
          rig.setTeamChroma('ash', '#65cf84'); rig.setTeamChroma('ash', '#f2c14e'); await rig.pendingColor;
          if (!rig.sheet.images[0].src.includes('/f2c14e/')) throw new Error('Stale color request won');
          const start = performance.now(), renderedBefore = window.__renders; let count = 0, gaps = [], last = start;
          await new Promise(resolve => { const tick = now => { count++; gaps.push(now - last); last = now; if (now - start < 2500) requestAnimationFrame(tick); else resolve(); }; requestAnimationFrame(tick); });
          return { rafFps: count / ((last - start) / 1000), submittedFps: (window.__renders - renderedBefore) / ((last - start) / 1000), maxGap: Math.max(...gaps), cache: BulletAgeCharacter.getAssetCacheStats() };
        });
        console.log(mode, JSON.stringify(result));
        assert.ok(result.rafFps > 45);
        assert.ok(result.submittedFps > 45);
        await frame.evaluate(() => {
          __celestefallTest.setPlayerPosition(520, 336);
          __celestefallTest.damageCreature('bat-west', 10);
        });
        await page.waitForTimeout(700);
        assert.equal(await frame.evaluate(() => JSON.parse(render_game_to_text()).creatures.find(c => c.id === 'bat-west').alive), false);
        // Exercise real loadout controls while animation and simulation run.
        await frame.locator('[data-character="p2"]').click();
        assert.equal(await frame.evaluate(() => JSON.parse(render_game_to_text()).player.character), 'P2');
        await page.screenshot({ path: `/tmp/encore-${mode}-v1.3.png` });
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
    const parity = await browser.newPage();
    await parity.goto(base + '/parity?renderer=baked');
    const comparison = await parity.evaluate(async () => {
      let compared = 0, maxError = 0, worst = '';
      for (const assetName of ['Ash', 'Player2']) for (const color of ['original', '65cf84']) {
        const options = { assetName, basePath: assetName === 'Ash' ? 'assets/ash' : 'assets/player2' };
        const canvases = [document.createElement('canvas'), document.createElement('canvas')];
        canvases.forEach(c => { c.width = c.height = 224; });
        const contexts = canvases.map(c => c.getContext('2d', { willReadFrequently: true }));
        const live = new LiveCharacter(contexts[0], options), baked = new BulletAgeCharacter(contexts[1], options);
        if (color !== 'original') for (const rig of [live, baked]) rig.setTeamChroma(assetName === 'Ash' ? 'ash' : 'p2', '#' + color);
        await Promise.all([live.load(), baked.load()]);
        live.state.data.defaultMix = 0;
        for (const [state, clip] of Object.entries(baked.sheet.manifest.animations)) for (const n of [0, Math.floor(clip.frames.length / 2), clip.frames.length - 1]) {
          live.skeleton.setToSetupPose(); live.setState(state, true); baked.setState(state, true);
          const time = Math.min(n / 30, clip.duration);
          live.update(0, state); live.draw(112, 176, 1);
          for (let i = 1; i <= n; i++) { live.update(Math.min(1 / 30, Math.max(0, clip.duration - (i - 1) / 30)), state); live.draw(112, 176, 1); }
          baked.update(time, state);
          contexts.forEach(ctx => ctx.clearRect(0, 0, 224, 224));
          live.draw(112, 176, 1); baked.draw(112, 176, 1);
          const a = contexts[0].getImageData(0, 0, 224, 224).data, b = contexts[1].getImageData(0, 0, 224, 224).data;
          let error = 0; for (let i = 0; i < a.length; i++) error += Math.abs(a[i] - b[i]);
          if (error / a.length > maxError) { maxError = error / a.length; worst = `${assetName}/${color}/${state}/${n}`; } compared++;
        }
      }
      return { compared, maxError, worst };
    });
    console.log('art parity', comparison);
    assert.ok(comparison.maxError < .1, 'Compiled art changed beyond pixel rounding');
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
