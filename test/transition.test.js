// The transition (#13): the fade, the switch, and the fade back.
//
// This file replaces test/handoff.test.js. That suite asserted the shape of a
// `shortcuts://` URL — the scheme, the `name`/`input`/`text` params, the percent-encoded
// JSON payload, the absence of `x-success`/`x-error`, the `?err=1` return leg. None of
// that exists any more, so those assertions are gone rather than rewritten. What they
// asserted ABOUT THE DECISIONS carried by that URL — the random offset, the inorder pair,
// the fade values, the no-token/no-uri fallback — is all still here, moved onto
// `resolvePlaybackPlan` and `resolveTile`.
//
// The new ground this covers is the part that could not exist inside a shortcut: ramp
// levels, pacing against a slow network, superseding taps, and getting the volume back
// when a request fails mid-ramp.

import { describe, it, expect, beforeEach } from 'vitest';

// Same real-enough localStorage as the other suites: the fade setting and the token both
// come out of storage.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const {
  resolvePlaybackPlan, resolveTile, pickOffset, rampLevels, rampPlan, rampVolume,
  loudnessLevel, stepsWithin, fadeLatencyNote, readLatencyMs, writeLatencyMs,
  startTransition, resetTransitions, FADE_STEPS, FADE_CONCURRENCY, LOUDNESS_EXPONENT,
  MIN_SMOOTH_STEPS, FADED, UNFADED, SUPERSEDED, FAILED,
} = await import('../src/transition.js');
const { SETTINGS_KEY } = await import('../src/settings.js');

const TOKEN = 'BQC-fake+token/with=padding';

const tavern = {
  id: '4kQrPlaylistId',
  uri: 'spotify:playlist:4kQrPlaylistId',
  name: 'Tavern',
  trackTotal: 120,
  nofadein: false,
};

beforeEach(() => {
  store.clear();
  resetTransitions();
});

/**
 * A clock the ramp can be run against. `sleep` moves time forward instead of waiting, so
 * a 3s fade is exercised in microtasks — and `now()` is then the honest answer to "how
 * long did that take", which is the thing worth asserting about the pacing.
 */
function makeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => { t += Math.max(0, Number(ms) || 0); },
    advance: (ms) => { t += ms; },
  };
}

/** A recorder for volume writes that costs `rtt` of clock time per call. */
function volumeRecorder(clock, rtt = 0) {
  const sent = [];
  const at = [];
  return {
    sent,
    at,
    setVolume: async (v) => {
      sent.push(v);
      at.push(clock.now());
      clock.advance(rtt);
    },
  };
}

/** Let any number of chained microtasks run. The fake clock never yields to a timer. */
const flush = async (n = 200) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/**
 * A fake NETWORK, which `makeClock` above cannot be: its `setVolume` charges the round
 * trip where the write is ISSUED, which is the same thing as being serial and so can
 * never show what overlapping writes buy. Here a write costs nothing to send and LANDS
 * `rtt` later, and time only moves when the driver below releases the next scheduled
 * event — a plain discrete-event simulation.
 *
 * It records both halves, because they are different questions: `issued` is what the
 * pacer decided to do, `landed` is what the speaker actually did.
 */
function makeNet({ rtt = 300, slow = null } = {}) {
  const net = {
    t: 0,
    timers: [],
    issued: [],
    landed: [],
    inFlight: 0,
    maxInFlight: 0,
    now: () => net.t,
    at: (when) => new Promise((resolve) => { net.timers.push({ when, resolve }); }),
    sleep: (ms) => net.at(net.t + Math.max(0, Number(ms) || 0)),
    setVolume: (v) => {
      // `slow` is one write index that comes back late, to prove ordering is handled.
      const cost = slow && slow.index === net.issued.length ? slow.rtt : rtt;
      net.issued.push({ level: v, at: net.t });
      net.inFlight += 1;
      net.maxInFlight = Math.max(net.maxInFlight, net.inFlight);
      return net.at(net.t + cost).then(() => {
        net.inFlight -= 1;
        net.landed.push({ level: v, at: net.t });
      });
    },
  };
  return net;
}

/** Run a ramp against `net`, releasing scheduled events in time order until it settles. */
async function runNet(net, promise) {
  let done = false;
  const settled = promise.then(
    (v) => { done = true; return v; },
    (e) => { done = true; throw e; },
  );
  settled.catch(() => {});
  for (let guard = 0; guard < 2000 && !done; guard++) {
    await flush(30);
    if (done || !net.timers.length) break;
    net.timers.sort((a, b) => a.when - b.when);
    const next = net.timers.shift();
    net.t = Math.max(net.t, next.when);
    next.resolve();
  }
  await flush(60);
  return settled;
}

