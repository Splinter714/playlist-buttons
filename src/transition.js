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
import { resolveFade, formatFade } from './settings.js';
import { read, write } from './storage.js';
import * as spotify from './api.js';

/**
 * Steps in each ramp, each one a `PUT /me/player/volume`. ONE constant for both
 * directions, so "how fine is the fade" is a single number.
 *
 * 12 is what the shortcut's ramp used before iOS 27's rate limiter cut it to 4 coarse
 * steps (#12). A transition is therefore about 24 volume writes plus three more calls.
 */
export const FADE_STEPS = 12;

/**
 * The shape of the ramp, and the one number to turn if a fade sounds wrong to the ear.
 *
 * The ramp used to step LINEARLY through `volume_percent`, and a linear fade does not
 * SOUND like an even fade. The ear responds roughly logarithmically, so equal amplitude
 * steps are not equal perceived steps: the top of a linear fade is nearly inaudible and
 * the last couple of steps fall off a cliff. Stevens' power law puts perceived loudness
 * near amplitude^0.6, so the ramp steps linearly through `level^EXPONENT` and inverts it,
 * which spends the same twelve writes where they are actually HEARD. That is the real fix
 * for the choppiness at 3s: not more writes, better placed ones.
 *
 * Tunable on purpose, which is why it is a constant and not inlined. 0.6 is the textbook
 * figure (loudness goes as intensity^0.3, and intensity goes as amplitude squared), but
 * two things about it cannot be settled from here:
 *
 *  - whether Spotify's `volume_percent` is itself linear in amplitude is UNDOCUMENTED. It
 *    may already be shaped, in which case this exponent is correcting a curve rather than
 *    creating one. The exponent being tunable is the hedge: it absorbs whatever Spotify
 *    is doing without this file having to claim to know.
 *  - the right value is finally a question of how it sounds in a room.
 *
 * Smaller curves harder (more of the fade spent quiet); 1 is exactly the old linear ramp.
 * Change this by ear.
 */
export const LOUDNESS_EXPONENT = 0.6;

/**
 * How many volume writes may be in flight at once.
 *
 * The ramp used to await every `PUT` before sending the next, which put a hard floor
 * under the step rate of one round trip. At 3s over 12 steps the pacer wants a write every
 * 250ms while a round trip costs 150-300ms, so it could not keep up and dropped levels to
 * stay on schedule — 10 writes instead of 12, measured. Fewer, bigger jumps is what
 * Jackson heard as choppy. Note the rate was bounded by LATENCY, not by `FADE_STEPS`:
 * raising that constant alone would have changed nothing, the extra levels would have been
 * skipped too.
 *
 * Deliberately SMALL. These are absolute writes (`volume_percent=N`), not deltas, so two
 * arriving out of order steps the volume audibly backwards. At 2 the worst case is one
 * level of twelve, briefly; at 4 it would be a lurch. Two in flight already covers a round
 * trip of up to 500ms at the 3s setting, which is well past the measured range, and the
 * pacer only ever uses as many slots as the latency forces — this is a ceiling, not a
 * target. The FINAL level of every ramp is written on its own, after everything else has
 * come back, so however the middle of a ramp is delivered it still ends where it promised.
 */
export const FADE_CONCURRENCY = 2;

/**
 * Below this many writes a fade stops sounding like a slide and starts sounding like a
 * staircase. Used only to decide whether the settings screen mentions it
 * (`fadeLatencyNote`) — the fade is NEVER silently stretched to make it true, because the
 * slider is supposed to mean what it says.
 *
 * 8 of the 12: on the equal-loudness curve each step is then about an eighth of the whole
 * perceived drop, which is roughly where a step becomes something you notice rather than
 * something you hear through. A threshold by ear, like the exponent above.
 */
export const MIN_SMOOTH_STEPS = 8;

/**
 * Where the last measured round trip for a volume write is kept (`pb.latency.v1`).
 *
 * The ramp measures latency as it goes anyway; persisting it lets the settings screen say
 * whether the chosen fade has room for enough steps WITHOUT making a request of its own.
 * A measurement rather than a setting, which is why it has its own key instead of living
 * in the settings record — nothing here is user intent, and losing it is harmless.
 */
export const LATENCY_KEY = 'latency.v1';

/** @returns {number|null} ms, or null when no transition has measured one yet. */
export function readLatencyMs() {
  const n = Number(read(LATENCY_KEY, null));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Store a measured round trip. Junk and zero are ignored rather than stored. */
export function writeLatencyMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const rounded = Math.round(n);
  write(LATENCY_KEY, rounded);
  return rounded;
}

/**
 * How many of the `steps` a fade of `fadeMs` can actually land at a round trip of
 * `latencyMs`. With `FADE_CONCURRENCY` writes in flight the best sustainable rate is one
 * write per `latencyMs / FADE_CONCURRENCY`, so the fade has room for
 * `fadeMs x FADE_CONCURRENCY / latencyMs` of them — capped by the step count itself,
 * since the ramp never sends more levels than it has.
 */
