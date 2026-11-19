import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA, MODELS, DEFAULT_MODEL, DEFAULT_CATEGORIES, DEFAULT_BEST } from './config.js';
import { writeFile } from './safefs.js';

export const RESULT = path.join(DATA, 'result.json');
export const SETTINGS = path.join(DATA, 'settings.json');
export const FIXES = path.join(DATA, 'fixes.json');

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function loadSettings() {
  const s = await readJson(SETTINGS, {});
  return {
    sources: Array.isArray(s.sources) ? s.sources : [],
    out: s.out || '',
    context: s.context || '',
    model: MODELS.includes(s.model) ? s.model : DEFAULT_MODEL,
    categories: Array.isArray(s.categories) && s.categories.length ? s.categories : DEFAULT_CATEGORIES,
    best: Number(s.best) > 0 ? Number(s.best) : DEFAULT_BEST,
  };
}

export async function saveSettings(patch) {
  const s = await readJson(SETTINGS, {});
  await writeFile(SETTINGS, JSON.stringify({ ...s, ...patch }, null, 1));
}
