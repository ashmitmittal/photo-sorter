import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA, APP, IS_MAC } from './config.js';

const run = promisify(execFile);

export function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fss.realpathSync(cur), ...rest.reverse());
    } catch {
      rest.push(path.basename(cur));
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      cur = up;
    }
  }
}

export const isInside = (child, parent) => {
  const c = realish(child);
  const p = realish(parent);
  return c === p || c.startsWith(p + path.sep);
};

let outRoot = null;
let protectedRoots = [];
let tmpSeq = 0;

export function guardRun(sources, out) {
  const o = realish(out);
  const banned = [path.parse(o).root, realish(os.homedir()), realish(path.join(os.homedir(), 'Desktop')),
    realish(path.join(os.homedir(), 'Pictures')), realish(path.join(os.homedir(), 'Documents'))];
  if (banned.includes(o)) throw new Error('Pick a dedicated output folder, not a top-level folder like Desktop or your home folder.');
  if (isInside(o, APP) || isInside(APP, o)) throw new Error('The output folder cannot be inside the app folder.');
  for (const d of sources) {
    if (isInside(o, d)) throw new Error(`The output folder is inside a photo folder (${path.basename(d)}). Pick a folder outside it.`);
    if (isInside(d, o)) throw new Error(`The photo folder ${path.basename(d)} is inside the output folder. Pick a different output folder.`);
    if (isInside(d, DATA) || isInside(DATA, d)) throw new Error('A photo folder overlaps the app data folder.');
  }
  outRoot = o;
  protectedRoots = sources.map(realish);
}

export function assertWritable(p) {
  const rp = realish(p);
  const allowed = [outRoot, DATA].filter(Boolean).some((root) => isInside(rp, root));
  const hitsSource = protectedRoots.some((src) => rp === src || rp.startsWith(src + path.sep));
  if (!allowed || hitsSource) throw new Error(`Safety guard: refusing to write ${p}`);
  return rp;
}

export async function mkdirp(dir) {
  assertWritable(dir);
  await fs.mkdir(dir, { recursive: true });
}

export async function writeFile(file, data) {
  assertWritable(file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${++tmpSeq}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

export async function cloneCopy(src, dest) {
  assertWritable(dest);
  if (realish(src) === realish(dest)) throw new Error('Safety guard: source and destination are the same file');
  if (fss.existsSync(dest)) throw Object.assign(new Error(`EEXIST: ${dest}`), { code: 'EEXIST' });
  if (IS_MAC) {
    try {
      // Node's COPYFILE_FICLONE makes full copies on macOS; cp -c uses clonefile(2).
      await run('/bin/cp', ['-c', '-p', '-n', '--', src, dest]);
      if (fss.existsSync(dest)) return;
    } catch {}
  }
  await fs.copyFile(src, dest, fss.constants.COPYFILE_EXCL | fss.constants.COPYFILE_FICLONE);
}

// Both ends pass the guard, so nothing inside a photo folder can ever be moved.
export async function moveWithin(src, dest) {
  assertWritable(src);
  assertWritable(dest);
  const caseOnly = src !== dest && src.toLowerCase() === dest.toLowerCase();
  if (src === dest) return;
  if (!caseOnly && fss.existsSync(dest)) throw Object.assign(new Error(`EEXIST: ${dest}`), { code: 'EEXIST' });
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (caseOnly) {
    const tmp = `${dest}.rename-${process.pid}-${++tmpSeq}`;
    await fs.rename(src, tmp);
    await fs.rename(tmp, dest);
  } else {
    await fs.rename(src, dest);
  }
}

export async function removeFile(file) {
  assertWritable(file);
  await fs.rm(file, { force: true });
}

export async function removeDirIfEmpty(dir) {
  assertWritable(dir);
  try {
    await fs.rmdir(dir);
    return true;
  } catch {
    return false;
  }
}
