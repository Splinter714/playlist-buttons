// DEBUG VIEW — lifted out of main.js unchanged in behaviour when the grid (#2) took
// over as the main view.
//
// It was originally how tag parsing got checked by eye. Tags are gone (#9), so what it is
// for now is auth and the join: how many playlists came back from Spotify, which ids the
// local rotation holds, and what the two produce together. That is the part of #9 with no
// UI of its own until #8's setup page exists.

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
    info.textContent = `logged in — token expires in ${mins} min — scopes: ${auth?.scope || '(none recorded)'} `;
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

/**
 * @param {Array} items the joined rotation, exactly what the grid is drawing
 * @param {number} candidateCount how many playlists the last fetch returned
 */
export function renderDebugPlaylists(items, candidateCount = null) {
  if (!listEl) return;
  listEl.innerHTML = '';

  const summary = document.createElement('p');
  summary.textContent = candidateCount === null
    ? `${items.length} in the rotation`
    : `${items.length} in the rotation, out of ${candidateCount} playlist${candidateCount === 1 ? '' : 's'} on the account`;
  listEl.append(summary);

  if (!items.length) {
    const empty = document.createElement('p');
    empty.textContent = 'The rotation is stored locally and starts empty — fill it from the settings screen (#8).';
    listEl.append(empty);
    return;
  }

  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const h of ['#', 'name', 'nofadein', 'tracks', 'id']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.append(th);
  }
  table.append(head);

  items.forEach((p, i) => {
    const tr = document.createElement('tr');
    const cells = [
      String(i + 1),
      p.name ?? '',
      p.nofadein ? 'yes' : 'no',
      String(p.trackTotal ?? ''),
      p.id ?? '',
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.append(td);
    }
    table.append(tr);
  });
  listEl.append(table);
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
