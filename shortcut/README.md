# The PlaylistButtons shortcut

The web app hands off to an iOS shortcut named **PlaylistButtons** to do the one
thing iOS won't let a web page do: change system volume. The shortcut fades the
volume down, switches playlist through the Spotify Web API, and fades back up.

This directory generates that shortcut from source, so tuning the fade means
editing a number in `build.mjs` and rebuilding — not dragging 70 actions around
on a phone screen.

## Reading the shape out of a shortcut that works

Every plist shape in `build.mjs` that was reasoned about rather than copied has been
wrong, and each wrong one cost a rebuild-import-test cycle on a phone. The ones that
work were lifted verbatim from a shortcut that works. This is the tool for lifting:

```sh
npm run shortcut:inspect -- ~/path/to/YourWorking.shortcut
```

It reads both that file and `dist/PlaylistButtons.shortcut`, and prints — per action
type — which parameter keys yours carries that the generated one does not, and vice
versa. That difference is the fix, arrived at from evidence instead of another theory.

Add action names to dump those actions in full, for when the keys match but a value is
shaped wrong inside — which is how an action can look right in the editor and still do
nothing:

```sh
npm run shortcut:inspect -- ~/path/to/YourWorking.shortcut downloadurl url
```

Binary and XML plists both work. It uses `plutil` where it exists and falls back to
python3's `plistlib`, so it behaves the same on the Mac and on a Linux box.

Point it at the shortcut you have **fixed by hand**, not at one exported from this
generator — the whole point is the difference between the two.

## Build

```sh
npm run shortcut:build
```

Writes `shortcut/dist/PlaylistButtons.shortcut` — an unsigned, old-format plist.
`dist/` is gitignored; the generator is the source of truth.

Then sign it:

```sh
npm run shortcut:sign
```

That builds and signs in one step, writing
`shortcut/dist/signed/PlaylistButtons.shortcut`.

Two things about that command are load-bearing:

- **`--mode anyone`.** The default, `people-who-know-me`, produces a file only
  your own contacts can open.
- **The signed file goes in its own directory rather than getting a suffix.**
  The imported shortcut is named after the *filename*, so signing to
  `PlaylistButtons.signed.shortcut` imports a shortcut called
  `PlaylistButtons.signed` — which does not match the `name=PlaylistButtons` in
  the app's URL, and the handoff silently does nothing. An earlier version of
  these instructions had exactly that bug.

## Install it on the phone

A shared copy, which installs in one tap:
<https://www.icloud.com/shortcuts/1d4a520ced5743e38562607289ed7c14>. That link is
a **signed snapshot** of the shortcut as it was when it was shared — it does not
track this generator, so after changing `build.mjs` it keeps handing out the old
one until it is rebuilt and re-shared from the Shortcuts app. The web app does not
link to it: the settings screen is for the rotation and the fade, and a link to an
install that has to be kept in step by hand did not earn a section on it.

To build and install it yourself:

1. `npm run shortcut:sign`
2. `open shortcut/dist/signed/PlaylistButtons.shortcut` — Shortcuts launches and
   offers to add it.
3. **Check the name is exactly `PlaylistButtons`.** Beyond the suffix problem
   above, a re-import over an existing one can land as `PlaylistButtons 1`.
   Either way the handoff breaks with no visible error, so check every time you
   reinstall. `shortcuts list | grep PlaylistButtons` is the quickest way.
4. It syncs to the phone over iCloud, assuming Shortcuts sync is on for both
   devices. Give it a minute.
5. On the phone, open the shortcut once and run it manually. It will fail (no
   input), but that first manual run is what gets iOS to stop asking about
   permissions later — expect prompts about allowing it to send data to
   `api.spotify.com`, and say yes.

To update it after a rebuild, import again and delete the old one. There's no
in-place update.

## Tuning the fade

Both knobs are constants at the top of `build.mjs`:

- `STEPS` — how many volume steps each ramp is divided into. Now 20, up from an
  original guess of 12. More steps sound smoother but each one costs a
  volume-set and a wait. Tune it by ear. It does not change the action count —
  the ramp is a repeat block, not unrolled — so raising it costs runtime inside
  the ramp, not import risk.
- `DEVICE_TRANSFER_SETTLE_SECONDS` — how long to wait after handing playback to
  a device before retrying. Only hit on the error path.

The ramp durations themselves (`downMs`, `upMs`) come in from the web app, not
from here.

## What it actually does

