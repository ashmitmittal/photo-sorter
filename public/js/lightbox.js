import { $, esc, fmt, icon, media, wallDate, clock, avgColor, typeIcon, toast } from './util.js';
import { hexToCanvas } from './tiles.js';
import { menuOpen, closeMenu } from './ui.js';

const DATE_FROM = { exif: 'from the photo', video: 'from the video', name: 'from the file name', mtime: 'file date, may be off' };
const PLACE_FROM = { gps: 'from GPS', time: 'from a photo taken nearby in time', none: '' };
const DUP_REASON = { exact: 'Exact copy', similar: 'Re-saved copy', burst: 'Burst shot' };

export class Lightbox {
  constructor(app) {
    this.app = app;
    this.list = [];
    this.pos = 0;
    this.info = true;
    this.z = { s: 1, x: 0, y: 0 };
    this.el = document.createElement('div');
    this.el.className = 'lb';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.setAttribute('aria-label', 'Photo viewer');
    this.el.tabIndex = -1;
    this.el.innerHTML = `
      <div class="lb-top">
        <div class="lb-title"><b class="lb-name"></b><span class="lb-pos"></span></div>
        <div class="lb-actions">
          <button class="lb-btn" data-act="best" title="Best shot (B)"></button>
          <button class="lb-btn" data-act="move" title="Move to another folder (M)" aria-haspopup="menu">${icon('move')}<span>Move to</span></button>
          <button class="lb-btn" data-act="notdup" title="Not a duplicate (D)">${icon('restore')}<span>Not a duplicate</span></button>
          <span class="lb-zoomer"><button class="lb-icon" data-act="zoomout" aria-label="Zoom out">${icon('zoomout')}</button><span class="lb-zoom">Fit</span><button class="lb-icon" data-act="zoomin" aria-label="Zoom in">${icon('zoomin')}</button></span>
          <button class="lb-icon" data-act="info" aria-label="Info (I)" title="Info (I)">${icon('info')}</button>
          <button class="lb-icon" data-act="close" aria-label="Close (Esc)" title="Close (Esc)">${icon('x')}</button>
        </div>
      </div>
      <div class="lb-body">
        <div class="lb-stage">
          <div class="lb-media"></div>
          <button class="lb-nav prev" data-act="prev" aria-label="Previous">${icon('left')}</button>
          <button class="lb-nav next" data-act="next" aria-label="Next">${icon('right')}</button>
        </div>
        <aside class="lb-info"></aside>
      </div>`;
    document.body.append(this.el);
    this.stageEl = $('.lb-stage', this.el);
    this.mediaEl = $('.lb-media', this.el);
    this.infoEl = $('.lb-info', this.el);
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.onKey = this.onKey.bind(this);
    this.stageEl.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.stageEl.addEventListener('dblclick', (e) => {
      if (e.target.closest('.lb-nav') || !this.box) return;
      if (this.z.s > 1) this.zoomTo(1);
      else this.zoomAt(e.clientX, e.clientY, 2.5);
    });
    this.stageEl.addEventListener('pointerdown', (e) => this.onDown(e));
    addEventListener('resize', () => this.isOpen && this.fit());
  }

  get isOpen() {
    return !this.el.hidden;
  }

  get item() {
    return this.app.result().items[this.list[this.pos]];
  }

  open(list, pos) {
    this.list = list;
    this.pos = Math.max(0, Math.min(pos, list.length - 1));
    this.lastFocus = document.activeElement;
    this.el.hidden = false;
    document.documentElement.classList.add('lb-open');
    document.addEventListener('keydown', this.onKey, true);
    this.show();
    this.el.focus();
  }

  close() {
    if (!this.isOpen) return;
    closeMenu();
    this.el.hidden = true;
    this.mediaEl.replaceChildren();
    document.documentElement.classList.remove('lb-open');
    document.removeEventListener('keydown', this.onKey, true);
    this.app.onClose?.(this.list[this.pos]);
    this.lastFocus?.focus?.();
  }

