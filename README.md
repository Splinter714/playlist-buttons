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

Rotation membership lives in the Spotify playlist description, so it's managed from
the Spotify app rather than a second place:

```
Late night driving stuff. [game order:3 nofadein]
```

- presence of `[game ...]` — in the rotation
- `order:N` — button position, rewritten when buttons are dragged
- `nofadein` — optional; skip the fade-in and start at full volume

Only works on playlists you own, which is fine — all of them are.

## Shortcut contract

Receives JSON as input:

```json
{ "token": "...", "context_uri": "spotify:playlist:...", "offset": 47,
  "downMs": 3000, "upMs": 3000 }
```

`upMs: 0` means restore to full volume immediately instead of ramping. The restore
happens *after* the play call returns, so the outgoing track never jumps back up.

## Scopes

`playlist-read-private`, `playlist-modify-private`, `playlist-modify-public`,
`user-read-playback-state`, `user-modify-playback-state`

No `streaming` scope — the SDK isn't used.

## v1

Playlist buttons as cover art, drag to reorder, tap to transition, shuffle with a
random start offset, per-playlist `nofadein`, 3s default fades adjustable in settings.

Not in v1: artwork upload from the app (`ugc-image-upload`), auto-rotation, mood groupings.