export function stepsWithin(fadeMs, latencyMs, steps = FADE_STEPS) {
  const d = Number(fadeMs);
  const n = Math.max(1, Math.floor(Number(steps) || 0));
  const l = Number(latencyMs);
  if (!Number.isFinite(d) || d <= 0) return 0;
  if (!Number.isFinite(l) || l <= 0) return n;
  return Math.max(0, Math.min(n, Math.floor((d * FADE_CONCURRENCY) / l)));
}

/**
 * One quiet line for the settings screen when the measured round trip cannot fill the
 * chosen fade with enough steps to sound smooth — or `null`, which is the normal case.
 *
 * Factual, not an error, and not a correction: the fade still does exactly what the slider
 * says. This exists because the alternative is mysterious — a 1s fade on a 300ms
 * connection is six steps whatever anyone wants, and being told that beats wondering why
 * short fades sound rough.
 */
export function fadeLatencyNote(fadeMs, latencyMs = readLatencyMs()) {
  const l = Number(latencyMs);
  if (!Number.isFinite(l) || l <= 0) return null;   // nothing measured yet
  if (!(Number(fadeMs) > 0)) return null;           // fade off — nothing to be rough
  const steps = stepsWithin(fadeMs, l);
  if (steps >= MIN_SMOOTH_STEPS) return null;
  return `Spotify is answering in about ${Math.round(l)}ms, so a ${formatFade(fadeMs)} fade `
    + `has room for about ${steps} volume step${steps === 1 ? '' : 's'} — it may sound `
    + 'stepped rather than smooth. A longer fade has more room.';
}

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

/**
 * The level a fraction `t` of the way from `from` to `to`, on the equal-loudness curve
 * (`LOUDNESS_EXPONENT`). Perceived loudness falls roughly linearly across the ramp instead
 * of amplitude doing so.
 *
 * Anchored EXACTLY at both ends: `t = 0` is the starting volume to the integer and `t = 1`
 * is the target to the integer. No off-by-one that leaves the music faintly audible at the
 * bottom of a fade-out, or a percent short at the top of a fade-in.
 */
export function loudnessLevel(from, to, t) {
  const a = clampPercent(from);
  const b = clampPercent(to);
  const x = Math.min(1, Math.max(0, Number(t) || 0));
  if (x <= 0) return a;
  if (x >= 1) return b;
  const e = LOUDNESS_EXPONENT;
  const la = Math.pow(a, e);
  const lb = Math.pow(b, e);
  return clampPercent(Math.pow(la + (lb - la) * x, 1 / e));
}

/**
 * The whole ramp: `{level, at}` per write, where `at` is the fraction of the duration the
 * write should land on. Levels, and WHEN each one is due — the two cannot be separated,
 * because the curve is not evenly spaced in time once duplicates are dropped.
 *
 * Two things happen here besides the curve itself:
 *
 *  - DUPLICATES ARE DROPPED. `volume_percent` is an integer, so a ramp from a quiet
 *    starting volume (3% over twelve steps) rounds to the same number several times over,
 *    and the curve's slow end does the same. A write that changes nothing is a wasted
 *    round trip — in a ramp whose step rate is bounded by round trips, the most expensive
 *    kind of waste there is. The starting volume counts as already written, so the ramp
 *    never opens by re-sending the level it is already sitting on.
 *  - THE TARGET LANDS AT THE END. If the final level is first reached early (0 from a
 *    quiet start, say), its write is moved to `at: 1` rather than firing early and
 *    leaving the fade silent for its last fifth.
 */
export function rampPlan(from, to, steps = FADE_STEPS) {
  const n = Math.max(1, Math.floor(Number(steps) || 0));
  const target = clampPercent(to);
  const plan = [];
  let last = clampPercent(from);
  for (let i = 1; i <= n; i++) {
    const at = i / n;
    const level = i === n ? target : loudnessLevel(from, to, at);
    if (level === last) continue;
    plan.push({ level, at });
    last = level;
  }
  if (plan.length && plan[plan.length - 1].level === target) plan[plan.length - 1].at = 1;
  return plan;
}

/** Just the levels, in order, the last one exactly `to`. The curve without the clock. */
export function rampLevels(from, to, steps = FADE_STEPS) {
  return rampPlan(from, to, steps).map((step) => step.level);
}

