export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
export const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function timeAgo(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export const store = {
  get(k, d) {
    try { return localStorage.getItem(k) ?? d; } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch {}
  },
};

export async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const PATHS = {
  logo: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><path d="m14 17.2 2.2 2.2 4.3-4.6"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z"/>',
  replay: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/>',
  skip: '<path d="m5 5 9 7-9 7zM18 5v14"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/>',
  mountain: '<path d="M2.5 19.5 9 8.5l4 6.2 3-4.2 5.5 9z"/><path d="m7.4 11.2 1.6 1.3 1.4-1.1"/>',
  group: '<circle cx="12" cy="7.5" r="2.8"/><circle cx="5.8" cy="9.5" r="2.2"/><circle cx="18.2" cy="9.5" r="2.2"/><path d="M6.5 20c.8-3.6 3-5.5 5.5-5.5s4.7 1.9 5.5 5.5M2 19c.5-2.6 2-4 3.8-4M22 19c-.5-2.6-2-4-3.8-4"/>',
  selfie: '<rect x="6" y="2.5" width="12" height="19" rx="2.6"/><circle cx="12" cy="10" r="2.6"/><path d="M8.6 16.6c.8-1.7 2-2.5 3.4-2.5s2.6.8 3.4 2.5"/>',
  food: '<path d="M3.5 11.5h17a8.5 8.5 0 0 1-17 0z"/><path d="M9 3.5c-1.1 1 1.1 2 0 3.2M13 3c-1.1 1 1.1 2 0 3.2M17 3.5c-1.1 1 1.1 2 0 3.2"/>',
  road: '<path d="M9.5 3 5 21M14.5 3 19 21M12 5v2.5M12 10.5v3M12 16.5v3"/>',
  stay: '<path d="M2.5 20 12 4l9.5 16z"/><path d="m9 20 3-5.5 3 5.5"/>',
  screen: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3M9.5 6.5h5"/>',
  video: '<rect x="2.5" y="6" width="13" height="12" rx="2.6"/><path d="m15.5 10.5 6-3.5v10l-6-3.5z"/>',
  dup: '<rect x="8" y="8" width="13" height="13" rx="2.6"/><path d="M16 8V5.6A2.6 2.6 0 0 0 13.4 3H5.6A2.6 2.6 0 0 0 3 5.6v7.8A2.6 2.6 0 0 0 5.6 16H8"/>',
  day: '<rect x="3" y="5" width="18" height="16" rx="2.6"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  tag: '<path d="M3 12V4.5A1.5 1.5 0 0 1 4.5 3H12l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/>',
  unsorted: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6h.01"/>',
  move: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M9.5 13.5h6M13 11l2.5 2.5L13 16"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  zoomin: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M11 8v6M8 11h6"/>',
  zoomout: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M8 11h6"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/><path d="M12 8v4l2.5 2.5"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7.5 14h9"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
};

export const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || PATHS.tag}</svg>`;

const TYPE_ICONS = {
  mountain: /mountain|nature|landscape|view|scenery|beach/i,
  group: /group|friends|people|family/i,
  selfie: /selfie|portrait/i,
  food: /food|drink|meal|cafe/i,
  road: /road|drive|travel|transit|car|bus|train/i,
  stay: /stay|hotel|camp|home|room/i,
  screen: /screen/i,
  video: /^videos?$/i,
  dup: /^duplicates$/i,
  unsorted: /^unsorted$/i,
};
export const typeIcon = (name) => Object.keys(TYPE_ICONS).find((k) => TYPE_ICONS[k].test(name)) || 'tag';

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export const media = {
  thumb: (it, size = 'm') => `/api/media/thumb/${it.key}${size === 's' ? '?s=s' : ''}`,
  full: (it) => `/api/media/full/${it.key}`,
  video: (it) => `/api/media/video/${it.key}`,
};

export function avgColor(hex) {
  if (!hex) return '#777';
  let r = 0;
  let g = 0;
  let b = 0;
  const n = hex.length / 6;
  for (let i = 0; i < n; i++) {
    r += parseInt(hex.substr(i * 6, 2), 16);
    g += parseInt(hex.substr(i * 6 + 2, 2), 16);
    b += parseInt(hex.substr(i * 6 + 4, 2), 16);
  }
  return `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`;
}

const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function wallDate(ts) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(ts || '');
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${WEEK[d.getUTCDay()]} ${+m[3]} ${MON[+m[2] - 1]} ${m[1]}, ${m[4]}:${m[5]}`;
}

export function clock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function toast(msg, { kind = '', action = null, ms = 4200 } = {}) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-btn';
    b.textContent = action.label;
    b.onclick = () => {
      el.remove();
      action.run();
    };
    el.append(b);
  }
  box.append(el);
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 450);
}
