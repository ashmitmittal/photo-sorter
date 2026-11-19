import {
  $, $$, esc, fmt, plural, duration, timeAgo, store, api, icon, typeIcon, media, avgColor, toast, clock,
} from './util.js';
import { hexToCanvas, TileCanvas } from './tiles.js';
import { Showcase } from './showcase.js';
import { Stage, FolderCard, SpriteBank } from './sphere.js';
import { VirtualGrid } from './grid.js';
import { Lightbox } from './lightbox.js';
import { menu, closeMenu, menuOpen, dialog, shortcutsDialog } from './ui.js';

const view = $('#view');
let APP = null;
let RESULT = null;
let keyIndex = new Map();
let current = null;
let showcase = null;

const privacy = () => Boolean(APP?.privacy);
const canReveal = () => !privacy() && Boolean(APP?.canPick);
const MOD = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';

const STAGE_INFO = {
  scan: ['Reading photos', 'Dates, places and a small preview of every file'],
  dupes: ['Finding duplicates', 'Exact copies, re-saves and burst shots'],
  label: ['AI labels each photo', 'Numbered contact sheets, 25 photos at a time'],
  organize: ['Grouping by day and place', 'AI names the places from GPS'],
  copy: ['Making copies', 'Clones on macOS, so no extra disk space'],
};
const DUP_REASON = { exact: 'Exact copy', similar: 'Re-saved', burst: 'Burst shot' };
const SIZES = { s: 132, m: 190, l: 280 };

function setResult(r) {
  RESULT = r;
  keyIndex = new Map(r ? r.items.map((it, i) => [it.key, i]) : []);
}

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set('theme', t);
  $('#themeBtn').innerHTML = icon(t === 'dark' ? 'sun' : 'moon');
}
const currentTheme = () => document.documentElement.dataset.theme
  || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

function renderPrivacyToggle() {
  const on = privacy();
  const locked = Boolean(APP?.privacyLocked);
  const b = $('#privacyBtn');
  b.setAttribute('aria-checked', String(!on));
  b.setAttribute('aria-disabled', String(locked));
  b.classList.toggle('locked', locked);
  $('.pv-label', b).textContent = locked ? 'Privacy locked' : on ? 'Privacy mode' : 'Photos shown';
  $('.pv-ic', b).innerHTML = icon(on ? 'lock' : 'eye');
  b.title = locked
    ? 'Locked on: the app was started with --privacy=on, so pictures stay hidden. Restart without it to show photos.'
    : on ? 'Pictures are hidden and shown only as colour tiles. Click to show photos.' : 'Click to hide every picture (privacy mode).';
  document.documentElement.classList.toggle('private', on);
}

function applyPrivacy(on) {
  if (APP.privacy === on) return;
  APP.privacy = on;
  if (RESULT) RESULT.privacy = on;
  renderPrivacyToggle();
  if (lightbox.isOpen) {
    lightbox.show();
    return;
  }
  route();
}

async function togglePrivacy() {
  if (APP.privacyLocked) {
    toast('Privacy mode is locked on. Restart without --privacy=on to show photos.');
    return;
  }
  try {
    const r = await api('/api/privacy', { on: !privacy() });
    applyPrivacy(r.privacy);
    toast(r.privacy ? 'Privacy mode on: pictures are hidden.' : 'Showing photos.');
  } catch (e) {
    toast(e.message, { kind: 'warn' });
  }
}

const lightbox = new Lightbox({
  result: () => RESULT,
  privacy,
  canReveal,
  fix: (body) => fix(body),
  undo: () => undo(),
  moveMenu: (anchor, keys) => moveMenu(anchor, keys),
  moveToNumber: (n, keys) => moveToNumber(n, keys),
  reveal: (key) => api('/api/reveal', { key }).catch((e) => toast(e.message, { kind: 'warn' })),
  onClose: (idx) => {
    if (current !== 'folder' || !FV.grid) return;
    const pos = FV.list.indexOf(idx);
    if (pos !== -1) {
      FV.focus = pos;
      FV.grid.scrollTo(pos);
      FV.grid.refresh();
    }
  },
});


const live = { stage: 'idle', items: [], counts: {}, progress: {}, total: 0 };
const liveUI = {};

function resetLive(s) {
  Object.assign(live, {
    stage: s.stage, title: s.title || '', total: s.total || 0, photos: s.photos || 0, videos: s.videos || 0,
    startedAt: s.startedAt || Date.now(), stageAt: s.stageAt || {}, progress: s.progress || {},
    error: s.error || null, done: s.done || null, items: [], counts: {}, sorted: 0,
  });
  for (const it of s.items || []) {
    if (!it) continue;
    live.items[it.id] = it;
    if (it.f) {
      live.counts[it.f] = (live.counts[it.f] || 0) + 1;
      live.sorted++;
    }
  }
}

function liveCard(name) {
  if (!liveUI.cards.has(name)) {
    const card = new FolderCard($('#lsCards'), liveUI.bank, { name, iconName: typeIcon(name), rows: 2, cell: 34 });
    liveUI.cards.set(name, card);
  }
  return liveUI.cards.get(name);
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', (e) => {
    const s = JSON.parse(e.data);
    resetLive(s);
    if (s.running && current !== 'sorting') location.hash = '#/sorting';
    else if (current === 'sorting') renderSorting();
  });
  es.addEventListener('start', (e) => {
    const s = JSON.parse(e.data);
    Object.assign(live, { total: s.total, photos: s.photos, videos: s.videos, title: s.title, items: [], counts: {}, sorted: 0 });
    if (current === 'sorting') renderSorting();
  });
  es.addEventListener('stage', (e) => {
    const { stage } = JSON.parse(e.data);
    live.stage = stage;
    live.stageAt[stage] = Date.now();
    if (current === 'sorting') updateSorting();
  });
  es.addEventListener('items', (e) => {
    for (const it of JSON.parse(e.data)) {
      live.items[it.id] = it;
      if (current === 'sorting' && liveUI.stage) {
        liveUI.bank.add(it.id, it);
        liveUI.stage.add(it.id);
      }
    }
  });
  es.addEventListener('progress', (e) => {
    const p = JSON.parse(e.data);
    live.progress[p.stage] = p;
    if (current === 'sorting') updateSorting();
  });
  es.addEventListener('sorted', (e) => {
    for (const s of JSON.parse(e.data)) {
      if (live.items[s.id]) live.items[s.id].f = s.folder;
      live.counts[s.folder] = (live.counts[s.folder] || 0) + 1;
      if (current === 'sorting' && liveUI.stage) {
        const card = liveCard(s.folder);
        liveUI.stage.enqueue(s.id, card, () => {
          card.land(s.id);
          live.sorted++;
          const el = $('#lsDone');
          if (el) el.textContent = fmt(live.sorted);
        });
      } else {
        live.sorted++;
      }
    }
  });
  es.addEventListener('done', async () => {
    live.stage = 'done';
    setResult(null);
    APP = await api('/api/state');
    if (current === 'sorting' && liveUI.stage) await liveUI.stage.idle(5000);
    location.hash = '#/results?play=1';
  });
  es.addEventListener('fail', (e) => {
    live.stage = 'failed';
    live.error = JSON.parse(e.data).message;
    if (current === 'sorting') renderSorting();
  });
  es.addEventListener('cancelled', () => {
    live.stage = 'cancelled';
    toast('Sorting cancelled. Nothing was changed in your photo folders.');
    location.hash = '#/';
  });
  es.addEventListener('privacy', (e) => applyPrivacy(JSON.parse(e.data).on));
}


