// DEBUG VIEW ONLY.
//
// The real button grid — cover art, drag to reorder, tap to transition — is issue #2.
// This is a plain list, kept ugly on purpose so nobody mistakes it for the product. It
// exists to answer two questions by eye: did auth work, and did the tag parse right.

import './debug.css';
import { beginLogin, handleRedirect, isLoggedIn, logout, getAuth, startRefreshTimer } from './auth.js';
import { readCache, refreshPlaylists, clearCache } from './playlists.js';
import { resolveRedirectUri } from './config.js';

const authEl = document.getElementById('auth');
const statusEl = document.getElementById('status');
const listEl = document.getElementById('playlists');

const warnings = [];

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function renderAuth() {
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

function renderPlaylists(items) {
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

async function main() {
  const redirect = await handleRedirect();
  if (redirect.error) setStatus(`login failed: ${redirect.error}`, 'error');

  renderAuth();

  if (!isLoggedIn()) {
    setStatus('not logged in');
    return;
  }

  startRefreshTimer((e) => setStatus(`token refresh failed: ${e.message}`, 'error'));

  // Paint from cache first, always. Never block on the network.
  const cached = readCache();
  renderPlaylists(cached);
  setStatus(cached.length ? `${cached.length} from cache — revalidating…` : 'loading…');

  try {
    const fresh = await refreshPlaylists({
      onUpdate: renderPlaylists,
      onWarn: (msg) => { warnings.push(msg); },
    });
    setStatus(`${fresh.length} tagged playlist${fresh.length === 1 ? '' : 's'}`);
    renderPlaylists(fresh);
  } catch (e) {
    setStatus(`refresh failed: ${e.message}${cached.length ? ' (showing cache)' : ''}`, 'error');
  }
}

main();