70 actions, in order:

1. Get Dictionary from Input, and pull out `token`, `context_uri`, `offset`,
   `shuffle`, `downMs`, `upMs`.
2. Get Device Details → Current Volume, saved as `V0`. Every ramp is a fraction
   of `V0`, so starting at 60% fades from 60% rather than jumping to 100% first.
3. Fade out: repeat `STEPS` times, setting volume to `V0 × (STEPS − Repeat Index) / STEPS`
   and waiting `downMs / STEPS / 1000` seconds.
4. `PUT /v1/me/player/play` with `{context_uri, offset: {position: N}}`.
5. A short wait, then `PUT /v1/me/player/shuffle?state=<shuffle>` — the value
   comes from the input, not from here. It is `true` for an ordinary playlist and
   `false` for one marked "no shuffle" in settings, which also arrives with
   `offset: 0` (#10). **After the play call, deliberately** — see below.
6. **Open App → Safari**, handing the phone straight back to the app now that
   the playlist is playing, so the fade-in happens with the app on screen instead
   of with Shortcuts on screen. `RETURN_VIA` in `build.mjs` picks the mechanism —
   `'app'`, `'url'`, or `false` for neither.
7. Fade back in to `V0` over `upMs` — behind the app, if step 6 worked.

There is no error recovery in the list, and that is not an omission — see
"No error recovery" below.

### Two places this departs from the plan in issue #4

Both are implementation shortcuts to the same observable behaviour, not scope
changes — but they're deliberate, so they're written down.

**Device recovery uses `?device_id=` instead of a separate transfer call.**
Issue #4 step 6 says transfer with `PUT /v1/me/player {device_ids, play: true}`
and then retry the play. Instead the retry goes straight to
`PUT /v1/me/player/play?device_id=<id>`, which transfers *and* plays in one
call. Same result, one fewer request, and it avoids having to serialise a JSON
**array** (`device_ids`) into the plist — array encoding inside `WFJSONValues`
is the shape I'd have been least sure of.

**`upMs: 0` has no special branch.** Issue #4 step 8 says set volume straight to
`V0` when `upMs` is 0. Here the normal fade-in loop runs, but every wait computes
to 0 seconds, so all 20 volume sets fire back-to-back and land on `V0` in a few
milliseconds. Behaviourally the same jump, and it avoids a numeric conditional
whose plist shape I'd have been guessing at. If it turns out to be audible as a
very fast ramp rather than an instant jump, that's the thing to fix.

### No error recovery

There used to be one: if the play call came back with a body containing
`"error"`, look up a device and retry against it, and if that failed too,
restore the volume and show the response. It is gone. Every shape tried for
those two `If` actions rendered with a blank condition on device, across several
rebuilds, and the working shortcut was reached by pulling them out by hand — so
the generator stopped emitting them rather than regenerating something known
broken.

What that costs, should it be worth revisiting: nothing recovers when Spotify is
not the active device (the play call fails and the music carries on unchanged),
and a failed transition is silent — the fade dips and comes back with the same
playlist still playing.

Worth knowing if it is picked up again: the recovery only needed a conditional
because it was a *retry*. Done unconditionally — always `GET
/v1/me/player/devices`, always pass `?device_id=` on the play call — there is no
`If` in it at all, and `?device_id=` transfers and plays in one request (below).

### Returning to the app early

`x-success` is Shortcuts' own mechanism and only fires when the run *finishes*,
which is the whole duration of the transition — both ramps plus request latency.
So the return is an explicit action placed right after the play call. `RETURN_VIA`
picks which:

**`'app'` — Open App → Safari.** The default. Brings the tab forward exactly as
it was, with no reload, so the grid is simply back. It cannot target the web app
itself: Shortcuts' Open App does not list installed web apps (tested on device
2026-09-09, recorded in `src/handoff.js`). Safari is the right target regardless,
since that is where the app is used from — the same finding established that a
Home Screen web app cannot be returned to at all.

**`'url'` — Open URLs → `return_url` from the input.** Lands on the exact page
rather than on whatever tab happens to be frontmost, at the cost of navigating
that tab, which reloads it. Worth switching to if Safari comes forward on the
wrong tab.

Not reloading costs nothing, but not for the reason it first appeared to: the app
repaints itself when it comes back to the front, which is what re-rolls each
tile's random offset. It is emphatically not because `x-success` reloads at the
end of the run — see below, it does not.

