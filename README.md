# playlist-buttons

A phone-first remote for switching between Spotify playlists with a volume fade
across the transition. Built for tabletop sessions: tap a playlist's cover art,
the current music fades out, the new playlist starts — shuffled, or in order from
track 1 if it's marked that way — and it fades back in.

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

One visible app switch per transition — Safari to Shortcuts and back. Audio
continues throughout.

The switch is as short as it can be made: the shortcut opens the app's own URL
itself, in an Open URLs action placed right after the play call, so the phone is
back in Safari as soon as the new playlist is playing and the fade-in finishes
behind it. `x-success` is still sent and still fires when the run ends, as a
backstop for the case where that action does not switch apps.

### Why the app switch can't be avoided

Asked and checked rather than assumed: there is no way to run a shortcut in the
background from a web page. `shortcuts://run-shortcut` and its `x-callback-url`
form both foreground the Shortcuts app by design, and Apple ships no background
variant — the open feedback request asking for a `shortcuts-background://` scheme
([FB11516273](https://github.com/feedback-assistant/reports/issues/356)) is still
a request. The ways a shortcut *does* run without a visible switch — personal
automations, widgets, the Action Button, Control Center, Siri — are all triggered
by the system or by a direct tap on that control, and none of them can be fired
from a page in Safari.

So the switch is not a rough edge to file down; it is the price of the only API
that can set iOS system volume from outside a native app. The thing that would
remove it is a native app, ruled out above on cost.

## Membership and ordering

Which playlists are in the rotation, what order they sit in, which skip the fade-in and
which play in order all live in `localStorage`. The app never writes anything to
Spotify — it only reads the playlist list.

```js
[{ id: '37i9…', nofadein: false, inorder: false },
 { id: '4kQr…', nofadein: true,  inorder: true }]
```

The array order *is* the button order, so reordering is moving an element. It's an
include list: nothing is in the rotation until it's added, from the settings screen —
which is also the only way to take something off it, to reorder it, and where the fade
length and each playlist's two flags (`nofadein` and `inorder`) are set. One screen,
reached from the grid, no search box: a plain scrolling list of every playlist on the
account, tapped to add or remove.

That list is **sorted**: the rotation first, in button order, then everything else under
an "everything else" divider. The sort is what makes the order draggable at all — a list
in account order would scatter button 3 forty rows away from button 4. Each member row
carries a drag handle at its trailing edge, and a drag can only start there, so the row's
own tap keeps meaning add-or-remove and nothing else. A drag can't push a row out of the
member block either; leaving the rotation is a tap, not a gesture.

Reordering used to live on the grid, behind an edit mode that turned tap-to-play off
while you dragged. Moving it here deleted the mode outright, and with it the only
`preventDefault` in the app — which mattered more than the tidiness: #4's on-device spike
found that suppressing or synthesising navigation is what brings iOS's "Open in
Shortcuts?" prompt back, so the fewer places a tap on a tile is anything but a plain link
navigation, the better. Every tile on the grid is now a live link, always. Dragging a row
on a settings screen was never risky in the way dragging a live button was, so the mode
had nothing left to protect.

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
one phone anyway, and rebuilding the list from the settings screen is a couple of minutes'
work, so there's no export or backup for now. Any `[game ...]` tags still sitting in
descriptions are dead text — nothing reads them; delete them by hand if they annoy
you.

`GET /me/playlists` still pages through everything, but it's now the *candidate*
list — the pool the settings screen picks from, and the source of names and cover art —
rather than the rotation itself. It already returns playlists you follow but don't
own, which is the whole point.

## Fade

One duration, used for both the fade out and the fade in, 3s by default, adjustable on
the settings screen and stored in `localStorage` alongside the rotation. It's global —
there's no per-playlist fade length. The per-playlist fade setting is `nofadein` — the
**no fade** pill on the playlist's settings row — which means the new playlist starts at
full volume instead of ramping (`upMs: 0`).

## Shuffle, and playing in order

By default a playlist starts shuffled from a random track — the offset is re-rolled on
every page load, and every transition reloads the page. A playlist can instead be marked
`inorder` on the settings screen — the **no shuffle** pill — which starts it at track 1
with shuffle off, the same way every time (#10). It's a second, independent pill beside
**no fade**, not a combined control: a playlist can start loud, start at track 1, both or
neither.

Both pills name the *exception* rather than the behaviour ("no fade", not "full volume";
"no shuffle", not "in order"), so an unlit row reads as "nothing unusual about this one"
at a glance down a list that is mostly unlit.

## Shortcut contract

Receives JSON as input:

```json
{ "token": "...", "context_uri": "spotify:playlist:...", "offset": 47,
  "shuffle": true, "downMs": 3000, "upMs": 3000,
  "return_url": "https://splinter714.github.io/playlist-buttons/" }
```

`return_url` is where the shortcut sends the phone back to, partway through its
own run. It travels in the payload rather than being baked into the shortcut so
one installed shortcut serves both the dev server and the Pages build.

`shuffle` and `offset` are decided together: normally `true` with a random offset, and
for an `inorder` playlist `false` with `offset: 0`.

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

Playlist buttons as cover art, tap to transition, shuffle with a random start offset,
per-playlist `nofadein` and `inorder`, order dragged from the settings screen, 3s default
fades adjustable in settings.

Not in v1: artwork upload from the app (`ugc-image-upload`), auto-rotation, mood groupings.
