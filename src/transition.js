// The transition: tap a tile, the current music fades out, the new playlist starts,
// and it fades back in. All of it in this app now (#13).
//
// ---------------------------------------------------------------------------------
// Why this is here at all, and not in a shortcut
// ---------------------------------------------------------------------------------
// It used to live in an iOS shortcut (#4), because the founding constraint was that iOS
// blocks programmatic volume control on the web — WebKit makes `HTMLMediaElement.volume`
// read-only, and `PUT /me/player/volume` was tried and failed too.
//
// That second finding was true but misread. It was tested with the PHONE as Spotify's
// playback device, and a phone driving a Bluetooth speaker has no remote volume to set:
// Spotify sees the phone as the device, the speaker is only an output, so "volume" there
// really is iOS system volume. It is a property of the DEVICE, not of the API. Tested on
// device 2026-10-19: with a Spotify Connect device as the player (the Mac), remote volume
// works — Jackson moved the Mac's volume from his phone.
//
// So the fade moves here, and the shortcut is retired. `shortcut/` and its generator stay
// in the repo as recoverable history for the phone-as-player case; nothing in `src/`
// references them.
//
// ---------------------------------------------------------------------------------
// Constraints this file does NOT have, and must not grow back
// ---------------------------------------------------------------------------------
// The old handoff put a hard rule on the tap path: every tile had to be a real `<a>` with
// its href fully built at render time, nothing in the tap path could `await`, and nothing
// could call `preventDefault` — because an await or a synthesised navigation can lose user
// gesture attribution, which is what brought iOS's "Open in Shortcuts?" prompt back.
// `getAccessTokenSync()` exists for that reason.
//
// Every bit of that existed SOLELY to protect the handoff into Shortcuts. There is no
// Shortcuts in the path any more, so there is nothing left to protect: tiles are ordinary
// buttons, this module is async from top to bottom, and the start offset is rolled at TAP
// time rather than at render time (which is more honest than the old arrangement — it used
// to re-roll on every render because every transition forced a page load).

import { getAccessTokenSync } from './auth.js';
import { resolveFade } from './settings.js';
import * as spotify from './api.js';

/**
 * Steps in each ramp, each one a `PUT /me/player/volume`. ONE constant for both
 * directions, so "how fine is the fade" is a single number.
 *
 * 12 is what the shortcut's ramp used before iOS 27's rate limiter cut it to 4 coarse
 * steps (#12). A transition is therefore about 24 volume writes plus three more calls.
 */
export const FADE_STEPS = 12;

const defaultNow = () => Date.now();
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Outcomes `startTransition` reports. The grid turns these into a line of text. */
export const FADED = 'faded';
export const UNFADED = 'unfaded';
export const SUPERSEDED = 'superseded';
export const FAILED = 'failed';

function clampPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** Track count as the cache stores it (`trackTotal`), tolerating a raw API object. */
function trackTotal(playlist) {
  const n = Number(playlist?.trackTotal ?? playlist?.tracks?.total);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

/**
 * A random start position in `[0, total)`. A playlist with no known track count gets 0,
 * which is a valid position for any non-empty playlist — better than refusing to play
 * because the cache is thin.
 */
export function pickOffset(total, random = Math.random) {
  const n = Math.floor(Number(total));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n - 1, Math.max(0, Math.floor(random() * n)));
}

/**
 * What one tap means, decided at tap time: which context, from which track, shuffled or
 * not, and how long each ramp gets.
 *
 * `inorder` (#10) is one decision expressed as two fields, so they are computed together:
 * a random offset with shuffle off would play the rest of the playlist from a random
 * point, and `offset: 0` with shuffle on would not start on track 1 at all.
 *
 * `nofadein` (#6) is the other per-playlist flag, and it means something again. Under the
 * shortcut's 5-call budget (#12) there was no fade-in left to skip, so the flag had
 * degenerated into a no-op. Here `upMs: 0` is a real choice: restore the volume in ONE
 * call instead of ramping back up, so the new playlist lands at full volume.
 */
export function resolvePlaybackPlan(playlist, { fadeMs, random } = {}) {
  const { downMs, upMs } = resolveFade(playlist?.nofadein === true, fadeMs);
  const inorder = playlist?.inorder === true;
  return {
    contextUri: typeof playlist?.uri === 'string' && playlist.uri ? playlist.uri : null,
    position: inorder ? 0 : pickOffset(trackTotal(playlist), random),
    shuffle: !inorder,
    downMs,
    upMs,
  };
}

/**
 * What kind of tile this playlist gets. Two kinds, as before:
 *
 *  - `play` — the real thing: a button that runs a transition.
 *  - `fallback` — there is no usable session, or the cached playlist has no `uri`. A tile
 *    that cannot do anything should not look like one that can, so it opens the playlist
 *    on Spotify and the grid says why (grid.js) rather than looking normal and failing
 *    on tap.
 *
 * `getAccessTokenSync` is used here only to decide what a tile LOOKS like. It is no longer
 * load-bearing — nothing races a gesture deadline any more — and `api.js` reads the token
 * itself on every request.
 */
