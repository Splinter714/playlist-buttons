// Entry point. The button grid (#2) is the main view; the debug table from #1 sits
// behind a toggle underneath it.
//
// Cache-first is still a hard requirement, though the reason changed: it used to be that
// every transition reloaded the page (#4). It doesn't any more — the transition happens
// in this tab (#13) — but the grid is the one thing on screen and it must never wait on
// the network to appear, so it paints from localStorage first regardless.
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
import {
  renderGrid, renderSkeleton, renderEmpty, renderSignedOut, attachTileHandler,
  TRANSITION_FAILED_TEXT, NO_VOLUME_TEXT, NO_PLAYER_TEXT,
} from './grid.js';
import { startTransition, fadeLatencyNote, FADED, UNFADED, FAILED } from './transition.js';
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
  // How the last transition went (#13): `null`, or `{text, kind}` for the one line above
  // the grid. It used to be read off the URL as `?err=1`, because the only moment the app
  // was running after a transition was the page load the shortcut's return caused. The
  // transition is in this tab now, so a failure can be reported as it happens.
  notice: null,
  // A row on the settings screen is under a finger right now (#3). Nothing may repaint
  // while that is true — a revalidation landing mid-drag would yank the row out from
  // under it. Deliberately NOT persisted: it lasts exactly as long as one gesture.
  dragging: false,
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
    // A drop (#3). The DOM is already in the new order — the drag put it there — so this
    // writes it through and hands back fresh positions for the badges, and the list
    // renumbers in place rather than being rebuilt.
    onReorder: (ids) => {
      reorderRotation(ids);
      return afterRotationChange();
    },
    onDragChange: (active) => { state.dragging = active; },
    onFadeChange: (ms) => writeFadeMs(ms),
    // Read from the round trip the last transition measured and stored — the settings
    // screen never makes a request of its own to work this out (#13 playtest).
    fadeNoteFor: (ms) => fadeLatencyNote(ms),
    onLogin: () => beginLogin(),
  });
}

/**
 * One line above the grid about the transition that just ran (#13). Most outcomes say
 * nothing — a fade that worked needs no commentary, and a superseded run returns
 * `undefined` so the run that took over gets to speak instead.
 */
function noticeFor(result) {
  if (result.outcome === FADED) return null;
  if (result.outcome === FAILED) return { text: TRANSITION_FAILED_TEXT, kind: 'error' };
  if (result.outcome === UNFADED) {
    if (result.reason === 'no-volume-support') return { text: NO_VOLUME_TEXT, kind: 'info' };
    if (result.reason === 'no-player') return { text: NO_PLAYER_TEXT, kind: 'info' };
    return null; // the fade length is set to zero — nothing to explain
  }
  return undefined;
}

/**
 * A tap. Takes as long as the fade takes, which is the whole difference from #4: the app
 * stays on screen and in control for the entire transition instead of handing the phone
 * to Shortcuts and hoping.
 *
 * `startTransition` owns the overlapping-taps problem — a second tap supersedes the ramp
 * in flight rather than fighting it — so this does not need to guard against one.
 */
async function runTransition(id) {
  const playlist = state.items.find((p) => p?.id === id);
  if (!playlist) return;

  // Repaint first: the now-playing marker moving is the feedback that something is
  // happening, and the fade-out takes seconds before the music changes.
  state.notice = null;
  if (!state.dragging) paint();

  const result = await startTransition(playlist);
  const notice = noticeFor(result);
  if (notice !== undefined) {
    state.notice = notice;
    if (!state.dragging) paint();
  }
  setDebugStatus(
    result.outcome === FAILED
      ? `transition failed: ${result.error?.message ?? 'unknown'}`
      : `transition ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`,
    result.outcome === FAILED ? 'error' : '',
  );
}

function paint() {
  const route = currentRoute();
  paintNav(route);

  if (route === 'settings') {
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
  // Never rebuild the list while a row is being dragged (#3): a revalidation landing
  // mid-rearrange would yank the row out from under the finger. The list is up to date
  // either way, and the next paint — the drop's own refresh, or leaving the screen —
  // shows it.
  if (!state.dragging) paint();
  renderDebugPlaylists(state.items, state.candidateCount);
}

async function main() {
  initDebugToggle();
  purgeLegacyStorage();

  // One delegated listener for the life of the page: the grid re-renders, this does not.
  // It records the tap and then runs the transition, which it is allowed to await (#13).
  attachTileHandler(appEl, { onTap: runTransition });

  // Grid ⇄ settings. The hash is the whole router.
  window.addEventListener('hashchange', paint);

  // Coming back to the tab. This carried real weight under the shortcut (#4): a
  // transition left the app, so this repaint was what re-rolled every tile's start offset
  // and rebuilt every href against the current token.
  //
  // It does much less now — the transition never leaves the tab, and the offset is rolled
  // at tap time — but a tab that has been in the background can still come back to a
  // refreshed token or a changed rotation, and a render off state we already hold costs
  // nothing.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // Never under a finger — same rule as everywhere else (#3).
    if (state.dragging) return;
    paint();
  });

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

  startRefreshTimer(
    (e) => {
      setAppStatus(`token refresh failed: ${e.message}`, 'error');
      setDebugStatus(`token refresh failed: ${e.message}`, 'error');
    },
    () => {
      // Repaint so a tile that fell back for want of a token becomes a real button
      // again. Skipped while a settings row is being dragged, for the same reason above.
      renderDebugAuth();
      if (!state.dragging) paint();
    },
  );

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
