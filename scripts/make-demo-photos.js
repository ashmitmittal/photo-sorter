import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const run = promisify(execFile);
const target = path.resolve(process.argv[2] || 'demo-photos');
try {
  if ((await fs.readdir(target)).length) {
    console.error(`${target} is not empty; pick a new folder.`);
    process.exit(1);
  }
} catch {}

let seed = Number(process.argv[3]) || 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const hsl = (h, s, l) => `hsl(${Math.round(h)},${s}%,${l}%)`;

const scenes = {
  mountain: (w, h) => {
    const sky = rnd() * 40 + 190;
    let s = `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hsl(sky, 60, 55)}"/><stop offset="1" stop-color="${hsl(sky + 20, 50, 85)}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/>`;
    for (let i = 0; i < 3; i++) {
      const x = rnd() * w, peak = h * (0.2 + rnd() * 0.25), base = h * 0.75;
      s += `<polygon points="${x - w * 0.5},${base} ${x},${peak} ${x + w * 0.5},${base}" fill="${hsl(140 + rnd() * 60, 20, 25 + i * 8)}"/>`;
      s += `<polygon points="${x - w * 0.08},${peak + h * 0.09} ${x},${peak} ${x + w * 0.08},${peak + h * 0.09}" fill="#f4f6f8"/>`;
    }
    return s + `<rect y="${h * 0.75}" width="${w}" height="${h * 0.25}" fill="${hsl(120, 35, 30)}"/><path d="M0 ${h * 0.9} Q ${w / 2} ${h * 0.8} ${w} ${h * 0.92}" stroke="${hsl(195, 70, 60)}" stroke-width="${h * 0.04}" fill="none"/>`;
  },
  group: (w, h) => {
    let s = `<rect width="${w}" height="${h}" fill="${hsl(100 + rnd() * 60, 30, 40)}"/><rect y="${h * 0.7}" width="${w}" height="${h * 0.3}" fill="${hsl(30, 30, 35)}"/>`;
    const n = 3 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const x = w * (i + 0.5) / n;
      s += `<rect x="${x - w * 0.05}" y="${h * 0.45}" width="${w * 0.1}" height="${h * 0.35}" rx="20" fill="${hsl(rnd() * 360, 55, 50)}"/><circle cx="${x}" cy="${h * 0.38}" r="${w * 0.045}" fill="${hsl(30, 45, 65)}"/>`;
    }
    return s;
  },
  selfie: (w, h) => `<rect width="${w}" height="${h}" fill="${hsl(rnd() * 360, 35, 55)}"/><ellipse cx="${w * 0.5}" cy="${h * 0.5}" rx="${w * 0.3}" ry="${h * 0.32}" fill="${hsl(28, 45, 66)}"/><circle cx="${w * 0.4}" cy="${h * 0.45}" r="${w * 0.03}" fill="#222"/><circle cx="${w * 0.6}" cy="${h * 0.45}" r="${w * 0.03}" fill="#222"/><path d="M${w * 0.4} ${h * 0.6} Q ${w * 0.5} ${h * 0.68} ${w * 0.6} ${h * 0.6}" stroke="#622" stroke-width="8" fill="none"/><rect x="0" y="${h * 0.75}" width="${w * 0.2}" height="${h * 0.25}" fill="${hsl(28, 45, 60)}"/>`,
  food: (w, h) => {
    let s = `<rect width="${w}" height="${h}" fill="${hsl(25, 40, 35)}"/><circle cx="${w * 0.45}" cy="${h * 0.5}" r="${Math.min(w, h) * 0.32}" fill="#f2f2ee"/>`;
    for (let i = 0; i < 6; i++) s += `<circle cx="${w * (0.35 + rnd() * 0.2)}" cy="${h * (0.4 + rnd() * 0.2)}" r="${Math.min(w, h) * 0.06}" fill="${hsl(40, 50, 80)}" stroke="#c9b48a" stroke-width="4"/>`;
    return s + `<rect x="${w * 0.78}" y="${h * 0.3}" width="${w * 0.14}" height="${h * 0.25}" rx="12" fill="${hsl(30, 60, 45)}"/>`;
  },
  road: (w, h) => `<rect width="${w}" height="${h}" fill="${hsl(200, 40, 70)}"/><polygon points="0,${h * 0.55} ${w},${h * 0.45} ${w},${h} 0,${h}" fill="${hsl(110, 30, 35)}"/><polygon points="${w * 0.45},${h * 0.5} ${w * 0.55},${h * 0.5} ${w * 0.9},${h} ${w * 0.1},${h}" fill="#555"/><line x1="${w / 2}" y1="${h * 0.52}" x2="${w / 2}" y2="${h}" stroke="#fff" stroke-width="10" stroke-dasharray="40 40"/><rect x="${w * (0.3 + rnd() * 0.3)}" y="${h * 0.7}" width="${w * 0.16}" height="${h * 0.1}" rx="10" fill="${hsl(rnd() * 360, 70, 45)}"/>`,
  stay: (w, h) => `<rect width="${w}" height="${h}" fill="${hsl(230, 40, 15)}"/><polygon points="${w * 0.2},${h * 0.75} ${w * 0.4},${h * 0.35} ${w * 0.6},${h * 0.75}" fill="${hsl(rnd() * 60, 70, 50)}"/><polygon points="${w * 0.36},${h * 0.75} ${w * 0.4},${h * 0.55} ${w * 0.44},${h * 0.75}" fill="#222"/><circle cx="${w * 0.75}" cy="${h * 0.72}" r="${w * 0.05}" fill="#ffb347"/><circle cx="${w * 0.75}" cy="${h * 0.68}" r="${w * 0.03}" fill="#ff6a3d"/><rect y="${h * 0.75}" width="${w}" height="${h * 0.25}" fill="${hsl(30, 25, 20)}"/>`,
  screenshot: (w, h) => {
    let s = `<rect width="${w}" height="${h}" fill="#f5f5f7"/><rect width="${w}" height="${h * 0.06}" fill="#1c7c54"/>`;
    for (let i = 0; i < 9; i++) s += `<rect x="${i % 2 ? w * 0.35 : w * 0.05}" y="${h * (0.1 + i * 0.09)}" width="${w * 0.6}" height="${h * 0.06}" rx="24" fill="${i % 2 ? '#dcf8c6' : '#ffffff'}" stroke="#ddd"/>`;
    return s;
  },
};

