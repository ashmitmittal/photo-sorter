import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { DATA } from './config.js';
import { RESULT, readJson } from './store.js';
import { isInside, writeFile, removeFile } from './safefs.js';
import { PREVIEW_DIR, TMP_DIR, toJpegFile } from './media.js';

const THUMB_DIR = path.join(DATA, 'thumbs');
const FULL_DIR = path.join(DATA, 'full');
const THUMB_PX = { s: 160, m: 420 };
const FULL_PX = 4096;
const NATIVE = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const VIDEO = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.3gp': 'video/3gpp' };

const exists = (f) => {
  try {
    return fs.statSync(f).size > 0;
  } catch {
    return false;
  }
};

let index = { mtime: -1, map: new Map(), roots: [] };

async function resultIndex() {
  let mtime = 0;
  try {
    mtime = (await fsp.stat(RESULT)).mtimeMs;
  } catch {}
  if (mtime !== index.mtime) {
    const r = mtime ? await readJson(RESULT, null) : null;
    index = {
      mtime,
      map: new Map((r?.items || []).map((it) => [it.key, { abs: it.abs, kind: it.kind, name: it.name }])),
      roots: (r?.sources || []).map((s) => s.path),
    };
  }
  return index;
}

// Only files listed in the last result (or the sort that is running) can be served, and only from inside their source folders.
export async function findMedia(key, live) {
  if (!/^[0-9a-f]{16}$/.test(key)) return null;
  const idx = await resultIndex();
  let hit = idx.map.get(key);
  let roots = idx.roots;
  if (!hit && live?.index?.has(key)) {
    hit = live.index.get(key);
    roots = live.sources;
  }
  if (!hit || !roots.some((r) => isInside(hit.abs, r))) return null;
  return hit;
}

const inflight = new Map();
function once(id, fn) {
  if (!inflight.has(id)) inflight.set(id, fn().finally(() => inflight.delete(id)));
  return inflight.get(id);
}

let running = 0;
const queue = [];
async function limited(fn) {
  if (running >= 2) await new Promise((resolve) => queue.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    queue.shift()?.();
  }
}

export async function thumbFile(key, size) {
  const px = THUMB_PX[size] || THUMB_PX.m;
  const file = path.join(THUMB_DIR, `${key}-${px}.jpg`);
  if (exists(file)) return file;
  const src = path.join(PREVIEW_DIR, `${key}.jpg`);
  if (!exists(src)) return null;
  return once(file, async () => {
    const img = sharp(src, { failOn: 'none' });
    const buf = await (px <= 160 ? img.resize(px, px, { fit: 'cover' }) : img.resize(px, px, { fit: 'outside', withoutEnlargement: true }))
      .jpeg({ quality: px <= 160 ? 72 : 78, mozjpeg: true })
      .toBuffer();
    await writeFile(file, buf);
    return file;
  });
}

export async function fullFile(key, hit) {
  const ext = path.extname(hit.abs).toLowerCase();
  if (hit.kind !== 'photo') return null;
  if (NATIVE[ext]) return { file: hit.abs, type: NATIVE[ext] };
  const file = path.join(FULL_DIR, `${key}.jpg`);
  if (!exists(file)) {
    await once(file, () => limited(async () => {
      const tmp = path.join(TMP_DIR, `full-${key}.jpg`);
      try {
        await toJpegFile(hit.abs, tmp, 0);
        const buf = await sharp(tmp, { failOn: 'none', limitInputPixels: false })
          .rotate()
          .resize(FULL_PX, FULL_PX, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 86, mozjpeg: true })
          .toBuffer();
        await writeFile(file, buf);
      } finally {
        if (exists(tmp)) await removeFile(tmp);
      }
    }));
  }
  return { file, type: 'image/jpeg' };
}

export function videoFile(hit) {
  const type = VIDEO[path.extname(hit.abs).toLowerCase()];
  return hit.kind === 'video' && type ? { file: hit.abs, type } : null;
}

export async function sendFile(req, res, file, type, cache) {
  const st = await fsp.stat(file);
  const headers = {
    'content-type': type,
    'cache-control': cache,
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'content-range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}
