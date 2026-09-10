// DEBUG VIEW — lifted out of main.js unchanged in behaviour when the grid (#2) took
// over as the main view.
//
// This is not dead weight: issue #1 is still open awaiting playtest, and this table is
// how auth and tag parsing get checked by eye against a real account. It shows the
// description exactly as Spotify handed it back, which is the whole point — the
// HTML-escape round trip is still an open question there. Keep it working.

import { beginLogin, isLoggedIn, logout, getAuth } from './auth.js';
import { clearCache } from './playlists.js';
import { resolveRedirectUri } from './config.js';
import { read, write } from './storage.js';

const OPEN_KEY = 'debugOpen';

const authEl = document.getElementById('auth');
const statusEl = document.getElementById('status');
const listEl = document.getElementById('playlists');

export function setDebugStatus(text, kind = '') {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = kind;
}

export function renderDebugAuth() {
  if (!authEl) return;
  authEl.innerHTML = '';
  if (isLoggedIn()) {
    const auth = getAuth();
    const info = document.createElement('span');
    const mins = Math.round(((auth?.expires_at ?? 0) - Date.now()) / 60000);
    info.textContent = `logged in — token expires in ${mins} min `;
    const out = document.createElement('button');
    out.textContent = 'log out';
    out.onclick = () => { logout(); clearCache(); location.reload(); };
    authEl.append(info, out);
  } else {
    const inBtn = document.createElement('button');
    inBtn.textContent = 'log in with Spotify';
    inBtn.onclick = () => beginLogin();
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = `redirect URI in use: ${resolveRedirectUri()} — this must be registered on the Spotify app, exactly.`;
    authEl.append(inBtn, hint);
  }
}

export function renderDebugPlaylists(items, warnings = []) {
  if (!listEl) return;
  listEl.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No playlists with a [game ...] tag in their description yet.';
    listEl.append(empty);
  } else {
    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const h of ['order', 'name', 'nofadein', 'tracks', 'description as Spotify returned it']) {
      const th = document.createElement('th');
      th.textContent = h;
      head.append(th);
    }
    table.append(head);

    for (const p of items) {
      const tr = document.createElement('tr');
      const cells = [
        p.order === null || p.order === undefined ? '(none)' : String(p.order),
        p.name,
        p.nofadein ? 'yes' : 'no',
        String(p.trackTotal ?? ''),
        p.description ?? '',
      ];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      table.append(tr);
    }
    listEl.append(table);
  }

  if (warnings.length) {
    const box = document.createElement('ul');
    box.className = 'warnings';
    for (const w of warnings) {
      const li = document.createElement('li');
      li.textContent = w;
      box.append(li);
    }
    listEl.append(box);
  }
}

/** Small toggle so the table stays one tap away without being in the way. */
export function initDebugToggle() {
  const toggle = document.getElementById('debug-toggle');
  const panel = document.getElementById('debug');
  if (!toggle || !panel) return;

  const apply = (open) => {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'hide debug view' : 'debug view';
  };

  apply(read(OPEN_KEY, false) === true);
  toggle.addEventListener('click', () => {
    const open = panel.hidden;
    apply(open);
    write(OPEN_KEY, open);
  });
}
