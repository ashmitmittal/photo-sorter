import os from 'node:os';
import path from 'node:path';
import { Pipeline, loadSettings } from '../lib/pipeline.js';
import { LABELER } from '../lib/config.js';

const args = process.argv.slice(2);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const expand = (p) => path.resolve(String(p).replace(/^~(?=$|\/)/, os.homedir()));
const folders = args.filter((a) => !a.startsWith('--'));
const settings = await loadSettings();
const sources = folders.length ? folders.map(expand) : settings.sources;
if (!sources.length) {
  console.log('Usage: npm run sort -- "<photos folder>" ["<another folder>"] [--out="<output folder>"] [--context="Trip to …"] [--model=sonnet|opus|haiku]');
  process.exit(1);
}
const out = expand(opt('out') || (folders.length ? path.join(path.dirname(sources[0]), 'Sorted') : settings.out));
console.log(`Sorting ${sources.map((s) => path.basename(s)).join(', ')}\n→ ${out}  (labels: ${LABELER})`);

const p = new Pipeline();
let last = 0;
p.on('stage', (e) => console.log(`\n== ${e.stage}`));
p.on('start', (e) => console.log(`${e.total} files: ${e.photos} photos, ${e.videos} videos`));
p.on('progress', (e) => {
  const now = Date.now();
  if (now - last < 2000 && e.done !== e.total) return;
  last = now;
  console.log(`  ${e.stage} ${e.done}/${e.total}${e.failures ? ` (${e.failures} failed)` : ''}`);
});
p.on('done', (e) => console.log('\nDone', JSON.stringify(e.totals), `originals changed: ${e.verified.changed} of ${e.verified.checked}`, e.failures ? `label failures: ${e.failures}` : ''));
process.on('SIGINT', () => p.cancel());

const t0 = Date.now();
await p.run({
  sources, out,
  context: opt('context') ?? settings.context,
  model: opt('model') ?? settings.model,
  categories: settings.categories,
  best: settings.best,
});
console.log(`Took ${Math.round((Date.now() - t0) / 1000)}s`);