/** Spacing of a sequence in PERCEIVED loudness, which is what "even" has to mean here. */
const perceivedGaps = (levels) => {
  const loud = levels.map((v) => Math.pow(v, LOUDNESS_EXPONENT));
  const gaps = [];
  for (let i = 1; i < loud.length; i++) gaps.push(Math.abs(loud[i - 1] - loud[i]));
  return gaps;
};
const evenness = (gaps) => Math.max(...gaps) / Math.min(...gaps);

/** A player that accepts remote volume, which is the whole premise of #13. */
function fakeApi({ volume = 70, supportsVolume = true, playerState, rtt = 0, clock } = {}) {
  const calls = [];
  const advance = () => { if (clock && rtt) clock.advance(rtt); };
  return {
    calls,
    getPlayerState: async () => {
      calls.push(['getPlayerState']);
      advance();
      if (playerState !== undefined) return playerState;
      return { device: { supports_volume: supportsVolume, volume_percent: volume } };
    },
    setVolume: async (v) => { calls.push(['setVolume', v]); advance(); },
    setShuffle: async (s) => { calls.push(['setShuffle', s]); advance(); },
    startPlayback: async (args) => { calls.push(['startPlayback', args]); advance(); },
  };
}

const volumesIn = (calls) => calls.filter((c) => c[0] === 'setVolume').map((c) => c[1]);
const namesIn = (calls) => calls.map((c) => c[0]);

describe('what one tap decides (was the handoff payload)', () => {
  it('shuffles from a random offset by default', () => {
    const plan = resolvePlaybackPlan(tavern, { random: () => 0.5 });
    expect(plan.contextUri).toBe('spotify:playlist:4kQrPlaylistId');
    expect(plan.shuffle).toBe(true);
    expect(plan.position).toBe(60);
  });

  it('uses the stored fade for both directions', () => {
    store.set(`pb.${SETTINGS_KEY}`, JSON.stringify({ fadeMs: 4500 }));
    expect(resolvePlaybackPlan(tavern)).toMatchObject({ downMs: 4500, upMs: 4500 });
  });

  it('falls back to the 3s default when nothing is stored', () => {
    expect(resolvePlaybackPlan(tavern)).toMatchObject({ downMs: 3000, upMs: 3000 });
  });

  it('sends upMs: 0 for a playlist marked nofadein — still fading OUT (#6)', () => {
    store.set(`pb.${SETTINGS_KEY}`, JSON.stringify({ fadeMs: 2000 }));
    expect(resolvePlaybackPlan({ ...tavern, nofadein: true }))
      .toMatchObject({ downMs: 2000, upMs: 0 });
  });

  it('starts an in-order playlist at track 1 with shuffle off (#10)', () => {
    const plan = resolvePlaybackPlan({ ...tavern, inorder: true }, { random: () => 0.9 });
    expect(plan).toMatchObject({ position: 0, shuffle: false });
  });

  it('treats a missing or junk inorder as the default, so an old entry shuffles', () => {
    for (const inorder of [undefined, null, false, 'yes', 0, 1]) {
      const plan = resolvePlaybackPlan({ ...tavern, inorder }, { random: () => 0.5 });
      expect(plan).toMatchObject({ shuffle: true, position: 60 });
    }
  });

  it('keeps the two flags independent — in order can still fade in, and vice versa', () => {
    expect(resolvePlaybackPlan({ ...tavern, inorder: true, nofadein: true }))
      .toMatchObject({ position: 0, shuffle: false, upMs: 0 });
    expect(resolvePlaybackPlan({ ...tavern, inorder: true, nofadein: false }))
      .toMatchObject({ position: 0, shuffle: false, upMs: 3000 });
    expect(resolvePlaybackPlan({ ...tavern, inorder: false, nofadein: true }))
      .toMatchObject({ shuffle: true, upMs: 0 });
  });

  it('re-rolls the offset on every call — a TAP is what re-randomises now, not a render', () => {
    const rolls = [0.1, 0.8];
    let i = 0;
    const random = () => rolls[i++];
    expect(resolvePlaybackPlan(tavern, { random }).position).toBe(12);
    expect(resolvePlaybackPlan(tavern, { random }).position).toBe(96);
  });
});

