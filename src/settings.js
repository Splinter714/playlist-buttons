// App settings that are not the rotation itself. Right now that is one number: how long
// the fade lasts (#5).
//
// ONE duration, used for both directions, 3s by default, global. Jackson declined a
// per-direction split and declined a per-playlist override, which is why this is a scalar
// in its own key rather than a field on the rotation entry — `nofadein` (#6) stays on the
// rotation entry, because it genuinely is per playlist.
//
// Same `pb.` prefix and versioned key as everything else in storage.js.

import { read, write, remove } from './storage.js';

export const SETTINGS_KEY = 'settings.v1';

/** The starting point Jackson named. Used whenever nothing is stored or storage is junk. */
export const DEFAULT_FADE_MS = 3000;

// The slider's ends. Zero is allowed on purpose — it is the honest way to say "no fade"
// for everything, and it costs nothing to permit.
export const MIN_FADE_MS = 0;
export const MAX_FADE_MS = 10000;
export const FADE_STEP_MS = 250;

function readRecord() {
  const stored = read(SETTINGS_KEY, null);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  return stored;
}

/** Anything unusable becomes the default; anything out of range is pulled into it. */
export function clampFadeMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_FADE_MS;
  return Math.min(MAX_FADE_MS, Math.max(MIN_FADE_MS, Math.round(n)));
}

/** @returns {number} milliseconds. Falls back to 3000 when unset. */
export function readFadeMs() {
  const raw = readRecord().fadeMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_FADE_MS;
  return clampFadeMs(raw);
}

/** Persist the fade. Returns what was actually stored, after clamping. */
export function writeFadeMs(ms) {
  const fadeMs = clampFadeMs(ms);
  write(SETTINGS_KEY, { ...readRecord(), fadeMs });
  return fadeMs;
}

export function clearSettings() {
  remove(SETTINGS_KEY);
}

/**
 * The two numbers the shortcut contract takes (#4), from the one setting plus the
 * playlist's own `nofadein` (#6). `upMs: 0` means restore to the captured volume
 * immediately rather than ramping.
 */
export function resolveFade(nofadein, fadeMs = readFadeMs()) {
  const downMs = clampFadeMs(fadeMs);
  return { downMs, upMs: nofadein === true ? 0 : downMs };
}

/** "3.0s" — one decimal, because the slider steps in quarter seconds. */
export function formatFade(ms) {
  return `${(clampFadeMs(ms) / 1000).toFixed(1)}s`;
}
