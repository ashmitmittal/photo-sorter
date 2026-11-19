import fs from 'node:fs/promises';
import path from 'node:path';
import { VIDEOS, UNSORTED, DUPLICATES, BEST } from './config.js';
import { mkdirp, cloneCopy, writeFile, removeFile, removeDirIfEmpty, isInside } from './safefs.js';

const DAY_MS = 86400000;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayOf = (wall) => wall.slice(0, 10);
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
const weekday = (d) => WEEKDAY[new Date(dayMs(d)).getUTCDay()];
const prettyDay = (d) => {
  const x = new Date(dayMs(d));
  return `${WEEKDAY[x.getUTCDay()]} ${x.getUTCDate()} ${MONTH[x.getUTCMonth()]}`;
};
const UNDATED = { name: 'Undated', label: 'Undated', sub: '', order: Infinity };

export function tripWindow(items) {
  const reliable = items.filter((it) => it.takenSrc !== 'mtime');
  const pool = reliable.length ? reliable : items;
  const counts = new Map();
  for (const it of pool) counts.set(dayOf(it.taken), (counts.get(dayOf(it.taken)) || 0) + 1);
  const days = [...counts.keys()].sort();
  if (!days.length) return null;
  const runs = [];
  for (const d of days) {
    const run = runs[runs.length - 1];
    if (run && dayMs(d) - dayMs(run[run.length - 1]) <= 2 * DAY_MS) run.push(d);
    else runs.push([d]);
  }
  const weight = (run) => run.reduce((n, d) => n + counts.get(d), 0);
  const best = runs.reduce((a, b) => (weight(b) > weight(a) ? b : a));
  const span = (dayMs(best[best.length - 1]) - dayMs(best[0])) / DAY_MS + 1;
  const isTrip = span <= 31 && weight(best) >= pool.length * 0.6;
  return { start: best[0], end: best[best.length - 1], isTrip };
}

export function assignDays(items) {
  const win = tripWindow(items);
  const folders = new Map();
  for (const it of items) {
    const d = dayOf(it.taken);
    let f;
    if (!win) {
      f = UNDATED;
    } else if (win.isTrip) {
      const off = Math.round((dayMs(d) - dayMs(win.start)) / DAY_MS);
      const endOff = Math.round((dayMs(d) - dayMs(win.end)) / DAY_MS);
      if (it.takenSrc === 'mtime' && (off < 0 || endOff > 0)) f = UNDATED;
      else if (off >= 0 && endOff <= 0) f = { name: `Day ${off + 1} – ${prettyDay(d)}`, label: `Day ${off + 1}`, sub: prettyDay(d), order: off };
      else if (off < 0) f = { name: `Before the trip – ${prettyDay(d)}`, label: prettyDay(d), sub: 'before trip', order: off };
      else f = { name: `After the trip – ${prettyDay(d)}`, label: prettyDay(d), sub: 'after trip', order: off };
    } else if (it.takenSrc === 'mtime') {
      f = UNDATED;
    } else {
      f = { name: `${d.slice(0, 4)}/${d} ${weekday(d)}`, label: prettyDay(d), sub: d.slice(0, 4), order: dayMs(d) / DAY_MS };
    }
    it.day = f.name;
    if (!folders.has(f.name)) folders.set(f.name, f);
  }
  return { window: win, days: [...folders.values()].sort((a, b) => a.order - b.order) };
}

export function pickBest(kept, categories, count) {
  const names = categories.map((c) => c.name);
  const cands = kept.filter((it) => it.kind === 'photo' && !it.broken && names.includes(it.type) && !/screen/i.test(it.type) && it.score >= 5);
  const rank = (a, b) => b.score - a.score || (b.w * b.h) - (a.w * a.h) || a.key.localeCompare(b.key);
  const target = Math.min(count, cands.length);
  const byDay = new Map();
  for (const it of cands) {
    if (!byDay.has(it.day)) byDay.set(it.day, []);
    byDay.get(it.day).push(it);
  }
  const chosen = new Set();
  for (const list of byDay.values()) {
    list.sort(rank);
    const quota = Math.floor((target * list.length) / Math.max(1, cands.length));
    list.slice(0, quota).forEach((it) => chosen.add(it));
  }
  for (const it of [...cands].sort(rank)) {
    if (chosen.size >= target) break;
    chosen.add(it);
  }
  for (const it of kept) it.best = chosen.has(it);
  return chosen.size;
}

export function typeFolders(items, categories) {
  const list = [...categories.map((c) => c.name), VIDEOS];
  if (items.some((it) => !it.dup && it.type === UNSORTED)) list.push(UNSORTED);
  list.push(DUPLICATES);
  return list;
}