const detail = (w, h) => {
  let s = '';
  for (let i = 0; i < 14; i++) {
    const x = rnd() * w, y = rnd() * h, r = 20 + rnd() * w * 0.12;
    s += rnd() < 0.5
      ? `<circle cx="${x}" cy="${y}" r="${r}" fill="${hsl(rnd() * 360, 60, 20 + rnd() * 60)}" opacity="0.55"/>`
      : `<rect x="${x}" y="${y}" width="${r * 1.6}" height="${r}" rx="8" fill="${hsl(rnd() * 360, 60, 20 + rnd() * 60)}" opacity="0.5"/>`;
  }
  return s;
};

const svg = (scene, w, h) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${scenes[scene](w, h)}${scene === 'screenshot' ? '' : detail(w, h)}</svg>`);

const toRational = (deg) => {
  const d = Math.floor(deg), m = Math.floor((deg - d) * 60), s = Math.round(((deg - d) * 60 - m) * 6000);
  return `${d}/1 ${m}/1 ${s}/100`;
};

const exifFor = (date, lat, lon) => {
  const exif = { IFD0: { Make: 'DemoCam' } };
  if (date) exif.IFD2 = { DateTimeOriginal: date, OffsetTimeOriginal: '+05:30' };
  if (lat) exif.IFD3 = { GPSLatitudeRef: 'N', GPSLatitude: toRational(lat), GPSLongitudeRef: 'E', GPSLongitude: toRational(lon) };
  return exif;
};

async function photo(file, scene, { date, lat, lon, w = 1600, h = 1200, quality = 88 } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const img = sharp(svg(scene, w, h));
  if (file.endsWith('.png')) await img.png().toFile(file);
  else await img.withExif(exifFor(date, lat, lon)).jpeg({ quality }).toFile(file);
}

const spots = {
  12: [[30.73, 76.8]],
  13: [[31.7, 76.95], [32.0101, 77.315], [32.012, 77.318]],
  14: [[32.0, 77.443], [31.994, 77.467], [31.991, 77.487], [31.993, 77.511]],
  15: [[31.993, 77.511], [32.0101, 77.315]],
  16: [[32.027, 77.348], [31.75, 77.2], [30.73, 76.8]],
};
const sceneFor = (day) => pick(day === 13 || day === 16 ? ['road', 'road', 'food', 'group', 'selfie', 'mountain', 'stay'] : ['mountain', 'mountain', 'group', 'selfie', 'food', 'stay']);

const A = path.join(target, 'Demo trip');
const B = path.join(target, 'Demo trip 2');
const made = [];
let n = 4400;
for (const day of [12, 13, 14, 15, 16]) {
  const count = day === 12 ? 3 : day === 16 ? 12 : 22;
  for (let i = 0; i < count; i++) {
    const hh = 7 + Math.floor((i / count) * 14);
    const date = `2022:08:${day} ${String(hh).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:10`;
    const [lat, lon] = pick(spots[day]);
    const noGps = rnd() < 0.12;
    const who = pick(['Person 1', 'Person 2']);
    const file = path.join(A, who, `IMG_${n++}.jpg`);
    const scene = sceneFor(day);
    await photo(file, scene, { date, lat: noGps ? null : lat + (rnd() - 0.5) * 0.004, lon: noGps ? null : lon + (rnd() - 0.5) * 0.004, w: scene === 'selfie' ? 1200 : 1600, h: scene === 'selfie' ? 1600 : 1200 });
    made.push({ file, scene, date });
  }
}

const burstBase = made[30];
for (let k = 1; k <= 2; k++) {
  const date = burstBase.date.replace(/:10$/, `:1${k * 2}`);
  const { width, height } = await sharp(burstBase.file).metadata();
  await sharp(burstBase.file).extract({ left: k * 10, top: 0, width: width - k * 10, height }).resize(width, height)
    .withExif(exifFor(date, 31.993, 77.511)).jpeg({ quality: 88 }).toFile(path.join(A, 'Person 1', `IMG_${n++}.jpg`));
}

for (const m of made.filter((_, i) => i % 9 === 4)) {
  const out = m.file.replace(/\.jpg$/, '.HEIC');
  await run('sips', ['-s', 'format', 'heic', m.file, '--out', out]);
  await fs.rm(m.file);
  m.file = out;
}

for (let i = 0; i < 2; i++) await photo(path.join(A, 'Person 2', `Screenshot_2022081${4 + i}-1015${i}0.png`), 'screenshot', { w: 590, h: 1280 });
for (let i = 0; i < 3; i++) {
  const f = path.join(B, `Snapchat-${1830000000 + i * 7919}.jpg`);
  await photo(f, pick(['selfie', 'group', 'food']), {});
  const t = i < 2 ? new Date('2022-08-14T09:30:00Z') : new Date('2026-11-10T09:30:00Z');
  await fs.utimes(f, t, t);
}

const jpgs = made.filter((m) => m.file.endsWith('.jpg'));
for (const m of jpgs.filter((_, i) => i % 11 === 3)) await fs.copyFile(m.file, path.join(B, path.basename(m.file)));
await fs.mkdir(path.join(B, 'Shared'), { recursive: true });
for (const m of jpgs.filter((_, i) => i % 13 === 6)) {
  await sharp(m.file).resize({ width: 1024 }).jpeg({ quality: 62 }).toFile(path.join(B, 'Shared', `IMG-2022081${m.date.slice(9, 10)}-WA00${n++ % 100}.jpg`));
}

const videos = [
  ['VID_20220813_142233.mp4', 'testsrc2', '2022-08-13T08:52:33Z', '+31.7000+076.9500/'],
  ['IMG_9001.MOV', 'testsrc', '2022-08-14T06:10:00Z', '+31.9930+077.5110/'],
  ['IMG_9002.MOV', 'rgbtestsrc', '2022-08-14T12:40:00Z', '+31.9930+077.5110/'],
  ['VID_20220815_101500.mp4', 'smptebars', '2022-08-15T04:45:00Z', '+32.0101+077.3150/'],
  ['VID_20220816_170000.mp4', 'mandelbrot', '2022-08-16T11:30:00Z', null],
];
for (const [name, src, ctime, loc] of videos) {
  const out = path.join(A, 'Person 2', name);
  const meta = ['-metadata', `creation_time=${ctime}`];
  if (loc) meta.push('-metadata', `location=${loc}`);
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `${src}=size=640x360:rate=24`, '-t', '2', '-pix_fmt', 'yuv420p', ...meta, '-y', out]);
}
await fs.copyFile(path.join(A, 'Person 2', 'IMG_9001.MOV'), path.join(B, 'IMG_9001.MOV'));
await fs.writeFile(path.join(B, 'notes.xlsx'), 'not a photo');
await fs.writeFile(path.join(B, '.DS_Store'), '');
console.log(`Demo photos written to ${target}`);
