// @vitest-environment jsdom
// A background token refresh has to tell the app, because every tile's handoff href
// embeds the token at render time. Without a repaint the grid keeps handing Shortcuts a
// dead token and every tap 401s — and because each transition reloads the page, it only
// shows up when the page has sat open long enough for the token to age out. It cost a
// long debugging session on the real device.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const KEY = 'pb.auth'; // storage.js prefixes every key with 'pb.'

function store(auth) {
  localStorage.setItem(KEY, JSON.stringify(auth));
}

const live = (extra = {}) => ({
  access_token: 'OLD',
  refresh_token: 'R',
  expires_at: Date.now() + 60 * 60 * 1000,
  scope: '',
  ...extra,
});

describe('a background token refresh notifies the app', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    vi.useFakeTimers();
  });

  it('does not fire when the token was already fresh', async () => {
    store(live());
    const { startRefreshTimer } = await import('../src/auth.js');
    const onRefreshed = vi.fn();
    startRefreshTimer(() => {}, onRefreshed);
    await vi.advanceTimersByTimeAsync(0);
    expect(onRefreshed).not.toHaveBeenCalled();
  });

  it('fires with the new token once a near-expiry token is exchanged', async () => {
    // Under the refresh margin, so the timer's first tick exchanges it.
    store(live({ expires_at: Date.now() + 30 * 1000 }));
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'NEW', expires_in: 3600, scope: '' }),
    });

    const { startRefreshTimer, getAccessTokenSync } = await import('../src/auth.js');
    const onRefreshed = vi.fn();
    startRefreshTimer(() => {}, onRefreshed);
    await vi.advanceTimersByTimeAsync(0);

    expect(onRefreshed).toHaveBeenCalledTimes(1);
    // The point of the callback: what the grid will now bake into its hrefs.
    expect(getAccessTokenSync()).toBe('NEW');
  });
});
