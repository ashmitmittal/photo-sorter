import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import {
  DATA, TILE, VIDEOS, UNSORTED, DUPLICATES, LABELER, PLACE_UNKNOWN,
  DEFAULT_CATEGORIES, DEFAULT_MODEL, DEFAULT_BEST, MODELS, isPrivate,
} from './config.js';
import { listMedia, listAllFiles } from './discover.js';
import { analyze, fileKey, PREVIEW_DIR } from './media.js';
import { findDuplicates } from './dupes.js';
import { labelAll } from './labeler.js';
import { assignPlaces } from './places.js';
import { assignDays, pickBest, typeFolders, applyCopies } from './organize.js';
import { guardRun, writeFile, mkdirp } from './safefs.js';
import { killAll } from './claude.js';
import { RESULT, readJson, loadSettings, saveSettings } from './store.js';
import { loadFixes, lastFix, clearHistory, applyOverrides, applyBestOverrides } from './fixes.js';

export { RESULT, readJson, loadSettings, saveSettings };

const SCAN_CACHE = path.join(DATA, 'scan-cache.json');

export const STAGES = ['scan', 'dupes', 'label', 'organize', 'copy'];
export const tileOf = (it) => it.tile8;

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function pool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) {
      const k = i++;
      await fn(list[k], k);
    }
  }));
}

async function statAll(dirs) {
  const files = await listAllFiles(dirs);
  const map = new Map();
  for (const f of files) {
    try {
      const st = await fs.stat(f);
      map.set(f, `${st.size}:${st.mtimeMs}`);
    } catch {
      map.set(f, 'missing');
    }
  }
  return map;
}

export function deriveTitle(sourceNames, year) {
  const words = sourceNames.map((n) => n.split(/[\s_-]+/).filter((w) => w && !/^\d+$/.test(w)));
  const first = words[0]?.[0] || 'Photos';
  const shared = words.every((w) => w[0]?.toLowerCase() === first.toLowerCase());
  const name = shared ? first[0].toUpperCase() + first.slice(1) : 'Photos';
  return year ? `${name} ’${String(year).slice(2)}` : name;
}

export function clientResult(r, fixes = null) {
  const types = r.folders.type;
  const days = r.folders.day;
  const places = r.folders.place;
  const index = new Map(r.items.map((it, i) => [it.abs, i]));
  const special = [VIDEOS, UNSORTED, DUPLICATES];
  const categories = Array.isArray(r.categories) ? r.categories.map((c) => c.name) : types.filter((t) => !special.includes(t));
  const dayLabel = new Map(days.map((d) => [d.name, d.sub ? `${d.label} · ${d.sub}` : d.label]));
  const home = os.homedir() + path.sep;
  const tilde = (p) => (p.startsWith(home) ? `~/${p.slice(home.length)}` : p);
  return {
    title: r.title,
    createdAt: r.createdAt,
    durationMs: r.durationMs,
    out: r.out,
    sources: r.sources,
    privacy: isPrivate(),
    tile: TILE,
    totals: r.totals,
    verified: r.verified,
    labelFailures: r.labelFailures,
    categories,
    undo: fixes ? lastFix(fixes) : null,
    folders: {
      type: types.map((name) => ({ name, special: special.includes(name) })),
      day: days.map((d) => ({ name: d.label, sub: d.sub, dir: d.name })),
      place: places.map((name) => ({ name })),
    },
    items: r.items.map((it) => ({
      key: it.key,
      k: it.kind === 'video' ? 'v' : 'p',
      t: it.tile8,
      n: it.name,
      ts: it.taken,
      tsrc: it.takenSrc,
      ty: types.indexOf(it.dup ? DUPLICATES : it.type),
      d: it.dup ? -1 : days.findIndex((d) => d.name === it.day),
      p: it.dup ? -1 : places.indexOf(it.place),
      dl: dayLabel.get(it.day) || it.day,
      pl: it.place,
      ps: it.placeSrc,
      b: it.best && !it.dup ? 1 : 0,
      x: it.dup ? 1 : 0,
      sc: it.score ?? null,
      w: it.w || 0,
      h: it.h || 0,
      dur: it.kind === 'video' ? Math.round((it.duration || 0) * 10) / 10 : 0,
      path: it.abs,
      pd: tilde(it.abs),
      src: it.source,
      dk: it.dup ? (index.get(typeof it.dupOf === 'string' ? it.dupOf : it.dupOf?.abs) ?? -1) : -1,
      dr: it.dupReason || null,
      fx: it.fixed ? 1 : 0,
      bad: it.broken ? 1 : 0,
    })),
  };
}

export async function loadResult() {
  const r = await readJson(RESULT, null);
  return r ? clientResult(r, await loadFixes()) : null;
}