  go(d) {
    const next = this.pos + d;
    if (next < 0 || next >= this.list.length) return;
    this.pos = next;
    this.show();
  }

  show() {
    const it = this.item;
    const r = this.app.result();
    this.z = { s: 1, x: 0, y: 0 };
    this.box = null;
    $('.lb-name', this.el).textContent = it.n;
    $('.lb-pos', this.el).textContent = `${fmt(this.pos + 1)} of ${fmt(this.list.length)}`;
    $('.lb-nav.prev', this.el).disabled = this.pos === 0;
    $('.lb-nav.next', this.el).disabled = this.pos === this.list.length - 1;
    this.el.classList.toggle('no-info', !this.info);
    this.mediaEl.replaceChildren();
    this.mediaEl.style.background = 'transparent';
    if (this.app.privacy()) {
      const c = hexToCanvas(it.t);
      c.className = 'lb-tile';
      const note = document.createElement('p');
      note.className = 'lb-note';
      note.innerHTML = `${icon('lock')} Privacy mode is on, so pictures stay hidden. Switch it off in the top bar to see the photo.`;
      this.mediaEl.append(c, note);
    } else if (it.k === 'v') {
      const v = document.createElement('video');
      v.className = 'lb-video';
      v.controls = true;
      v.autoplay = true;
      v.playsInline = true;
      v.poster = media.thumb(it);
      v.src = media.video(it);
      v.onerror = () => {
        const p = document.createElement('p');
        p.className = 'lb-note';
        p.textContent = 'This browser can’t play this video. It is still sorted; open the copy in QuickTime or VLC.';
        this.mediaEl.append(p);
      };
      this.mediaEl.append(v);
    } else {
      const box = document.createElement('div');
      box.className = 'lb-box';
      box.style.background = avgColor(it.t);
      const ph = new Image();
      ph.className = 'lb-ph';
      ph.alt = '';
      const full = new Image();
      full.className = 'lb-full';
      full.alt = it.n;
      full.decoding = 'async';
      ph.onload = () => {
        this.aspect = ph.naturalWidth / ph.naturalHeight;
        this.fit();
      };
      full.onload = () => {
        if (!this.aspect) {
          this.aspect = full.naturalWidth / full.naturalHeight;
          this.fit();
        }
        this.natural = full.naturalWidth;
        full.classList.add('in');
        this.preload();
      };
      full.onerror = () => toast('Couldn’t open the full-size photo.', { kind: 'warn' });
      this.aspect = 0;
      this.natural = 0;
      ph.src = media.thumb(it);
      full.src = media.full(it);
      box.append(ph, full);
      this.box = box;
      this.mediaEl.append(box);
    }
    this.renderActions(it);
    this.renderInfo(it, r);
    this.updateZoom();
  }

  preload() {
    const r = this.app.result();
    for (const d of [1, -1]) {
      const it = r.items[this.list[this.pos + d]];
      if (it && it.k === 'p') new Image().src = media.full(it);
    }
  }

  fit() {
    if (!this.box || !this.aspect) return;
    const W = this.stageEl.clientWidth - 48;
    const H = this.stageEl.clientHeight - 32;
    const w = Math.min(W, H * this.aspect);
    this.box.style.width = `${Math.round(w)}px`;
    this.box.style.height = `${Math.round(w / this.aspect)}px`;
    this.applyZoom();
  }

  maxZoom() {
    const w = this.box?.clientWidth || 1;
    return Math.max(4, ((this.natural || 0) / w) * 1.5);
  }

  zoomAt(px, py, s) {
    if (!this.box) return;
    const ns = Math.max(1, Math.min(this.maxZoom(), s));
    const r = this.stageEl.getBoundingClientRect();
    const dx = px - (r.left + r.width / 2);
    const dy = py - (r.top + r.height / 2);
    this.z.x = dx - ((dx - this.z.x) * ns) / this.z.s;
    this.z.y = dy - ((dy - this.z.y) * ns) / this.z.s;
    this.z.s = ns;
    if (ns === 1) this.z = { s: 1, x: 0, y: 0 };
    this.applyZoom();
  }

