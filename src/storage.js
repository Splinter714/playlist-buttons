// Thin localStorage wrapper. Everything the app needs across a transition lives here:
// issue #4 established that every playlist transition reloads the page, so nothing may
// live only in memory. Reads and writes are wrapped because Safari private mode throws
// on access rather than returning null.

const PREFIX = 'pb.';

export function read(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}