const form = { sources: [], out: '', outTouched: false, context: '', model: 'sonnet', categories: [], best: 40 };

async function initForm() {
  const s = APP.settings;
  Object.assign(form, {
    out: s.out, outTouched: Boolean(s.out), context: s.context, model: s.model,
    categories: s.categories.map((c) => ({ ...c })), best: s.best, sources: [],
  });
  if (s.sources.length) {
    const r = await api('/api/inspect', { paths: s.sources });
    form.sources = r.folders.filter((f) => !f.error);
  }
}

async function addPaths(paths) {
  const r = await api('/api/inspect', { paths });
  for (const f of r.folders) {
    if (f.error) toast(`Couldn’t open “${f.name}”. Check the path.`, { kind: 'warn' });
    else if (f.sortedOutput) toast(`“${f.name}” is a sorted output folder. Pick the original photos instead.`, { kind: 'warn' });
    else if (form.sources.some((x) => x.path === f.path)) toast(`“${f.name}” is already added.`);
    else if (!f.photos && !f.videos) toast(`No photos or videos found in “${f.name}”.`, { kind: 'warn' });
    else form.sources.push(f);
  }
  if (!form.outTouched && form.sources.length) {
    const first = await api('/api/inspect', { paths: [form.sources[0].path] });
    form.out = first.suggestedOut;
  }
  renderSources();
}

function totals() {
  const photos = form.sources.reduce((n, f) => n + f.photos, 0);
  const videos = form.sources.reduce((n, f) => n + f.videos, 0);
  return { photos, videos, files: photos + videos };
}

function estimate(t) {
  const sheets = Math.ceil((t.photos * 0.85) / 25);
  const sec = t.files * 0.12 + Math.ceil(sheets / 4) * 22 + 10;
  return sec < 90 ? 'about a minute' : `about ${Math.round(sec / 60)} min`;
}

function renderSort() {
  current = 'sort';
  const claudeMissing = APP.labeler === 'claude' && !APP.claude?.ok;
  view.innerHTML = `
    ${APP.running ? `<div class="banner">${icon('spark')} A sort is running. <a href="#/sorting">View progress</a></div>` : ''}
    <section class="hero">
      <p class="eyebrow">${icon('laptop')} Runs on your computer · Powered by AI</p>
      <h1>Sort your photos with AI</h1>
      <p class="lede">Choose a folder. The AI looks at every photo and files a copy by what’s in it, the day it was taken and the place. It picks your best shots and sets duplicates aside. Your originals are never changed.</p>
    </section>
    ${claudeMissing ? `<div class="banner warn">${icon('alert')} Claude Code isn’t installed or isn’t on your PATH. Install it from <a href="https://claude.com/claude-code" target="_blank" rel="noreferrer">claude.com/claude-code</a>, then reload this page.</div>` : ''}
    <div class="layout">
      <section class="card setup">
        <div class="step"><span class="step-n">1</span><div><h2>Photos to sort</h2><p class="muted">Add one or more folders. Subfolders are included.</p></div></div>
        <div id="sources"></div>
        <div class="add-row">
          <button class="btn secondary" id="browseBtn">${icon('folder')} Choose folder…</button>
          <form class="path-form" id="pathForm"><input class="input" id="pathInput" placeholder="or paste a folder path" spellcheck="false" autocomplete="off"><button class="btn ghost" type="submit">Add</button></form>
        </div>
        <div id="suggest"></div>

        <div class="step"><span class="step-n">2</span><div><h2>Save sorted copies to</h2><p class="muted">A new folder. Your originals stay where they are.</p></div></div>
        <div class="out-row">
          <input class="input mono" id="outInput" spellcheck="false" placeholder="Choose a folder for the sorted copies">
          <button class="btn ghost" id="outBtn">Change…</button>
        </div>

        <details class="advanced" id="advanced">
          <summary>Advanced options</summary>
          <div class="adv-grid">
            <label class="field wide"><span>About these photos <em>optional</em></span>
              <input class="input" id="contextInput" maxlength="300" placeholder="e.g. Trip to Kasol and Kheerganga with college friends, Aug 2022"></label>
            <div class="field wide"><span>Folders by type <em>every photo goes in one of these</em></span>
              <div class="cats" id="cats"></div>
              <form class="cat-form" id="catForm">
                <input class="input" id="catName" maxlength="40" placeholder="New folder, e.g. Pets">
                <input class="input" id="catHint" maxlength="200" placeholder="What goes in it (optional)">
                <button class="btn ghost" type="submit">${icon('plus')} Add</button>
              </form>
              <button class="link" id="catReset" type="button">Reset to defaults</button>
            </div>
            <label class="field"><span>AI model</span>
              <select class="input" id="modelSelect">
                <option value="sonnet">Sonnet: balanced (recommended)</option>
                <option value="opus">Opus: most careful, slower</option>
                <option value="haiku">Haiku: fastest</option>
              </select></label>
            <label class="field"><span>Best shots to pick</span><input class="input" id="bestInput" type="number" min="1" max="500"></label>
          </div>
        </details>

        <div class="start-bar">
          <div class="start-summary" id="summary"></div>
          <button class="btn primary lg" id="startBtn">Start sorting ${icon('arrow')}</button>
        </div>
      </section>

      <aside class="side">
        ${APP.last ? `<section class="card last">
          <p class="eyebrow">Last sort · ${esc(timeAgo(APP.last.createdAt))}</p>
          <h3>${esc(APP.last.title)}</h3>
          <p class="muted">${plural(APP.last.totals.files, 'file')} · ${plural(APP.last.totals.best, 'best shot')} · ${plural(APP.last.totals.duplicates, 'duplicate')}</p>
          <a class="btn primary block" href="#/results">Browse and fix ${icon('arrow')}</a>
        </section>` : ''}
        <section class="card info">
          <h3>What you get</h3>
          <ul class="ticks">
            <li>${icon('tag')}<span><b>By type</b>: your folders, one label per photo</span></li>
            <li>${icon('day')}<span><b>By day</b>: Day 1, Day 2… or by date</span></li>
            <li>${icon('pin')}<span><b>By place</b>: named from GPS</span></li>
            <li>${icon('star')}<span><b>Best shots</b>: the top-scoring photos</span></li>
            <li>${icon('dup')}<span><b>Duplicates</b>: copies, re-saves and bursts</span></li>
            <li>${icon('edit')}<span><b>Fixes</b>: move a photo, restore a duplicate, undo</span></li>
          </ul>
        </section>
        <section class="card info">
          <h3>Private by design</h3>
          <ul class="ticks">
            <li>${icon('laptop')}<span>Runs on localhost, no accounts. Your originals never leave this computer; the AI sees small previews to label them.</span></li>
            <li>${icon('shield')}<span>Originals are only read, then checked again after every sort.</span></li>
            <li>${icon('lock')}<span>${privacy() ? 'Privacy mode is on: photos show as colour tiles, never as pictures.' : 'Photos are shown. Switch on privacy mode in the top bar to hide every picture.'}</span></li>
          </ul>
        </section>
      </aside>
    </div>`;

  $('#browseBtn').onclick = async () => {
    if (!APP.canPick) {
      $('#pathInput').focus();
      return toast('Paste the folder path in the box next to the button.');
    }
    const r = await api('/api/pick-folder', { prompt: 'Choose a folder with photos' });
    if (r.path) await addPaths([r.path]);
    return undefined;
  };
  $('#pathForm').onsubmit = async (e) => {
    e.preventDefault();
    const v = $('#pathInput').value.trim();
    if (!v) return;
    await addPaths([v]);
    $('#pathInput').value = '';
  };
  $('#outInput').value = form.out;
  $('#outInput').oninput = (e) => { form.out = e.target.value; form.outTouched = true; };
  $('#outBtn').onclick = async () => {
    if (!APP.canPick) return $('#outInput').focus();
    const r = await api('/api/pick-folder', { prompt: 'Choose where to create the Sorted folder' });
    if (r.path) {
      const picked = (await api('/api/inspect', { paths: [r.path] })).folders[0];
      const base = picked?.display || r.path;
      form.out = /\/Sorted$/i.test(base) ? base : `${base}/Sorted`;
      form.outTouched = true;
      $('#outInput').value = form.out;
    }
    return undefined;
  };
  $('#contextInput').value = form.context;
  $('#contextInput').oninput = (e) => { form.context = e.target.value; };
  $('#modelSelect').value = form.model;
  $('#modelSelect').onchange = (e) => { form.model = e.target.value; };
  $('#bestInput').value = form.best;
  $('#bestInput').oninput = (e) => { form.best = Number(e.target.value) || 40; };
  $('#catForm').onsubmit = (e) => {
    e.preventDefault();
    const name = $('#catName').value.trim().replace(/[/\\:]/g, '-');
    if (!name) return;
    if (form.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) return toast('That folder already exists.');
    form.categories.push({ name, hint: $('#catHint').value.trim() });
    $('#catName').value = '';
    $('#catHint').value = '';
    renderCats();
    return undefined;
  };
  $('#catReset').onclick = () => {
    form.categories = APP.defaults.categories.map((c) => ({ ...c }));
    renderCats();
  };
  $('#startBtn').onclick = start;
  renderSources();
  renderCats();
  renderSuggest();
}

