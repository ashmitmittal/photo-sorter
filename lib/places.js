import fs from 'node:fs/promises';
import fss from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { APP, DATA, PLACE_UNKNOWN, PLACE_BORROW_MS, PLACES_MODEL } from './config.js';
import { writeFile } from './safefs.js';
import { wallToMs } from './media.js';
import { askClaude } from './claude.js';

const CACHE = path.join(DATA, 'places-cache.json');
const RADIUS_KM = 2;
const MAX_PER_CALL = 150;

function km(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

let TOWNS = null;
function towns() {
  if (!TOWNS) {
    const txt = zlib.gunzipSync(fss.readFileSync(path.join(APP, 'lib/data/towns.tsv.gz'))).toString('utf8');
    TOWNS = txt.split('\n').filter(Boolean).map((l) => {
      const [name, lat, lon, cc] = l.split('\t');
      return { name, lat: Number(lat), lon: Number(lon), cc };
    });
  }
  return TOWNS;
}

export function nearestTowns(lat, lon, k = 2) {
  return towns()
    .filter((t) => Math.abs(t.lat - lat) < 1 && Math.abs(t.lon - lon) < 1.5)
    .map((t) => ({ ...t, km: km(lat, lon, t.lat, t.lon) }))
    .filter((t) => t.km <= 80)
    .sort((a, b) => a.km - b.km)
    .slice(0, k);
}

export function clusterPoints(points) {
  const cellOf = (p) => `${Math.floor(p.lat / 0.05)},${Math.floor(p.lon / 0.05)}`;
  const grid = new Map();
  points.forEach((p, i) => {
    const k = cellOf(p);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  const near = (p, r) => {
    const [a, b] = cellOf(p).split(',').map(Number);
    const out = [];
    for (let x = a - 1; x <= a + 1; x++) {
      for (let y = b - 1; y <= b + 1; y++) {
        for (const j of grid.get(`${x},${y}`) || []) if (km(p.lat, p.lon, points[j].lat, points[j].lon) <= r) out.push(j);
      }
    }
    return out;
  };
  const density = points.map((p) => near(p, RADIUS_KM / 2).length);
  const order = points.map((_, i) => i).sort((a, b) => density[b] - density[a]);
  const owner = new Array(points.length).fill(-1);
  const clusters = [];
  for (const seed of order) {
    if (owner[seed] !== -1) continue;
    const members = near(points[seed], RADIUS_KM).filter((j) => owner[j] === -1);
    const id = clusters.length;
    members.forEach((j) => { owner[j] = id; });
    const lat = members.reduce((s, j) => s + points[j].lat, 0) / members.length;
    const lon = members.reduce((s, j) => s + points[j].lon, 0) / members.length;
    const times = members.map((j) => points[j].taken).sort();
    clusters.push({ id, lat, lon, count: members.length, first: times[0], last: times[times.length - 1], members });
  }
  return clusters;
}

const placeSchema = {
  type: 'object',
  properties: {
    places: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string', minLength: 1, maxLength: 40 },
          area: { type: 'string', minLength: 1, maxLength: 40 },
        },
        required: ['id', 'name', 'area'],
        additionalProperties: false,
      },
    },
  },
  required: ['places'],
  additionalProperties: false,
};

const near = (c) => {
  const t = nearestTowns(c.lat, c.lon).filter((x) => x.km <= 10);
  return t.length ? t.map((x) => `${x.name}, ${x.cc} (${x.km < 1 ? '<1' : Math.round(x.km)} km)`).join('; ') : '-';
};

const placePrompt = (list, context) => `Photos were taken at these GPS locations${context ? ` (${context})` : ''}. Each line is: id | latitude, longitude | number of photos | first and last time taken | towns of 5,000+ people within 10 km, from a gazetteer (- if none).


${list.map((c) => `${c.id} | ${c.lat.toFixed(4)}, ${c.lon.toFixed(4)} | ${c.count} | ${c.first.replace('T', ' ')} to ${c.last.replace('T', ' ')} | ${near(c)}`).join('\n')}

Name the village, town, neighbourhood, beach, trek or landmark at each point, as precisely as you can from the coordinates. Small villages are not in the gazetteer, so rely on your own geography there. For points on a road between places, use "<nearest town> highway".

Give every id a short folder name (1 to 3 words, no brackets, no coordinates, no country) that a traveller would recognise, for example "Kasol", "Kheerganga", "Old Manali", "Baga Beach". Points in the same place get the same name; separate villages keep separate names.
Also give every id an "area": the broader valley, city or route a traveller would group it under, for example "Parvati Valley", "Chandigarh", "Mandi–Kullu highway", "North Goa". Points on the same stretch of road share one area. Answer for every id.`;

