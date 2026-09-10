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
import './settings.css';
import './debug.css';

import { beginLogin, handleRedirect, isLoggedIn, logout, getAuth, startRefreshTimer } from './auth.js';
import { sessionScopesStale } from './scopes.js';
import { readCache, hasCache, refreshPlaylists, clearCache, purgeLegacyStorage } from './playlists.js';
import {
  readRotation, joinRotation, buildCandidates, reorderRotation,
  addToRotation, removeFromRotation, isInRotation, toggleNofadein, toggleInorder,
} from './rotation.js';
import {
  readFadeMs, writeFadeMs, MIN_FADE_MS, MAX_FADE_MS, FADE_STEP_MS,
} from './settings.js';
import { resolveView } from './view.js';
import { renderGrid, renderSkeleton, renderEmpty, renderSignedOut, attachTriggerRecorder, HANDOFF_ERROR_TEXT } from './grid.js';
import { consumeHandoffError } from './handoff.js';
import { renderSettings } from './settings-view.js';
import { readNowPlaying, resolveNowPlaying } from './nowplaying.js';
import { renderDebugAuth, renderDebugPlaylists, setDebugStatus, initDebugToggle } from './debug.js';

const appEl = document.getElementById('app');
const appStatusEl = document.getElementById('app-status');
const navEl = document.getElementById('nav-settings');

const state = {
  items: [],
  // A cache entry existing at all is what separates a genuine first load (skeleton)
  // from an established one (never a skeleton).
  cachePresent: false,
  // A refresh has come back, successfully or not.
  settled: false,
  candidateCount: null,
  // Set when this load is the return leg of a shortcut run that failed (#4). Read off
  // the URL once, on load, and shown on the grid until the next tap takes us away.
  notice: null,
  // Edit mode (#3): drag to reorder, no tap-to-play, markers visible. Deliberately NOT
  // persisted — a reload, and every transition is a reload, lands on a playable grid.
  editing: false,
};

function setAppStatus(text = '', kind = '') {
  if (!appStatusEl) return;
  appStatusEl.textContent = text;
  appStatusEl.className = kind;
}

/** Two screens, told apart by the hash so the back gesture works. */
function currentRoute() {
  return location.hash.replace(/^#\/?/, '') === 'settings' ? 'settings' : 'grid';
}

function paintNav(route) {
  if (!navEl) return;
  const onSettings = route === 'settings';
  navEl.textContent = onSettings ? 'done' : 'settings';
  navEl.href = onSettings ? '#' : '#settings';
}

/**
 * The settings screen changes the rotation, so it hands back a fresh candidate list on
 * every tap and keeps the grid's own state in step — but it deliberately does NOT
 * repaint: the list updates its rows in place, and a repaint here would rebuild them
 * under the user's thumb.
 */
function candidates() {
  return buildCandidates(readCache(), readRotation());
}

function afterRotationChange() {
  state.items = joinRotation(readRotation(), readCache());
  renderDebugPlaylists(state.items, state.candidateCount);
  return candidates();
}

function paintSettings() {
  renderSettings(appEl, {
    loggedIn: isLoggedIn(),
    loading: !state.cachePresent && !state.settled,
    fadeMs: readFadeMs(),
    minFadeMs: MIN_FADE_MS,
    maxFadeMs: MAX_FADE_MS,
    stepFadeMs: FADE_STEP_MS,
    candidates: candidates(),
    onToggleMember: (id) => {
      if (isInRotation(id)) removeFromRotation(id);
      else addToRotation(id); // appends to the end (#8)
      return afterRotationChange();
    },
    onToggleNofadein: (id) => {
      toggleNofadein(id);
      return afterRotationChange();
    },
    // #10, independent of nofadein: in order from track 1 with shuffle off.
    onToggleInorder: (id) => {
      toggleInorder(id);
      return afterRotationChange();
    },
    onFadeChange: (ms) => writeFadeMs(ms),
    onLogin: () => beginLogin(),
  });
}

/**
 * A drop (#3). The DOM is already in the new order — the drag put it there — so this
 * writes it through and updates our copy, but deliberately does NOT repaint: a repaint
 * would rebuild the tiles under the user's thumb mid-rearrange. The next paint (leaving
 * edit mode, or any reload) renders from the rotation, which is now the same order.
 */
function onReorder(ids) {
  reorderRotation(ids);
  state.items = joinRotation(readRotation(), readCache());
  renderDebugPlaylists(state.items, state.candidateCount);
}

function paint() {
  const route = currentRoute();
  paintNav(route);

  if (route === 'settings') {
    // Membership is settings' job and order is the grid's; leaving the grid leaves edit
    // mode, so coming back is always a playable grid.
    state.editing = false;
    paintSettings();
    return;
  }

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
      notice: state.notice,
      editing: state.editing,
      onToggleEdit: (next) => {
        state.editing = next;
        paint();
      },
      onReorder,
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
  // Same rule as a drop: never rebuild the tiles while they are being dragged. A
  // revalidation landing mid-rearrange would yank the tile out from under the finger.
  // The list is up to date either way, and leaving edit mode paints it.
  if (!state.editing) paint();
  renderDebugPlaylists(state.items, state.candidateCount);
}

async function main() {
  initDebugToggle();
  purgeLegacyStorage();

  // `x-error` sends the phone back here with `?err=1`. Read it and strip it before
  // anything else touches the URL, so a later reload of this same address does not
  // re-announce a failure that already happened.
  if (consumeHandoffError()) {
    state.notice = HANDOFF_ERROR_TEXT;
    setDebugStatus('returned from the shortcut with ?err=1 — the transition failed', 'error');
  }

  // One delegated listener for the life of the page: the grid re-renders, this does not.
  // It records the tap and returns — the anchor's own navigation does the rest (#4).
  attachTriggerRecorder(appEl);

  // Grid ⇄ settings. The hash is the whole router.
  window.addEventListener('hashchange', paint);

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
