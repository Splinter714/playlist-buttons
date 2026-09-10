// Spotify app configuration.
//
// The client ID is PUBLIC BY DESIGN. This is a PKCE public client: it has no client
// secret, and the ID is baked into the JS bundle that ships to every browser no matter
// where it is stored. Putting it in a .env would hide it from nobody and would only
// break the static GitHub Pages build. Please do not "fix" this.
export const CLIENT_ID = 'b7db750c39cd449eb9c07493cf21e2c5';

// Both of these must be registered on the Spotify app's settings page, byte for byte.
// Spotify requires https for redirect URIs; the loopback IP is the one http exception,
// and "localhost" is explicitly NOT accepted — it has to be 127.0.0.1.
//
// Both MUST include the '/playlist-buttons/' path. vite.config.js sets
// base: '/playlist-buttons/' so the Pages build works, which means the dev server
// serves the app at http://127.0.0.1:5173/playlist-buttons/ too — not at the root.
// A redirect URI pointing at the root would send Spotify back to a path where the
// app isn't served, and would not match what's registered.
export const REDIRECT_URI_PROD = 'https://splinter714.github.io/playlist-buttons/';
export const REDIRECT_URI_DEV = 'http://127.0.0.1:5173/playlist-buttons/';

// No `streaming` scope: the web app never plays audio (see README). The native Spotify
// app is the player; this is only a remote.
//
// No modify scopes either, since #9: rotation membership, order and `nofadein` live in
// localStorage and the app never writes anything back to Spotify. Read-only on playlists.
// `playlist-read-collaborative` is deliberately left out to keep the consent screen
// short — adding it later just costs one re-consent.
export const SCOPES = [
  'playlist-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
];

// Scopes this app used to request and no longer does. A stored session that still carries
// one of these predates #9 and has to be re-consented rather than reused — see scopes.js.
export const REMOVED_SCOPES = [
  'playlist-modify-private',
  'playlist-modify-public',
];

// Where someone goes to GET the PlaylistButtons shortcut. Without it installed under
// exactly that name, every tile on the grid is a link to nowhere — so the app has to be
// able to point at it rather than assuming whoever is holding the phone already knows.
//
// An iCloud share link, so it installs in one tap. It is a SIGNED SNAPSHOT of the
// shortcut as it was when it was shared, not a live view of shortcut/build.mjs: rebuild
// the shortcut and this link still hands out the old one until it is re-shared from the
// Shortcuts app and the new URL put here.
export const SHORTCUT_URL = 'https://www.icloud.com/shortcuts/1d4a520ced5743e38562607289ed7c14';

export const AUTH_ENDPOINT = 'https://accounts.spotify.com/authorize';
export const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
export const API_BASE = 'https://api.spotify.com/v1';

// Refresh when under this much time is left. Never lazily at tap time — issue #4:
// an `await` between the tap and the navigation can lose gesture attribution and
// bring the iOS "Open in Shortcuts?" prompt back.
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const REFRESH_CHECK_INTERVAL_MS = 60 * 1000;

export function resolveRedirectUri(loc = globalThis.location) {
  const host = loc?.hostname ?? '';
  if (host === '127.0.0.1' || host === 'localhost') return REDIRECT_URI_DEV;
  return REDIRECT_URI_PROD;
}
