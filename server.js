import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import {
  APP, HOST, PORT, TILE, LABELER, IS_MAC, MODELS,
  DEFAULT_CATEGORIES, DEFAULT_BEST, DEFAULT_MODEL, isPrivate, setPrivate, PRIVACY_LOCKED,
} from './lib/config.js';
import { inspectFolder, suggestFolders } from './lib/discover.js';
import {
  Pipeline, loadResult, loadSettings, saveSettings, deriveTitle, STAGES, readJson, RESULT, clientResult,
} from './lib/pipeline.js';
import { guardRun } from './lib/safefs.js';
import { claudeAvailable } from './lib/claude.js';
import { findMedia, thumbFile, fullFile, videoFile, sendFile } from './lib/images.js';
import { applyFix, undoFix } from './lib/fixes.js';

const PUBLIC = path.join(APP, 'public');
const FONT = path.join(APP, 'node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const pkg = JSON.parse(await fs.readFile(path.join(APP, 'package.json'), 'utf8'));

const pipeline = new Pipeline();
const clients = new Set();
let claude = null;
let live = null;

const send = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
const broadcast = (type, data) => clients.forEach((res) => send(res, type, data));
const tilde = (p) => (p && p.startsWith(os.homedir() + path.sep) ? `~${p.slice(os.homedir().length)}` : p);
const expand = (p) => path.resolve(String(p).trim().replace(/^~(?=$|\/)/, os.homedir()));
const scrub = (msg) => String(msg).replace(/(^|\s)\/[^\s'"]+/g, '$1…');

let pendingItems = [];
let itemTimer = null;
const flushItems = () => {
  itemTimer = null;
  if (pendingItems.length) broadcast('items', pendingItems);
  pendingItems = [];
};
let lastProgress = 0;
let lastProgressStage = '';

pipeline.on('stage', (e) => {
  flushItems();
  live.stage = e.stage;
  live.stageAt[e.stage] = Date.now();
  broadcast('stage', e);
});
pipeline.on('start', (e) => {
  Object.assign(live, e, { items: new Array(e.total).fill(null) });
  broadcast('start', e);
});
pipeline.on('item', (e) => {
  live.items[e.id] = { ...e, f: null };
  pendingItems.push(e);
  if (!itemTimer) itemTimer = setTimeout(flushItems, 120);
});
pipeline.on('sorted', (list) => {
  flushItems();
  for (const s of list) if (live.items[s.id]) live.items[s.id].f = s.folder;
  broadcast('sorted', list);
});
pipeline.on('progress', (e) => {
  live.progress[e.stage] = e;
  const now = Date.now();
  if (now - lastProgress > 120 || e.done === e.total || e.done === 0 || e.stage !== lastProgressStage) {
    lastProgress = now;
    lastProgressStage = e.stage;
    broadcast('progress', e);
  }
});
pipeline.on('done', (e) => {
  live.stage = 'done';
  live.done = e;
  broadcast('done', e);
});

async function state() {
  if (!claude) claude = await claudeAvailable();
  const settings = await loadSettings();
  settings.out = tilde(settings.out);
  const last = await readJson(RESULT, null);
  return {
    app: { name: 'Photo Sorter', version: pkg.version },
    privacy: isPrivate(),
    privacyLocked: PRIVACY_LOCKED,
    tile: TILE,
    labeler: LABELER,
    canPick: IS_MAC,
    claude,
    models: MODELS,
    stages: STAGES,
    defaults: { categories: DEFAULT_CATEGORIES, best: DEFAULT_BEST, model: DEFAULT_MODEL },
    settings,
    suggestions: await suggestFolders(),
    running: pipeline.running,
    last: last ? { title: last.title, createdAt: last.createdAt, totals: last.totals, out: last.out } : null,
  };
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2e5) throw new Error('Request too large');
  }
  return body ? JSON.parse(body) : {};
}

function pickFolder(prompt) {
  return new Promise((resolve) => {
    if (!IS_MAC) return resolve({ unsupported: true });
    const safe = String(prompt || 'Choose a folder').replace(/["\\]/g, '');
    execFile('osascript', ['-e', `POSIX path of (choose folder with prompt "${safe}")`], { timeout: 600000 }, (err, stdout) => {
      if (err) return resolve({ cancelled: true });
      return resolve({ path: stdout.trim().replace(/\/$/, '') });
    });
    return undefined;
  });
}

const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const sameSite = (req) => {
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
};

async function serveStatic(res, pathname) {
  if (pathname === '/font.woff2') {
    res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=86400' });
    return res.end(await fs.readFile(FONT));
  }
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !TYPES[path.extname(file)]) return false;
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)], 'cache-control': 'no-store' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

async function handle(req, res) {
  if (!allowedHosts.has(req.headers.host)) return json(res, 403, { error: 'Forbidden host' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/') && !sameSite(req)) return json(res, 403, { error: 'Forbidden site' });

  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return json(res, 403, { error: 'Forbidden origin' });
    if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { error: 'JSON only' });
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/api/media/')) {
    if (isPrivate()) return json(res, 403, { error: 'Privacy mode is on' });
    const [, , , kind, key] = url.pathname.split('/');
    const hit = await findMedia(String(key || ''), pipeline.live);
    if (!hit) return json(res, 404, { error: 'Not found' });
    if (kind === 'thumb') {
      const file = await thumbFile(key, url.searchParams.get('s'));
      if (!file) return json(res, 404, { error: 'No preview' });
      return sendFile(req, res, file, 'image/jpeg', 'private, max-age=86400, immutable');
    }
    if (kind === 'full') {
      const f = await fullFile(key, hit);
      if (!f) return json(res, 404, { error: 'Not a photo' });
      return sendFile(req, res, f.file, f.type, 'private, max-age=3600');
    }
    if (kind === 'video') {
      const f = videoFile(hit);
      if (!f) return json(res, 404, { error: 'Not a video' });
      return sendFile(req, res, f.file, f.type, 'private, max-age=3600');
    }
    return json(res, 404, { error: 'Not found' });
  }

  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    if (await serveStatic(res, url.pathname)) return undefined;
    return json(res, 404, { error: 'Not found' });
  }

  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await state());

  if (req.method === 'GET' && url.pathname === '/api/result') {
    const r = await loadResult();
    return r ? json(res, 200, { ...r, outDisplay: tilde(r.out) }) : json(res, 404, { error: 'No sort yet' });
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    send(res, 'snapshot', live ? { ...live, running: pipeline.running } : { stage: 'idle', running: false });
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return undefined;
  }

  if (req.method === 'POST' && url.pathname === '/api/inspect') {
    const { paths } = await readBody(req);
    const folders = [];
    for (const p of (Array.isArray(paths) ? paths : []).slice(0, 50)) {
      try {
        const f = await inspectFolder(expand(p));
        folders.push({ ...f, display: tilde(f.path) });
      } catch {
        folders.push({ path: String(p), name: path.basename(String(p)), error: 'Folder not found' });
      }
    }
    const first = folders.find((f) => !f.error);
    return json(res, 200, { folders, suggestedOut: first ? tilde(path.join(path.dirname(first.path), 'Sorted')) : '' });
  }

  if (req.method === 'POST' && url.pathname === '/api/pick-folder') {
    const { prompt } = await readBody(req);
    return json(res, 200, await pickFolder(prompt));
  }

  if (req.method === 'POST' && url.pathname === '/api/start') {
    if (pipeline.running) return json(res, 409, { error: 'A sort is already running' });
    const body = await readBody(req);
    const sources = (Array.isArray(body.sources) ? body.sources : []).map(expand);
    if (!sources.length) return json(res, 400, { error: 'Add at least one photos folder' });
    if (!body.out) return json(res, 400, { error: 'Choose where the sorted copies should go' });
    try {
      body.out = expand(body.out);
      guardRun(sources, body.out);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    if (LABELER === 'claude') {
      claude = await claudeAvailable();
      if (!claude.ok) return json(res, 400, { error: 'Claude Code is not installed or not on your PATH. Install it from claude.com/claude-code, then try again.' });
    }
    const categories = (Array.isArray(body.categories) ? body.categories : [])
      .map((c) => ({ name: String(c.name || '').trim().slice(0, 40), hint: String(c.hint || '').trim().slice(0, 300) }))
      .filter((c) => c.name && !/[/\\:]/.test(c.name));
    live = {
      stage: 'starting', startedAt: Date.now(), stageAt: {}, progress: {}, items: [], done: null, error: null,
      title: deriveTitle(sources.map((s) => path.basename(s))), total: 0,
    };
    broadcast('snapshot', { ...live, running: true });
    pipeline.run({ sources, out: body.out, categories, context: body.context, model: body.model, best: body.best }).catch((e) => {
      const cancelled = e.message === 'cancelled';
      if (!cancelled) console.error(e);
      live.stage = cancelled ? 'cancelled' : 'failed';
      live.error = cancelled ? null : scrub(e.message || e);
      broadcast(cancelled ? 'cancelled' : 'fail', { message: live.error });
    });
    return json(res, 202, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/cancel') return json(res, 200, { ok: pipeline.cancel() });

  if (req.method === 'POST' && url.pathname === '/api/privacy') {
    const { on } = await readBody(req);
    if (PRIVACY_LOCKED && !on) return json(res, 403, { error: 'Privacy mode is locked on for this session. Restart without --privacy=on to show photos.' });
    const now = setPrivate(on);
    await saveSettings({ privacy: now });
    broadcast('privacy', { on: now });
    return json(res, 200, { privacy: now });
  }

  if (req.method === 'POST' && (url.pathname === '/api/fix' || url.pathname === '/api/undo')) {
    if (pipeline.running) return json(res, 409, { error: 'Wait for the sort to finish first.' });
    const body = url.pathname === '/api/fix' ? await readBody(req) : {};
    try {
      const out = url.pathname === '/api/fix' ? await applyFix(body) : await undoFix();
      const result = clientResult(out.r, out.f);
      return json(res, 200, { message: out.message, changed: out.changed, problems: out.problems, result: { ...result, outDisplay: tilde(result.out) } });
    } catch (e) {
      if (e.status) return json(res, e.status, { error: e.message });
      throw e;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/reveal') {
    const { key } = await readBody(req);
    const r = await readJson(RESULT, null);
    if (isPrivate()) return json(res, 403, { error: 'Not available in privacy mode' });
    if (!IS_MAC || !r?.out) return json(res, 400, { error: 'Only available on macOS' });
    if (key) {
      const hit = await findMedia(String(key), null);
      if (!hit) return json(res, 404, { error: 'Not found' });
      execFile('open', ['-R', hit.abs]);
    } else {
      execFile('open', [r.out]);
    }
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Not found' });
}

function openBrowser(url) {
  if (IS_MAC) execFile('open', [url]);
  else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
  else execFile('xdg-open', [url], () => {});
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: scrub(e.message || e) });
    else res.end();
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is busy. Photo Sorter is probably already running at http://${HOST}:${PORT}`);
    if (process.argv.includes('--open')) openBrowser(`http://${HOST}:${PORT}`);
    setTimeout(() => process.exit(0), 300);
    return;
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  console.log(`Photo Sorter is running at http://${HOST}:${PORT}`);
  console.log(`Privacy mode ${isPrivate() ? 'on' : 'off'} · labels by ${LABELER === 'claude' ? 'AI' : 'demo labeler'} · press Ctrl+C to stop`);
  if (process.argv.includes('--open')) openBrowser(`http://${HOST}:${PORT}`);
});