**There is no `x-success` and no `x-error` any more.** They do not fire at the end
of the run: once the shortcut has put Safari in front, a backgrounded app cannot
switch apps, so the callback waits until Shortcuts is next foregrounded by hand —
and then fires, pulling the phone to Safari out of nowhere. The run itself keeps
going; the fade-in completes normally. It is only the app switch that queues.

So the early return is now the *only* return, and if it fails on some iOS version
the shortcut finishes and leaves you in Shortcuts — which is what `RETURN_VIA` and
the guess table below are for. The web app used to get a page load per transition
out of `x-success`; it repaints on `visibilitychange` instead.

**The failure mode to watch for on device.** What runs after the early return is
the fade-in. A backgrounded Shortcuts run that iOS suspends part way through
leaves system volume part way down, with the music playing quietly and nothing
on screen saying so. Test it: transition, and check the volume comes all the way
back — with the phone unlocked, with it locked, and with another app in front.
Also try tapping a second tile mid-transition; the old behaviour made overlapping
runs impossible by keeping the app off screen, and this removes that interlock.
If the volume is unreliable, `RETURN_VIA = false` puts it back.

## What I'm confident about vs. what's a guess

**Read this before the first import.** `plutil -lint` passes and
`shortcuts sign` succeeds, but neither proves the actions are real. I tested
this directly: `shortcuts sign` will happily sign a shortcut whose only action
is `is.workflow.actions.totally.made.up.nonsense`. Signing validates that the
file is a well-formed plist and nothing more. **Action identifiers and parameter
names are only checked when Shortcuts actually imports the file.**

### Confirmed

These were read out of a real, working Spotify shortcut on this Mac
(`~/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/Latest.shortcut`),
which happens to make the same `PUT /me/player/play` call with a
`context_uri` + `offset` body. Identifier *and* parameter shape both verified:

| Action | Identifier | Parameters |
| --- | --- | --- |
| Get Dictionary from Input | `detect.dictionary` | — |
| Get Value for Key | `getvalueforkey` | `WFDictionaryKey` |
| Set / Get / Append Variable | `setvariable`, `getvariable`, `appendvariable` | `WFVariableName` **plus `WFInput`** (see below), `WFVariable` |
| Get Contents of URL | `downloadurl` | `WFHTTPMethod`, `WFHTTPHeaders`, `WFJSONValues`, `Advanced`, `ShowHeaders` |
| URL | `url` | `WFURLActionURL` |
| If / Otherwise / End If | `conditional` | `WFCondition`, `WFConditionalActionString`, `WFControlFlowMode`, `GroupingIdentifier` |
| Repeat with Each | `repeat.each` | `WFControlFlowMode`, `GroupingIdentifier` |
| Wait | `delay` | `WFDelayTime` |
| Show Alert | `alert` | `WFAlertActionTitle`, `WFAlertActionMessage`, `WFAlertActionCancelButtonShown` |
| Comment | `comment` | `WFCommentActionText` |
| Stop Shortcut | `exit` | — |
| Get Device Details | `getdevicedetails` | **identifier only** — see below |
| Get Item from List | `getitemfromlist` | `WFItemSpecifier` (`'First Item'` — no longer emitted since the device-recovery branch was removed) |

The text-token serialisation (`WFTextTokenString` with `attachmentsByRange`,
`WFTextTokenAttachment`, `WFDictionaryFieldValue`, the `WFItemType` codes, and
the `{offset, 1}` range syntax) is confirmed the same way, as is the control-flow
convention that 0 / 1 / 2 mean start / otherwise / end.

`repeat.count` as an identifier is confirmed separately, out of the Shortcuts
app binary.

### The chaining rule — the thing that broke this twice

**Generated plists do not inherit the implicit chaining the Shortcuts editor wires up
for you.** Building by hand, each action's input box gets filled in as you drop it in.
Emitting the same actions as a plist leaves every consumer pointing at a bare
placeholder — the phone shows "Dictionary" or "URL" with nothing behind it, and the
action either errors or silently yields empty.

Jackson found this by opening the shortcut and noticing every Get Value for Key read
"Dictionary" until he filled it in himself. It explains failures that were previously
misattributed twice: first to the CLI test harness, then to Set Variable.

So **every action that consumes a previous value must name its input explicitly.** In
this generator that is handled at the helper level, via `prevRef()`:

