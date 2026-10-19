# playlist-buttons

A phone-first remote for switching between Spotify playlists with a volume fade
across the transition. Built for tabletop sessions: tap a playlist's cover art,
the current music fades out, the new playlist starts — shuffled, or in order from
track 1 if it's marked that way — and it fades back in.

## Why it's shaped this way

The fade is the whole app, and for most of this project's life the fade could not live
here. It lived in an iOS shortcut, and the reason was real:

- **Web Playback SDK `setVolume()`** — WebKit makes `HTMLMediaElement.volume`
  read-only, so it silently no-ops. (The SDK itself *does* run in iOS Safari,
  contrary to Spotify's docs.)
- **`PUT /me/player/volume`** — tested, and it failed too.

Spotify's built-in crossfade doesn't help either: it only applies when a track ends on
its own, not on a triggered playlist change. What *can* set volume on iOS is the
Shortcuts app — so the volume ramp went into a shortcut (#4), and everything else stayed
in the web app.

### What that got wrong, and when it dissolved

The first finding still holds. The second one was true as measured and wrong as
generalised, and the distinction is the thing worth remembering:

**Remote volume is a property of the playback DEVICE, not of the API.** The test that
dismissed `PUT /me/player/volume` was run with the phone as Spotify's playback device. A
phone driving a Bluetooth speaker has no remote volume to set — Spotify sees the *phone*
as the device and the speaker is only an output, so the only volume in the picture is iOS
system volume, which is exactly what WebKit won't give a page. The API wasn't refusing;
there was nothing there to turn.

Put a **Spotify Connect device** in front of it and the same call works. Tested on device
2026-10-19: with the Mac as the player, Jackson moved the Mac's volume from his phone's
Spotify. `GET /me/player` reports this per device as `device.supports_volume`, which is
the app's own way of asking the question now.

The push to go back and retest came from iOS 27 (#12): it made the Shortcuts `Set Volume`
action expensive per call — around 1.5s each, established by splitting a probe shortcut
until only that action was left — which capped a transition at five calls. The fade
degenerated to four coarse steps down and the fade-in disappeared entirely. So the
shortcut route got worse at the same moment the API route turned out to have been
available all along.

**The fade now lives in the app** (#13). On tap: read the device's volume, ramp it to zero
over the configured fade, start the new playlist, ramp back up. About 24 volume calls per
transition, twelve each way.

What that deleted, rather than merely moved: the `shortcuts://` handoff, the app switch to
Shortcuts and back, the 5-call budget, the reimport-after-every-change cycle, the whole
class of plist-shape bugs that dominated #4 — and, in the app itself, the rule that every
tile had to be a real `<a>` with its href built at render time and nothing in the tap path
allowed to `await`. That rule existed solely to keep iOS from showing an "Open in
Shortcuts?" prompt on the handoff. With no Shortcuts in the path, tiles are ordinary
buttons with async handlers.

### The case the shortcut still answers

Phone-as-player with a Bluetooth speaker is still the case the API cannot fade, because
the limitation was never the API. `shortcut/` and its generator stay in the repo,
unchanged and still buildable, as recoverable history for exactly that — see
`shortcut/README.md`, which also holds the record of making it work on device. Nothing in
`src/` references it.

The app does not pretend the case away. If `GET /me/player` says the active device will
not take remote volume, the playlist switches **immediately, at full volume**, and the
grid says so in one quiet line. Never silently nothing, and never a refusal to switch —
the music changing is the point, the fade is the polish.

### Why not a native iOS app

A native app could set system volume directly, which would fade the phone-as-player case
too. It was weighed rather than overlooked, and it loses on cost: Xcode and Swift instead
of the plain-JS + Vite stack reused across these projects, an Apple Developer account to
keep the app installed past the 7-day sideload window, and a rebuild-and-reinstall cycle
in place of pushing to Pages.

It was a closer call when the shortcut was in the path, because the thing native would
have fixed was the app switch — and a throwaway spike had already shown the switch was
tolerable, so the main advantage turned out not to hurt. The switch is gone now, which
removes the last of that advantage: there is no handoff left to improve on.

## Architecture

The web app is a remote — it never plays audio. Spotify is the player. Everything a
transition does is a Web API call from this tab:

```
tap a tile
  ├─ GET  /me/player                    read the device's volume, and whether it fades
  ├─ PUT  /me/player/volume  × 12       ramp down to silence
  ├─ PUT  /me/player/play               the new playlist, at the chosen track
  ├─ PUT  /me/player/shuffle            on, or off for an `inorder` playlist
  └─ PUT  /me/player/volume  × 12       ramp back up (or one call, for `nofadein`)
```

No app switch, no page reload, nothing queued in another app. The app stays on screen and
in control for the whole transition, which is what makes it able to *report* a failure —
under the shortcut a failed transition was silent by construction.

**Play comes before shuffle, not after.** Spotify does not guarantee the order two Player
writes are applied in, and setting shuffle first raced the play call and lost on device
(#10): "no shuffle" started on track 1 and then shuffled everything after it. The shortcut
had to do it in this order too. The finding is about Spotify, so it survived the rewrite.

### Two things the ramp has to get right

Both are consequences of the fade being twelve network round trips rather than twelve
local writes.

**It is paced against the wall clock.** Each `PUT` is a 100–300ms round trip, so at twelve
steps over 3s the requests alone can cost more than the fade is allowed to take. Sleeping
`duration / steps` between calls would overrun the setting, and overrun it *more* the
slower the connection, which is the wrong way round. So every step has a deadline, the
loop reads the clock before each write, and a run that has fallen behind **skips levels
rather than overrunning**. A fade missing some of its steps still sounds like a fade; one
that takes five seconds when it was set to three does not. The round trip is measured as
it goes, so a write is issued early enough to *land* on its deadline.

**A second tap supersedes the first.** Two ramps writing volume at once would fight, and
the second one must not read the current volume as the level to restore to — mid-fade-out
that is on its way to zero, and every tap would quietly ratchet the music down. So a new
transition cancels the one in flight and inherits its original volume, which is carried
along until a transition finishes cleanly.

And when a request fails mid-ramp, the volume is put back in one call before anything
else. Getting the user's volume back matters more than completing the transition.

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

That list is **sorted**: the rotation first, in button order, then the rest under an
"other playlists" divider. The sort is what makes the order draggable at all — a list
in account order would scatter button 3 forty rows away from button 4. Each member row
carries a drag handle at its trailing edge, and a drag can only start there, so the row's
own tap keeps meaning add-or-remove and nothing else. A drag can't push a row out of the
member block either; leaving the rotation is a tap, not a gesture.

Reordering used to live on the grid, behind an edit mode that turned tap-to-play off
while you dragged. Moving it here deleted the mode outright, and with it the only
`preventDefault` in the app — which at the time mattered more than the tidiness, because
#4's on-device spike had found that suppressing or synthesising navigation is what brings
iOS's "Open in Shortcuts?" prompt back. That particular danger is gone with the shortcut
(#13), and the grid's tiles are buttons now rather than links. The reason to keep
reordering on the settings screen is the one that survives either way: the grid has ONE
kind of tile and no mode to get stuck in, and the rotation is already decided on the
screen where you drag it.

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
there's no per-playlist fade length. Zero is a permitted value, and means no fade at all:
the playlist just switches.

Twelve steps each way, one constant (`FADE_STEPS` in `src/transition.js`) rather than a
number per direction. Twelve is what the shortcut's ramp used before iOS 27 cut it to
four (#12); the steps are cheap again now that they are HTTP calls rather than Shortcuts
actions.

The per-playlist fade setting is `nofadein` — the **no fade-in** pill on the playlist's
settings row — which means the new playlist starts at full volume instead of ramping, as
a single volume call rather than a ramp. That pill means something again: under the
shortcut's 5-call budget there was no fade-in left for it to skip, so it had quietly
become a no-op (#6, #12).

## Shuffle, and playing in order

By default a playlist starts shuffled from a random track. The offset is rolled when a
tile is TAPPED, which is the obvious place for it and took two detours to get to: it
started out rolled into each tile's href at render time, because every transition ended
in a page load and that reload was the re-randomising step; when the reload went away the
app re-rolled on `visibilitychange` instead, to keep the same effect. With the whole
transition in the tap handler (#13) neither trick is needed — the tap decides, once, for
the playlist being tapped. A playlist can instead be marked
`inorder` on the settings screen — the **no shuffle** pill — which starts it at track 1
with shuffle off, the same way every time (#10). It's a second, independent pill beside
**no fade-in**, not a combined control: a playlist can start loud, start at track 1, both or
neither.

Both pills name the *exception* rather than the behaviour ("no fade-in", not "full
volume"; "no shuffle", not "in order"), so an unlit row reads as "nothing unusual about
this one" at a glance down a list that is mostly unlit.

## What one tap decides

Resolved at **tap time**, from the rotation entry and the fade setting:

```js
{ contextUri: 'spotify:playlist:…', position: 47, shuffle: true,
  downMs: 3000, upMs: 3000 }
```

`shuffle` and `position` are decided together: normally `true` with a random offset, and
for an `inorder` playlist `false` with `position: 0`. A random offset with shuffle off
would play the rest of the playlist from a random point, and position 0 with shuffle on
would not start on track 1 at all — so they are one decision in two fields.

`upMs: 0` is `nofadein`: restore the captured volume in one call instead of ramping. The
restore happens *after* the play call returns, so the outgoing track never jumps back up.

This used to be a JSON payload percent-encoded into a `shortcuts://` URL, built at render
time because the tap path was not allowed to compute anything. Now it is a plain object
built in the click handler, which is why the start offset is re-rolled per *tap* rather
than per *render*.

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
