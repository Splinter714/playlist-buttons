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
  resolvePlaybackPlan, resolveTile, pickOffset, rampLevels, rampVolume,
  startTransition, resetTransitions, FADE_STEPS, FADED, UNFADED, SUPERSEDED, FAILED,
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

describe('ramp levels', () => {
  it('walks down in twelve even steps and lands exactly on zero', () => {
    expect(rampLevels(100, 0, FADE_STEPS))
      .toEqual([92, 83, 75, 67, 58, 50, 42, 33, 25, 17, 8, 0]);
  });

  it('walks back up to the captured volume, not to 100', () => {
    const up = rampLevels(0, 70, FADE_STEPS);
    expect(up).toHaveLength(12);
    expect(up[0]).toBe(6);
    expect(up.at(-1)).toBe(70);
  });

  it('scales through the starting volume rather than through absolute fractions', () => {
    // From 60% the first step of a fade OUT must go down, not up to 92%.
    expect(rampLevels(60, 0, FADE_STEPS)[0]).toBe(55);
  });

  it('has one named step count for both directions', () => {
    expect(FADE_STEPS).toBe(12);
    expect(rampLevels(100, 0)).toHaveLength(FADE_STEPS);
    expect(rampLevels(0, 100)).toHaveLength(FADE_STEPS);
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
    expect(volumes.slice(0, 12)).toEqual([64, 58, 53, 47, 41, 35, 29, 23, 18, 12, 6, 0]);
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
      if (writes === 2) await gate; // park the first transition mid-fade-out
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
      if (writes === 2) await gate;
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
