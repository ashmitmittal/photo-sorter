import fs from 'node:fs/promises';
import path from 'node:path';
import { APP, DATA, PHOTO_EXT, VIDEO_EXT } from './config.js';
import { isInside } from './safefs.js';

export function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (PHOTO_EXT.has(ext)) return 'photo';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

const byName = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
const SKIP = new Set(['node_modules', 'Library', 'Applications', '.git']);

async function walk(dir, out = [], limits = null, depth = 0) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => byName(a.name, b.name));
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    if (limits && (out.length >= limits.files || depth > limits.depth)) return out;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out, limits, depth + 1);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export async function isSortedOutput(dir) {
  try {
    await fs.access(path.join(dir, '.sorter-manifest.json'));
    return true;
  } catch {
    return false;
  }
}

export async function inspectFolder(dir) {
  const st = await fs.stat(dir);
  if (!st.isDirectory()) throw new Error('Not a folder');
  const files = await walk(dir);
  return {
    path: dir,
    name: path.basename(dir),
    photos: files.filter((f) => kindOf(f) === 'photo').length,
    videos: files.filter((f) => kindOf(f) === 'video').length,
    sortedOutput: await isSortedOutput(dir),
  };
}

export async function suggestFolders() {
  const parent = path.dirname(APP);
  let entries = [];
  try {
    entries = await fs.readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const dir = path.join(parent, e.name);
    if (isInside(dir, APP) || isInside(APP, dir) || isInside(dir, DATA) || (await isSortedOutput(dir))) continue;
    const sample = await walk(dir, [], { files: 4000, depth: 4 });
    const media = sample.filter((f) => kindOf(f)).length;
    if (media >= 3) found.push(dir);
    if (found.length >= 8) break;
  }
  return found.sort(byName);
}

export async function listAllFiles(dirs) {
  const all = [];
  for (const d of dirs) all.push(...(await walk(d)));
  return all;
}

export async function listMedia(dirs) {
  const media = [];
  for (const dir of dirs) {
    for (const abs of await walk(dir)) {
      const kind = kindOf(abs);
      if (!kind) continue;
      const st = await fs.stat(abs);
      media.push({ abs, source: path.basename(dir), name: path.basename(abs), kind, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return media;
}
