export function hexToCanvas(hex) {
  const n = Math.round(Math.sqrt(hex.length / 6));
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(n, n);
  for (let i = 0; i < n * n; i++) {
    img.data[i * 4] = parseInt(hex.substr(i * 6, 2), 16);
    img.data[i * 4 + 1] = parseInt(hex.substr(i * 6 + 2, 2), 16);
    img.data[i * 4 + 2] = parseInt(hex.substr(i * 6 + 4, 2), 16);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export class TileCanvas {
  constructor(canvas, { cell = null, maxCell = 28, minCell = 5 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.fixedCell = cell;
    this.maxCell = maxCell;
    this.minCell = minCell;
    this.tiles = [];
  }

  layout(n) {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 300;
    const h = this.canvas.clientHeight || 100;
    let cell = this.fixedCell;
    if (!cell) {
      cell = Math.max(this.minCell, Math.min(this.maxCell, Math.floor(Math.sqrt((w * h) / Math.max(1, n)))));
      while (cell > this.minCell && Math.floor(w / cell) * Math.floor(h / cell) < n) cell--;
    }
    this.cell = cell;
    this.cols = Math.max(1, Math.floor(w / cell));
    this.rows = Math.max(1, Math.floor(h / cell));
    this.cap = this.cols * this.rows;
    this.ox = Math.floor((w - this.cols * cell) / 2);
    this.oy = this.fixedCell ? 0 : Math.floor((h - Math.min(this.rows, Math.ceil(n / this.cols)) * cell) / 2);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.clear();
    return this;
  }

  pos(i) {
    return { x: this.ox + (i % this.cols) * this.cell, y: this.oy + Math.floor(i / this.cols) * this.cell };
  }

  gap() {
    return this.cell >= 10 ? 2 : 1;
  }

  draw(i, tile, alpha = 1) {
    if (i >= this.cap) return;
    const p = this.pos(i);
    this.ctx.clearRect(p.x, p.y, this.cell, this.cell);
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(tile, p.x, p.y, this.cell - this.gap(), this.cell - this.gap());
    this.ctx.globalAlpha = 1;
  }

  erase(i) {
    if (i >= this.cap) return;
    const p = this.pos(i);
    this.ctx.clearRect(p.x, p.y, this.cell, this.cell);
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.tiles = [];
  }

  push(tile) {
    this.tiles.push(tile);
    if (this.tiles.length > this.cap) {
      this.tiles.shift();
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.tiles.forEach((t, i) => this.draw(i, t));
    } else {
      this.draw(this.tiles.length - 1, tile);
    }
  }

  nextRect(root) {
    return this.rect(Math.min(this.tiles.length, this.cap - 1), root);
  }

  rect(i, root) {
    const b = this.canvas.getBoundingClientRect();
    const r = root.getBoundingClientRect();
    const p = this.pos(Math.min(i, this.cap - 1));
    return { x: b.left - r.left + p.x, y: b.top - r.top + p.y, size: this.cell - this.gap() };
  }
}