function renderSources() {
  const box = $('#sources');
  if (!box) return;
  if (!form.sources.length) {
    box.innerHTML = `<div class="empty-drop">${icon('folder')}<div><b>No folders yet</b><span>A trip folder, a camera-roll export, anything with photos.</span></div></div>`;
  } else {
    box.innerHTML = `<div class="folder-list">${form.sources.map((f, i) => `
      <div class="folder-row">
        <span class="fr-ic">${icon('folder')}</span>
        <div class="fr-main"><div class="fr-name">${esc(f.name)}</div><div class="fr-path" title="${esc(f.path)}">${esc(f.display || f.path)}</div></div>
        <div class="fr-meta">${plural(f.photos, 'photo')}<span>${plural(f.videos, 'video')}</span></div>
        <button class="icon-btn" data-remove="${i}" aria-label="Remove ${esc(f.name)}">${icon('x')}</button>
      </div>`).join('')}</div>`;
    $$('[data-remove]', box).forEach((b) => {
      b.onclick = () => {
        form.sources.splice(Number(b.dataset.remove), 1);
        renderSources();
      };
    });
  }
  if ($('#outInput') && !form.outTouched) $('#outInput').value = form.out;
  renderSuggest();
  const t = totals();
  $('#summary').innerHTML = form.sources.length
    ? `<div><b>${plural(t.photos, 'photo')}</b> and <b>${plural(t.videos, 'video')}</b></div><span>${estimate(t)} · originals are never changed</span>`
    : '<span>Add a folder to begin</span>';
  $('#startBtn').disabled = !form.sources.length;
}

