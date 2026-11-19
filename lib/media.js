import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import exifr from 'exifr';
import { DATA, IS_MAC } from './config.js';
import { assertWritable, realish, writeFile, removeFile, mkdirp } from './safefs.js';

const run = promisify(execFile);
sharp.cache(false);

export const PREVIEW_DIR = path.join(DATA, 'previews');
export const TMP_DIR = path.join(DATA, 'tmp');
const PREVIEW_PX = 640;

export const fileKey = (f) =>
  crypto.createHash('sha1').update(`${f.abs}|${f.size}|${f.mtimeMs}`).digest('hex').slice(0, 16);

const pad = (n) => String(n).padStart(2, '0');
const plausibleYear = (y) => y >= 2005 && y <= new Date().getFullYear() + 1;

export function wallFromUtcMs(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export const wallToMs = (wall) => Date.parse(`${wall}Z`);

function validParts(y, mo, d, h = 0, mi = 0, s = 0) {
  return plausibleYear(y) && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h < 24 && mi < 60 && s < 61;
}

function parseExifDate(value) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value || '');
  if (!m || !validParts(...m.slice(1).map(Number))) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

function parseIsoDate(value) {
  const s = String(value || '');
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?[+-]\d{2}:?\d{2}$/.exec(s);
  if (local && validParts(...local.slice(1).map(Number))) return `${local[1]}-${local[2]}-${local[3]}T${local[4]}:${local[5]}:${local[6]}`;
  const ms = Date.parse(s);
  if (Number.isNaN(ms) || !plausibleYear(new Date(ms).getUTCFullYear())) return null;
  return wallFromUtcMs(ms);
}

export function dateFromName(name) {
  let m = /(?<!\d)(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})(?!\d)/.exec(name);
  if (m && validParts(...m.slice(1).map(Number))) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  m = /(?<!\d)(20\d{2})[-_]?(\d{2})[-_]?(\d{2})(?!\d)/.exec(name);
  if (m && validParts(...m.slice(1).map(Number))) return `${m[1]}-${m[2]}-${m[3]}T12:00:00`;
  return null;
}

const validGps = (lat, lon) =>
  Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

async function probePhoto(abs) {
  let x = null;
  try {
    x = await exifr.parse(abs, {
      tiff: true, exif: true, gps: true, reviveValues: false, translateValues: false,
      pick: ['DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'ExifImageWidth', 'ExifImageHeight',
        'ImageWidth', 'ImageHeight', 'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef'],
    });
  } catch {
    x = null;
  }
  const gps = validGps(x?.latitude, x?.longitude);
  return {
    taken: parseExifDate(x?.DateTimeOriginal || x?.CreateDate),
    lat: gps ? x.latitude : null,
    lon: gps ? x.longitude : null,
    w: x?.ExifImageWidth || x?.ImageWidth || 0,
    h: x?.ExifImageHeight || x?.ImageHeight || 0,
  };
}

