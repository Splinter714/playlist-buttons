import { describe, it, expect, beforeEach } from 'vitest';

// Same real-enough localStorage as the rotation tests: the whole point of a setting is
// that it survives the reload every transition forces (#4), so the tests go through
// storage rather than memory.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const {
  readFadeMs, writeFadeMs, clearSettings, clampFadeMs, resolveFade, formatFade,
  SETTINGS_KEY, DEFAULT_FADE_MS, MIN_FADE_MS, MAX_FADE_MS,
} = await import('../src/settings.js');

const stored = () => JSON.parse(store.get(`pb.${SETTINGS_KEY}`) ?? 'null');

beforeEach(() => store.clear());

describe('the fade duration (#5) — one number, both directions, global', () => {
  it('falls back to 3000ms when nothing is stored', () => {
    expect(DEFAULT_FADE_MS).toBe(3000);
    expect(readFadeMs()).toBe(3000);
  });

  it('persists across a reload', () => {
    writeFadeMs(4500);
    expect(readFadeMs()).toBe(4500);
    // Nothing cached in the module: a fresh read goes back to storage.
    expect(stored().fadeMs).toBe(4500);
  });

  it('keeps the last value written', () => {
    writeFadeMs(1000);
    writeFadeMs(6250);
    expect(readFadeMs()).toBe(6250);
  });

  it('accepts zero — no fade at all is a legitimate setting', () => {
    writeFadeMs(0);
    expect(readFadeMs()).toBe(0);
  });

  it('uses the pb. prefix like everything else in storage', () => {
    writeFadeMs(2000);
    expect(store.has(`pb.${SETTINGS_KEY}`)).toBe(true);
  });

  it('clears back to the default', () => {
    writeFadeMs(7000);
    clearSettings();
    expect(readFadeMs()).toBe(DEFAULT_FADE_MS);
  });
});

describe('the fade duration — junk in storage never reaches the shortcut', () => {
  it('falls back when the stored value is not JSON', () => {
    store.set(`pb.${SETTINGS_KEY}`, 'not json at all');
    expect(readFadeMs()).toBe(DEFAULT_FADE_MS);
  });

  it('falls back when the stored record is the wrong shape', () => {
    store.set(`pb.${SETTINGS_KEY}`, JSON.stringify([1, 2, 3]));
    expect(readFadeMs()).toBe(DEFAULT_FADE_MS);
  });

  it('falls back when fadeMs is missing or not a number', () => {
    store.set(`pb.${SETTINGS_KEY}`, JSON.stringify({ fadeMs: '3000' }));
    expect(readFadeMs()).toBe(DEFAULT_FADE_MS);
    store.set(`pb.${SETTINGS_KEY}`, JSON.stringify({ other: 1 }));
    expect(readFadeMs()).toBe(DEFAULT_FADE_MS);
  });

  it('pulls an out-of-range stored value into range rather than trusting it', () => {
    store.set(`pb.${SETTINGS_KEY}`, JSON.stringify({ fadeMs: 999999 }));
    expect(readFadeMs()).toBe(MAX_FADE_MS);
    store.set(`pb.${SETTINGS_KEY}`, JSON.stringify({ fadeMs: -5000 }));
    expect(readFadeMs()).toBe(MIN_FADE_MS);
  });

  it('clamps and rounds on the way in too', () => {
    expect(writeFadeMs(20000)).toBe(MAX_FADE_MS);
    expect(writeFadeMs(-1)).toBe(MIN_FADE_MS);
    expect(writeFadeMs('2500')).toBe(2500);
    expect(writeFadeMs(2500.4)).toBe(2500);
    expect(clampFadeMs(undefined)).toBe(DEFAULT_FADE_MS);
    expect(clampFadeMs(NaN)).toBe(DEFAULT_FADE_MS);
  });
});

describe('resolveFade — the two numbers the shortcut takes (#4/#6)', () => {
  it('uses the one duration for both directions by default', () => {
    expect(resolveFade(false, 3000)).toEqual({ downMs: 3000, upMs: 3000 });
  });

  it('sends upMs 0 for a nofadein playlist — full volume, no ramp', () => {
    expect(resolveFade(true, 3000)).toEqual({ downMs: 3000, upMs: 0 });
  });

  it('still fades OUT for a nofadein playlist — only the fade in is skipped', () => {
    expect(resolveFade(true, 4000).downMs).toBe(4000);
  });

  it('reads the stored duration when none is passed', () => {
    writeFadeMs(1500);
    expect(resolveFade(false)).toEqual({ downMs: 1500, upMs: 1500 });
  });
});

describe('formatFade', () => {
  it('reads as seconds with one decimal', () => {
    expect(formatFade(3000)).toBe('3.0s');
    expect(formatFade(250)).toBe('0.3s');
    expect(formatFade(0)).toBe('0.0s');
  });
});
