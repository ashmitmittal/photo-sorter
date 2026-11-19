import { $, $$, fmt, typeIcon, reducedMotion } from './util.js';
import { Stage, FolderCard } from './sphere.js';

const MAX_CARDS = 12;
const CHAPTERS = [
  { key: 'type', title: 'What’s in them', short: 'Type' },
  { key: 'day', title: 'Which day', short: 'Day' },
  { key: 'place', title: 'Where', short: 'Place' },
  { key: 'best', title: 'Best shots', short: 'Best' },
];

const shuffled = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export class Showcase {
  constructor(root, data, bank) {
    this.root = root;
    this.data = data;
    this.bank = bank;
    data.items.forEach((it, i) => bank.add(i, it));
    this.run = 0;
    this.playing = false;
    root.innerHTML = `<div class="sc">
      <div class="sc-side">
        <div class="sc-top">
          <div class="sc-num">0</div>
          <div class="sc-label">photos sorted <span class="sc-chip" hidden></span></div>
        </div>
        <div class="sphere-slot"></div>
        <div class="sc-chapter"><span class="sc-chapter-title"></span><span class="sc-chapter-sub"></span></div>
        <div class="sc-steps">${CHAPTERS.map((c) => `<span data-k="${c.key}">${c.short}</span>`).join('')}</div>
      </div>
      <div class="sc-grid"></div>
    </div>`;
    this.sc = $('.sc', root);
    this.grid = $('.sc-grid', root);
    this.num = $('.sc-num', root);
    this.chip = $('.sc-chip', root);
    this.stage = new Stage(this.sc, bank);
    this.cards = [];
  }

  cancelled(token) {
    return token !== this.run;
  }

  wait(ms, token) {
    return new Promise((resolve, reject) => setTimeout(() => (this.cancelled(token) ? reject(new Error('cancel')) : resolve()), ms));
  }

  series(list, spanMs, flightMs, token, launch) {
    return new Promise((resolve, reject) => {
      if (!list.length) return resolve();
      const t0 = performance.now();
      const stagger = list.length > 1 ? Math.max(0, spanMs - flightMs) / (list.length - 1) : 0;
      const landings = [];
      let i = 0;
      const tick = () => {
        if (this.cancelled(token)) return reject(new Error('cancel'));
        const elapsed = performance.now() - t0;
        while (i < list.length && i * stagger <= elapsed) landings.push(launch(list[i++], flightMs));
        if (i < list.length) requestAnimationFrame(tick);
        else Promise.all(landings).then(resolve);
        return undefined;
      };
      tick();
      return undefined;
    });
  }

  fly(id, card, dur, token, after) {
    return new Promise((resolve) => {
      this.stage.launch(id, card, () => {
        if (!this.cancelled(token)) after?.();
        resolve();
      }, dur);
    });
  }

  setChapter(key, sub = '') {
    const c = CHAPTERS.find((x) => x.key === key);
    const t = $('.sc-chapter-title', this.root);
    t.textContent = c ? c.title : key;
    t.classList.remove('swap');
    void t.offsetWidth;
    t.classList.add('swap');
    $('.sc-chapter-sub', this.root).textContent = sub;
    const idx = CHAPTERS.findIndex((x) => x.key === key);
    $$('.sc-steps span', this.root).forEach((s, i) => {
      s.classList.toggle('on', i === idx);
      s.classList.toggle('done', i < idx);
    });
  }

  setCounter(photos, videos) {
    this.num.textContent = fmt(photos);
    this.chip.hidden = !videos;
    this.chip.textContent = `+ ${fmt(videos)} video${videos === 1 ? '' : 's'}`;
  }

  folders(kind) {
    const f = this.data.folders;
    const items = this.data.items;
    let list;
    if (kind === 'type') {
      const used = new Set(items.map((it) => it.ty));
      list = f.type.map((x, i) => ({ name: x.name, iconName: typeIcon(x.name), i })).filter((x) => used.has(x.i));
    } else if (kind === 'day') {
      list = f.day.map((x, i) => ({ name: x.name, sub: x.sub, iconName: 'day', i }));
    } else {
      list = f.place.map((x, i) => ({ name: x.name, iconName: 'pin', i }));
    }
    const slot = new Map(list.map((x, k) => [x.i, Math.min(k, MAX_CARDS - 1)]));
    if (list.length <= MAX_CARDS) return { shown: list, slotOf: (i) => slot.get(i) };
    const rest = list.length - (MAX_CARDS - 1);
    return {
      shown: [...list.slice(0, MAX_CARDS - 1), { name: `${rest} more ${kind === 'day' ? 'days' : kind === 'place' ? 'places' : 'folders'}`, iconName: 'more' }],
      slotOf: (i) => slot.get(i),
    };
  }

  showCards(specs) {
    this.grid.replaceChildren();
    this.cards = specs.map((s) => new FolderCard(this.grid, this.bank, s));
  }

  async scene(kind, ids, spanMs, flightMs, token, count) {
    const { shown, slotOf } = this.folders(kind);
    if (kind !== 'type') {
      this.showCards(shown);
      this.stage.fill(ids);
      await this.wait(450, token);
    }
    const key = kind === 'type' ? 'ty' : kind === 'day' ? 'd' : 'p';
    await this.series(ids, spanMs, flightMs, token, (id, dur) => {
      const it = this.data.items[id];
      const card = this.cards[slotOf(it[key])];
      return this.fly(id, card, dur, token, () => {
        card?.land(id);
        if (count) {
          this.counts[it.k]++;
          this.setCounter(this.counts.p, this.counts.v);
        }
      });
    });
  }

  finaleCards() {
    const t = this.data.totals;
    const v = this.data.verified;
    this.showCards([
      { name: 'Best shots', iconName: 'star', wide: true, rows: 3, cell: 44 },
      { name: 'Duplicates', iconName: 'dup' },
      { name: 'Days', iconName: 'day', stat: fmt(t.days) },
      { name: 'Places', iconName: 'pin', stat: fmt(t.places) },
      { name: 'Copies made', iconName: 'copy', stat: fmt(t.copies) },
      { name: 'Originals changed', iconName: 'shield', stat: v ? fmt(v.changed) : '0' },
    ]);
  }

  async play() {
    if (reducedMotion()) return this.skip();
    this.run++;
    const token = this.run;
    this.playing = true;
    this.root.classList.add('playing');
    const d = this.data;
    const all = d.items.map((_, i) => i);
    const kept = all.filter((i) => !d.items[i].x);
    this.counts = { p: 0, v: 0 };
    this.setCounter(0, 0);
    try {
      this.setChapter('type', `${fmt(d.totals.files)} files`);
      this.showCards(this.folders('type').shown);
      const order = shuffled(all);
      this.stage.fill(order);
      await this.wait(1100, token);
      this.setChapter('type', 'labelled');
      await this.scene('type', order, 6500, 900, token, true);
      this.setChapter('day', `${fmt(d.totals.days)} days`);
      await this.scene('day', shuffled(kept), 2800, 700, token, false);
      this.setChapter('place', `${fmt(d.totals.places)} places`);
      await this.scene('place', shuffled(kept), 2800, 700, token, false);
      this.setChapter('best', `${fmt(d.totals.best)} best · ${fmt(d.totals.duplicates)} duplicates`);
      this.finaleCards();
      const best = kept.filter((i) => d.items[i].b);
      this.stage.fill([...best, ...shuffled(kept.filter((i) => !d.items[i].b))]);
      await this.wait(450, token);
      const [bestCard, dupCard] = this.cards;
      all.filter((i) => d.items[i].x).forEach((i) => dupCard.land(i, false));
      await this.series(best, 2400, 900, token, (id, dur) => this.fly(id, bestCard, dur, token, () => bestCard.land(id)));
      this.done();
    } catch (e) {
      if (e.message !== 'cancel') throw e;
    }
    return undefined;
  }

  done() {
    this.playing = false;
    this.root.classList.remove('playing');
    $$('.sc-steps span', this.root).forEach((s) => { s.classList.remove('on'); s.classList.add('done'); });
  }

  skip() {
    this.run++;
    this.stage.flyers = [];
    const d = this.data;
    const kept = d.items.map((_, i) => i).filter((i) => !d.items[i].x);
    this.setCounter(d.totals.photos, d.totals.videos);
    this.setChapter('best', `${fmt(d.totals.best)} best · ${fmt(d.totals.duplicates)} duplicates`);
    this.finaleCards();
    this.stage.fill(shuffled(kept));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const [bestCard, dupCard] = this.cards;
      d.items.forEach((it, i) => {
        if (it.b) bestCard.land(i, false);
        if (it.x) dupCard.land(i, false);
      });
    }));
    this.done();
  }

  destroy() {
    this.run++;
    this.stage.destroy();
  }
}
