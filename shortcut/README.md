# The PlaylistButtons shortcut

The web app hands off to an iOS shortcut named **PlaylistButtons** to do the one
thing iOS won't let a web page do: change system volume. The shortcut fades the
volume down, switches playlist through the Spotify Web API, and fades back up.

This directory generates that shortcut from source, so tuning the fade means
editing a number in `build.mjs` and rebuilding — not dragging 67 actions around
on a phone screen.

## Build

```sh
npm run shortcut:build
```

Writes `shortcut/dist/PlaylistButtons.shortcut` — an unsigned, old-format plist.
`dist/` is gitignored; the generator is the source of truth.

Then sign it:

```sh
shortcuts sign --mode anyone \
  -i shortcut/dist/PlaylistButtons.shortcut \
  -o shortcut/dist/PlaylistButtons.signed.shortcut
```

`--mode anyone` matters. The default, `people-who-know-me`, produces a file only
your own contacts can open.

## Install it on the phone

1. `npm run shortcut:build`, then run the `shortcuts sign` command above.
2. Open the signed file on the Mac: `open shortcut/dist/PlaylistButtons.signed.shortcut`.
   Shortcuts launches and offers to add it.
3. **Rename it to exactly `PlaylistButtons`** if it didn't come in that way. The
   name is what the app's `shortcuts://x-callback-url/run-shortcut?name=…` URL
   asks for, and it comes from the *filename*, not from anything inside the
   plist — so a stray " 1" suffix from a re-import will silently break the
   handoff. Check for that every time you reinstall.
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

- `STEPS` — how many volume steps each ramp is divided into. 12 is a starting
  guess, not a considered value. More steps sound smoother but each one costs a
  volume-set and a wait. Tune it by ear.
- `DEVICE_TRANSFER_SETTLE_SECONDS` — how long to wait after handing playback to
  a device before retrying. Only hit on the error path.

The ramp durations themselves (`downMs`, `upMs`) come in from the web app, not
from here.

## What it actually does

67 actions, in order:

1. Get Dictionary from Input, and pull out `token`, `context_uri`, `offset`,
   `downMs`, `upMs`.
2. Get Device Details → Current Volume, saved as `V0`. Every ramp is a fraction
   of `V0`, so starting at 60% fades from 60% rather than jumping to 100% first.
3. Fade out: repeat `STEPS` times, setting volume to `V0 × (STEPS − Repeat Index) / STEPS`
   and waiting `downMs / STEPS / 1000` seconds.
4. `PUT /v1/me/player/shuffle?state=true`.
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
to 0 seconds, so all 12 volume sets fire back-to-back and land on `V0` in a few
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
| Set / Get / Append Variable | `setvariable`, `getvariable`, `appendvariable` | `WFVariableName`, `WFVariable` |
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

### Guesses — check these first if the import misbehaves

Set Volume and Get Device Details' parameter list don't ship on macOS in any
readable form (they're not in `WorkflowKit.framework`, the Shortcuts binary, or
the dyld shared cache), so these four could not be verified locally:

| # | Guess | Symptom if wrong | Fix |
| --- | --- | --- | --- |
| 1 | `is.workflow.actions.setvolume` with parameter `WFVolume`, a 0–1 number | Import shows a broken/greyed placeholder where a "Set Volume" action should be, or it imports but volume never changes | Replace both Set Volume actions by hand (there are 3 — two in the ramps, one in the error path) |
| 2 | `WFDeviceDetail: "Current Volume"` on Get Device Details | Action imports but the dropdown reads "Device Name" or similar; the fade jumps to a weird level or does nothing, because `V0` is text not a number | Open the action and pick Volume from its menu |
| 3 | `is.workflow.actions.calculateexpression` with parameter `Input` | Broken placeholder where each ramp's calculation should be; the ramps do nothing | Retype the expression — it's `V0 × (12 − Repeat Index) ÷ 12` for the fade out and `V0 × Repeat Index ÷ 12` for the fade in |
| 4 | `Repeat Index` as a magic variable, referenced as `{Type: "Variable", VariableName: "Repeat Index"}` | Ramps run but every step sets the same volume, so the fade is a single step | Re-pick the Repeat Index variable inside the calculation |

Two smaller ones:

- **`WFItemType: 3` for `offset.position`.** If Spotify gets `"position": "47"`
  as a string rather than a number it may reject the play call with a 400. The
  symptom is the alert firing on every tap with a message about a malformed
  body.
- **`WFRepeatCount: 12`** as a plain integer on `repeat.count`. If wrong, the
  repeat block imports with an empty or 1 count.

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