describe('the random start offset', () => {
  it('stays inside [0, tracks.total) for every roll', () => {
    for (const r of [0, 0.001, 0.5, 0.999, 0.9999999]) {
      const { position } = resolvePlaybackPlan(tavern, { random: () => r });
      expect(position).toBeGreaterThanOrEqual(0);
      expect(position).toBeLessThan(tavern.trackTotal);
      expect(Number.isInteger(position)).toBe(true);
    }
  });

  it('never runs off the end, even if the random source returns exactly 1', () => {
    expect(pickOffset(120, () => 1)).toBe(119);
  });

  it('is 0 for a playlist with no known track count, rather than refusing to play', () => {
    expect(pickOffset(0)).toBe(0);
    expect(resolvePlaybackPlan({ ...tavern, trackTotal: undefined }).position).toBe(0);
  });

  it('reads a raw API shape too, not just the cache field', () => {
    const plan = resolvePlaybackPlan(
      { ...tavern, trackTotal: undefined, tracks: { total: 10 } },
      { random: () => 0.5 },
    );
    expect(plan.position).toBe(5);
  });
});

describe('what kind of tile a playlist gets', () => {
  it('is a playable tile with a session and a URI', () => {
    expect(resolveTile(tavern, { token: TOKEN })).toEqual({ mode: 'play' });
  });

  it('falls back to opening Spotify with no usable token', () => {
    expect(resolveTile(tavern, { token: null })).toEqual({
      mode: 'fallback',
      reason: 'no-token',
      href: 'https://open.spotify.com/playlist/4kQrPlaylistId',
    });
  });

  it('falls back the same way when the cached playlist has no URI', () => {
    expect(resolveTile({ ...tavern, uri: undefined }, { token: TOKEN }))
      .toMatchObject({ mode: 'fallback', reason: 'no-uri' });
  });

  it('has no href at all for a playlist with no id either', () => {
    expect(resolveTile({}, { token: null }).href).toBe(null);
  });

  it('reads the token straight out of storage when none is passed in', () => {
    store.set('pb.auth', JSON.stringify({ access_token: 'stored', expires_at: Date.now() + 1e6 }));
    expect(resolveTile(tavern).mode).toBe('play');
  });

  it('falls back when storage holds no session', () => {
    expect(resolveTile(tavern).mode).toBe('fallback');
  });
});