const keyOf = (c, context) => `${c.lat.toFixed(3)},${c.lon.toFixed(3)}|${context}`;
const fallbackName = (c) => {
  const town = nearestTowns(c.lat, c.lon, 1)[0];
  const name = town ? (town.km <= 5 ? town.name : `Near ${town.name}`) : `Near ${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}`;
  return { name, area: name };
};
const clean = (v) => String(v || '').replace(/[/:\\]/g, '-').trim();

async function nameClusters(clusters, { labeler, context, model, signal }) {
  let cache = {};
  try {
    cache = JSON.parse(await fs.readFile(CACHE, 'utf8'));
  } catch {}
  const names = new Map();
  const todo = [];
  for (const c of clusters) {
    const hit = cache[keyOf(c, context)];
    if (hit?.name) names.set(c.id, hit);
    else todo.push(c);
  }
  if (todo.length && labeler === 'claude') {
    const sorted = [...todo].sort((a, b) => a.first.localeCompare(b.first));
    for (let i = 0; i < sorted.length; i += MAX_PER_CALL) {
      const part = sorted.slice(i, i + MAX_PER_CALL);
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const data = await askClaude({ prompt: placePrompt(part, context), schema: placeSchema, model: labeler === 'claude' ? PLACES_MODEL : model, cwd: DATA, signal, timeoutMs: 240000 });
          for (const p of data.places || []) {
            const c = part.find((x) => x.id === p.id);
            const name = clean(p.name);
            if (c && name) {
              const entry = { name, area: clean(p.area) || name };
              names.set(c.id, entry);
              cache[keyOf(c, context)] = entry;
            }
          }
          break;
        } catch (e) {
          if (signal?.aborted) throw e;
          if (attempt === 3) console.warn(`Naming places failed, using coordinates instead: ${String(e.message || e).slice(0, 300)}`);
        }
      }
    }
    await writeFile(CACHE, JSON.stringify(cache));
  }
  for (const c of clusters) if (!names.has(c.id)) names.set(c.id, fallbackName(c));
  return names;
}

export async function assignPlaces(items, opts) {
  const gps = items.filter((it) => !it.dup && it.lat !== null && it.lon !== null);
  const clusters = clusterPoints(gps.map((it) => ({ lat: it.lat, lon: it.lon, taken: it.taken })));
  const names = await nameClusters(clusters, opts);
  const perName = new Map();
  for (const c of clusters) {
    const k = names.get(c.id).name.toLowerCase();
    perName.set(k, (perName.get(k) || 0) + c.count);
  }
  const minPhotos = Math.max(4, Math.round(gps.length * 0.015));
  const canonical = new Map();
  for (const c of clusters) {
    const { name, area } = names.get(c.id);
    const n = perName.get(name.toLowerCase()) >= minPhotos ? name : area;
    const k = n.toLowerCase();
    if (!canonical.has(k)) canonical.set(k, n);
    for (const j of c.members) {
      gps[j].place = canonical.get(k);
      gps[j].placeSrc = 'gps';
    }
  }

  const anchors = gps.filter((it) => it.takenSrc !== 'mtime').map((it) => ({ t: wallToMs(it.taken), place: it.place })).sort((a, b) => a.t - b.t);
  for (const it of items) {
    if (it.place) continue;
    let near = null;
    if (anchors.length && it.takenSrc !== 'mtime') {
      const t = wallToMs(it.taken);
      let lo = 0;
      let hi = anchors.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (anchors[mid].t < t) lo = mid + 1;
        else hi = mid;
      }
      for (const a of [anchors[lo - 1], anchors[lo]]) {
        if (a && Math.abs(a.t - t) <= PLACE_BORROW_MS && (!near || Math.abs(a.t - t) < Math.abs(near.t - t))) near = a;
      }
    }
    it.place = near ? near.place : PLACE_UNKNOWN;
    it.placeSrc = near ? 'time' : 'none';
  }

  const counts = new Map();
  for (const it of items) if (!it.dup) counts.set(it.place, (counts.get(it.place) || 0) + 1);
  return [...counts.keys()].sort((a, b) =>
    (a === PLACE_UNKNOWN) - (b === PLACE_UNKNOWN) || counts.get(b) - counts.get(a) || a.localeCompare(b));
}
