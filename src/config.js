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
export const SCOPES = [
  'playlist-read-private',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-read-playback-state',
  'user-modify-playback-state',
];

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
