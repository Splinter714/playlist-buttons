// Entry point. The button grid (#2) is the main view; the debug table from #1 sits
// behind a toggle underneath it.
//
// Cache-first is a hard requirement, not an optimisation: every transition reloads the
// page (#4), so the grid paints from localStorage before anything touches the network.
//
// Two localStorage things, kept apart on purpose (#9): the ROTATION (which playlists are
// buttons, in what order, which skip the fade-in — the source of truth, only ever changed
// by the user) and the CACHE of playlist metadata from Spotify (names and cover art,
// refreshed behind the paint). The grid is the two joined.

import './grid.css';
import './debug.css';

import { beginLogin, handleRedirect, isLoggedIn, logout, getAuth, startRefreshTimer } from './auth.js';
import { sessionScopesStale } from './scopes.js';
import { readCache, hasCache, refreshPlaylists, clearCache, purgeLegacyStorage } from './playlists.js';
import { readRotation, joinRotation } from './rotation.js';
import { resolveView } from './view.js';
import { renderGrid, renderSkeleton, renderEmpty, renderSignedOut, attachTriggerRecorder } from './grid.js';
import { readNowPlaying, resolveNowPlaying } from './nowplaying.js';
import { renderDebugAuth, renderDebugPlaylists, setDebugStatus, initDebugToggle } from './debug.js';

const appEl = document.getElementById('app');
const appStatusEl = document.getElementById('app-status');

const state = {
  items: [],
  // A cache entry existing at all is what separates a genuine first load (skeleton)
  // from an established one (never a skeleton).
  cachePresent: false,
  // A refresh has come back, successfully or not.
  settled: false,
  candidateCount: null,
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

/** Rebuild the grid's list from the rotation and whatever metadata we have. */
function update(playlists) {
  if (playlists) state.candidateCount = playlists.length;
  state.items = joinRotation(readRotation(), playlists ?? readCache());
  paint();
  renderDebugPlaylists(state.items, state.candidateCount);
}

async function main() {
  initDebugToggle();
  purgeLegacyStorage();

  // One delegated listener for the life of the page: the grid re-renders, this does not.
  // It records the tap and returns — the anchor's own navigation does the rest (#4).
  attachTriggerRecorder(appEl);

  const redirect = await handleRedirect();
  if (redirect.error) {
    setAppStatus(`login failed: ${redirect.error}`, 'error');
    setDebugStatus(`login failed: ${redirect.error}`, 'error');
  }

  // #9 shrank the scopes. A session stored before that carries the old set, including
  // write access this app no longer wants, and the consent screen has to be shown again
  // anyway — so drop it here rather than letting it fail somewhere confusing later. The
  // rotation is untouched: it is the user's data, not Spotify's.
  if (sessionScopesStale(getAuth())) {
    logout();
    clearCache();
    renderDebugAuth();
    setAppStatus('Spotify permissions changed — log in again', 'error');
    setDebugStatus('stored session predates the scope change (#9) — logged out', 'error');
    update();
    return;
  }

  renderDebugAuth();

  if (!isLoggedIn()) {
    setDebugStatus('not logged in');
    update();
    return;
  }

  startRefreshTimer((e) => {
    setAppStatus(`token refresh failed: ${e.message}`, 'error');
    setDebugStatus(`token refresh failed: ${e.message}`, 'error');
  });

  // Paint from cache first, always. Never block on the network.
  state.cachePresent = hasCache();
  update(hasCache() ? readCache() : null);
  setDebugStatus(state.items.length ? `${state.items.length} from cache — revalidating…` : 'loading…');

  try {
    const fresh = await refreshPlaylists();
    state.settled = true;
    state.cachePresent = true;
    update(fresh);
    setAppStatus('');
    setDebugStatus(`${state.items.length} in the rotation, ${fresh.length} playlist${fresh.length === 1 ? '' : 's'} on the account`);
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