function renderSuggest() {
  const box = $('#suggest');
  if (!box) return;
  const left = (APP.suggestions || []).filter((p) => !form.sources.some((f) => f.path === p));
  if (!left.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `<div class="suggest"><span class="muted">Found next to the app:</span>${left.map((p) => `<button class="chip" data-path="${esc(p)}">${icon('plus')}${esc(p.split('/').pop())}</button>`).join('')}
    ${left.length > 1 ? '<button class="link" id="addAll">Add all</button>' : ''}</div>`;
  $$('.chip[data-path]', box).forEach((b) => { b.onclick = () => addPaths([b.dataset.path]); });
  if ($('#addAll')) $('#addAll').onclick = () => addPaths(left);
}

function renderCats() {
  const box = $('#cats');
  if (!box) return;
  box.innerHTML = form.categories.map((c, i) => `<span class="cat" title="${esc(c.hint || '')}">${icon(typeIcon(c.name))}${esc(c.name)}<button type="button" data-cat="${i}" aria-label="Remove ${esc(c.name)}">${icon('x')}</button></span>`).join('');
  $$('[data-cat]', box).forEach((b) => {
    b.onclick = () => {
      if (form.categories.length <= 2) return toast('Keep at least two folders.');
      form.categories.splice(Number(b.dataset.cat), 1);
      renderCats();
      return undefined;
    };
  });
}

async function start() {
  const btn = $('#startBtn');
  btn.disabled = true;
  try {
    await api('/api/start', {
      sources: form.sources.map((f) => f.path), out: form.out.trim(), context: form.context.trim(),
      model: form.model, categories: form.categories, best: form.best,
    });
    location.hash = '#/sorting';
  } catch (e) {
    toast(e.message, { kind: 'warn' });
    btn.disabled = false;
  }
}


function renderSorting() {
  current = 'sorting';
  if (live.stage === 'idle' || live.stage === 'done') {
    location.hash = live.stage === 'done' ? '#/results' : '#/';
    return;
  }
  if (live.stage === 'failed') {
    view.innerHTML = `<div class="page-head"><div><p class="eyebrow">Sorting stopped</p><h1>Something went wrong</h1></div></div>
      <section class="card error-card">${icon('alert')}<div><p>${esc(live.error || 'Unknown error')}</p><p class="muted">Your photo folders were not changed. Fix the problem and start again.</p><a class="btn secondary" href="#/">Back to setup</a></div></section>`;
    return;
  }
  liveUI.stage?.destroy();
  view.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">Sorting</p><h1>${esc(live.title || 'Your photos')}</h1><p class="muted" id="sMeta"></p></div>
      <button class="btn secondary" id="cancelBtn">Cancel</button>
    </div>
    <section class="card prog-card">
      <ol class="stepper" id="stepper">${APP.stages.map((k, i) => `<li data-stage="${k}"><span class="st-dot"><i>${i + 1}</i>${icon('check')}</span><div><b>${STAGE_INFO[k][0]}</b><span>${STAGE_INFO[k][1]}</span></div><em class="st-time"></em></li>`).join('')}</ol>
      <div class="progress"><div class="progress-bar" id="pBar"></div></div>
      <div class="progress-meta"><span id="pText">Starting…</span><span id="pElapsed"></span></div>
    </section>
    <section class="card live-stage" id="liveStage">
      <div class="ls-side">
        <div class="sphere-slot"></div>
        <div class="ls-count"><b id="lsDone">${fmt(live.sorted || 0)}</b><span>of <span id="lsTotal">${fmt(live.total)}</span> sorted</span></div>
        <p class="muted ls-note">${privacy() ? 'Privacy mode: every photo is a colour tile.' : 'Each photo flies to its folder as it is labelled.'}</p>
      </div>
      <div class="ls-cards" id="lsCards"></div>
    </section>`;
  $('#cancelBtn').onclick = async () => {
    if (!confirm('Cancel this sort? Copies made so far stay in the output folder; your originals are not touched.')) return;
    await api('/api/cancel', {});
  };
  liveUI.bank = new SpriteBank(privacy());
  liveUI.stage = new Stage($('#liveStage'), liveUI.bank, { max: 240 });
  liveUI.cards = new Map();
  for (const name of [...(APP.settings.categories || []).map((c) => c.name), 'Videos', 'Duplicates']) liveCard(name);
  const unsorted = [];
  live.items.forEach((it, id) => {
    if (!it) return;
    liveUI.bank.add(id, it);
    if (it.f) liveCard(it.f).land(id, false);
    else unsorted.push(id);
  });
  liveUI.stage.fill(unsorted);
  updateSorting();
  clearInterval(liveUI.timer);
  liveUI.timer = setInterval(() => {
    if (current !== 'sorting') return clearInterval(liveUI.timer);
    $('#pElapsed').textContent = duration(Date.now() - live.startedAt);
    return undefined;
  }, 1000);
}

function updateSorting() {
  if (!$('#stepper')) return;
  const order = APP.stages;
  const idx = order.indexOf(live.stage);
  $$('#stepper li').forEach((li, i) => {
    li.classList.toggle('done', i < idx);
    li.classList.toggle('active', i === idx);
    const k = order[i];
    const next = order[i + 1];
    if (i < idx && live.stageAt[k] && live.stageAt[next]) $('.st-time', li).textContent = duration(live.stageAt[next] - live.stageAt[k]);
  });
  $('#sMeta').textContent = live.total ? `${plural(live.photos, 'photo')} and ${plural(live.videos, 'video')}` : 'Looking for photos…';
  if ($('#lsTotal')) $('#lsTotal').textContent = fmt(live.total);
  const p = live.progress[live.stage];
  let pct = 0;
  let text = STAGE_INFO[live.stage]?.[0] || 'Starting…';
  if (p && live.stage === 'label') {
    pct = p.total ? p.done / p.total : 1;
    text = p.total ? `Labelled ${p.done} of ${p.total} contact sheets${p.cached ? ` · ${fmt(p.cached)} photos already known` : ''}` : `All ${fmt(p.cached)} photos already labelled`;
  } else if (p && p.total) {
    pct = p.done / p.total;
    text = `${STAGE_INFO[live.stage][0]}: ${fmt(p.done)} of ${fmt(p.total)}`;
  }
  const bar = $('#pBar');
  bar.classList.toggle('indeterminate', live.stage === 'organize' || live.stage === 'starting');
  bar.style.width = `${Math.round(Math.min(1, pct) * 100)}%`;
  $('#pText').textContent = text;
}


const TABS = [
  { key: 'type', label: 'By type' },
  { key: 'day', label: 'By day' },
  { key: 'place', label: 'By place' },
  { key: 'best', label: 'Best shots' },
  { key: 'dups', label: 'Duplicates' },
];

function indices(fn) {
  const out = [];
  RESULT.items.forEach((it, i) => { if (fn(it)) out.push(i); });
  return out;
}

function folders(tab) {
  const r = RESULT;
  if (tab === 'type') {
    return r.folders.type.map((f, i) => ({
      tab, i, name: f.name, special: f.special, icon: typeIcon(f.name), path: `By type/${f.name}`, list: indices((it) => it.ty === i && !it.x),
    })).filter((f) => f.name !== 'Duplicates' && (f.list.length || !f.special));
  }
  if (tab === 'day') return r.folders.day.map((f, i) => ({ tab, i, name: f.name, sub: f.sub, icon: 'day', path: `By day/${f.dir}`, list: indices((it) => it.d === i) }));
  if (tab === 'place') return r.folders.place.map((f, i) => ({ tab, i, name: f.name, icon: 'pin', path: `By place/${f.name}`, list: indices((it) => it.p === i) }));
  if (tab === 'best') return [{ tab, i: 0, name: 'Best shots', icon: 'star', path: 'Best shots', list: indices((it) => it.b) }];
  if (tab === 'dups') return [{ tab, i: 0, name: 'Duplicates', icon: 'dup', path: 'Duplicates', list: indices((it) => it.x) }];
  return [];
}

const folderOf = (tab, i) => folders(tab).find((f) => f.i === i) || null;

function coverPicks(f) {
  const items = RESULT.items;
  if (f.tab === 'dups') return f.list.slice(0, 3);
  return [...f.list].sort((a, b) => (items[b].sc || 0) - (items[a].sc || 0) || a - b).slice(0, 3);
}

function coverHtml(f) {
  if (privacy()) return '<canvas class="bc-tiles"></canvas>';
  const picks = coverPicks(f);
  if (!picks.length) return `<div class="bc-empty">${icon('folder')}<span>Empty</span></div>`;
  return picks.map((i) => {
    const it = RESULT.items[i];
    return `<img src="${media.thumb(it)}" alt="" loading="lazy" decoding="async" style="background:${avgColor(it.t)}">`;
  }).join('');
}

function drawTileCovers(root, list) {
  $$('.bc-tiles', root).forEach((c) => {
    const f = list[Number(c.closest('[data-f]').dataset.f)];
    const tc = new TileCanvas(c, { maxCell: 40, minCell: 5 }).layout(f.list.length);
    f.list.slice(0, tc.cap).forEach((i) => tc.push(hexToCanvas(RESULT.items[i].t)));
  });
}


async function loadResultIfNeeded() {
  if (RESULT) return RESULT;
  try {
    setResult(await api('/api/result'));
  } catch {
    setResult(null);
  }
  return RESULT;
}

function stat(value, label, sub, cls = '') {
  return `<div class="stat ${cls}"><b>${esc(value)}</b><span>${esc(label)}</span>${sub ? `<em>${esc(sub)}</em>` : ''}</div>`;
}

function statsHtml() {
  const r = RESULT;
  const t = r.totals;
  return `
    ${stat(fmt(t.files), 'files sorted', `${plural(t.photos, 'photo')} · ${plural(t.videos, 'video')}`)}
    ${stat(fmt(t.best), 'best shots', 'highest scores, across the days')}
    ${stat(fmt(t.duplicates), 'duplicates', 'set aside, best copy kept')}
    ${stat(fmt(t.copies), 'copies made', 'clones: no extra space on macOS')}
    ${stat(`${t.days} · ${t.places}`, 'days · places', 'from dates and GPS')}
    ${stat(r.verified?.changed ? fmt(r.verified.changed) : '0', 'originals changed', r.verified ? `${fmt(r.verified.checked)} files re-checked` : '', r.verified && !r.verified.changed ? 'ok' : '')}`;
}

function undoBarHtml() {
  const u = RESULT?.undo;
  return u ? `<div class="undo-bar">${icon('edit')}<span>Last fix: <b>${esc(u.label)}</b></span><button class="btn ghost sm" data-act="undo">${icon('undo')} Undo <kbd>${MOD} Z</kbd></button></div>` : '';
}

async function renderResults(params) {
  current = 'results';
  await loadResultIfNeeded();
  showcase?.destroy();
  showcase = null;
  if (!RESULT) {
    view.innerHTML = `<section class="empty-page">${icon('folder')}<h1>No results yet</h1><p class="muted">Sort a folder of photos and the results show up here.</p><a class="btn primary" href="#/">Sort photos</a></section>`;
    return;
  }
  const r = RESULT;
  view.innerHTML = `
    <div class="page-head">
      <div>
        <p class="eyebrow">Sorted ${esc(timeAgo(r.createdAt))} · took ${esc(duration(r.durationMs || 0))}</p>
        <h1>${esc(r.title)}</h1>
        <div class="out-path">${icon('folder')}<code title="${esc(r.out)}">${esc(r.outDisplay || r.out)}</code>
          <button class="btn ghost sm" id="copyPath">${icon('copy')} Copy path</button>
          ${canReveal() ? `<button class="btn ghost sm" id="reveal">${icon('external')} Open in Finder</button>` : ''}
        </div>
      </div>
      <a class="btn secondary" href="#/">New sort</a>
    </div>
    <section class="card browse-card">
      <div class="browse-head">
        <div><h2>Browse and fix</h2><p class="muted">Open a folder to see every photo. Move anything that landed in the wrong place; originals stay untouched.</p></div>
        <div class="tabs" role="tablist">${TABS.map((x) => `<button role="tab" data-tab="${x.key}">${x.label}</button>`).join('')}</div>
      </div>
      <div id="undoBox">${undoBarHtml()}</div>
      <div id="folderGrid"></div>
    </section>
    <div class="stats" id="stats">${statsHtml()}</div>
    ${r.labelFailures ? `<div class="banner warn">${icon('alert')} ${plural(r.labelFailures, 'contact sheet')} couldn’t be labelled. Those photos are in “Unsorted”. Sort again to retry them, or move them by hand.</div>` : ''}
    <section class="card showcase-card">
      <div class="card-head"><h3>Sorting replay</h3><div class="row-gap">
        <button class="btn ghost sm" id="skipBtn">${icon('skip')} Skip</button>
        <button class="btn secondary sm" id="replayBtn">${icon('replay')} Replay</button></div></div>
      <div id="showcase"></div>
    </section>`;

  $('#copyPath').onclick = async () => {
    try {
      await navigator.clipboard.writeText(r.out);
      toast('Path copied');
    } catch {
      toast(r.out);
    }
  };
  if ($('#reveal')) $('#reveal').onclick = () => api('/api/reveal', {}).catch((e) => toast(e.message, { kind: 'warn' }));
  $$('[data-tab]').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
  view.onclick = (e) => {
    if (e.target.closest('[data-act="undo"]')) undo();
  };
  showTab(store.get('tab', 'type'));

  showcase = new Showcase($('#showcase'), r, new SpriteBank(privacy()));
  $('#replayBtn').onclick = () => {
    $('.showcase-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
    showcase.play();
  };
  $('#skipBtn').onclick = () => showcase.skip();
  requestAnimationFrame(() => {
    if (params.get('play')) {
      history.replaceState(null, '', '#/results');
      $('.showcase-card').scrollIntoView({ block: 'center' });
      showcase.play();
    } else {
      showcase.skip();
    }
  });
}

function showTab(key) {
  store.set('tab', key);
  $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === key)));
  const grid = $('#folderGrid');
  const list = folders(key);
  const wide = key === 'best' || key === 'dups';
  const desc = key === 'best'
    ? 'The highest-scoring photos, spread across the days. Screenshots are never picked. Mark or unmark any photo.'
    : 'Exact copies, re-saves and burst shots, each shown next to the copy that was kept. Restore anything that isn’t really a duplicate.';
  grid.innerHTML = `<div class="bgrid${wide ? ' wide' : ''}">${list.map((f, k) => `
    <a class="bcard${wide ? ' wide' : ''}" href="#/folder/${f.tab}/${f.i}" data-f="${k}">
      <div class="bc-cover n${privacy() ? 0 : Math.min(3, coverPicks(f).length)}">${coverHtml(f)}</div>
      <div class="bc-meta">
        <span class="bc-ic">${icon(f.icon)}</span>
        <div class="bc-title"><b title="${esc(f.name)}">${esc(f.name)}</b>${wide ? `<span>${esc(desc)}</span>` : f.sub ? `<span>${esc(f.sub)}</span>` : `<span class="mono">${esc(f.path)}/</span>`}</div>
        <span class="bc-count">${fmt(f.list.length)}</span>
      </div>
      ${f.tab === 'type' && !f.special ? `<button class="bc-edit" data-rename="${esc(f.name)}" aria-label="Rename ${esc(f.name)}" title="Rename">${icon('edit')}</button>` : ''}
    </a>`).join('')}
    ${key === 'type' ? `<button class="bcard add" id="addType">${icon('plus')}<b>New folder</b><span>Add a type folder, then move photos into it</span></button>` : ''}
  </div>`;
  if (privacy()) drawTileCovers(grid, list);
  $$('[data-rename]', grid).forEach((b) => {
    b.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const from = b.dataset.rename;
      const v = await dialog({ title: `Rename “${from}”`, text: 'Renames the folder in the sorted copies. Future sorts use the new name too.', fields: [{ name: 'name', label: 'Folder name', value: from }], ok: 'Rename' });
      if (v && v.name.trim() && v.name.trim() !== from) await fix({ op: 'rename', from, to: v.name.trim() });
    };
  });
  if ($('#addType')) $('#addType').onclick = () => newFolder();
}

async function newFolder(keys = null) {
  const v = await dialog({
    title: 'New type folder',
    text: keys ? `Create a folder and move ${plural(keys.length, 'item')} into it.` : 'It appears in By type and in every Move to menu.',
    fields: [{ name: 'name', label: 'Folder name', placeholder: 'e.g. Pets' }, { name: 'hint', label: 'What goes in it', optional: true, max: 200, placeholder: 'Helps future sorts, e.g. Dogs, cats, birds' }],
    ok: keys ? 'Create and move' : 'Create',
  });
  if (!v || !v.name.trim()) return;
  const ok = await fix({ op: 'addType', name: v.name.trim(), hint: v.hint || '' }, { quiet: Boolean(keys) });
  if (ok && keys) await fix({ op: 'move', keys, to: v.name.trim().replace(/\s+/g, ' ') });
}


let fixing = false;

async function fix(body, { quiet = false } = {}) {
  if (fixing) return false;
  fixing = true;
  try {
    const res = await api('/api/fix', body);
    setResult(res.result);
    afterFix();
    if (!quiet) toast(res.message, res.changed ? { action: { label: 'Undo', run: undo } } : {});
    if (res.problems?.length) toast(`${plural(res.problems.length, 'file')} couldn’t be updated. ${res.problems[0]}`, { kind: 'warn', ms: 9000 });
    return true;
  } catch (e) {
    toast(e.message, { kind: 'warn' });
    return false;
  } finally {
    fixing = false;
  }
}

async function undo() {
  if (fixing) return;
  if (!RESULT?.undo) {
    toast('Nothing to undo.');
    return;
  }
  fixing = true;
  try {
    const res = await api('/api/undo', {});
    setResult(res.result);
    afterFix();
    toast(res.message);
  } catch (e) {
    toast(e.message, { kind: 'warn' });
  } finally {
    fixing = false;
  }
}

function afterFix() {
  if (current === 'folder') refreshFolder();
  else if (current === 'results') {
    showTab(store.get('tab', 'type'));
    $('#stats').innerHTML = statsHtml();
    $('#undoBox').innerHTML = undoBarHtml();
  }
  lightbox.update();
}

function moveTargets(keys) {
  const items = keys.map((k) => RESULT.items[keyIndex.get(k)]).filter(Boolean);
  const allVideo = items.length && items.every((it) => it.k === 'v');
  const one = items.length === 1 && !items[0].x ? RESULT.folders.type[items[0].ty]?.name : null;
  return RESULT.folders.type
    .filter((f) => f.name !== 'Duplicates' && f.name !== 'Unsorted' && (f.name !== 'Videos' || allVideo))
    .map((f, n) => ({ label: f.name, value: f.name, icon: typeIcon(f.name), hint: n < 9 ? String(n + 1) : '', current: f.name === one }));
}

function moveMenu(anchor, keys) {
  if (!keys.length) return;
  menu(anchor, [...moveTargets(keys), { sep: true }, { label: 'New folder…', value: '__new', icon: 'plus' }], {
    title: `Move ${plural(keys.length, 'item')} to`,
    onPick: (e) => (e.value === '__new' ? newFolder(keys) : fix({ op: 'move', keys, to: e.value })),
  });
}

function moveToNumber(n, keys) {
  const t = moveTargets(keys)[n - 1];
  if (t && keys.length) fix({ op: 'move', keys, to: t.value });
}


let FV = {};

function renderFolder(tab, i) {
  current = 'folder';
  closeMenu();
  if (!RESULT) {
    loadResultIfNeeded().then(() => {
      if (RESULT) renderFolder(tab, i);
      else location.hash = '#/results';
    });
    return;
  }
  const f = folderOf(tab, i);
  if (!f) {
    location.hash = '#/results';
    return;
  }
  FV.grid?.destroy();
  FV = { tab, i, f, list: f.list, sel: new Set(), anchor: -1, focus: -1, size: store.get('gridSize', 'm'), grid: null, flat: [] };
  view.innerHTML = `
    <div class="fv-head">
      <a class="back" href="#/results">${icon('back')} All folders</a>
      <div class="fv-title"><span class="fv-ic">${icon(f.icon)}</span><div><h1>${esc(f.name)}</h1><p class="muted" id="fvMeta"></p></div></div>
    </div>
    <div class="fv-bar" id="fvBar"></div>
    ${tab === 'dups' ? '<div class="dgroups" id="dgroups"></div>' : `<div class="vgrid size-${FV.size}" id="vgrid"></div>`}
    <div class="fv-empty" id="fvEmpty" hidden>${icon('folder')}<b>This folder is empty</b><span>Move photos here from any other folder.</span></div>`;
  renderFolderMeta();
  renderBar();
  if (tab === 'dups') renderDupGroups();
  else FV.grid = new VirtualGrid($('#vgrid'), { count: FV.list.length, size: SIZES[FV.size], render: renderCell });
  $('#fvEmpty').hidden = FV.list.length > 0;
  view.onclick = onFolderClick;
  scrollTo({ top: 0 });
}

function renderFolderMeta() {
  const f = FV.f;
  const items = FV.list.map((i) => RESULT.items[i]);
  const videos = items.filter((it) => it.k === 'v').length;
  const parts = [plural(items.length - videos, 'photo')];
  if (videos) parts.push(plural(videos, 'video'));
  $('#fvMeta').innerHTML = `${parts.join(' · ')}${f.sub ? ` · ${esc(f.sub)}` : ''} · <code>${esc(f.path)}/</code>`;
}

function refreshFolder() {
  const f = folderOf(FV.tab, FV.i);
  if (!f) {
    location.hash = '#/results';
    return;
  }
  FV.f = f;
  FV.list = f.list;
  const keys = new Set(f.list.map((i) => RESULT.items[i].key));
  FV.sel = new Set([...FV.sel].filter((k) => keys.has(k)));
  FV.focus = Math.min(FV.focus, FV.list.length - 1);
  renderFolderMeta();
  renderBar();
  if (FV.tab === 'dups') renderDupGroups();
  else FV.grid?.setCount(FV.list.length);
  $('#fvEmpty').hidden = FV.list.length > 0;
}

function renderCell(pos, el) {
  const idx = FV.list[pos];
  const it = RESULT.items[idx];
  if (!it) return;
  if (el.dataset.key !== it.key || el.dataset.pv !== String(privacy())) {
    el.dataset.key = it.key;
    el.dataset.pv = String(privacy());
    el.style.setProperty('--c', avgColor(it.t));
    el.innerHTML = `${privacy() ? '' : `<img src="${media.thumb(it)}" alt="" decoding="async" draggable="false">`}<span class="badges"></span><button class="pick" tabindex="-1" aria-label="Select">${icon('check')}</button>`;
    if (privacy()) {
      const c = hexToCanvas(it.t);
      c.className = 'tile';
      el.prepend(c);
    }
  }
  el.dataset.pos = pos;
  el.dataset.idx = idx;
  el.className = `cell${FV.sel.has(it.key) ? ' sel' : ''}${FV.focus === pos ? ' focus' : ''}`;
  el.title = it.n;
  $('.badges', el).innerHTML = badges(it);
}

function badges(it) {
  return `${it.b ? `<i class="bd best" title="Best shot">${icon('star')}</i>` : ''}${it.k === 'v' ? `<i class="bd vid">${icon('play')}${clock(it.dur)}</i>` : ''}${it.fx ? `<i class="bd fx" title="Fixed by you">${icon('edit')}</i>` : ''}`;
}

function dupCell(i, label, keeper = false) {
  const it = RESULT.items[i];
  return `<div class="cell dcell${keeper ? ' keeper' : ''}${FV.sel.has(it.key) ? ' sel' : ''}" data-idx="${i}" data-key="${it.key}" title="${esc(it.n)}" style="--c:${avgColor(it.t)}">
    ${privacy() ? `<canvas class="tile" data-tile="${i}"></canvas>` : `<img src="${media.thumb(it)}" alt="" loading="lazy" decoding="async" draggable="false">`}
    <span class="badges">${badges(it)}</span>
    <span class="dlabel">${esc(label)}</span>
    ${keeper ? '' : `<button class="pick" tabindex="-1" aria-label="Select">${icon('check')}</button><button class="restore" data-restore="${it.key}" title="Not a duplicate">${icon('restore')} Not a duplicate</button>`}
  </div>`;
}

function renderDupGroups() {
  const box = $('#dgroups');
  const groups = new Map();
  for (const i of FV.list) {
    const k = RESULT.items[i].dk;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  FV.flat = [];
  box.innerHTML = [...groups].map(([k, dups]) => {
    const keeper = RESULT.items[k];
    if (keeper) FV.flat.push(k);
    FV.flat.push(...dups);
    return `<section class="dgroup">
      <div class="dg-keep">${keeper ? dupCell(k, 'Kept copy', true) : ''}</div>
      <div class="dg-arrow">${icon('dup')}<span>${plural(dups.length, 'duplicate')}</span></div>
      <div class="dg-dups">${dups.map((i) => dupCell(i, DUP_REASON[RESULT.items[i].dr] || 'Similar')).join('')}</div>
    </section>`;
  }).join('');
  if (privacy()) {
    $$('canvas[data-tile]', box).forEach((c) => {
      const t = hexToCanvas(RESULT.items[Number(c.dataset.tile)].t);
      c.width = t.width;
      c.height = t.height;
      c.getContext('2d').drawImage(t, 0, 0);
    });
  }
}

function targetKeys() {
  if (FV.sel.size) return [...FV.sel];
  if (FV.focus >= 0 && FV.list[FV.focus] !== undefined) return [RESULT.items[FV.list[FV.focus]].key];
  return [];
}

function renderBar() {
  const n = FV.sel.size;
  const keys = targetKeys();
  const items = keys.map((k) => RESULT.items[keyIndex.get(k)]).filter(Boolean);
  const anyDup = items.some((it) => it.x);
  const anyKept = items.some((it) => !it.x);
  const allBest = anyKept && items.filter((it) => !it.x).every((it) => it.b);
  const u = RESULT.undo;
  $('#fvBar').innerHTML = `<div class="fv-bar-inner">
    <div class="fv-sel">${n ? `<b>${plural(n, 'item')} selected</b>` : '<span class="muted">Click a photo to open it. Click the circle, or press <kbd>X</kbd>, to select.</span>'}</div>
    <div class="fv-acts">
      <button class="btn sm secondary" data-act="move" ${keys.length ? '' : 'disabled'} aria-haspopup="menu">${icon('move')} Move to… <kbd>M</kbd></button>
      ${FV.tab !== 'dups' ? `<button class="btn sm ghost" data-act="best" ${anyKept ? '' : 'disabled'}>${icon('star')} ${allBest ? 'Remove from best' : 'Mark best'} <kbd>B</kbd></button>` : ''}
      ${FV.tab === 'dups' || anyDup ? `<button class="btn sm ghost" data-act="notdup" ${anyDup ? '' : 'disabled'}>${icon('restore')} Not a duplicate <kbd>D</kbd></button>` : ''}
      ${n ? '<button class="btn sm ghost" data-act="clear">Clear</button>' : `<button class="btn sm ghost" data-act="all" ${FV.list.length ? '' : 'disabled'}>Select all</button>`}
    </div>
    <div class="fv-right">
      ${FV.tab !== 'dups' ? `<div class="seg" role="group" aria-label="Thumbnail size">${['s', 'm', 'l'].map((s) => `<button data-size="${s}" aria-pressed="${FV.size === s}">${s.toUpperCase()}</button>`).join('')}</div>` : ''}
      <button class="btn sm ghost icon-only" data-act="keys" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">${icon('keyboard')}</button>
      <button class="btn sm ghost" data-act="undo" ${u ? '' : 'disabled'} title="${u ? `Undo: ${esc(u.label)}` : 'Nothing to undo'}">${icon('undo')} Undo</button>
    </div>
  </div>`;
}

function setSelection(next, anchor = FV.anchor) {
  FV.sel = next;
  FV.anchor = anchor;
  if (FV.tab === 'dups') $$('.dcell', $('#dgroups')).forEach((c) => c.classList.toggle('sel', FV.sel.has(c.dataset.key)));
  else FV.grid?.refresh();
  renderBar();
}

function toggleKey(key, pos) {
  const next = new Set(FV.sel);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  setSelection(next, pos >= 0 ? pos : FV.anchor);
}

function selectRange(a, b) {
  const next = new Set(FV.sel);
  for (let p = Math.min(a, b); p <= Math.max(a, b); p++) next.add(RESULT.items[FV.list[p]].key);
  setSelection(next, FV.anchor);
}

function openAt(idx) {
  if (FV.tab === 'dups') lightbox.open(FV.flat, Math.max(0, FV.flat.indexOf(idx)));
  else lightbox.open(FV.list, Math.max(0, FV.list.indexOf(idx)));
}

async function runAct(act, anchorEl) {
  const keys = targetKeys();
  const items = keys.map((k) => RESULT.items[keyIndex.get(k)]).filter(Boolean);
  if (act === 'move') moveMenu(anchorEl || $('[data-act="move"]'), keys);
  else if (act === 'best') {
    const kept = items.filter((it) => !it.x);
    if (kept.length) await fix({ op: 'best', keys: kept.map((it) => it.key), on: !kept.every((it) => it.b) });
  } else if (act === 'notdup') {
    const dups = items.filter((it) => it.x);
    if (dups.length) await fix({ op: 'notdup', keys: dups.map((it) => it.key) });
  } else if (act === 'all') setSelection(new Set(FV.list.map((i) => RESULT.items[i].key)));
  else if (act === 'clear') setSelection(new Set(), -1);
  else if (act === 'undo') await undo();
  else if (act === 'keys') showKeys();
}

function onFolderClick(e) {
  const size = e.target.closest('[data-size]');
  if (size) {
    FV.size = size.dataset.size;
    store.set('gridSize', FV.size);
    $('#vgrid').className = `vgrid size-${FV.size}`;
    FV.grid?.setSize(SIZES[FV.size]);
    renderBar();
    return;
  }
  const restore = e.target.closest('[data-restore]');
  if (restore) {
    fix({ op: 'notdup', keys: [restore.dataset.restore] });
    return;
  }
  const actBtn = e.target.closest('[data-act]');
  if (actBtn && !actBtn.disabled) {
    runAct(actBtn.dataset.act, actBtn);
    return;
  }
  const cell = e.target.closest('.cell');
  if (!cell) return;
  const idx = Number(cell.dataset.idx);
  const it = RESULT.items[idx];
  const pos = cell.dataset.pos !== undefined ? Number(cell.dataset.pos) : -1;
  if (cell.classList.contains('keeper')) {
    openAt(idx);
    return;
  }
  if (e.shiftKey && pos >= 0 && FV.anchor >= 0) {
    selectRange(FV.anchor, pos);
  } else if (e.target.closest('.pick') || e.metaKey || e.ctrlKey || FV.sel.size) {
    toggleKey(it.key, pos);
  } else {
    if (pos >= 0) FV.focus = pos;
    openAt(idx);
  }
}

function moveFocus(d, extend) {
  if (!FV.list.length || !FV.grid) return;
  const from = FV.focus < 0 ? 0 : FV.focus;
  const to = FV.focus < 0 ? 0 : Math.max(0, Math.min(FV.list.length - 1, from + d));
  FV.focus = to;
  if (extend) {
    if (FV.anchor < 0) FV.anchor = from;
    const next = new Set();
    for (let p = Math.min(FV.anchor, to); p <= Math.max(FV.anchor, to); p++) next.add(RESULT.items[FV.list[p]].key);
    FV.sel = next;
  } else {
    FV.anchor = to;
  }
  FV.grid.scrollTo(to);
  FV.grid.refresh();
  renderBar();
}

function showKeys() {
  shortcutsDialog([
    ['← → ↑ ↓', 'Move between photos'],
    ['Enter', 'Open the photo'],
    ['X', 'Select or unselect'],
    ['Shift ←→', 'Select a range'],
    [`${MOD} A`, 'Select all'],
    ['M', 'Move to…'],
    ['1 – 9', 'Move straight to folder 1–9'],
    ['B', 'Mark or unmark best shot'],
    ['D', 'Not a duplicate'],
    [`${MOD} Z`, 'Undo the last fix'],
    ['Esc', 'Clear the selection or close the viewer'],
    ['+ − 0', 'Zoom in the viewer'],
    ['I', 'Show or hide info in the viewer'],
  ]);
}

function onKey(e) {
  if (lightbox.isOpen || menuOpen() || document.querySelector('dialog[open]')) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey && (current === 'folder' || current === 'results')) {
    e.preventDefault();
    undo();
    return;
  }
  if (current !== 'folder') return;
  const cols = FV.grid?.cols || 1;
  const k = e.key;
  let handled = true;
  if (k === 'ArrowRight') moveFocus(1, e.shiftKey);
  else if (k === 'ArrowLeft') moveFocus(-1, e.shiftKey);
  else if (k === 'ArrowDown') moveFocus(cols, e.shiftKey);
  else if (k === 'ArrowUp') moveFocus(-cols, e.shiftKey);
  else if ((k === 'Enter' || k === ' ') && FV.focus >= 0 && FV.grid) openAt(FV.list[FV.focus]);
  else if (k === 'x' && FV.focus >= 0 && FV.grid) toggleKey(RESULT.items[FV.list[FV.focus]].key, FV.focus);
  else if (mod && k.toLowerCase() === 'a') runAct('all');
  else if (k === 'Escape') runAct('clear');
  else if (k === 'm' && !mod) runAct('move');
  else if (k === 'b' && !mod) runAct('best');
  else if (k === 'd' && !mod) runAct('notdup');
  else if (k === '?') showKeys();
  else if (/^[1-9]$/.test(k) && !mod) moveToNumber(Number(k), targetKeys());
  else handled = false;
  if (handled) e.preventDefault();
}


function route() {
  const [p, q] = (location.hash || '#/').slice(1).split('?');
  const params = new URLSearchParams(q || '');
  const page = p.startsWith('/folder/') || p === '/results' ? 'results' : 'sort';
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === page));
  if (p !== '/results') {
    showcase?.destroy();
    showcase = null;
  }
  if (lightbox.isOpen) lightbox.close();
  closeMenu();
  view.onclick = null;
  if (p !== '/sorting' && liveUI.stage) {
    liveUI.stage.destroy();
    liveUI.stage = null;
  }
  if (!p.startsWith('/folder/')) {
    FV.grid?.destroy();
    FV = {};
  }
  if (p === '/sorting') return renderSorting();
  if (p === '/results') return renderResults(params);
  const m = /^\/folder\/(type|day|place|best|dups)\/(\d+)$/.exec(p);
  if (m) return renderFolder(m[1], Number(m[2]));
  return renderSort();
}

(async function main() {
  setTheme(store.get('theme', currentTheme()));
  $('#themeBtn').onclick = () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  APP = await api('/api/state');
  renderPrivacyToggle();
  $('#privacyBtn').onclick = togglePrivacy;
  $('#version').textContent = `v${APP.app.version}`;
  document.addEventListener('keydown', onKey);
  await initForm();
  addEventListener('hashchange', () => {
    scrollTo({ top: 0 });
    route();
  });
  connect();
  route();
}());
