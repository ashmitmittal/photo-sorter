import fss from 'node:fs';
import path from 'node:path';
import { VIDEOS, UNSORTED, DUPLICATES, BEST, PLACE_UNKNOWN } from './config.js';
import { RESULT, FIXES, readJson, loadSettings, saveSettings } from './store.js';
import { guardRun, writeFile, cloneCopy, moveWithin, removeFile, removeDirIfEmpty, mkdirp } from './safefs.js';
import { desiredDirs, planCopies, writeOutputs, dirOf } from './organize.js';
import { cachePath } from './labeler.js';

const RESERVED = [VIDEOS, UNSORTED, DUPLICATES, BEST];
const HISTORY_MAX = 100;
const FIELDS = ['type', 'dup', 'dupOf', 'dupReason', 'best', 'score', 'fixed'];

const userError = (msg) => Object.assign(new Error(msg), { status: 400 });

export async function loadFixes() {
  const f = await readJson(FIXES, {});
  return { overrides: f.overrides || {}, history: Array.isArray(f.history) ? f.history : [] };
}

const saveFixes = (f) => writeFile(FIXES, JSON.stringify(f));

export function lastFix(f) {
  const h = f.history[f.history.length - 1];
  return h ? { label: h.label, at: h.at } : null;
}

export async function clearHistory() {
  const f = await loadFixes();
  if (!f.history.length) return;
  f.history = [];
  await saveFixes(f);
}

let chain = Promise.resolve();
const serial = (fn) => {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
};

function cleanName(v) {
  const name = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 40) throw userError('A folder name needs 1 to 40 characters.');
  if (/[/\\:]/.test(name) || name.startsWith('.')) throw userError('A folder name can’t contain / \\ : or start with a dot.');
  if (RESERVED.some((r) => r.toLowerCase() === name.toLowerCase())) throw userError(`“${name}” is a built-in folder.`);
  return name;
}

function freeName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let n = name;
  for (let i = 2; fss.existsSync(path.join(dir, n)); i++) n = `${base} (${i})${ext}`;
  return path.join(dir, n);
}

async function removeEmptyUp(dir, out) {
  for (let d = dir; d !== out && d.startsWith(out + path.sep); d = path.dirname(d)) {
    if (!(await removeDirIfEmpty(d))) return;
  }
}

async function migrateLabels(oldCats, newCats, rename = null) {
  for (const labeler of ['claude', 'mock']) {
    const from = await readJson(cachePath(labeler, oldCats), null);
    if (!from) continue;
    const mapped = {};
    for (const [k, v] of Object.entries(from)) mapped[k] = rename && v.label === rename[0] ? { ...v, label: rename[1] } : v;
    const to = await readJson(cachePath(labeler, newCats), {});
    await writeFile(cachePath(labeler, newCats), JSON.stringify({ ...to, ...mapped }));
  }
}

function ensureCopies(r) {
  if (r.items.every((it) => Array.isArray(it.copies))) return;
  for (const it of r.items) it.copies = [];
  for (const e of planCopies(r.items, r.out)) {
    if (fss.existsSync(e.dest)) e.it.copies.push(path.relative(r.out, e.dest));
  }
}

async function open() {
  const r = await readJson(RESULT, null);
  if (!r) throw userError('Sort some photos first.');
  if (!fss.existsSync(r.out)) throw userError('The sorted folder was moved or deleted. Sort again to fix photos.');
  guardRun(r.sources.map((s) => s.path), r.out);
  ensureCopies(r);
  if (!Array.isArray(r.categories)) {
    const settings = await loadSettings();
    const names = r.folders.type.filter((t) => !RESERVED.includes(t));
    r.categories = names.map((name) => settings.categories.find((c) => c.name === name) || { name, hint: '' });
  }
  return r;
}

