import { $, esc, fmt, icon, media, reducedMotion } from './util.js';
import { hexToCanvas } from './tiles.js';

const SPRITE = 96;
const TILE_SPRITE = 48;

function rounded(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.14);
  ctx.clip();
  draw(ctx, size);
  return c;
}

export class SpriteBank {
  constructor(privacy) {
    this.privacy = privacy;
    this.map = new Map();
    this.listeners = new Set();
    this.pending = false;
  }

  add(id, { t, key }) {
    if (!this.map.has(id)) this.map.set(id, { t, key, sprite: null, state: 0 });
  }

  has(id) {
    return this.map.has(id);
  }

  notify() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.listeners.forEach((fn) => fn());
    });
  }

  get(id) {
    const e = this.map.get(id);
    if (!e) return null;
    if (!e.sprite) {
      const tile = hexToCanvas(e.t);
      e.sprite = rounded(TILE_SPRITE, (ctx, s) => {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tile, 0, 0, s, s);
      });
    }
    if (!this.privacy && e.state === 0 && e.key) {
      e.state = 1;
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        if (this.privacy) return;
        e.sprite = rounded(SPRITE, (ctx, s) => {
          const m = Math.min(img.naturalWidth, img.naturalHeight);
          ctx.drawImage(img, (img.naturalWidth - m) / 2, (img.naturalHeight - m) / 2, m, m, 0, 0, s, s);
        });
        e.state = 2;
        this.notify();
      };
      img.onerror = () => { e.state = 3; };
      img.src = media.thumb({ key: e.key }, 's');
    }
    return e.sprite;
  }
}

