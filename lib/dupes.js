import fs from 'node:fs';
import crypto from 'node:crypto';
import { wallToMs } from './media.js';

const RANK = { exact: 3, similar: 2, burst: 1 };

function hashFile(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(abs, { flags: 'r' })
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

function hamming(a, b) {
  let x = a ^ b;
  let c = 0;
  while (x) {
    x &= x - 1n;
    c++;
  }
  return c;
}

function meanAbsDiff(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

const reliableTime = (it) => (it.takenSrc === 'exif' || it.takenSrc === 'video' || it.takenSrc === 'name') ? wallToMs(it.taken) : null;
const aspect = (it) => (it.w && it.h ? Math.max(it.w, it.h) / Math.min(it.w, it.h) : null);

function keeperOrder(a, b) {
  return (b.w * b.h) - (a.w * a.h)
    || Number(b.takenSrc === 'exif') - Number(a.takenSrc === 'exif')
    || b.size - a.size
    || a.abs.localeCompare(b.abs);
}

export async function findDuplicates(items, onProgress = () => {}) {
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const why = new Map();
  const link = (i, j, reason) => {
    for (const k of [i, j]) if (!why.has(k) || RANK[reason] > RANK[why.get(k)]) why.set(k, reason);
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[b] = a;
  };

  const bySize = new Map();
  items.forEach((it, i) => {
    const k = `${it.kind}:${it.size}`;
    if (!bySize.has(k)) bySize.set(k, []);
    bySize.get(k).push(i);
  });
  const sameSize = [...bySize.values()].filter((g) => g.length > 1);
  const toHash = sameSize.reduce((n, g) => n + g.length, 0);
  let hashed = 0;
  for (const group of sameSize) {
    const byHash = new Map();
    for (const i of group) {
      const h = await hashFile(items[i].abs);
      onProgress(++hashed, toHash);
      if (byHash.has(h)) link(byHash.get(h), i, 'exact');
      else byHash.set(h, i);
    }
  }

  const cand = items
    .map((it, i) => ({
      i, it, d: it.dhash ? BigInt(`0x${it.dhash}`) : null, g: it.g32 ? Buffer.from(it.g32, 'base64') : null,
      c: Buffer.from(it.tile8, 'hex'), t: reliableTime(it), ar: aspect(it),
    }))
    .filter((c) => c.d !== null);
  for (let x = 0; x < cand.length; x++) {
    const A = cand[x];
    for (let y = x + 1; y < cand.length; y++) {
      const B = cand[y];
      if (A.it.kind !== B.it.kind) continue;
      const hd = hamming(A.d, B.d);
      if (hd > 10) continue;
      if (A.ar && B.ar && Math.abs(A.ar - B.ar) > 0.08) continue;
      const mad = meanAbsDiff(A.g, B.g);
      const cm = meanAbsDiff(A.c, B.c);
      const dt = A.t !== null && B.t !== null ? Math.abs(A.t - B.t) : null;
      if (A.it.kind === 'video') {
        if (Math.abs(A.it.duration - B.it.duration) < 0.15 && hd <= 4 && mad <= 8 && cm <= 10) link(A.i, B.i, 'similar');
        continue;
      }
      if (A.it.flat || B.it.flat) {
        if (hd <= 4 && mad <= 3 && cm <= 6 && (dt === null || dt <= 20000)) link(A.i, B.i, 'similar');
      } else if (hd <= 6 && mad <= 7 && cm <= 10) {
        link(A.i, B.i, 'similar');
      } else if (dt !== null && dt <= 20000 && mad <= 14 && cm <= 16) {
        link(A.i, B.i, 'burst');
      }
    }
  }

  const groups = new Map();
  items.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });
  const result = new Map();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => keeperOrder(items[a], items[b]));
    const keeper = sorted[0];
    for (const i of sorted.slice(1)) result.set(i, { dupOf: keeper, reason: why.get(i) || 'similar' });
  }
  return result;
}