async function reconcile(r, items) {
  const out = r.out;
  const emptied = new Set();
  const problems = [];
  for (const it of items) {
    const want = desiredDirs(it);
    const have = (it.copies || []).map((rel) => ({ rel, dir: path.dirname(rel) }));
    const keep = have.filter((h) => want.includes(h.dir) && fss.existsSync(path.join(out, h.rel)));
    const stale = have.filter((h) => !want.includes(h.dir));
    const missing = want.filter((d) => !keep.some((h) => h.dir === d));
    try {
      for (const d of missing) {
        const dest = freeName(path.join(out, d), it.name);
        const from = stale.shift();
        if (from && fss.existsSync(path.join(out, from.rel))) {
          await moveWithin(path.join(out, from.rel), dest);
          emptied.add(path.dirname(path.join(out, from.rel)));
        } else {
          await mkdirp(path.dirname(dest));
          await cloneCopy(it.abs, dest);
        }
        keep.push({ rel: path.relative(out, dest), dir: d });
      }
      while (stale.length) {
        const s = stale.shift();
        await removeFile(path.join(out, s.rel));
        emptied.add(path.dirname(path.join(out, s.rel)));
      }
    } catch (e) {
      problems.push(`${it.name}: ${e.code === 'ENOENT' ? 'original file not found' : e.message}`);
      keep.push(...stale);
    }
    it.copies = keep.map((k) => k.rel);
  }
  for (const d of emptied) await removeEmptyUp(d, out);
  return problems;
}

function restoreDup(it, r) {
  const keeper = r.items.find((x) => x.abs === it.dupOf && !x.dup);
  it.dup = false;
  it.dupOf = null;
  it.dupReason = null;
  it.best = false;
  it.score = it.score ?? keeper?.score ?? null;
  it.type = keeper ? keeper.type : it.kind === 'video' ? VIDEOS : UNSORTED;
  if (!r.folders.place.includes(it.place)) {
    const at = r.folders.place.indexOf(PLACE_UNKNOWN);
    r.folders.place.splice(at === -1 ? r.folders.place.length : at, 0, it.place);
  }
}

const snap = (it, f) => ({
  key: it.key,
  before: Object.fromEntries(FIELDS.map((k) => [k, it[k] ?? null])),
  ov: f.overrides[it.key] ? { ...f.overrides[it.key] } : null,
});

const noun = (items) => {
  const n = items.length;
  const videos = items.every((it) => it.kind === 'video');
  const photos = items.every((it) => it.kind === 'photo');
  return `${n} ${videos ? (n === 1 ? 'video' : 'videos') : photos ? (n === 1 ? 'photo' : 'photos') : (n === 1 ? 'item' : 'items')}`;
};

function pickItems(r, keys) {
  if (!Array.isArray(keys) || !keys.length) throw userError('Choose at least one photo.');
  const byKey = new Map(r.items.map((it) => [it.key, it]));
  const items = [...new Set(keys.map(String))].map((k) => byKey.get(k)).filter(Boolean);
  if (!items.length) throw userError('Those photos are not in the last sort.');
  return items;
}

function opMove(r, f, { keys, to }) {
  const target = r.folders.type.find((t) => t.toLowerCase() === String(to ?? '').toLowerCase());
  if (!target || target === DUPLICATES || target === UNSORTED) throw userError('Pick a folder to move to.');
  const items = pickItems(r, keys).filter((it) => it.dup || it.type !== target);
  if (target === VIDEOS && items.some((it) => it.kind !== 'video')) throw userError('Only videos can go in Videos.');
  const log = items.map((it) => snap(it, f));
  for (const it of items) {
    const wasDup = it.dup;
    if (wasDup) restoreDup(it, r);
    it.type = target;
    it.fixed = true;
    const ov = f.overrides[it.key] || {};
    f.overrides[it.key] = { ...ov, type: target, score: it.score ?? null, ...(wasDup ? { notDup: true } : {}) };
  }
  return { items, log, label: `Moved ${noun(items)} to ${target}` };
}