| Action | Parameter |
| --- | --- |
| Get Dictionary from Input | `WFInput` — `ExtensionInput`, or explicitly the previous action. Omitting it does **not** chain; it silently falls back to Shortcut Input |
| Get Value for Key | `WFInput` |
| Get Item from List | `WFInput` |
| Get Contents of URL | `WFURL` — the URL **itself**, not a reference |
| If (opening, `WFControlFlowMode: 0`) | **none** — see the exceptions below |
| Set Variable | `WFInput` |

**Conditionals are the other exception, in three ways.** An `If` chains from the
preceding action implicitly and takes no `WFInput`. Its comparison value is a **plain
string** — a `WFTextTokenString` there leaves the condition blank. And, least
obviously, **an opening `If` must carry no `UUID` at all**: in the reference shortcut
all 7 opening conditionals and both `Repeat` openers are UUID-less, while `End If`
markers sometimes have one and work either way. This generator assigns UUIDs
automatically so actions can reference each other's output, so conditionals opt out via
`act(..., { noUUID: true })`.

That last one cost three rebuilds. The condition rendered blank on device while every
field in it was already correct, because of a key that shouldn't have been there.

`WFCondition` is omitted, which defaults to "contains" for text. Do not "fix" any of
this by adding an input or a UUID.

**Get Contents of URL is the exception to the rule above.** It takes its URL from a
`url` action immediately above it, and carries **no `WFURL` of its own** — that is how
all six requests in the reference shortcut are shaped. Two other forms were tried and
both failed on device:

| Shape | Result |
| --- | --- |
| `WFURL` pointing at the url action's output | "No URL Specified" |
| `WFURL` holding the URL inline, no url action | Displayed the URL correctly, but the request never fired — playback simply did not change, with no error |

The second is the dangerous one: it *looks* right when you open the shortcut. Jackson
caught it by noticing playback stopped changing and tracing it back to when the URL
handling changed.

> **Resolved 2026-09-10, from evidence rather than a guess.** `WFURL` on Get Contents of
> URL is the `url` action's output embedded as a token *inside a text string*: a
> `WFTextTokenString` whose entire string is one attachment, `{0, 1}` → `{Type:
> "ActionOutput", OutputUUID: <url action's UUID>, OutputName: "URL"}`. Read straight out
> of the hand-fixed working shortcut via `npm run shortcut:inspect` against the unsigned
> plist that an iCloud share link serves — the inspect tool's first real use, and it
> found the one missing key in one line.
>
> That makes four shapes tried in total; only this one imports with its URLs linked:
>
> | Shape | Result |
> | --- | --- |
> | `WFURL` as a bare `WFTextTokenAttachment` to the url action | "No URL Specified" |
> | `WFURL` holding the URL inline, no url action | Displayed correctly, never fired |
> | No `WFURL`, relying on chaining | Does not chain |
> | `WFURL` = token string containing the url action's output | **Works** |

`WFHTTPBodyType` is not set anywhere. In the reference it appears only on a Form body;
a JSON request carries `WFJSONValues` and nothing else.

`End If` and `Otherwise` markers take no input, and Repeat's control-flow entries take
none either. Anything added to this generator later that reads a prior value needs the
same treatment.

### The shuffle flag is a string, not a boolean

`400 Bad format for parameter state` on the shuffle call, on device. Shortcuts renders a
boolean taken from a dictionary as `1`/`0`, and Spotify's
`PUT /me/player/shuffle?state=` wants `true`/`false`. The app now sends `shuffle` as the
string `"true"` or `"false"` in the payload, so what reaches the URL is already correct
and the shortcut needs no conversion.

This was guessed at when #10 was built, and the symptom predicted then was *silent* —
playback starting normally with shuffle left however it was. It turned out to be a loud
400 instead, which is the better outcome.

### Shuffle is set AFTER the play call

It used to be set before, and "no shuffle" did not stick: the playlist started on
track 1, because `offset` said so, and then shuffled everything after it.