function fibonacci(n) {
  const pts = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / Math.max(1, n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = golden * i;
    pts.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  return pts;
}

const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export class Stage {
  constructor(root, bank, { max = 280 } = {}) {
    this.root = root;
    this.bank = bank;
    this.slotEl = $('.sphere-slot', root);
    this.reduced = reducedMotion();
    this.points = fibonacci(max);
    this.slots = new Array(max).fill(null);
    this.where = new Map();
    this.waiting = [];
    this.flyers = [];
    this.queue = [];
    this.budget = 0;
    this.angle = 0.7;
    this.tilt = 0.32;
    this.last = performance.now();
    this.idleWaiters = [];
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage-canvas';
    root.append(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(root);
    this.resize();
    this.frame = this.frame.bind(this);
    this.raf = requestAnimationFrame(this.frame);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.root.clientWidth;
    this.h = this.root.clientHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const a = this.root.getBoundingClientRect();
    const b = (this.slotEl || this.root).getBoundingClientRect();
    this.cx = b.left - a.left + b.width / 2;
    this.cy = b.top - a.top + b.height / 2;
    this.R = Math.min(b.width, b.height) * 0.36;
  }

  clear() {
    this.slots.fill(null);
    this.where.clear();
    this.waiting = [];
  }

  fill(ids) {
    this.clear();
    const order = shuffle(this.slots.map((_, i) => i));
    const now = performance.now();
    ids.forEach((id, k) => {
      if (k < order.length) {
        this.slots[order[k]] = { id, born: now + (this.reduced ? -1e4 : Math.random() * 500) };
        this.where.set(id, order[k]);
      } else {
        this.waiting.push(id);
      }
    });
  }

  add(id) {
    if (this.where.has(id)) return;
    const free = [];
    for (let i = 0; i < this.slots.length; i++) if (!this.slots[i]) free.push(i);
    if (!free.length) {
      this.waiting.push(id);
      return;
    }
    const s = free[Math.floor(Math.random() * free.length)];
    this.slots[s] = { id, born: performance.now() };
    this.where.set(id, s);
  }

  project(p) {
    const ca = Math.cos(this.angle);
    const sa = Math.sin(this.angle);
    const x = p[0] * ca + p[2] * sa;
    const z1 = -p[0] * sa + p[2] * ca;
    const ct = Math.cos(this.tilt);
    const st = Math.sin(this.tilt);
    const y = p[1] * ct - z1 * st;
    const z = p[1] * st + z1 * ct;
    const persp = 3 / (3 - z);
    return { x: this.cx + x * this.R * persp, y: this.cy + y * this.R * persp, z, s: this.R * 0.2 * persp };
  }

  take(id) {
    const slot = this.where.get(id);
    if (slot !== undefined) {
      const pos = this.project(this.points[slot]);
      this.where.delete(id);
      this.slots[slot] = null;
      while (this.waiting.length) {
        const next = this.waiting.shift();
        if (this.where.has(next)) continue;
        this.slots[slot] = { id: next, born: performance.now() };
        this.where.set(next, slot);
        break;
      }
      return pos;
    }
    for (let tries = 0; tries < 8; tries++) {
      const pos = this.project(this.points[Math.floor(Math.random() * this.points.length)]);
      if (pos.z > 0) return pos;
    }
    return { x: this.cx, y: this.cy, z: 1, s: this.R * 0.2 };
  }

  launch(id, card, onLand = () => {}, dur = 900) {
    const from = this.take(id);
    const to = card?.target(this.root);
    if (!to || this.reduced) {
      onLand();
      return;
    }
    const lift = 30 + Math.random() * 70;
    this.flyers.push({
      id, from, to, t0: performance.now(), dur, onLand,
      cx: (from.x + to.x) / 2 + (Math.random() - 0.5) * 120,
      cy: Math.min(from.y, to.y) - lift,
    });
  }

  enqueue(id, card, onLand) {
    this.queue.push({ id, card, onLand });
  }

  flush() {
    for (const q of this.queue.splice(0)) {
      this.take(q.id);
      q.onLand();
    }
    for (const f of this.flyers.splice(0)) f.onLand();
  }

  idle(timeout = 6000) {
    if (!this.queue.length && !this.flyers.length) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
      setTimeout(() => {
        this.flush();
        resolve();
      }, timeout);
    });
  }

  frame(t) {
    if (!this.root.isConnected) return this.destroy();
    const dt = Math.min(64, t - this.last);
    this.last = t;
    if (!this.reduced) this.angle += dt * 0.00021;

    if (this.queue.length) {
      const rate = Math.min(260, Math.max(36, this.queue.length / 1.4));
      this.budget += (rate * dt) / 1000;
      const dur = this.queue.length > 200 ? 650 : 900;
      while (this.budget >= 1 && this.queue.length) {
        this.budget--;
        const q = this.queue.shift();
        this.launch(q.id, q.card, q.onLand, dur);
      }
    } else {
      this.budget = 0;
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    const drawn = [];
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s) continue;
      const p = this.project(this.points[i]);
      p.id = s.id;
      p.a = Math.min(1, Math.max(0, (t - s.born) / 450));
      drawn.push(p);
    }
    drawn.sort((a, b) => a.z - b.z);
    for (const p of drawn) {
      const img = this.bank.get(p.id);
      if (!img) continue;
      ctx.globalAlpha = p.a * (0.18 + 0.82 * ((p.z + 1) / 2) ** 1.3);
      ctx.drawImage(img, p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
    }
    ctx.globalAlpha = 1;

    const done = [];
    for (const f of this.flyers) {
      const raw = Math.min(1, (t - f.t0) / f.dur);
      const e = ease(raw);
      const u = 1 - e;
      const x = u * u * f.from.x + 2 * u * e * f.cx + e * e * f.to.x;
      const y = u * u * f.from.y + 2 * u * e * f.cy + e * e * f.to.y;
      const size = f.from.s + (f.to.s - f.from.s) * e + Math.sin(raw * Math.PI) * 10;
      const img = this.bank.get(f.id);
      if (img) {
        ctx.shadowColor = 'rgba(0,0,0,0.28)';
        ctx.shadowBlur = 10;
        ctx.shadowOffsetY = 4;
        ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
        ctx.shadowColor = 'transparent';
      }
      if (raw >= 1) done.push(f);
    }
    if (done.length) {
      this.flyers = this.flyers.filter((f) => !done.includes(f));
      done.forEach((f) => f.onLand());
    }
    if (!this.queue.length && !this.flyers.length && this.idleWaiters.length) this.idleWaiters.splice(0).forEach((fn) => fn());
    this.raf = requestAnimationFrame(this.frame);
    return undefined;
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.canvas.remove();
  }
}