export function resolveTile(playlist, { token } = {}) {
  const id = playlist?.id;
  const uri = typeof playlist?.uri === 'string' && playlist.uri ? playlist.uri : null;
  const accessToken = token === undefined ? getAccessTokenSync() : token;

  if (!accessToken || !uri) {
    return {
      mode: 'fallback',
      reason: !accessToken ? 'no-token' : 'no-uri',
      href: id ? `https://open.spotify.com/playlist/${encodeURIComponent(id)}` : null,
    };
  }
  return { mode: 'play' };
}

/** The level each step writes, `steps` of them, the last one landing exactly on `to`. */
export function rampLevels(from, to, steps = FADE_STEPS) {
  const a = clampPercent(from);
  const b = clampPercent(to);
  const n = Math.max(1, Math.floor(Number(steps) || 0));
  const levels = [];
  for (let i = 1; i <= n; i++) levels.push(Math.round(a + (b - a) * (i / n)));
  return levels;
}

/**
 * Walk the volume from `from` to `to` over `durationMs`, PACED AGAINST THE WALL CLOCK.
 *
 * This is the part that cannot be written the obvious way. Sleeping `durationMs / steps`
 * between calls assumes a write is free; each `PUT` is a 100–300ms round trip, so at 12
 * steps over 3s the requests alone can cost more than the whole fade is allowed to take,
 * and a naive ramp would overrun its setting badly on a slow connection — worse the
 * slower the connection, which is the wrong way round.
 *
 * So each step has a DEADLINE (`i × durationMs / steps`) and the loop reads the clock
 * before every write:
 *
 *  - ahead of schedule → sleep until the deadline, minus the round trip the write is
 *    about to cost, so the write LANDS on the deadline rather than starting there;
 *  - behind schedule → skip straight to the step whose deadline is next, dropping the
 *    intermediate levels. A fade with some levels missing still sounds like a fade; one
 *    that runs 60% over its setting does not.
 *
 * The round trip is measured, not assumed: an exponential average of the writes so far,
 * seeded with whatever the caller already observed (the `GET /me/player` at the top of
 * the transition is a free sample).
 *
 * The final level is always written, however many steps were skipped — the ramp must end
 * where it said it would, whatever happened on the way.
 *
 * @returns {number[]} the levels actually sent, in order
 */
export async function rampVolume({
  from,
  to,
  steps = FADE_STEPS,
  durationMs,
  setVolume,
  now = defaultNow,
  sleep = defaultSleep,
  shouldStop = () => false,
  rttMs = 0,
}) {
  const levels = rampLevels(from, to, steps);
  const sent = [];

  // No time to ramp in: go straight there. One call, not a loop of them.
  if (!(Number(durationMs) > 0)) {
    const target = levels[levels.length - 1];
    await setVolume(target);
    return [target];
  }

  const stepMs = Number(durationMs) / levels.length;
  let rtt = Math.max(0, Number(rttMs) || 0);
  const t0 = now();
  let next = 1;

  while (next <= levels.length) {
    if (shouldStop()) return sent;

    const elapsed = now() - t0;
    // The furthest step whose deadline will have passed by the time this write lands.
    const due = Math.floor((elapsed + rtt) / stepMs);
    if (due > next) {
      next = Math.min(due, levels.length);
    } else {
      const wait = next * stepMs - elapsed - rtt;
      if (wait > 0) await sleep(wait);
    }
    if (shouldStop()) return sent;

    const level = levels[next - 1];
    // A ramp from a quiet starting volume repeats levels (3% over 12 steps rounds to the
    // same integer four times over). Re-sending one costs a request and changes nothing.
    // The ramp still always ENDS on its target: skipping the last write can only happen
    // when the volume is already sitting on it.
    if (level !== sent[sent.length - 1]) {
      const issued = now();
      await setVolume(level);
      const measured = Math.max(0, now() - issued);
      rtt = rtt === 0 ? measured : rtt * 0.6 + measured * 0.4;
      sent.push(level);
    }
    next += 1;
  }

  return sent;
}

// The transition in flight, if any. A rapid series of taps must not leave two ramps
// fighting over the volume, so a new transition SUPERSEDES the old one: it flips the old
// run's `cancelled` flag, and the old run returns at its next await instead of writing
// another level.
//
// It also INHERITS the old run's starting volume. That is the part that is easy to get
// wrong — a second tap landing mid-fade-out would otherwise read the current volume (on
// its way to zero) as the level to restore to, and every tap would quietly ratchet the
// music down. The original level is passed along until a transition finishes cleanly.
let inFlight = null;

/** Test seam: forget any in-flight run, so one test's volume cannot leak into the next. */
export function resetTransitions() {
  if (inFlight) inFlight.cancelled = true;
  inFlight = null;
}