describe('ramp levels, on the equal-loudness curve', () => {
  // These were [92, 83, 75, ... 8, 0] when the ramp stepped linearly through
  // volume_percent. That is what sounded choppy at 3s (#13 playtest): a linear fade is
  // nearly inaudible at the top and falls off a cliff at the bottom, so the writes are
  // spent where they are not heard. The curve below is the same twelve writes, placed so
  // that each one is the same size TO THE EAR.
  it('walks down the curve and lands exactly on zero', () => {
    expect(rampLevels(100, 0, FADE_STEPS))
      .toEqual([87, 74, 62, 51, 41, 31, 23, 16, 10, 5, 2, 0]);
  });

  it('walks back up to the captured volume, not to 100', () => {
    const up = rampLevels(0, 70, FADE_STEPS);
    expect(up).toHaveLength(12);
    expect(up[0]).toBe(1);
    expect(up.at(-1)).toBe(70);
  });

  it('scales through the starting volume rather than through absolute fractions', () => {
    // From 60% the first step of a fade OUT must go down, not up to 87%.
    expect(rampLevels(60, 0, FADE_STEPS)[0]).toBe(52);
  });

  it('has one named step count for both directions', () => {
    expect(FADE_STEPS).toBe(12);
    expect(rampLevels(100, 0)).toHaveLength(FADE_STEPS);
    expect(rampLevels(0, 100)).toHaveLength(FADE_STEPS);
  });

  it('is anchored exactly at both ends, in both directions', () => {
    // No off-by-one: a fade-out that stopped at 1% would leave the music faintly audible
    // under the new playlist, and a fade-in that stopped at 69% would quietly turn the
    // user's volume down a notch on every tap.
    expect(loudnessLevel(70, 0, 0)).toBe(70);
    expect(loudnessLevel(70, 0, 1)).toBe(0);
    expect(loudnessLevel(0, 70, 0)).toBe(0);
    expect(loudnessLevel(0, 70, 1)).toBe(70);
    expect(rampLevels(70, 0).at(-1)).toBe(0);
    expect(rampLevels(0, 70).at(-1)).toBe(70);
  });

  it('never repeats a level, from any starting volume, in either direction', () => {
    // volume_percent is an integer, so the quiet end of the curve rounds to the same
    // number repeatedly. A write that changes nothing is a wasted round trip — and the
    // round trip is the thing the step rate is bounded by.
    for (let v = 1; v <= 100; v++) {
      for (const levels of [rampLevels(v, 0), rampLevels(0, v)]) {
        for (let i = 1; i < levels.length; i++) {
          expect(levels[i]).not.toBe(levels[i - 1]);
        }
      }
      expect(rampLevels(v, 0).at(-1)).toBe(0);
      expect(rampLevels(0, v).at(-1)).toBe(v);
    }
  });

  it('spaces the steps more evenly in PERCEIVED loudness than a linear ramp does', () => {
    const linear = [100];
    for (let i = 1; i <= FADE_STEPS; i++) linear.push(Math.round(100 - (100 * i) / FADE_STEPS));
    const curved = [100, ...rampLevels(100, 0, FADE_STEPS)];

    // The property, not the numbers: on the curve every step is about the same size to
    // the ear, so the biggest and smallest are close together. On a linear ramp the last
    // step is several times the first.
    expect(evenness(perceivedGaps(curved))).toBeLessThan(2);
    expect(evenness(perceivedGaps(linear))).toBeGreaterThan(4);
    expect(evenness(perceivedGaps(curved)))
      .toBeLessThan(evenness(perceivedGaps(linear)) / 2);
  });

  it('spends more of the fade quiet than a linear ramp, by a tunable exponent', () => {
    expect(LOUDNESS_EXPONENT).toBeGreaterThan(0);
    expect(LOUDNESS_EXPONENT).toBeLessThan(1);
    // Halfway through a 100 -> 0 fade the curve is well below the linear halfway point.
    expect(loudnessLevel(100, 0, 0.5)).toBeLessThan(50);
  });

  it('moves the final write to the end when the curve reaches it early', () => {
    // From 3% most of the curve rounds to the same few integers, so 0 is first reached
    // two thirds of the way in. Firing it there would leave the last third silent.
    const plan = rampPlan(3, 0, FADE_STEPS);
    expect(plan.map((step) => step.level)).toEqual([2, 1, 0]);
    expect(plan.at(-1).at).toBe(1);
  });
});

describe('pacing the ramp against the wall clock', () => {
  it('takes exactly its duration when the writes are instant', async () => {
    const clock = makeClock();
    const vol = volumeRecorder(clock, 0);
    await rampVolume({
      from: 100, to: 0, durationMs: 3000, setVolume: vol.setVolume,
      now: clock.now, sleep: clock.sleep,
    });
    expect(vol.sent).toHaveLength(12);
    expect(vol.sent.at(-1)).toBe(0);
    expect(clock.now()).toBe(3000);
    // Evenly spaced, 250ms apart.
    expect(vol.at).toEqual([250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750, 3000]);
  });

  it('still hits its duration when every write costs 300ms, by skipping steps', async () => {
    const clock = makeClock();
    const vol = volumeRecorder(clock, 300);
    await rampVolume({
      from: 100, to: 0, durationMs: 3000, setVolume: vol.setVolume,
      now: clock.now, sleep: clock.sleep,
    });
    // Sleeping duration/steps between calls would have taken 12×250 + 12×300 = 6600ms,
    // more than twice the fade it was asked for. This stays within a round trip of 3000.
    expect(clock.now()).toBeLessThanOrEqual(3300);
    expect(clock.now()).toBeGreaterThan(2700);
    // It got there by dropping levels, not by rushing them…
    expect(vol.sent.length).toBeLessThan(12);
    expect(vol.sent.length).toBeGreaterThan(5);
    // …and it still ended where it promised.
    expect(vol.sent.at(-1)).toBe(0);
    // Monotonic: a skipped step never means a level going back up mid-fade.
    for (let i = 1; i < vol.sent.length; i++) {
      expect(vol.sent[i]).toBeLessThan(vol.sent[i - 1]);
    }
  });

  it('degrades to very few steps rather than overrunning on a terrible connection', async () => {
    const clock = makeClock();
    const vol = volumeRecorder(clock, 1200);
    await rampVolume({
      from: 100, to: 0, durationMs: 3000, setVolume: vol.setVolume,
      now: clock.now, sleep: clock.sleep,
    });
    expect(vol.sent.length).toBeLessThanOrEqual(4);
    expect(vol.sent.at(-1)).toBe(0);
    // Three or four round trips is the floor; the point is that it is not twelve.
    expect(clock.now()).toBeLessThanOrEqual(3000 + 1200 * 2);
  });

  it('goes straight to the target when there is no time to ramp in', async () => {
    const clock = makeClock();
    const vol = volumeRecorder(clock, 0);
    await rampVolume({
      from: 100, to: 0, durationMs: 0, setVolume: vol.setVolume,
      now: clock.now, sleep: clock.sleep,
    });
    expect(vol.sent).toEqual([0]);
  });

  it('does not re-send a level a quiet starting volume repeats', async () => {
    const clock = makeClock();
    const vol = volumeRecorder(clock, 0);
    await rampVolume({
      from: 3, to: 0, durationMs: 1200, setVolume: vol.setVolume,
      now: clock.now, sleep: clock.sleep,
    });
    // 3% over 12 steps rounds to the same integer repeatedly; only the changes are sent.
    expect(new Set(vol.sent).size).toBe(vol.sent.length);
    expect(vol.sent.at(-1)).toBe(0);
  });

  it('stops writing as soon as it is told to stop', async () => {
    const clock = makeClock();
    const vol = volumeRecorder(clock, 0);
    let stop = false;
    const promise = rampVolume({
      from: 100, to: 0, durationMs: 3000, setVolume: async (v) => {
        await vol.setVolume(v);
        if (vol.sent.length === 3) stop = true;
      },
      now: clock.now, sleep: clock.sleep, shouldStop: () => stop,
    });
    await promise;
    expect(vol.sent).toHaveLength(3);
  });
});