Two things account for that, and neither is a bug in this shortcut. Spotify's own
reference for [toggle shuffle](https://developer.spotify.com/documentation/web-api/reference/toggle-shuffle-for-users-playback)
says the order of execution is **not guaranteed** when it is combined with other
Player endpoints, and starting a context is separately reported to reset the
shuffle state ([spotify/web-api#605](https://github.com/spotify/web-api/issues/605)).
Setting shuffle first was therefore racing the play call, and usually losing.

Doing it second is safe because the play call names the start track: `offset`
decides the first track whatever shuffle happens to be at that instant, and the
shuffle call only settles the queue behind it. `SHUFFLE_SETTLE_SECONDS` sits
between the two for the same "not guaranteed" reason — two Player writes back to
back can be applied out of order.

The same race applied to ordinary playlists, where it was invisible: a random
start offset feels shuffled whether or not shuffle actually took.

Both calls happen before the return to Safari, so neither depends on a
backgrounded run.

### Verified on device, 2026-09-09

Three of these were settled by running probe shortcuts on the Mac and reading their
output back, rather than reasoning about them.

**The real fault was `Get Dictionary from Input` not reading Shortcut Input.**
Without `WFInput`, that action takes whatever the *previous* action produced. Fine
mid-chain — after an HTTP response, say — but here it was preceded by a `Comment`,
which produces nothing. So the dictionary was empty, all six unpacked values were
blank, and the first calculation died on `"" / 12 / 1000`, surfacing as a bare "Math
error" with no indication of which action failed. It now names `ExtensionInput`
explicitly, so it no longer depends on what sits above it. The one mid-chain use, for
the `/me/player/devices` response, passes `fromPrevious: true`.

**A correction on `Set Variable`.** An earlier note here claimed `setvariable`
requires an explicit `WFInput` or it silently stores nothing, based on a probe where
the bare form came back empty. Jackson's own working `refresh_token` shortcut
disproves the general claim — its `setvariable` actions carry no `WFInput` and work.
The `WFInput` this generator emits is harmless and arguably clearer (the phone renders
it as "Set variable V0 to Current Volume"), but it was not the bug, and the probe
result most likely reflected something else about that probe.

`build.mjs` now tracks the previously emitted action's UUID and points each
`Set Variable` at it.

**Guess 2 retired — `WFDeviceDetail: "Current Volume"` is correct.** A probe returned
`0.1875` with the Mac at 19%, so it works and returns a 0–1 fraction, which is what
the ramp arithmetic assumes.

**Guess 3 retired — `calculateexpression` with `Input` is correct.** A probe
calculating `2 + 2` returned `4`.

### `shortcuts run` cannot test any of this end to end

`shortcuts run --input-path <file>` does **not** deliver input to
`Get Dictionary from Input`. A probe returned identical empty results with a `.json`
file, a `.txt` file, and no input at all. So running this shortcut from the command
line always fails with "Math error" regardless of whether it is correct — the CLI is
useful for probing actions that do not read input, and useless for validating the
real path.

The only real test is tapping a tile in the web app, where the
`shortcuts://…&input=text&text=…` URL delivers the payload properly.

### Guesses — check these first if the import misbehaves

**Every guess this table ever held is now confirmed by a full working run on device
(2026-09-10):** fade out, playlist change, shuffle, fade in, return to Safari, in that
order, with nothing fixed by hand. The rows are kept as a record of what was uncertain
and how each one resolved, so they are not re-litigated.

| # | Was a guess | How it resolved |
| --- | --- | --- |
| 1 | `setvolume` / `WFVolume` as a 0–1 number | Both ramps audibly work. Confirmed. |
| 2 | `WFDeviceDetail: "Current Volume"` | Probe returned `0.1875` at 19%; restore-to-V0 works. Confirmed. |
| 3 | `calculateexpression` / `Input` | Probe returned `4` for `2 + 2`; ramps run. Confirmed. |
| 4 | `Repeat Index` as `{Type: "Variable", VariableName: "Repeat Index"}` | Fade is a smooth ramp, not one jump. Confirmed. |
| 5 | `openapp` with `WFAppIdentifier` + `WFSelectedApp` for Safari | Safari opens at the end of every run. Confirmed. |
| 6 | `openurl` taking `WFInput` from a `url` action | Only emitted for `RETURN_VIA = 'url'`, which is not in use. **Still unverified** — the one shape here nobody has run. |

**If a future import misbehaves, the cause is almost certainly a new action or a
changed shape, not one of these.** Run `npm run shortcut:inspect` against a shortcut
that works before guessing: that is what settled the last unresolved shape in one line,
after three rounds of reasoning got it wrong.

### If an action does import broken

Fix it in the Shortcuts app to get it working, then — so the fix isn't lost on
the next rebuild — export the corrected shortcut and diff its plist against
`shortcut/dist/PlaylistButtons.shortcut` to see the real identifier or parameter
name, and correct `build.mjs`. To read an exported shortcut:

```sh
plutil -convert xml1 -o - Exported.shortcut | less
```