async function probeVideo(abs) {
  let j = {};
  try {
    const { stdout } = await run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', abs], { maxBuffer: 1 << 24 });
    j = JSON.parse(stdout);
  } catch {
    j = {};
  }
  const tags = j.format?.tags || {};
  const vs = (j.streams || []).find((s) => s.codec_type === 'video');
  let w = vs?.width || 0;
  let h = vs?.height || 0;
  const rot = Number(vs?.side_data_list?.find((x) => x.rotation !== undefined)?.rotation ?? vs?.tags?.rotate ?? 0);
  if (Math.abs(rot) === 90 || Math.abs(rot) === 270) [w, h] = [h, w];
  const g = /([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(tags['com.apple.quicktime.location.ISO6709'] || tags.location || '');
  const lat = g ? Number(g[1]) : null;
  const lon = g ? Number(g[2]) : null;
  return {
    taken: parseIsoDate(tags['com.apple.quicktime.creationdate']),
    takenUtc: parseIsoDate(tags.creation_time),
    lat: validGps(lat, lon) ? lat : null,
    lon: validGps(lat, lon) ? lon : null,
    w, h,
    duration: Number(j.format?.duration) || 0,
  };
}

async function exists(p) {
  try {
    return (await fs.stat(p)).size > 0;
  } catch {
    return false;
  }
}

export async function toJpegFile(src, out, maxPx = 1280) {
  assertWritable(out);
  if (realish(out) === realish(src)) throw new Error('Safety guard: output equals input');
  await mkdirp(path.dirname(out));
  if (IS_MAC) {
    const size = maxPx ? ['-Z', String(maxPx)] : [];
    await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', maxPx ? '82' : '90', ...size, src, '--out', out]);
  } else {
    const { default: convert } = await import('heic-convert');
    await writeFile(out, Buffer.from(await convert({ buffer: await fs.readFile(src), format: 'JPEG', quality: 0.85 })));
  }
  if (!(await exists(out))) throw new Error('could not convert image');
}

async function videoFrame(src, out) {
  assertWritable(out);
  await mkdirp(path.dirname(out));
  for (const at of ['1', '0']) {
    try {
      await run('ffmpeg', ['-v', 'error', '-ss', at, '-i', src, '-frames:v', '1',
        '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease', '-y', out]);
      if (await exists(out)) return;
    } catch {}
  }
  throw new Error('ffmpeg produced no frame');
}

const toPreview = (src) =>
  sharp(src, { failOn: 'none', limitInputPixels: false })
    .rotate()
    .resize(PREVIEW_PX, PREVIEW_PX, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#000' })
    .jpeg({ quality: 80 })
    .toBuffer();

async function makePreview(f, key) {
  const tmp = path.join(TMP_DIR, `${key}.jpg`);
  try {
    if (f.kind === 'video') {
      await videoFrame(f.abs, tmp);
      return await toPreview(tmp);
    }
    if (/\.(heic|heif)$/i.test(f.abs)) {
      await toJpegFile(f.abs, tmp);
      return await toPreview(tmp);
    }
    try {
      return await toPreview(f.abs);
    } catch {
      await toJpegFile(f.abs, tmp);
      return await toPreview(tmp);
    }
  } finally {
    if (await exists(tmp)) await removeFile(tmp);
  }
}

async function fingerprints(buf) {
  const tile = async (n) => (await sharp(buf).resize(n, n, { fit: 'cover' }).removeAlpha().raw().toBuffer()).toString('hex');
  const d = await sharp(buf).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = '';
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) bits += d[r * 9 + c] < d[r * 9 + c + 1] ? '1' : '0';
  const g32 = await sharp(buf).greyscale().resize(32, 32, { fit: 'fill' }).raw().toBuffer();
  const mean = g32.reduce((a, v) => a + v, 0) / g32.length;
  const sd = Math.sqrt(g32.reduce((a, v) => a + (v - mean) ** 2, 0) / g32.length);
  return {
    tile8: await tile(8),
    tile24: await tile(24),
    dhash: BigInt(`0b${bits}`).toString(16).padStart(16, '0'),
    g32: g32.toString('base64'),
    flat: sd < 14,
  };
}

const GREY8 = '6b6b6b'.repeat(64);
const GREY24 = '6b6b6b'.repeat(576);

export async function analyze(f) {
  const key = fileKey(f);
  const meta = f.kind === 'video' ? await probeVideo(f.abs) : await probePhoto(f.abs);

  let taken = meta.taken;
  let takenSrc = taken ? (f.kind === 'video' ? 'video' : 'exif') : null;
  const fromName = taken ? null : dateFromName(f.name);
  if (fromName) [taken, takenSrc] = [fromName, 'name'];
  if (!taken && meta.takenUtc) [taken, takenSrc] = [meta.takenUtc, 'video'];
  if (!taken) [taken, takenSrc] = [wallFromUtcMs(f.mtimeMs), 'mtime'];

  let w = meta.w;
  let h = meta.h;
  if (f.kind === 'photo' && !(w && h)) {
    try {
      const m = await sharp(f.abs, { failOn: 'none' }).metadata();
      [w, h] = [m.width || 0, m.height || 0];
    } catch {}
  }

  const base = {
    key, abs: f.abs, source: f.source, name: f.name, kind: f.kind, size: f.size, mtimeMs: f.mtimeMs,
    taken, takenSrc, lat: meta.lat, lon: meta.lon, w, h, duration: meta.duration || 0,
  };
  try {
    const buf = await makePreview(f, key);
    await writeFile(path.join(PREVIEW_DIR, `${key}.jpg`), buf);
    return { ...base, ...(await fingerprints(buf)), broken: false };
  } catch (e) {
    return { ...base, tile8: GREY8, tile24: GREY24, dhash: null, g32: null, flat: true, broken: true, error: String(e.message || e) };
  }
}