describe('overlapping writes, so the step rate is not one per round trip', () => {
  // The choppiness Jackson heard at 3s was this: a strictly serial ramp cannot put two
  // writes closer together than one round trip, so at 250ms deadlines and 300ms round
  // trips it dropped levels to stay on schedule. These run the SAME ramp against the same
  // simulated network with one write in flight and with FADE_CONCURRENCY, which is the
  // only honest way to state the improvement.
  const ramp = (net, concurrency) => rampVolume({
    from: 70, to: 0, durationMs: 3000, concurrency,
    setVolume: net.setVolume, now: net.now, sleep: net.sleep,
  });

  it('lands all twelve levels at 300ms round trips, where serial managed ten', async () => {
    const serial = makeNet({ rtt: 300 });
    await runNet(serial, ramp(serial, 1));
    const overlapped = makeNet({ rtt: 300 });
    await runNet(overlapped, ramp(overlapped, FADE_CONCURRENCY));

    // Serial cannot land more than one write per round trip, so a 3s fade is ten.
    const serialInsideFade = serial.landed.filter((w) => w.at <= 3000);
    expect(serialInsideFade.length).toBeLessThanOrEqual(10);
    expect(serial.t).toBeGreaterThan(3300); // and it runs past the fade to finish

    expect(overlapped.landed).toHaveLength(FADE_STEPS);
    expect(overlapped.landed.length).toBeGreaterThan(serialInsideFade.length);
    // Bought by overlapping, not by overrunning.
    expect(overlapped.t).toBeLessThanOrEqual(3000 + 300);
    expect(overlapped.maxInFlight).toBeLessThanOrEqual(FADE_CONCURRENCY);
  });

  it('keeps a usable number of steps where serial collapsed, at 500ms', async () => {
    const serial = makeNet({ rtt: 500 });
    await runNet(serial, ramp(serial, 1));
    const overlapped = makeNet({ rtt: 500 });
    await runNet(overlapped, ramp(overlapped, FADE_CONCURRENCY));

    expect(serial.landed.filter((w) => w.at <= 3000).length).toBeLessThanOrEqual(6);
    expect(overlapped.landed.length).toBeGreaterThanOrEqual(11);
  });

  it('never has more writes in flight than the cap, however slow the network', async () => {
    const net = makeNet({ rtt: 1500 });
    await runNet(net, ramp(net, FADE_CONCURRENCY));
    expect(net.maxInFlight).toBeLessThanOrEqual(FADE_CONCURRENCY);
    expect(net.landed.at(-1).level).toBe(0);
  });

  it('writes the final level last and alone, even when an earlier one comes back late', async () => {
    // These are ABSOLUTE writes, so a straggler landing after the last one would leave the
    // volume somewhere the ramp never meant to end. The final level is written only after
    // everything else has come back.
    const net = makeNet({ rtt: 300, slow: { index: 4, rtt: 2400 } });
    await runNet(net, ramp(net, FADE_CONCURRENCY));

    expect(net.landed.at(-1).level).toBe(0);
    expect(net.landed.filter((w) => w.level === 0)).toHaveLength(1);
    const zeroAt = net.landed.at(-1).at;
    expect(net.landed.every((w) => w.at <= zeroAt)).toBe(true);
    // The straggler is still the straggler — it just cannot land after the end.
    expect(net.landed.map((w) => w.level).at(-2)).not.toBe(0);
  });

  it('still paces against the clock rather than firing everything at once', async () => {
    const net = makeNet({ rtt: 300 });
    await runNet(net, ramp(net, FADE_CONCURRENCY));
    // Twelve writes spread over the fade, not twelve writes in the first 300ms.
    expect(net.issued.filter((w) => w.at < 500).length).toBeLessThanOrEqual(3);
    expect(net.landed.at(-1).at).toBeGreaterThan(2700);
  });
});