async function switchPlaylist(api, plan) {
  // PLAY FIRST, THEN SHUFFLE. Not the intuitive order, and not negotiable: Spotify does
  // not guarantee the order two Player writes are applied in, and setting shuffle first
  // raced the play call and lost on device (#10) — "no shuffle" started on track 1 and
  // then shuffled everything after it. The shortcut had to do it this way too; the
  // finding is about Spotify, not about Shortcuts, so it survives the rewrite.
  await api.startPlayback({ contextUri: plan.contextUri, position: plan.position });
  await api.setShuffle(plan.shuffle);
}

/**
 * Run one transition. Resolves when the new playlist is playing and the volume is back
 * where it started.
 *
 * @param {object} playlist   a rotation-joined entry: uri, trackTotal, nofadein, inorder
 * @param {object} [options]
 * @param {number} [options.fadeMs]   overrides the stored fade setting
 * @param {() => number} [options.random]
 * @param {object} [options.api]      injected in tests: getPlayerState/setVolume/setShuffle/startPlayback
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise} [options.sleep]
 * @param {number} [options.steps]
 * @returns {Promise<{outcome: string, reason?: string, error?: Error, baseVolume?: number|null}>}
 */
export async function startTransition(playlist, {
  fadeMs,
  random,
  api = spotify,
  now = defaultNow,
  sleep = defaultSleep,
  steps = FADE_STEPS,
} = {}) {
  const plan = resolvePlaybackPlan(playlist, { fadeMs, random });
  if (!plan.contextUri) return { outcome: FAILED, reason: 'no-uri' };

  const previous = inFlight;
  if (previous) previous.cancelled = true;
  const run = {
    cancelled: false,
    // Inherited across a supersede; `null` means "not read yet".
    baseVolume: previous?.baseVolume ?? null,
    canFade: previous?.canFade ?? null,
    reason: previous?.reason ?? null,
    rttMs: previous?.rttMs ?? 0,
  };
  inFlight = run;

  const stop = () => run.cancelled;
  const finish = (result) => {
    if (inFlight === run) inFlight = null;
    return result;
  };

  try {
    // 1. Where are we starting from, and can this device even be faded?
    if (run.canFade === null) {
      const t = now();
      let state = null;
      let reachable = true;
      try {
        state = await api.getPlayerState();
      } catch {
        // A failed read is not a reason to refuse the switch — see below.
        reachable = false;
      }
      run.rttMs = Math.max(0, now() - t);
      const device = state?.device ?? null;
      const level = Number(device?.volume_percent);
      run.canFade = device?.supports_volume === true && Number.isFinite(level);
      run.baseVolume = run.canFade ? clampPercent(level) : null;
      run.reason = run.canFade ? null : (reachable && device ? 'no-volume-support' : 'no-player');
    }
    if (stop()) return { outcome: SUPERSEDED };

    // 2. A device that will not take remote volume still gets its playlist switched —
    //    immediately, at whatever volume it is already at. NEVER silently do nothing, and
    //    never refuse to switch: the music changing is the point, the fade is the polish.
    //    The grid says the current device cannot be faded (grid.js) so this reads as a
    //    known limitation rather than a bug.
    //    A fade length of 0 lands here too, which is what the setting's zero end means.
    if (!run.canFade || !(plan.downMs > 0)) {
      await switchPlaylist(api, plan);
      return finish({
        outcome: UNFADED,
        reason: run.canFade ? 'fade-off' : run.reason,
      });
    }

    // 3. Down to silence.
    await rampVolume({
      from: run.baseVolume, to: 0, steps, durationMs: plan.downMs,
      setVolume: api.setVolume, now, sleep, shouldStop: stop, rttMs: run.rttMs,
    });
    if (stop()) return { outcome: SUPERSEDED };

    // 4. The actual point of all this.
    await switchPlaylist(api, plan);
    if (stop()) return { outcome: SUPERSEDED };

    // 5. Back up — or, for a `nofadein` playlist, straight back in one call (#6).
    if (plan.upMs > 0) {
      await rampVolume({
        from: 0, to: run.baseVolume, steps, durationMs: plan.upMs,
        setVolume: api.setVolume, now, sleep, shouldStop: stop, rttMs: run.rttMs,
      });
    } else {
      await api.setVolume(run.baseVolume);
    }

    return finish({ outcome: FADED, baseVolume: run.baseVolume });
  } catch (error) {
    // A request failed somewhere in the middle. The one thing that must not happen is
    // leaving the volume stuck at zero: getting the user's volume back matters more than
    // completing the transition, so the restore is attempted even though something is
    // clearly wrong, and its own failure is swallowed.
    //
    // Not when superseded, though — the run that took over owns the volume now, and
    // restoring here would fight the ramp it has already started.
    if (!run.cancelled && run.baseVolume !== null) {
      try {
        await api.setVolume(run.baseVolume);
      } catch { /* nothing left to try */ }
    }
    if (run.cancelled) return { outcome: SUPERSEDED, error };
    return finish({ outcome: FAILED, error, baseVolume: run.baseVolume });
  }
}
