import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : 'on';
};

export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.resolve(process.env.SORTER_DATA || path.join(APP, 'data'));

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.SORTER_PORT || flag('port') || 8765);
export const IS_MAC = process.platform === 'darwin';

// --privacy=on|off at launch wins over the saved setting; with neither, photos are shown.
const PRIVACY_FLAG = flag('privacy') ?? process.env.SORTER_PRIVACY;
const savedPrivacy = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')).privacy;
  } catch {
    return undefined;
  }
})();
let privacyOn = PRIVACY_FLAG !== undefined ? PRIVACY_FLAG !== 'off' : savedPrivacy === true;
// Starting with --privacy=on locks it, so no photo can appear during a screen recording.
export const PRIVACY_LOCKED = PRIVACY_FLAG !== undefined && PRIVACY_FLAG !== 'off';
export const isPrivate = () => privacyOn;
export function setPrivate(on) {
  privacyOn = PRIVACY_LOCKED || Boolean(on);
  return privacyOn;
}
export const TILE = 8;

export const LABELER = flag('labeler') || process.env.SORTER_LABELER || 'claude';
export const MODELS = ['sonnet', 'opus', 'haiku'];
export const DEFAULT_MODEL = MODELS.includes(process.env.SORTER_MODEL) ? process.env.SORTER_MODEL : 'sonnet';
export const PLACES_MODEL = MODELS.includes(process.env.SORTER_PLACES_MODEL) ? process.env.SORTER_PLACES_MODEL : 'opus';
export const CLAUDE_PARALLEL = Number(process.env.SORTER_PARALLEL || 4);
export const SHEET_SIZE = 25;

export const DEFAULT_CATEGORIES = JSON.parse(fs.readFileSync(path.join(APP, 'categories.json'), 'utf8'));
export const DEFAULT_BEST = 40;

export const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.heic', '.heif', '.png', '.webp']);
export const VIDEO_EXT = new Set(['.mov', '.mp4', '.m4v', '.3gp']);

export const VIDEOS = 'Videos';
export const UNSORTED = 'Unsorted';
export const DUPLICATES = 'Duplicates';
export const BEST = 'Best shots';
export const PLACE_UNKNOWN = 'No location';
export const PLACE_BORROW_MS = 2 * 60 * 60 * 1000;
