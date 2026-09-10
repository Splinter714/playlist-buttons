# The PlaylistButtons shortcut

The web app hands off to an iOS shortcut named **PlaylistButtons** to do the one
thing iOS won't let a web page do: change system volume. The shortcut fades the
volume down, switches playlist through the Spotify Web API, and fades back up.

This directory generates that shortcut from source, so tuning the fade means
editing a number in `build.mjs` and rebuilding — not dragging 70 actions around
on a phone screen.

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

The web app's settings screen links to a shared copy, which installs in one tap:
<https://www.icloud.com/shortcuts/1d4a520ced5743e38562607289ed7c14>. That link is
a **signed snapshot** of the shortcut as it was when it was shared — it does not
track this generator. After changing `build.mjs`, rebuild, re-share from the
Shortcuts app, and put the new URL in `SHORTCUT_URL` (`src/config.js`), or the
app will keep handing people the old shortcut.

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
4. `PUT /v1/me/player/shuffle?state=<shuffle>` — the value comes from the input,
   not from here. It is `true` for an ordinary playlist and `false` for one
   marked "no shuffle" in settings, which also arrives with `offset: 0` (#10).
5. `PUT /v1/me/player/play` with `{context_uri, offset: {position: N}}`.
6. If that failed, `GET /v1/me/player/devices`, take the first device, and retry
   the play call against it.
7. If it still failed, restore volume to `V0`, show the error, and stop.
8. Fade back in to `V0` over `upMs`.

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

### Error handling is thin, on purpose

Shortcuts has no try/catch. What it does have is that Get Contents of URL
returns the response body without halting, and Spotify is well behaved here: a
successful `PUT /me/player/play` returns **204 with an empty body**, while every
failure returns a JSON body containing `"error"`. So the error branch is just a
text check — *does the response contain "error"* — which uses only condition
shapes I've confirmed against a real working shortcut.

The cost is that it can't tell *which* error it got. "No active device" and
"token expired" both take the same recovery path: pick a device, retry once,
and if that fails too, restore the volume and show the raw response. For a
token problem the alert will show Spotify's own message, which is enough to
tell what happened.

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
| Get Item from List | `getitemfromlist` | `WFItemSpecifier` (key confirmed, value string is a guess) |

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

Set Volume and Get Device Details' parameter list don't ship on macOS in any
readable form (they're not in `WorkflowKit.framework`, the Shortcuts binary, or
the dyld shared cache), so these four could not be verified locally:

| # | Guess | Symptom if wrong | Fix |
| --- | --- | --- | --- |
| 1 | `is.workflow.actions.setvolume` with parameter `WFVolume`, a 0–1 number | Import shows a broken/greyed placeholder where a "Set Volume" action should be, or it imports but volume never changes | Replace both Set Volume actions by hand (there are 3 — two in the ramps, one in the error path) |
| 2 | `WFDeviceDetail: "Current Volume"` on Get Device Details | Action imports but the dropdown reads "Device Name" or similar; the fade jumps to a weird level or does nothing, because `V0` is text not a number | Open the action and pick Volume from its menu |
| 3 | `is.workflow.actions.calculateexpression` with parameter `Input` | Broken placeholder where each ramp's calculation should be; the ramps do nothing | Retype the expression — it's `V0 × (20 − Repeat Index) ÷ 20` for the fade out and `V0 × Repeat Index ÷ 20` for the fade in, using whatever `STEPS` is set to |
| 4 | `Repeat Index` as a magic variable, referenced as `{Type: "Variable", VariableName: "Repeat Index"}` | Ramps run but every step sets the same volume, so the fade is a single step | Re-pick the Repeat Index variable inside the calculation |

Two smaller ones:

- **The `shuffle` boolean interpolated into the URL.** The input JSON carries
  `shuffle` as a real boolean, and the URL is built as
  `…/shuffle?state=` + the `shuffle` variable, so this relies on Shortcuts
  rendering a dictionary boolean into text as `true` / `false`. If it renders
  `1` / `0` instead, Spotify rejects the call with a 400 and — because the
  shuffle call's result is not checked — the symptom is subtle: playback still
  starts, but shuffle stays however it was last left, so a "no shuffle" playlist
  shuffles anyway. Fix by having the web app send the string `"true"`/`"false"`
  in `handoff.js` instead of a boolean.
- **`WFItemType: 3` for `offset.position`.** If Spotify gets `"position": "47"`
  as a string rather than a number it may reject the play call with a 400. The
  symptom is the alert firing on every tap with a message about a malformed
  body.
- **`WFRepeatCount`** (20, from `STEPS`) as a plain integer on `repeat.count`.
  If wrong, the repeat block imports with an empty or 1 count.

If items 1–3 all import cleanly, the rest of the shortcut is built out of shapes
lifted verbatim from a shortcut that works, and should be sound.

### If an action does import broken

Fix it in the Shortcuts app to get it working, then — so the fix isn't lost on
the next rebuild — export the corrected shortcut and diff its plist against
`shortcut/dist/PlaylistButtons.shortcut` to see the real identifier or parameter
name, and correct `build.mjs`. To read an exported shortcut:

```sh
plutil -convert xml1 -o - Exported.shortcut | less
```
