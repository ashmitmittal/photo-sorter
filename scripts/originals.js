import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA } from '../lib/config.js';
import { listAllFiles } from '../lib/discover.js';
import { loadSettings } from '../lib/pipeline.js';
import { writeFile } from '../lib/safefs.js';

const SNAP = path.join(DATA, 'originals-snapshot.json');
const mode = process.argv[2];
const given = process.argv.slice(3).map((d) => path.resolve(d));
const dirs = given.length ? given : (await loadSettings()).sources;

const sha256 = (abs) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(abs, { flags: 'r' }).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

async function take() {
  const files = await listAllFiles(dirs);
  const out = {};
  let n = 0;
  for (const abs of files) {
    const st = await fsp.stat(abs);
    out[abs] = { size: st.size, mtimeMs: st.mtimeMs, sha256: await sha256(abs) };
    if (++n % 100 === 0) process.stdout.write(`  ${n}/${files.length}\r`);
  }
  return out;
}

if (mode === 'snapshot') {
  const files = await take();
  await writeFile(SNAP, JSON.stringify({ createdAt: new Date().toISOString(), files }, null, 1));
  console.log(`Snapshot of ${Object.keys(files).length} original files saved.`);
} else if (mode === 'verify') {
  const before = JSON.parse(await fsp.readFile(SNAP, 'utf8'));
  const now = await take();
  const problems = [];
  for (const [rel, b] of Object.entries(before.files)) {
    const a = now[rel];
    if (!a) problems.push(`MISSING  ${rel}`);
    else if (a.sha256 !== b.sha256 || a.size !== b.size) problems.push(`CHANGED  ${rel}`);
    else if (a.mtimeMs !== b.mtimeMs) problems.push(`TOUCHED  ${rel}`);
  }
  for (const rel of Object.keys(now)) if (!before.files[rel]) problems.push(`NEW      ${rel}`);
  console.log(`Checked ${Object.keys(before.files).length} originals against snapshot from ${before.createdAt}.`);
  if (problems.length) {
    console.log(problems.join('\n'));
    process.exit(1);
  }
  console.log('All originals identical: same bytes, same size, same modified time. Nothing moved, edited or deleted.');
} else {
  console.log('Usage: npm run snapshot|verify -- [photo folders]   (defaults to the folders from the last sort)');
}