describe('telling the settings screen when latency cannot fill the fade', () => {
  it('says nothing until a transition has actually measured something', () => {
    expect(readLatencyMs()).toBe(null);
    expect(fadeLatencyNote(3000)).toBe(null);
  });

  it('says nothing at 3s on the latency measured on device', () => {
    writeLatencyMs(300);
    expect(stepsWithin(3000, 300)).toBe(FADE_STEPS);
    expect(fadeLatencyNote(3000)).toBe(null);
  });

  it('speaks up for a short fade on that same connection', () => {
    writeLatencyMs(300);
    const note = fadeLatencyNote(1000);
    expect(note).toContain('300ms');
    expect(note).toContain('1.0s');
    expect(note).toContain('6 volume steps');
    // Factual, not an error, and not a threat to change anything.
    expect(note).not.toMatch(/error|failed|cannot fade/i);
  });

  it('speaks up at 3s when the connection is genuinely slow', () => {
    expect(stepsWithin(3000, 900)).toBeLessThan(MIN_SMOOTH_STEPS);
    expect(fadeLatencyNote(3000, 900)).toBeTruthy();
  });

  it('counts the steps the ramp can actually land, concurrency included', () => {
    // One write per round trip would make 3s at 300ms ten steps; two in flight makes the
    // full twelve, which is why the notice does not appear in the measured range.
    expect(stepsWithin(3000, 300)).toBe(FADE_STEPS);
    expect(stepsWithin(1000, 300)).toBe(6);
    expect(stepsWithin(3000, 1500)).toBe(4);
    expect(stepsWithin(3000, null)).toBe(FADE_STEPS); // unknown is not a complaint
  });

  it('says nothing when the fade is switched off entirely', () => {
    writeLatencyMs(1500);
    expect(fadeLatencyNote(0)).toBe(null);
  });

  it('ignores junk rather than storing it', () => {
    expect(writeLatencyMs(0)).toBe(null);
    expect(writeLatencyMs('soon')).toBe(null);
    expect(readLatencyMs()).toBe(null);
  });

  it('is persisted by a transition, so settings never has to ask Spotify', async () => {
    const clock = makeClock();
    const api = fakeApi({ volume: 70, rtt: 200, clock });
    await startTransition(tavern, {
      api, now: clock.now, sleep: clock.sleep, fadeMs: 3000,
    });
    expect(readLatencyMs()).toBe(200);
  });
});

