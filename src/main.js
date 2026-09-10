// Entry point. The button grid (#2) is the main view; the debug table from #1 sits
// behind a toggle underneath it.
//
// Cache-first is a hard requirement, not an optimisation: every transition reloads the
// page (#4), so the grid paints from localStorage before anything touches the network.

import './grid.css';
import './debug.css';

import { beginLogin, handleRedirect, isLoggedIn, startRefreshTimer } from './auth.js';
import { readCache, hasCache, refreshPlaylists } from './playlists.js';
import { resolveView } from './view.js';
import { renderGrid, renderSkeleton, renderEmpty, renderSignedOut, attachTriggerRecorder } from './grid.js';
import { readNowPlaying, resolveNowPlaying } from './nowplaying.js';
import { renderDebugAuth, renderDebugPlaylists, setDebugStatus, initDebugToggle } from './debug.js';

const appEl = document.getElementById('app');
const appStatusEl = document.getElementById('app-status');

const warnings = [];

const state = {
  items: [],
  // A cache entry existing at all is what separates a genuine first load (skeleton)
  // from an established one (never a skeleton).
  cachePresent: false,
  // A refresh has come back, successfully or not.
  settled: false,
};

function setAppStatus(text = '', kind = '') {
  if (!appStatusEl) return;
  appStatusEl.textContent = text;
  appStatusEl.className = kind;
}

function paint() {
  const view = resolveView({
    loggedIn: isLoggedIn(),
    cachePresent: state.cachePresent,
    settled: state.settled,
    items: state.items,
  });

  if (view === 'grid') {
    renderGrid(appEl, {
      items: state.items,
      nowPlayingId: resolveNowPlaying(state.items, readNowPlaying()),
    });
  } else if (view === 'skeleton') {
    renderSkeleton(appEl);
  } else if (view === 'empty') {
    renderEmpty(appEl);
  } else {
    renderSignedOut(appEl, () => beginLogin());
  }
}

function update(items) {
  state.items = items;
  paint();
  renderDebugPlaylists(items, warnings);
}

async function main() {
  initDebugToggle();

  // One delegated listener for the life of the page: the grid re-renders, this does not.
  // It records the tap and returns — the anchor's own navigation does the rest (#4).
  attachTriggerRecorder(appEl);

  const redirect = await handleRedirect();
  if (redirect.error) {
    setAppStatus(`login failed: ${redirect.error}`, 'error');
    setDebugStatus(`login failed: ${redirect.error}`, 'error');
  }

  renderDebugAuth();

  if (!isLoggedIn()) {
    setDebugStatus('not logged in');
    paint();
    return;
  }

  startRefreshTimer((e) => {
    setAppStatus(`token refresh failed: ${e.message}`, 'error');
    setDebugStatus(`token refresh failed: ${e.message}`, 'error');
  });

  // Paint from cache first, always. Never block on the network.
  state.cachePresent = hasCache();
  update(readCache());
  setDebugStatus(state.items.length ? `${state.items.length} from cache — revalidating…` : 'loading…');

  try {
    const fresh = await refreshPlaylists({
      onUpdate: update,
      onWarn: (msg) => { warnings.push(msg); },
    });
    state.settled = true;
    state.cachePresent = true;
    update(fresh);
    setAppStatus('');
    setDebugStatus(`${fresh.length} tagged playlist${fresh.length === 1 ? '' : 's'}`);
  } catch (e) {
    // A failed revalidation is not a failed load — whatever the cache had stays on
    // screen. Only a first-ever load has nothing to fall back to.
    state.settled = true;
    paint();
    if (!isLoggedIn()) {
      // The session was rejected and cleared out from under us, so the sign-in prompt
      // is already on screen — saying "showing cached playlists" here would describe a
      // grid that is no longer there.
      setAppStatus('Spotify session expired', 'error');
      renderDebugAuth(); // it was drawn as logged-in a moment ago; keep it honest
    } else {
      const suffix = state.items.length ? ' (showing cached playlists)' : '';
      setAppStatus(`could not reach Spotify${suffix}`, 'error');
    }
    setDebugStatus(`refresh failed: ${e.message}${state.items.length ? ' (showing cache)' : ''}`, 'error');
  }
}

main();
