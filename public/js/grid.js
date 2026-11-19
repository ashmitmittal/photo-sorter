export class VirtualGrid {
  constructor(el, { count, size = 190, gap = 8, render }) {
    this.el = el;
    this.count = count;
    this.size = size;
    this.gap = gap;
    this.render = render;
    this.cells = new Map();
    this.pool = [];
    this.queued = false;
    this.onScroll = () => {
      if (this.queued) return;
      this.queued = true;
      requestAnimationFrame(() => {
        this.queued = false;
        this.update();
      });
    };
    addEventListener('scroll', this.onScroll, { passive: true });
    addEventListener('resize', this.onScroll);
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(el);
    this.layout();
  }

  layout() {
    const w = this.el.clientWidth || 800;
    const cols = Math.max(2, Math.floor((w + this.gap) / (this.size + this.gap)));
    const cell = (w - this.gap * (cols - 1)) / cols;
    const changed = cols !== this.cols || Math.abs(cell - (this.cell || 0)) > 0.5;
    this.cols = cols;
    this.cell = cell;
    this.rowH = cell + this.gap;
    this.el.style.height = `${Math.max(0, Math.ceil(this.count / cols) * this.rowH - this.gap)}px`;
    if (changed) for (const [i, c] of this.cells) this.place(i, c);
    this.update();
  }

  place(i, c) {
    c.style.width = `${this.cell}px`;
    c.style.height = `${this.cell}px`;
    c.style.transform = `translate(${(i % this.cols) * this.rowH}px, ${Math.floor(i / this.cols) * this.rowH}px)`;
  }

  update() {
    if (!this.el.isConnected) return this.destroy();
    const top = -this.el.getBoundingClientRect().top;
    const over = innerHeight * 0.75;
    const first = Math.max(0, Math.floor((top - over) / this.rowH)) * this.cols;
    const last = Math.min(this.count, Math.ceil((top + innerHeight + over) / this.rowH) * this.cols);
    for (const [i, c] of this.cells) {
      if (i < first || i >= last) {
        this.cells.delete(i);
        c.remove();
        this.pool.push(c);
      }
    }
    for (let i = first; i < last; i++) {
      if (this.cells.has(i)) continue;
      const c = this.pool.pop() || document.createElement('div');
      this.cells.set(i, c);
      this.place(i, c);
      this.render(i, c);
      this.el.append(c);
    }
    return undefined;
  }

  refresh() {
    for (const [i, c] of this.cells) this.render(i, c);
  }

  setCount(n) {
    this.count = n;
    for (const [i, c] of this.cells) {
      if (i >= n) {
        this.cells.delete(i);
        c.remove();
        this.pool.push(c);
      }
    }
    this.layout();
    this.refresh();
  }

  setSize(px) {
    this.size = px;
    this.layout();
  }

  scrollTo(i) {
    const r = this.el.getBoundingClientRect();
    const y = r.top + scrollY + Math.floor(i / this.cols) * this.rowH;
    const pad = 150;
    if (y < scrollY + pad) scrollTo({ top: y - pad });
    else if (y + this.cell > scrollY + innerHeight - 20) scrollTo({ top: y + this.cell - innerHeight + 40 });
  }

  cellAt(i) {
    return this.cells.get(i) || null;
  }

  destroy() {
    removeEventListener('scroll', this.onScroll);
    removeEventListener('resize', this.onScroll);
    this.ro.disconnect();
  }
}