describe('a whole transition on a device that accepts volume', () => {
  it('fades out, switches, then fades back to the volume it started from', async () => {
    const clock = makeClock();
    const api = fakeApi({ volume: 70, clock });
    const result = await startTransition(tavern, {
      api, now: clock.now, sleep: clock.sleep, fadeMs: 3000, random: () => 0.5,
    });

    expect(result.outcome).toBe(FADED);
    const volumes = volumesIn(api.calls);
    expect(volumes).toHaveLength(24);
    expect(volumes.slice(0, 12)).toEqual([61, 52, 43, 36, 29, 22, 16, 11, 7, 4, 1, 0]);
    expect(volumes.slice(12)).toEqual([1, 4, 7, 11, 16, 22, 29, 36, 43, 52, 61, 70]);
    expect(volumes.at(-1)).toBe(70);
  });

  it('reads the device volume first, and restores to THAT rather than to 100', async () => {
    const clock = makeClock();
    const api = fakeApi({ volume: 35, clock });
    await startTransition(tavern, { api, now: clock.now, sleep: clock.sleep });
    expect(namesIn(api.calls)[0]).toBe('getPlayerState');
    expect(volumesIn(api.calls).at(-1)).toBe(35);
  });

  it('plays BEFORE setting shuffle — the order lost a race on device (#10)', async () => {
    const clock = makeClock();
    const api = fakeApi({ clock });
    await startTransition({ ...tavern, inorder: true }, { api, now: clock.now, sleep: clock.sleep });
    const order = namesIn(api.calls).filter((n) => n === 'startPlayback' || n === 'setShuffle');
    expect(order).toEqual(['startPlayback', 'setShuffle']);
    expect(api.calls.find((c) => c[0] === 'setShuffle')[1]).toBe(false);
    expect(api.calls.find((c) => c[0] === 'startPlayback')[1])
      .toEqual({ contextUri: tavern.uri, position: 0 });
  });

  it('switches at the chosen random offset', async () => {
    const clock = makeClock();
    const api = fakeApi({ clock });
    await startTransition(tavern, {
      api, now: clock.now, sleep: clock.sleep, random: () => 0.25,
    });
    expect(api.calls.find((c) => c[0] === 'startPlayback')[1])
      .toEqual({ contextUri: tavern.uri, position: 30 });
  });

  it('restores in ONE call for a nofadein playlist, instead of ramping back up (#6)', async () => {
    const clock = makeClock();
    const api = fakeApi({ volume: 70, clock });
    const result = await startTransition({ ...tavern, nofadein: true }, {
      api, now: clock.now, sleep: clock.sleep, fadeMs: 3000,
    });
    expect(result.outcome).toBe(FADED);
    const volumes = volumesIn(api.calls);
    // Twelve down, then exactly one back up.
    expect(volumes).toHaveLength(13);
    expect(volumes.at(-2)).toBe(0);
    expect(volumes.at(-1)).toBe(70);
    // And it happens after the switch, so the outgoing track never jumps back up.
    const names = namesIn(api.calls);
    expect(names.lastIndexOf('setVolume')).toBeGreaterThan(names.indexOf('startPlayback'));
  });

  it('just switches, with no volume calls at all, when the fade is set to zero', async () => {
    const clock = makeClock();
    const api = fakeApi({ clock });
    const result = await startTransition(tavern, {
      api, now: clock.now, sleep: clock.sleep, fadeMs: 0,
    });
    expect(result).toMatchObject({ outcome: UNFADED, reason: 'fade-off' });
    expect(volumesIn(api.calls)).toEqual([]);
    expect(namesIn(api.calls)).toContain('startPlayback');
  });
});

describe('a device that will not take remote volume', () => {
  it('switches immediately at full volume and says which case it is', async () => {
    const clock = makeClock();
    const api = fakeApi({ supportsVolume: false, volume: 60, clock });
    const result = await startTransition(tavern, { api, now: clock.now, sleep: clock.sleep });

    expect(result).toMatchObject({ outcome: UNFADED, reason: 'no-volume-support' });
    // Never silently nothing, and never a refusal to switch.
    expect(namesIn(api.calls)).toEqual(['getPlayerState', 'startPlayback', 'setShuffle']);
    expect(volumesIn(api.calls)).toEqual([]);
  });

  it('reports the no-player case separately — Spotify answers 204 with nothing active', async () => {
    const clock = makeClock();
    const api = fakeApi({ playerState: null, clock });
    const result = await startTransition(tavern, { api, now: clock.now, sleep: clock.sleep });
    expect(result).toMatchObject({ outcome: UNFADED, reason: 'no-player' });
    expect(namesIn(api.calls)).toContain('startPlayback');
  });

  it('still switches when the player read itself fails', async () => {
    const clock = makeClock();
    const api = fakeApi({ clock });
    api.getPlayerState = async () => { throw new Error('offline'); };
    const result = await startTransition(tavern, { api, now: clock.now, sleep: clock.sleep });
    expect(result).toMatchObject({ outcome: UNFADED, reason: 'no-player' });
    expect(namesIn(api.calls)).toContain('startPlayback');
  });

  it('refuses only when there is no playlist URI to play', async () => {
    const result = await startTransition({ ...tavern, uri: undefined }, { api: fakeApi() });
    expect(result).toMatchObject({ outcome: FAILED, reason: 'no-uri' });
  });
});