function opNotDup(r, f, { keys }) {
  const items = pickItems(r, keys).filter((it) => it.dup);
  const log = items.map((it) => snap(it, f));
  for (const it of items) {
    restoreDup(it, r);
    it.fixed = true;
    f.overrides[it.key] = { ...(f.overrides[it.key] || {}), notDup: true, type: it.type, score: it.score ?? null };
  }
  return { items, log, label: `Restored ${noun(items)} from Duplicates` };
}

function opBest(r, f, { keys, on }) {
  const want = Boolean(on);
  const picked = pickItems(r, keys);
  if (want && picked.every((it) => it.dup)) throw userError('Restore it from Duplicates first.');
  const items = picked.filter((it) => !it.dup && Boolean(it.best) !== want);
  const log = items.map((it) => snap(it, f));
  for (const it of items) {
    it.best = want;
    it.fixed = true;
    f.overrides[it.key] = { ...(f.overrides[it.key] || {}), best: want };
  }
  return { items, log, label: want ? `Added ${noun(items)} to Best shots` : `Removed ${noun(items)} from Best shots` };
}

async function renameType(r, f, from, to) {
  const out = r.out;
  const a = dirOf('By type', from);
  const b = dirOf('By type', to);
  const caseOnly = a.toLowerCase() === b.toLowerCase();
  if (!caseOnly && fss.existsSync(path.join(out, b))) throw userError(`A folder called “${to}” already exists in the sorted folder.`);
  if (fss.existsSync(path.join(out, a))) await moveWithin(path.join(out, a), path.join(out, b));
  for (const it of r.items) {
    if (it.type === from) it.type = to;
    it.copies = (it.copies || []).map((rel) => (rel.startsWith(a + path.sep) ? b + rel.slice(a.length) : rel));
  }
  r.folders.type = r.folders.type.map((t) => (t === from ? to : t));
  r.categories = r.categories.map((c) => (c.name === from ? { ...c, name: to } : c));
  for (const ov of Object.values(f.overrides)) if (ov.type === from) ov.type = to;
  const settings = await loadSettings();
  if (settings.categories.some((c) => c.name === from)) {
    const next = settings.categories.map((c) => (c.name === from ? { ...c, name: to } : c));
    await migrateLabels(settings.categories, next, [from, to]);
    await saveSettings({ categories: next });
  }
}

async function opRename(r, f, { from, to }) {
  const old = r.categories.find((c) => c.name === from)?.name;
  if (!old) throw userError('Only your own type folders can be renamed.');
  const name = cleanName(to);
  if (name === old) return { items: [], label: null };
  if (r.folders.type.some((t) => t !== old && t.toLowerCase() === name.toLowerCase())) throw userError(`There is already a folder called “${name}”.`);
  await renameType(r, f, old, name);
  return { items: [], label: `Renamed ${old} to ${name}`, entry: { kind: 'rename', from: old, to: name } };
}

async function addType(r, name, hint) {
  const at = r.folders.type.indexOf(VIDEOS);
  r.folders.type.splice(at === -1 ? r.categories.length : at, 0, name);
  r.categories.push({ name, hint });
  const settings = await loadSettings();
  if (!settings.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    const next = [...settings.categories, { name, hint }];
    await migrateLabels(settings.categories, next);
    await saveSettings({ categories: next });
  }
}

async function removeType(r, name) {
  if (r.items.some((it) => !it.dup && it.type === name)) throw userError(`Move the photos out of ${name} first.`);
  r.folders.type = r.folders.type.filter((t) => t !== name);
  r.categories = r.categories.filter((c) => c.name !== name);
  const settings = await loadSettings();
  if (settings.categories.some((c) => c.name === name)) {
    const next = settings.categories.filter((c) => c.name !== name);
    await migrateLabels(settings.categories, next);
    await saveSettings({ categories: next });
  }
}