/**
 * Walk the volume from `from` to `to` over `durationMs`, PACED AGAINST THE WALL CLOCK,
 * with up to `concurrency` writes in flight.
 *
 * This is the part that cannot be written the obvious way. Sleeping `durationMs / steps`
 * between calls assumes a write is free; each `PUT` is a 100-300ms round trip, so at 12
 * steps over 3s the requests alone can cost more than the whole fade is allowed to take,
 * and a naive ramp would overrun its setting badly on a slow connection — worse the
 * slower the connection, which is the wrong way round.
 *
 * So each write has a DEADLINE (its `at` times `durationMs`) and the loop reads the clock
 * before every one:
 *
 *  - ahead of schedule -> sleep until the deadline, minus the round trip the write is
 *    about to cost, so the write LANDS on the deadline rather than starting there;
 *  - behind schedule -> skip straight to the level whose deadline is next, dropping the
 *    ones in between. A fade with some levels missing still sounds like a fade; one that
 *    runs 60% over its setting does not.
 *
 * The round trip is measured, not assumed: an exponential average of the writes so far,
 * seeded with whatever the caller already observed (the `GET /me/player` at the top of
 * the transition is a free sample).
 *
 * WHY WRITES OVERLAP. Awaiting each response before sending the next put a floor under the
 * step rate of one round trip, which is why 3s/12 steps managed only 10 writes at 300ms
 * latency and sounded choppy (#13 playtest). Letting `concurrency` writes be in flight
 * decouples the step rate from latency — the loop keeps to the schedule and the responses
 * catch up behind it. See `FADE_CONCURRENCY` for why that number is small.
 *
 * The final level is always written, however many steps were skipped, and it is written
 * ALONE: everything still in flight is awaited first, so no earlier absolute write can
 * land after it. The ramp must end where it said it would, whatever happened on the way.
 *
 * @returns {Promise<{sent: number[], rttMs: number}>} the levels issued, in order, and the
 *   round trip this ramp ended up measuring (the caller persists it — see `LATENCY_KEY`)
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
  concurrency = FADE_CONCURRENCY,
}) {
  const target = clampPercent(to);
  const plan = rampPlan(from, to, steps);
  const sent = [];
  let rtt = Math.max(0, Number(rttMs) || 0);

  // No time to ramp in: go straight there. One call, not a loop of them.
  if (!(Number(durationMs) > 0)) {
    await setVolume(target);
    return { sent: [target], rttMs: rtt };
  }
  // Already there — a device sitting at 0 being faded to 0. Nothing to send at all.
  if (!plan.length) return { sent, rttMs: rtt };

  const duration = Number(durationMs);
  const slots = Math.max(1, Math.floor(Number(concurrency) || 1));
  const t0 = now();
  const flight = [];
  let failure = null;

  // Send NOW, and keep the promise. The loop goes on to pace the next step rather than
  // waiting for this one to come back.
  const issue = (level) => {
    const issued = now();
    sent.push(level);
    flight.push((async () => {
      try {
        await setVolume(level);
        const measured = Math.max(0, now() - issued);
        rtt = rtt === 0 ? measured : rtt * 0.6 + measured * 0.4;
      } catch (error) {
        // Recorded rather than thrown from here: the loop is not awaiting this promise,
        // so it checks `failure` at each of its own await points instead. `settle`/`drain`
        // observe every promise, so nothing becomes an unhandled rejection.
        failure ??= error;
        throw error;
      }
    })());
  };

  // Wait until at most `keep` writes are still in flight. `allSettled`, not `all`: a write
  // that failed while the loop had already moved past it must still be observed.
  const drain = () => Promise.allSettled(flight.splice(0));
  const settle = async (keep) => {
    const taken = flight.splice(0, Math.max(0, flight.length - keep));
    if (taken.length) await Promise.allSettled(taken);
    else await Promise.resolve();
  };

  let i = 0;
  while (i < plan.length) {
    if (shouldStop()) { await drain(); return { sent, rttMs: rtt }; }

    // Where the clock will be by the time a write issued now comes back.
    const landing = now() - t0 + rtt;
    while (i + 1 < plan.length && plan[i + 1].at * duration <= landing) i += 1;

    const isLast = i === plan.length - 1;
    await settle(isLast ? 0 : slots - 1);
    if (failure) { await drain(); throw failure; }
    if (shouldStop()) { await drain(); return { sent, rttMs: rtt }; }

    const wait = plan[i].at * duration - (now() - t0) - rtt;
    if (wait > 0) await sleep(wait);
    if (failure) { await drain(); throw failure; }
    if (shouldStop()) { await drain(); return { sent, rttMs: rtt }; }

    issue(plan[i].level);
    i += 1;
  }

  await settle(0);
  if (failure) { await drain(); throw failure; }
  return { sent, rttMs: rtt };
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
    const down = await rampVolume({
      from: run.baseVolume, to: 0, steps, durationMs: plan.downMs,
      setVolume: api.setVolume, now, sleep, shouldStop: stop, rttMs: run.rttMs,
    });
    if (down.rttMs > 0) run.rttMs = down.rttMs;
    if (stop()) return { outcome: SUPERSEDED };

    // 4. The actual point of all this.
    await switchPlaylist(api, plan);
    if (stop()) return { outcome: SUPERSEDED };

    // 5. Back up — or, for a `nofadein` playlist, straight back in one call (#6).
    if (plan.upMs > 0) {
      const up = await rampVolume({
        from: 0, to: run.baseVolume, steps, durationMs: plan.upMs,
        setVolume: api.setVolume, now, sleep, shouldStop: stop, rttMs: run.rttMs,
      });
      if (up.rttMs > 0) run.rttMs = up.rttMs;
    } else {
      await api.setVolume(run.baseVolume);
    }

    // What the connection cost, kept for the settings screen (`fadeLatencyNote`) so it can
    // say whether the chosen fade has room for enough steps without asking Spotify itself.
    // Written here rather than inside the ramp: one transition, one measurement.
    writeLatencyMs(run.rttMs);

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