  zoomTo(s) {
    const r = this.stageEl.getBoundingClientRect();
    this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, s);
  }

  applyZoom() {
    if (this.box) {
      this.box.style.transform = `translate(${this.z.x}px, ${this.z.y}px) scale(${this.z.s})`;
      this.stageEl.classList.toggle('zoomed', this.z.s > 1);
    }
    this.updateZoom();
  }

  updateZoom() {
    const photo = Boolean(this.box);
    $('.lb-zoomer', this.el).hidden = !photo;
    $('.lb-zoom', this.el).textContent = this.z.s === 1 ? 'Fit' : `${Math.round(this.z.s * 100)}%`;
  }

  onWheel(e) {
    if (!this.box) return;
    e.preventDefault();
    this.zoomAt(e.clientX, e.clientY, this.z.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
  }

  onDown(e) {
    if (!this.box || this.z.s === 1 || e.button !== 0 || e.target.closest('.lb-nav')) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, zx: this.z.x, zy: this.z.y };
    this.stageEl.classList.add('dragging');
    const move = (ev) => {
      this.z.x = start.zx + ev.clientX - start.x;
      this.z.y = start.zy + ev.clientY - start.y;
      this.applyZoom();
    };
    const up = () => {
      this.stageEl.classList.remove('dragging');
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  renderActions(it) {
    const best = $('[data-act="best"]', this.el);
    best.innerHTML = `${icon('star')}<span>${it.b ? 'Best shot' : 'Mark as best'}</span>`;
    best.classList.toggle('on', Boolean(it.b));
    best.hidden = Boolean(it.x);
    $('[data-act="notdup"]', this.el).hidden = !it.x;
  }

  renderInfo(it, r) {
    const type = r.folders.type[it.ty]?.name || '';
    const keeper = it.x && it.dk >= 0 ? r.items[it.dk] : null;
    const dupIdx = it.x ? [] : r.items.map((x, i) => (x.dk === this.list[this.pos] ? i : -1)).filter((i) => i >= 0);
    const row = (label, value, sub = '') => `<div class="lbi-row"><dt>${label}</dt><dd>${value}${sub ? `<span>${esc(sub)}</span>` : ''}</dd></div>`;
    const thumb = (x, i, label) => `<button class="lbi-thumb" data-goto="${i}" title="${esc(x.n)}">${this.app.privacy() ? '' : `<img src="${media.thumb(x, 's')}" alt="">`}<span>${esc(label)}</span></button>`;
    this.infoEl.innerHTML = `
      <h4>Details</h4>
      <dl>
        ${row('Taken', esc(wallDate(it.ts) || 'Unknown'), DATE_FROM[it.tsrc] || '')}
        ${row('Day', esc(it.dl || ''))}
        ${row('Place', esc(it.pl || 'No location'), PLACE_FROM[it.ps] || '')}
        ${row('Type', `${icon(typeIcon(type))}${esc(it.x ? 'Duplicates' : type)}`, it.fx ? 'fixed by you' : '')}
        ${it.x ? '' : row('Best-shot score', it.sc ? `<b class="score">${it.sc}</b>/10` : '–', it.b ? 'in Best shots' : '')}
        ${it.k === 'v' ? row('Length', esc(clock(it.dur))) : ''}
        ${it.w && it.h ? row('Size', `${fmt(it.w)} × ${fmt(it.h)}`) : ''}
        ${row('Folder', esc(it.src || ''))}
      </dl>
      ${keeper ? `<h4>Duplicate of</h4><div class="lbi-dups">${thumb(keeper, it.dk, 'Kept copy')}</div><p class="muted small">${esc(DUP_REASON[it.dr] || 'Similar')}. Only the kept copy is in the other folders.</p>` : ''}
      ${dupIdx.length ? `<h4>Set aside as duplicates</h4><div class="lbi-dups">${dupIdx.slice(0, 8).map((i) => thumb(r.items[i], i, DUP_REASON[r.items[i].dr] || 'Similar')).join('')}</div>` : ''}
      <h4>Original file</h4>
      <code class="lbi-path" title="${esc(it.path)}">${esc(it.pd || it.path)}</code>
      <div class="lbi-btns"><button class="btn ghost sm" data-act="copypath">${icon('copy')} Copy path</button>
        ${this.app.canReveal() ? `<button class="btn ghost sm" data-act="reveal">${icon('external')} Show in Finder</button>` : ''}</div>
      <p class="muted small">The original is never changed. Fixes only move the sorted copies.</p>`;
  }

  update() {
    if (!this.isOpen) return;
    const it = this.item;
    if (!it) return this.close();
    $('.lb-name', this.el).textContent = it.n;
    this.renderActions(it);
    this.renderInfo(it, this.app.result());
    return undefined;
  }

  async onClick(e) {
    const b = e.target.closest('[data-act], [data-goto]');
    if (!b) {
      if (e.target === this.stageEl || e.target === this.mediaEl) this.close();
      return;
    }
    const it = this.item;
    if (b.dataset.goto !== undefined) {
      const i = Number(b.dataset.goto);
      const at = this.list.indexOf(i);
      if (at === -1) {
        this.list = [...this.list.slice(0, this.pos + 1), i, ...this.list.slice(this.pos + 1)];
        this.pos++;
      } else {
        this.pos = at;
      }
      this.show();
      return;
    }
    const act = b.dataset.act;
    if (act === 'close') this.close();
    else if (act === 'prev') this.go(-1);
    else if (act === 'next') this.go(1);
    else if (act === 'info') {
      this.info = !this.info;
      this.el.classList.toggle('no-info', !this.info);
      requestAnimationFrame(() => this.fit());
    } else if (act === 'zoomin') this.zoomTo(this.z.s * 1.5);
    else if (act === 'zoomout') this.zoomTo(this.z.s / 1.5);
    else if (act === 'best') await this.app.fix({ op: 'best', keys: [it.key], on: !it.b });
    else if (act === 'notdup') await this.app.fix({ op: 'notdup', keys: [it.key] });
    else if (act === 'move') this.app.moveMenu(b, [it.key]);
    else if (act === 'copypath') {
      try {
        await navigator.clipboard.writeText(it.path);
        toast('Path copied');
      } catch {
        toast(it.path);
      }
    } else if (act === 'reveal') this.app.reveal(it.key);
  }

  onKey(e) {
    if (menuOpen() || document.querySelector('dialog[open]')) return;
    const it = this.item;
    const k = e.key;
    let handled = true;
    if (k === 'Escape') {
      if (this.z.s > 1) this.zoomTo(1);
      else this.close();
    } else if (k === 'ArrowLeft') this.go(-1);
    else if (k === 'ArrowRight') this.go(1);
    else if (k === '+' || k === '=') this.zoomTo(this.z.s * 1.5);
    else if (k === '-') this.zoomTo(this.z.s / 1.5);
    else if (k === '0') this.zoomTo(1);
    else if (k === 'i') $('[data-act="info"]', this.el).click();
    else if (k === 'b' && !it.x) this.app.fix({ op: 'best', keys: [it.key], on: !it.b });
    else if (k === 'd' && it.x) this.app.fix({ op: 'notdup', keys: [it.key] });
    else if (k === 'm') this.app.moveMenu($('[data-act="move"]', this.el), [it.key]);
    else if (/^[1-9]$/.test(k) && !e.metaKey && !e.ctrlKey) this.app.moveToNumber(Number(k), [it.key]);
    else if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'z') this.app.undo();
    else if (k === ' ' && it.k === 'v' && !this.app.privacy()) {
      const v = $('video', this.mediaEl);
      if (v) v.paused ? v.play() : v.pause();
    } else if (k === 'Tab') handled = false;
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}