export class FolderCard {
  constructor(parent, bank, { name, sub = '', iconName = 'folder', wide = false, rows = 2, cell = 36, stat = null, href = null }) {
    this.bank = bank;
    this.count = 0;
    this.rows = rows;
    this.cellSize = cell;
    this.recent = [];
    this.el = document.createElement(href ? 'a' : 'div');
    if (href) this.el.href = href;
    this.el.className = `fcard${wide ? ' wide' : ''}${stat !== null ? ' is-stat' : ''} enter`;
    this.el.innerHTML = `<div class="fcard-head"><span class="fcard-ic">${icon(iconName)}</span><div class="fcard-title"><b title="${esc(name)}">${esc(name)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>
      <span class="fcard-count">${stat !== null ? esc(stat) : '0'}</span></div>${stat === null ? `<canvas class="fcard-strip" style="height:${rows * (cell + 4) - 4}px"></canvas>` : ''}`;
    parent.append(this.el);
    this.countEl = $('.fcard-count', this.el);
    this.canvas = $('.fcard-strip', this.el);
    this.redraw = this.redraw.bind(this);
    if (this.canvas) bank.listeners.add(this.redraw);
    requestAnimationFrame(() => {
      this.layout();
      requestAnimationFrame(() => this.el.classList.remove('enter'));
    });
  }

  layout() {
    if (!this.canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 160;
    this.cols = Math.max(1, Math.floor((w + 4) / (this.cellSize + 4)));
    this.cell = (w - (this.cols - 1) * 4) / this.cols;
    this.cap = this.cols * this.rows;
    const h = Math.round(this.rows * (this.cell + 4) - 4);
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
  }

  target(root) {
    if (!this.canvas) {
      const a = this.el.getBoundingClientRect();
      const r = root.getBoundingClientRect();
      return { x: a.left - r.left + a.width / 2, y: a.top - r.top + a.height / 2, s: 24 };
    }
    if (!this.cell) this.layout();
    const b = this.canvas.getBoundingClientRect();
    const r = root.getBoundingClientRect();
    return { x: b.left - r.left + this.cell / 2, y: b.top - r.top + this.cell / 2, s: this.cell };
  }

  land(id, pulse = true) {
    this.count++;
    this.countEl.textContent = fmt(this.count);
    if (this.canvas && id !== null && id !== undefined) {
      this.recent.unshift(id);
      if (this.recent.length > 64) this.recent.length = 64;
      if (!this.queued) {
        this.queued = true;
        requestAnimationFrame(() => {
          this.queued = false;
          this.redraw();
        });
      }
    }
    if (pulse) {
      this.el.classList.add('hit');
      clearTimeout(this.t);
      this.t = setTimeout(() => this.el.classList.remove('hit'), 180);
    }
  }

  setCount(n) {
    this.count = n;
    this.countEl.textContent = fmt(n);
  }

  redraw() {
    if (!this.canvas || !this.el.isConnected) {
      if (this.canvas && !this.el.isConnected) this.bank.listeners.delete(this.redraw);
      return;
    }
    if (!this.cap) return;
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.recent.slice(0, this.cap).forEach((id, i) => {
      const img = this.bank.get(id);
      if (!img) return;
      const x = (i % this.cols) * (this.cell + 4);
      const y = Math.floor(i / this.cols) * (this.cell + 4);
      ctx.imageSmoothingEnabled = img.width > 60;
      ctx.drawImage(img, x, y, this.cell, this.cell);
    });
  }
}
