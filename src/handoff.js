// The href a tile carries.
//
// PLACEHOLDER — issue #4 owns the real one. What matters here, and the reason this
// exists as its own seam, is the shape: every tile is a real `<a>` with its href
// already in the DOM before the tap. #4's spike found that a tapped link reaches
// Shortcuts with no iOS confirmation prompt, while a URL constructed and navigated to
// at tap time risks one. So #2 builds anchors, and #4 changes only what this function
// returns — nothing has to be ripped out.
//
// Until then the href points at the playlist on Spotify: a real, working destination,
// so the tiles are genuinely tappable during playtest, and honest about the fact that
// no fade happens yet.

export function buildTileHref(playlist) {
  const id = playlist?.id;
  if (!id) return null;
  return `https://open.spotify.com/playlist/${encodeURIComponent(id)}`;
}
