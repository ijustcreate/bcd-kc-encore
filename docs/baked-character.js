(() => {
  'use strict';
  const requested = new URLSearchParams(location.search).get('renderer');
  const enabled = requested === 'baked' || (requested !== 'spine' && navigator.maxTouchPoints > 0 && window.matchMedia?.('(pointer: coarse)').matches);
  window.ENCORE_BAKED_RENDERER = enabled;
  if (!enabled) return;

  // Share decoded sheets across actors. Keep only original + the current color
  // for each character; repeatedly changing colors must not retain eight sets.
  const assets = new Map();
  const colors = new Set(['e85d5d', '4fa3ff', '65cf84', 'f2c14e', 'b77bff', 'ef75b5', 'f28a4b', '4ed1c5']);
  function loadSheet(id, color) {
    const key = `${id}/${color}`;
    if (!assets.has(key)) {
      const base = `assets/baked/${key}/`;
      const promise = fetch(window.encoreAssetUrl(base + 'manifest.json')).then(response => {
        if (!response.ok) throw new Error(`Animation sheet missing: ${key}`);
        return response.json();
      }).then(async manifest => {
        const images = await Promise.all(manifest.pages.map(file => new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = async () => { try { await image.decode?.(); resolve(image); } catch (error) { reject(error); } };
          image.onerror = () => reject(new Error(`Animation image missing: ${base}${file}`));
          image.src = window.encoreAssetUrl(base + file);
        })));
        return { manifest, images };
      });
      assets.set(key, promise);
      promise.catch(() => { if (assets.get(key) === promise) assets.delete(key); });
    }
    return assets.get(key);
  }

  const Original = window.BulletAgeCharacter;
  class BakedCharacter extends Original {
    constructor(context, options = {}) {
      super(context, options);
      this.baked = true;
      this.sheet = null;
      this.time = 0;
      this.colorRevision = 0;
      this.id = this.assetName === 'Slugger setup' ? 'slug' : this.assetName.toLowerCase();
    }
    colorKey() {
      const key = (this.teamChroma?.color || '').replace('#', '');
      return colors.has(key) && (this.id === 'ash' || this.id === 'player2') ? key : 'original';
    }
    async load() {
      // Color can change while initial sheets are streaming. Never install an
      // obsolete request or start a live Spine fallback after an asset error.
      do {
        const color = this.colorKey();
        const sheet = await loadSheet(this.id, color);
        if (color !== this.colorKey()) continue;
        this.sheet = sheet;
        break;
      } while (true);
      this.ready = true;
      this.setState('idle', true);
      return this;
    }
    setState(logicalState, immediate = false) {
      const state = this.sheet?.manifest.animations[logicalState] ? logicalState : 'idle';
      if (!immediate && this.currentState === state) return;
      this.currentState = state;
      this.currentAnimation = this.animationMap[state]?.name || state;
      this.time = 0;
    }
    update(delta, logicalState) {
      if (!this.ready) return;
      this.setState(logicalState);
      const clip = this.sheet.manifest.animations[this.currentState];
      this.time += Math.max(0, delta);
      this.time = clip.loop && clip.duration > 0 ? this.time % clip.duration : Math.min(this.time, clip.duration);
    }
    setTeamChroma(source, color) {
      const previous = this.colorKey();
      this.teamChroma = { source, color: String(color).toLowerCase() };
      const next = this.colorKey();
      if (this.ready && previous !== next) {
        const revision = ++this.colorRevision;
        this.pendingColor = loadSheet(this.id, next).then(sheet => {
          if (revision !== this.colorRevision) return;
          this.sheet = sheet;
          // Live actor references keep active sheets alive; cache only needs
          // the most recently requested color to avoid unlimited GPU memory.
          for (const key of assets.keys()) if (key.startsWith(this.id + '/') && key !== `${this.id}/${next}`) assets.delete(key);
        }).catch(error => console.error('Could not change character color; keeping the loaded sheet.', error));
      }
      return { ...this.palette };
    }
    currentFrame() {
      const clip = this.sheet.manifest.animations[this.currentState];
      const index = !clip.loop && this.time >= clip.duration ? clip.frames.length - 1
        : Math.min(clip.frames.length - 1, Math.floor(this.time * this.sheet.manifest.fps + 1e-6));
      return clip.frames[index];
    }
    visibleBottom() {
      const frame = this.currentFrame();
      return frame[6] + frame[4];
    }
    draw(x, y, facing, stretch = 1, squash = 1) {
      if (!this.ready) return;
      const [page, sx, sy, w, h, ox, oy] = this.currentFrame();
      const ctx = this.context;
      ctx.save();
      ctx.translate(Math.round(x), Math.round(y));
      ctx.scale(facing * stretch, squash);
      // Trimmed frame offsets are relative to the same authored ground anchor.
      ctx.drawImage(this.sheet.images[page], sx, sy, w, h, ox, oy, w, h);
      ctx.restore();
    }
  }
  BakedCharacter.getAssetCacheStats = () => ({ entries: assets.size });
  window.BulletAgeCharacter = BakedCharacter;
  window.AshCharacter = class extends BakedCharacter {
    constructor(context) { super(context, { assetName: 'Ash', basePath: 'assets/ash' }); }
  };
})();
