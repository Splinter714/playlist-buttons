# playlist-buttons

A phone-first remote for switching between Spotify playlists with a volume fade
across the transition. Built for tabletop sessions: tap a playlist's cover art,
the current music fades out, the new playlist starts shuffled, and it fades back in.

## Why it's shaped this way

iOS blocks programmatic volume control on the web. Both paths were tested and both
fail on iPhone:

- **Web Playback SDK `setVolume()`** — WebKit makes `HTMLMediaElement.volume`
  read-only, so it silently no-ops. (The SDK itself *does* run in iOS Safari,
  contrary to Spotify's docs.)
- **`PUT /me/player/volume`** — also fails against the mobile web player.

Spotify's built-in crossfade doesn't help either: it only applies when a track ends
on its own, not on a triggered playlist change.

What *can* set volume on iOS is the Shortcuts app. So the volume ramp lives in a
shortcut, and everything else lives in the web app.

### Why not a native iOS app

A native app could set system volume directly and skip the Shortcuts handoff
entirely — no app switch, no `x-success`, no page reload per transition. That's a
real advantage, and it was weighed rather than overlooked.

It loses on cost. Native means Xcode and Swift instead of the plain-JS + Vite stack
reused across these projects, an Apple Developer account to keep the app installed
past the 7-day sideload window, and a rebuild-and-reinstall cycle in place of pushing
to Pages.

The deciding factor was that the handoff was tested before being built on. A throwaway
two-action shortcut proved `x-success` returns to Safari with no iOS confirmation
prompt — provided the app fires it from a real link tap under a user gesture, since
address-bar navigation *does* prompt — and the app switch was unobtrusive in practice.
The main thing native would have fixed turned out not to hurt.

## Architecture

The web app is a remote — it never plays audio. The native Spotify app is the
player, a Bluetooth speaker is the output, and the shortcut fades iOS system volume.

```
web app  ──shortcuts://x-callback-url──▶  shortcut
(UI, config, playlist data)               ├─ ramp system volume down
                                          ├─ PUT /me/player/play  (new playlist)
                                          └─ ramp back up (or jump to full)
```

One visible app switch per transition — Safari to Shortcuts and back via
`x-success`. Audio continues throughout.

## Membership and ordering

Which playlists are in the rotation, what order they sit in, and which skip the
fade-in all live in `localStorage`. The app never writes anything to Spotify — it only
reads the playlist list.

```js
[{ id: '37i9…', nofadein: false }, { id: '4kQr…', nofadein: true }]
```

The array order *is* the button order, so reordering is moving an element. It's an
include list: nothing is in the rotation until it's added, from the setup page.

This started out the other way round. Membership lived in the playlist description as
a `[game order:3 nofadein]` tag, which was appealing because it's managed from the
Spotify app, syncs to every device, and needs no second place to keep state. That
rested on one assumption — that every playlist in the rotation is one you own — and
it doesn't hold: some of them are other people's playlists, followed not owned, and
**you cannot edit the description of a playlist you don't own**. A description tag
physically cannot express membership for those, so the tag couldn't be the source of
truth for the rotation and had to go entirely.

What that costs, accepted knowingly: the rotation is per-browser. It doesn't sync to
another device, and clearing Safari's site data loses it. Everything here runs on the
one phone anyway, and rebuilding the list from the setup page is a couple of minutes'
work, so there's no export or backup for now. Any `[game ...]` tags still sitting in
descriptions are dead text — nothing reads them; delete them by hand if they annoy
you.

`GET /me/playlists` still pages through everything, but it's now the *candidate*
list — the pool the setup page picks from, and the source of names and cover art —
rather than the rotation itself. It already returns playlists you follow but don't
own, which is the whole point.

## Shortcut contract

Receives JSON as input:

```json
{ "token": "...", "context_uri": "spotify:playlist:...", "offset": 47,
  "downMs": 3000, "upMs": 3000 }
```

`upMs: 0` means restore to full volume immediately instead of ramping. The restore
happens *after* the play call returns, so the outgoing track never jumps back up.

## Scopes

`playlist-read-private`, `user-read-playback-state`, `user-modify-playback-state`

No `streaming` scope — the SDK isn't used. No modify scopes either: with membership
local, nothing is ever written back to Spotify, so read-only on playlists is enough.
`playlist-read-collaborative` is deliberately left off too, to keep the consent
screen short; adding it later costs one re-consent.

Dropping the two modify scopes is itself a re-consent. The app checks a stored
session's granted scopes on load and sends it back through login if they predate the
change, rather than running on a token that can still edit playlists.

## v1

Playlist buttons as cover art, drag to reorder, tap to transition, shuffle with a
random start offset, per-playlist `nofadein`, 3s default fades adjustable in settings.

Not in v1: artwork upload from the app (`ugc-image-upload`), auto-rotation, mood groupings.