describe('when something fails in the middle', () => {
  it('puts the volume back rather than leaving it at zero', async () => {
    const clock = makeClock();
    const api = fakeApi({ volume: 70, clock });
    const sent = [];
    let n = 0;
    api.setVolume = async (v) => {
      n += 1;
      if (n === 4) throw new Error('500 from Spotify');
      sent.push(v);
      api.calls.push(['setVolume', v]);
    };

    const result = await startTransition(tavern, {
      api, now: clock.now, sleep: clock.sleep, fadeMs: 3000,
    });

    expect(result.outcome).toBe(FAILED);
    expect(result.error.message).toContain('500');
    // The last thing it did was give the volume back — not keep ramping, not stop at 0.
    expect(sent.at(-1)).toBe(70);
    expect(sent).toHaveLength(4); // three ramp steps, then the restore
  });

  it('puts the volume back when the play call is what fails', async () => {
    const clock = makeClock();
    const api = fakeApi({ volume: 55, clock });
    api.startPlayback = async () => { throw new Error('no active device'); };

    const result = await startTransition(tavern, {
      api, now: clock.now, sleep: clock.sleep, fadeMs: 3000,
    });

    expect(result.outcome).toBe(FAILED);
    const volumes = volumesIn(api.calls);
    expect(volumes.at(-2)).toBe(0); // the fade-out finished
    expect(volumes.at(-1)).toBe(55); // and then it was undone
  });

  it('does not get stuck reporting failure if even the restore fails', async () => {
    const clock = makeClock();
    const api = fakeApi({ clock });
    api.setVolume = async () => { throw new Error('everything is down'); };
    const result = await startTransition(tavern, { api, now: clock.now, sleep: clock.sleep });
    expect(result.outcome).toBe(FAILED);
  });
});

describe('a second tap while a ramp is still running', () => {
  it('supersedes the ramp in flight instead of fighting it', async () => {
    const clock = makeClock();
    const api = fakeApi({ volume: 70, clock });

    let release;
    const gate = new Promise((r) => { release = r; });
    let writes = 0;
    const plainSetVolume = api.setVolume;
    api.setVolume = async (v) => {
      writes += 1;
      await plainSetVolume(v);
      // Park the first transition mid-fade-out. Gating the FIRST write parks it after
      // two, because the ramp now keeps a second write in flight (FADE_CONCURRENCY).
      if (writes === 1) await gate;
    };

    const first = startTransition(tavern, {
      api, now: clock.now, sleep: clock.sleep, fadeMs: 3000,
    });
    await flush();
    expect(writes).toBe(2);

    const second = startTransition(tavern, {
      api, now: clock.now, sleep: clock.sleep, fadeMs: 3000,
    });
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.outcome).toBe(SUPERSEDED);
    expect(b.outcome).toBe(FADED);

    // The superseding run inherits the ORIGINAL volume. Reading the current one instead
    // would have restored to whatever the half-finished fade-out was at, and a run of
    // taps would ratchet the music quieter and quieter.
    expect(b.baseVolume).toBe(70);
    expect(volumesIn(api.calls).at(-1)).toBe(70);

    // It also does not re-interrogate the device it already knows about.
    expect(namesIn(api.calls).filter((n) => n === 'getPlayerState')).toHaveLength(1);
  });

  it('only the surviving tap starts a playlist — the superseded one never plays', async () => {
    const clock = makeClock();
    const api = fakeApi({ volume: 70, clock });

    let release;
    const gate = new Promise((r) => { release = r; });
    let writes = 0;
    const plainSetVolume = api.setVolume;
    api.setVolume = async (v) => {
      writes += 1;
      await plainSetVolume(v);
      if (writes === 1) await gate;
    };

    const first = startTransition(tavern, { api, now: clock.now, sleep: clock.sleep });
    await flush();
    const second = startTransition({ ...tavern, id: 'other', uri: 'spotify:playlist:other' }, {
      api, now: clock.now, sleep: clock.sleep,
    });
    release();
    await Promise.all([first, second]);

    const played = api.calls.filter((c) => c[0] === 'startPlayback').map((c) => c[1].contextUri);
    expect(played).toEqual(['spotify:playlist:other']);
  });
});