export class Pipeline extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.abort = null;
    this.live = null;
  }

  cancel() {
    if (!this.running) return false;
    this.abort?.abort();
    killAll();
    return true;
  }

  async run(opts) {
    if (this.running) throw new Error('A sort is already running');
    this.running = true;
    this.abort = new AbortController();
    try {
      return await this.#run(opts, this.abort.signal);
    } finally {
      this.running = false;
    }
  }

  async #run(opts, signal) {
    const t0 = Date.now();
    const sources = [...new Set(opts.sources.map((s) => path.resolve(s)))];
    const out = path.resolve(opts.out);
    const labeler = opts.labeler || LABELER;
    const categories = opts.categories?.length ? opts.categories : DEFAULT_CATEGORIES;
    const model = MODELS.includes(opts.model) ? opts.model : DEFAULT_MODEL;
    const best = Number(opts.best) > 0 ? Number(opts.best) : DEFAULT_BEST;
    const context = String(opts.context || '').slice(0, 300);
    const check = () => { if (signal.aborted) throw new Error('cancelled'); };

    if (!sources.length) throw new Error('Add at least one photos folder');
    for (const s of sources) {
      const st = await fs.stat(s).catch(() => null);
      if (!st?.isDirectory()) throw new Error(`Folder not found: ${path.basename(s)}`);
    }
    guardRun(sources, out);
    this.live = { sources, out, index: new Map() };
    await mkdirp(PREVIEW_DIR);
    await saveSettings({ sources, out, context, model, categories, best });

    this.emit('stage', { stage: 'scan' });
    const before = await statAll(sources);
    const media = await listMedia(sources);
    check();
    if (!media.length) throw new Error('No photos or videos found in those folders');
    const photos = media.filter((m) => m.kind === 'photo').length;
    const names = sources.map((s) => path.basename(s));
    this.emit('start', { total: media.length, photos, videos: media.length - photos, title: deriveTitle(names) });

    const cache = await readJson(SCAN_CACHE, {});
    const items = new Array(media.length);
    let scanned = 0;
    await pool(media, 6, async (m, id) => {
      if (signal.aborted) return;
      const key = fileKey(m);
      const hit = cache[key];
      const it = hit && (hit.broken || (await fileExists(path.join(PREVIEW_DIR, `${key}.jpg`))))
        ? { ...hit, abs: m.abs, source: m.source, name: m.name }
        : await analyze(m);
      cache[key] = it;
      it.id = id;
      items[id] = it;
      this.live.index.set(key, { abs: it.abs, kind: it.kind, name: it.name });
      this.emit('item', { id, key, k: it.kind === 'video' ? 'v' : 'p', t: tileOf(it) });
      this.emit('progress', { stage: 'scan', done: ++scanned, total: media.length });
    });
    await writeFile(SCAN_CACHE, JSON.stringify(cache));
    check();

    this.emit('stage', { stage: 'dupes' });
    const dupMap = await findDuplicates(items, (done, total) => this.emit('progress', { stage: 'dupes', done, total }));
    const fixes = await loadFixes();
    const early = [];
    for (const [i, d] of dupMap) {
      if (fixes.overrides[items[i].key]?.notDup) continue;
      Object.assign(items[i], { dup: true, dupOf: items[d.dupOf], dupReason: d.reason, type: DUPLICATES });
      early.push({ id: i, folder: DUPLICATES });
    }
    for (const it of items) {
      if (it.dup) continue;
      it.dup = false;
      if (it.kind === 'video') {
        it.type = VIDEOS;
      } else if (it.broken) {
        it.type = UNSORTED;
      }
    }
    const fixed = applyOverrides(fixes, items, categories);
    for (const it of items) {
      if (!it.dup && (fixed.has(it) || it.kind === 'video' || it.broken)) early.push({ id: it.id, folder: it.type });
    }
    if (early.length) this.emit('sorted', early);
    check();

    this.emit('stage', { stage: 'label' });
    const toLabel = items.filter((it) => !it.dup && it.kind === 'photo' && !it.broken && !fixed.has(it)).sort((a, b) => a.taken.localeCompare(b.taken));
    const { failures } = await labelAll(toLabel, {
      labeler, categories, context, model, signal,
      onStatus: (s) => this.emit('progress', { stage: 'label', ...s, photos: toLabel.length }),
      onBatch: (rows) => {
        for (const r of rows) Object.assign(r.it, { type: r.label, score: r.score, labeledBy: r.by });
        this.emit('sorted', rows.map((r) => ({ id: r.it.id, folder: r.label })));
      },
    });
    check();

    this.emit('stage', { stage: 'organize' });
    const { window: win, days } = assignDays(items);
    const places = await assignPlaces(items, { labeler, context, model, signal });
    const kept = items.filter((it) => !it.dup);
    pickBest(kept, categories, best);
    applyBestOverrides(fixes, kept);
    const bestCount = kept.filter((it) => it.best).length;
    check();

    this.emit('stage', { stage: 'copy' });
    const { copies } = await applyCopies(items, out, (done, total) => this.emit('progress', { stage: 'copy', done, total }), signal);
    check();

    const after = await statAll(sources);
    let changed = 0;
    for (const [f, sig] of before) if (after.get(f) !== sig) changed++;

    const year = win ? Number(win.start.slice(0, 4)) : null;
    const chrono = [...items].sort((a, b) => (a.day === 'Undated') - (b.day === 'Undated')
      || a.taken.localeCompare(b.taken) || a.abs.localeCompare(b.abs));
    const result = {
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      title: deriveTitle(names, win?.isTrip ? year : null),
      sources: sources.map((s) => ({ name: path.basename(s), path: s })),
      out,
      labeler,
      labelFailures: failures.length,
      verified: { checked: before.size, changed },
      totals: {
        files: items.length,
        photos: items.filter((it) => it.kind === 'photo').length,
        videos: items.filter((it) => it.kind === 'video').length,
        duplicates: items.filter((it) => it.dup).length,
        best: bestCount,
        copies,
        days: days.filter((d) => d.name !== 'Undated').length,
        places: places.filter((p) => p !== PLACE_UNKNOWN).length,
      },
      categories,
      folders: { type: typeFolders(items, categories), day: days, place: places },
      items: chrono.map(({ g32, tile24, dupOf, ...it }) => ({ ...it, dupOf: dupOf ? dupOf.abs : null })),
    };
    await writeFile(RESULT, JSON.stringify(result));
    await clearHistory();
    this.emit('done', { totals: result.totals, verified: result.verified, failures: failures.length });
    return result;
  }
}
