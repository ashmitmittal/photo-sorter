import { esc, icon } from './util.js';

let openMenu = null;

export const menuOpen = () => Boolean(openMenu);

export function closeMenu() {
  if (!openMenu) return;
  openMenu.el.remove();
  document.removeEventListener('pointerdown', openMenu.outside, true);
  document.removeEventListener('keydown', openMenu.keys, true);
  openMenu.anchor?.setAttribute('aria-expanded', 'false');
  openMenu = null;
}

export function menu(anchor, entries, { title = '', onPick }) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'menu';
  el.setAttribute('role', 'menu');
  el.innerHTML = `${title ? `<div class="menu-title">${esc(title)}</div>` : ''}${entries.map((e, i) => (e.sep
    ? '<div class="menu-sep"></div>'
    : `<button role="menuitem" class="menu-item${e.current ? ' current' : ''}" data-i="${i}" ${e.disabled ? 'disabled' : ''}>
        ${e.icon ? icon(e.icon) : ''}<span>${esc(e.label)}</span>${e.hint ? `<kbd>${esc(e.hint)}</kbd>` : ''}</button>`)).join('')}`;
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const left = Math.max(8, Math.min(innerWidth - w - 8, r.left));
  const top = r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  anchor.setAttribute('aria-expanded', 'true');
  const buttons = [...el.querySelectorAll('.menu-item:not([disabled])')];
  const pick = (i) => {
    closeMenu();
    onPick(entries[i]);
  };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('.menu-item');
    if (b) pick(Number(b.dataset.i));
  });
  const outside = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu();
  };
  const keys = (e) => {
    const at = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      anchor.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const next = e.key === 'ArrowDown' ? at + 1 : at - 1;
      buttons[(next + buttons.length) % buttons.length]?.focus();
    } else if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey) {
      const i = entries.findIndex((x) => x.hint === e.key && !x.disabled);
      if (i !== -1) {
        e.preventDefault();
        e.stopPropagation();
        pick(i);
      }
    }
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', keys, true);
  openMenu = { el, outside, keys, anchor };
  requestAnimationFrame(() => buttons[0]?.focus());
}

export function dialog({ title, text = '', fields, ok = 'Save' }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    d.innerHTML = `<form method="dialog">
      <h3>${esc(title)}</h3>${text ? `<p class="muted">${esc(text)}</p>` : ''}
      ${fields.map((f) => `<label class="field"><span>${esc(f.label)}${f.optional ? ' <em>optional</em>' : ''}</span>
        <input class="input" name="${esc(f.name)}" value="${esc(f.value || '')}" maxlength="${f.max || 40}" placeholder="${esc(f.placeholder || '')}" ${f.optional ? '' : 'required'} autocomplete="off"></label>`).join('')}
      <div class="dlg-actions"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">${esc(ok)}</button></div>
    </form>`;
    document.body.append(d);
    d.addEventListener('close', () => {
      const values = d.returnValue === 'ok' ? Object.fromEntries(new FormData(d.querySelector('form'))) : null;
      d.remove();
      resolve(values);
    });
    d.showModal();
    const first = d.querySelector('input');
    first?.select();
  });
}

export function shortcutsDialog(rows) {
  const d = document.createElement('dialog');
  d.className = 'dlg keys';
  d.innerHTML = `<form method="dialog"><h3>Keyboard shortcuts</h3>
    <dl>${rows.map(([k, v]) => `<dt>${k.split(' ').map((x) => `<kbd>${esc(x)}</kbd>`).join(' ')}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <div class="dlg-actions"><button class="btn primary" value="ok">Done</button></div></form>`;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
}