const safeName = (s) => s.replace(/[:\\]/g, '-').replace(/^\.+/, '');
export const dirOf = (...parts) => path.join(...parts.flatMap((p) => String(p).split('/')).map(safeName));

export function desiredDirs(it) {
  if (it.dup) return [dirOf(DUPLICATES)];
  const dirs = [dirOf('By type', it.type.replace(/\//g, '-')), dirOf('By day', it.day), dirOf('By place', it.place.replace(/\//g, '-'))];
  if (it.best) dirs.push(dirOf(BEST));
  return dirs;
}

export function planCopies(items, out) {
  const ordered = [...items].sort((a, b) => a.taken.localeCompare(b.taken) || a.abs.localeCompare(b.abs));
  const used = new Map();
  const plan = [];
  for (const it of ordered) {
    for (const rel of desiredDirs(it)) {
      const dir = path.join(out, rel);
      if (!used.has(dir)) used.set(dir, new Set());
      const names = used.get(dir);
      const ext = path.extname(it.name);
      const base = path.basename(it.name, ext);
      let name = it.name;
      for (let n = 2; names.has(name.toLowerCase()); n++) name = `${base} (${n})${ext}`;
      names.add(name.toLowerCase());
      plan.push({ it, dest: path.join(dir, name) });
    }
  }
  return plan;
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
const absOf = (x) => (typeof x === 'string' ? x : x?.abs ?? '');

async function clearPreviousRun(out) {
  const manifest = path.join(out, '.sorter-manifest.json');
  let files = [];
  try {
    files = JSON.parse(await fs.readFile(manifest, 'utf8')).files || [];
  } catch {
    return;
  }
  const dirs = new Set();
  for (const rel of files) {
    const p = path.join(out, rel);
    if (!isInside(p, out) || p === out) continue;
    await removeFile(p);
    for (let d = path.dirname(p); d !== out && isInside(d, out); d = path.dirname(d)) dirs.add(d);
  }
  const deepestFirst = [...dirs].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  for (const d of deepestFirst) await removeDirIfEmpty(d);
  await removeFile(manifest);
}

export async function writeOutputs(items, out) {
  const kept = items.filter((it) => !it.dup);
  const rows = [['file', 'kind', 'type', 'day', 'place', 'best_shot', 'keeper_score', 'taken', 'date_from', 'place_from', 'latitude', 'longitude', 'original_path', 'fixed_by_you']];
  const byTime = (a, b) => a.taken.localeCompare(b.taken) || a.abs.localeCompare(b.abs);
  for (const it of [...kept].sort(byTime)) {
    rows.push([it.name, it.kind, it.type, it.day, it.place, it.best ? 'yes' : '', it.score ?? '', it.taken.replace('T', ' '),
      it.takenSrc, it.placeSrc, it.lat ?? '', it.lon ?? '', it.abs, it.fixed ? 'yes' : '']);
  }
  const dupRows = [['duplicate', 'kept_copy', 'reason']];
  for (const it of items.filter((x) => x.dup).sort(byTime)) dupRows.push([it.abs, absOf(it.dupOf), it.dupReason]);
  await writeFile(path.join(out, 'sorted.csv'), csv(rows));
  await writeFile(path.join(out, 'duplicates.csv'), csv(dupRows));
  const files = [...items.flatMap((it) => it.copies || []), 'sorted.csv', 'duplicates.csv'];
  await writeFile(path.join(out, '.sorter-manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), files }, null, 1));
}

export async function applyCopies(items, out, onProgress = () => {}, signal) {
  await mkdirp(out);
  await clearPreviousRun(out);
  const plan = planCopies(items, out);
  for (const it of items) it.copies = [];
  const made = new Set();
  let done = 0;
  let i = 0;
  const worker = async () => {
    while (i < plan.length) {
      if (signal?.aborted) return;
      const e = plan[i++];
      const dir = path.dirname(e.dest);
      if (!made.has(dir)) {
        await mkdirp(dir);
        made.add(dir);
      }
      let dest = e.dest;
      for (let n = 2; ; n++) {
        try {
          await cloneCopy(e.it.abs, dest);
          break;
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
          const ext = path.extname(e.dest);
          dest = `${ext ? e.dest.slice(0, -ext.length) : e.dest} (copy ${n})${ext}`;
        }
      }
      e.it.copies.push(path.relative(out, dest));
      onProgress(++done, plan.length);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  await writeOutputs(items, out);
  return { copies: plan.length };
}