async function opAdd(r, f, { name, hint }) {
  const clean = cleanName(name);
  if (r.folders.type.some((t) => t.toLowerCase() === clean.toLowerCase())) throw userError(`There is already a folder called “${clean}”.`);
  const h = String(hint ?? '').trim().slice(0, 300);
  await addType(r, clean, h);
  return { items: [], label: `Added the folder ${clean}`, entry: { kind: 'add', name: clean, hint: h } };
}

function totals(r) {
  const t = r.totals;
  t.duplicates = r.items.filter((it) => it.dup).length;
  t.best = r.items.filter((it) => it.best && !it.dup).length;
  t.copies = r.items.reduce((n, it) => n + (it.copies?.length || 0), 0);
  const used = new Set(r.items.filter((it) => !it.dup).map((it) => it.place));
  r.folders.place = r.folders.place.filter((p) => used.has(p));
  t.places = r.folders.place.filter((p) => p !== PLACE_UNKNOWN).length;
}

async function finish(r, f, items) {
  const problems = items.length ? await reconcile(r, items) : [];
  totals(r);
  await writeOutputs(r.items, r.out);
  r.fixedAt = new Date().toISOString();
  await writeFile(RESULT, JSON.stringify(r));
  if (f.history.length > HISTORY_MAX) f.history.splice(0, f.history.length - HISTORY_MAX);
  await saveFixes(f);
  return problems;
}

const OPS = { move: opMove, notdup: opNotDup, best: opBest, rename: opRename, addType: opAdd };

export function applyFix(body) {
  return serial(async () => {
    const fn = OPS[body?.op];
    if (!fn) throw userError('Unknown fix');
    const r = await open();
    const f = await loadFixes();
    const res = await fn(r, f, body);
    if (!res.label || (!res.items.length && !res.entry)) return { r, f, message: 'Nothing to change', changed: 0, problems: [] };
    f.history.push(res.entry
      ? { ...res.entry, label: res.label, at: new Date().toISOString() }
      : { kind: 'items', label: res.label, at: new Date().toISOString(), items: res.log });
    const problems = await finish(r, f, res.items);
    return { r, f, message: res.label, changed: res.items.length || 1, problems };
  });
}

export function undoFix() {
  return serial(async () => {
    const r = await open();
    const f = await loadFixes();
    const h = f.history[f.history.length - 1];
    if (!h) throw userError('Nothing to undo.');
    const items = [];
    if (h.kind === 'items') {
      const byKey = new Map(r.items.map((it) => [it.key, it]));
      for (const s of h.items) {
        const it = byKey.get(s.key);
        if (!it) continue;
        Object.assign(it, s.before);
        if (s.ov) f.overrides[s.key] = s.ov;
        else delete f.overrides[s.key];
        items.push(it);
      }
    } else if (h.kind === 'rename') {
      await renameType(r, f, h.to, h.from);
    } else if (h.kind === 'add') {
      await removeType(r, h.name);
    }
    f.history.pop();
    const problems = await finish(r, f, items);
    return { r, f, message: `Undone: ${h.label}`, changed: 1, problems };
  });
}

export function applyOverrides(f, items, categories) {
  const valid = new Set([...categories.map((c) => c.name), VIDEOS]);
  const typed = new Set();
  for (const it of items) {
    const ov = f.overrides[it.key];
    if (!ov || it.dup) continue;
    if (ov.type && valid.has(ov.type) && (ov.type !== VIDEOS || it.kind === 'video')) {
      it.type = ov.type;
      it.score = ov.score ?? it.score ?? null;
      it.fixed = true;
      typed.add(it);
    }
  }
  return typed;
}

export function applyBestOverrides(f, kept) {
  for (const it of kept) {
    const ov = f.overrides[it.key];
    if (ov && typeof ov.best === 'boolean') {
      it.best = ov.best;
      it.fixed = true;
    }
  }
}
