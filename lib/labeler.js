import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { DATA, UNSORTED, CLAUDE_PARALLEL, SHEET_SIZE } from './config.js';
import { writeFile, mkdirp } from './safefs.js';
import { PREVIEW_DIR } from './media.js';
import { askClaude } from './claude.js';

const SHEETS_DIR = path.join(DATA, 'sheets');
const CELL = 300;
const COLS = 5;

export const categorySig = (categories) =>
  crypto.createHash('sha1').update(JSON.stringify(categories.map((c) => [c.name, c.hint || '']))).digest('hex').slice(0, 10);

export const cachePath = (labeler, categories) => path.join(DATA, `labels-${labeler}-${categorySig(categories)}.json`);

async function loadCache(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

const numberBadge = (n) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="66" height="46"><rect width="66" height="46" rx="9" fill="#000" fill-opacity="0.82"/>` +
  `<text x="33" y="34" font-size="30" font-family="Helvetica, Arial, sans-serif" font-weight="700" fill="#fff" text-anchor="middle">${n}</text></svg>`,
);

async function buildSheet(batch, file) {
  const rows = Math.ceil(batch.length / COLS);
  const layers = [];
  for (let i = 0; i < batch.length; i++) {
    const left = (i % COLS) * CELL + 4;
    const top = Math.floor(i / COLS) * CELL + 4;
    const img = await sharp(path.join(PREVIEW_DIR, `${batch[i].key}.jpg`))
      .resize(CELL - 8, CELL - 8, { fit: 'contain', background: '#141414' })
      .jpeg({ quality: 85 })
      .toBuffer();
    layers.push({ input: img, left, top }, { input: numberBadge(i + 1), left, top });
  }
  const sheet = await sharp({ create: { width: COLS * CELL, height: rows * CELL, channels: 3, background: '#141414' } })
    .composite(layers)
    .jpeg({ quality: 82 })
    .toBuffer();
  await writeFile(file, sheet);
}

const schema = (n, names) => ({
  type: 'object',
  properties: {
    items: {
      type: 'array',
      minItems: n,
      maxItems: n,
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer', minimum: 1, maximum: n },
          label: { type: 'string', enum: names },
          score: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['n', 'label', 'score'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
});

const prompt = (sheetFile, n, categories, context) => `You are sorting someone's personal photos${context ? `. About these photos: ${context}` : ''}.

Use the Read tool to look at the image ${sheetFile}. It is a contact sheet of ${n} photos. Each photo sits in its own square cell with its number (1 to ${n}) in a black badge in the top-left corner.

For every number from 1 to ${n}, choose exactly one folder:
${categories.map((c) => `- ${c.name}${c.hint ? `: ${c.hint}` : ''}`).join('\n')}

Also give each photo a keeper score from 1 to 10: how good it is as a highlight. Sharp, well lit, a great moment or view scores high. Blurry, very dark, accidental or plain filler scores low.

Answer for all ${n} numbers.`;

async function labelWithClaude(batch, batchNo, { categories, context, model, signal }) {
  await mkdirp(SHEETS_DIR);
  const id = crypto.createHash('sha1').update(batch.map((b) => b.key).join(',')).digest('hex').slice(0, 10);
  const file = path.join(SHEETS_DIR, `sheet-${String(batchNo).padStart(3, '0')}-${id}.jpg`);
  await buildSheet(batch, file);
  const names = categories.map((c) => c.name);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw new Error('cancelled');
    try {
      const data = await askClaude({
        prompt: prompt(file, batch.length, categories, context),
        schema: schema(batch.length, names),
        model, cwd: SHEETS_DIR, tools: ['Read'], signal,
      });
      const out = {};
      for (const r of data.items || []) {
        const it = batch[r.n - 1];
        const label = names.find((x) => x.toLowerCase() === String(r.label).toLowerCase());
        if (it && label) out[it.key] = { label, score: Math.max(1, Math.min(10, Math.round(r.score) || 1)), by: 'claude' };
      }
      if (Object.keys(out).length >= batch.length * 0.9) return out;
      lastErr = new Error(`Claude answered ${Object.keys(out).length}/${batch.length}`);
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

function labelWithMock(batch, { categories }) {
  const names = categories.map((c) => c.name);
  const out = {};
  for (const it of batch) {
    const h = crypto.createHash('md5').update(it.key).digest();
    out[it.key] = { label: names[h[1] % names.length], score: (h[2] % 10) + 1, by: 'mock' };
  }
  return new Promise((resolve) => setTimeout(() => resolve(out), 300 + (batch.length * 37) % 500));
}

export async function labelAll(items, { labeler = 'claude', categories, context = '', model, onBatch = () => {}, onStatus = () => {}, signal } = {}) {
  const file = cachePath(labeler, categories);
  const cache = await loadCache(file);
  const cached = items.filter((it) => cache[it.key]);
  const todo = items.filter((it) => !cache[it.key]);
  const batches = [];
  for (let i = 0; i < todo.length; i += SHEET_SIZE) batches.push(todo.slice(i, i + SHEET_SIZE));

  for (let i = 0; i < cached.length; i += SHEET_SIZE) {
    onBatch(cached.slice(i, i + SHEET_SIZE).map((it) => ({ it, ...cache[it.key] })), { cached: true });
  }

  let done = 0;
  let next = 0;
  const failures = [];
  onStatus({ done, total: batches.length, cached: cached.length });
  const worker = async () => {
    while (next < batches.length) {
      if (signal?.aborted) return;
      const no = next++;
      const batch = batches[no];
      let res = {};
      try {
        res = labeler === 'mock'
          ? await labelWithMock(batch, { categories })
          : await labelWithClaude(batch, no + 1, { categories, context, model, signal });
        Object.assign(cache, res);
        await writeFile(file, JSON.stringify(cache));
      } catch (e) {
        if (signal?.aborted) return;
        failures.push(String(e.message || e));
      }
      done++;
      onStatus({ done, total: batches.length, cached: cached.length, failures: failures.length });
      onBatch(batch.map((it) => ({ it, ...(res[it.key] || { label: UNSORTED, score: 0, by: 'none' }) })), { cached: false });
    }
  };
  const parallel = labeler === 'mock' ? 4 : CLAUDE_PARALLEL;
  await Promise.all(Array.from({ length: Math.min(parallel, batches.length) }, worker));
  if (signal?.aborted) throw new Error('cancelled');
  return { failures };
}
