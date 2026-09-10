import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The shortcut is GENERATED (shortcut/build.mjs), so the thing worth asserting is what
// comes out of the generator — the actual file that gets signed and imported on the
// phone. #10 changed the one value in it that used to be hardcoded: shuffle.
//
// This runs the real build rather than importing pieces of it, because the build script
// is a script: its output IS its behaviour.

const root = resolve(import.meta.dirname, '..');
const built = resolve(root, 'shortcut', 'dist', 'PlaylistButtons.shortcut');

/** The object-replacement char build.mjs uses to stand in for a variable attachment. */
const OBJ = '￼';

let plist = '';

beforeAll(() => {
  execFileSync(process.execPath, [resolve(root, 'shortcut', 'build.mjs')], { stdio: 'ignore' });
  plist = readFileSync(built, 'utf8');
});

/**
 * The `<dict>` block for the URL action whose URL string contains `needle`.
 *
 * Requests take their URL from a `url` action immediately above them, never from a
 * `WFURL` on the request itself — both alternatives failed on device. See
 * shortcut/README.md.
 */
function urlActionFor(needle) {
  const blocks = plist.split('<key>WFURLActionURL</key>');
  const match = blocks.slice(1).find((b) => b.includes(needle));
  expect(match, `no URL action containing ${needle}`).toBeDefined();
  // Everything up to the end of this action's parameters is enough to read the URL and
  // any variable attachment inside it.
  return match.slice(0, match.indexOf('WFWorkflowActionIdentifier'));
}

describe('the generated shortcut takes shuffle from its input (#10)', () => {
  it('unpacks every field the web app sends, `shuffle` included, and nothing it does not', () => {
    const keys = [...plist.matchAll(/<key>WFDictionaryKey<\/key>\s*<string>([^<]+)<\/string>/g)]
      .map((m) => m[1]);
    // `devices` and `id` belong to the no-active-device recovery path, not to the input.
    expect(keys.filter((k) => !['devices', 'id'].includes(k)))
      .toEqual(['token', 'context_uri', 'offset', 'shuffle', 'downMs', 'upMs', 'return_url']);
  });

  it('no longer hardcodes shuffle on', () => {
    expect(plist).not.toContain('shuffle?state=true');
    expect(plist).not.toContain('shuffle?state=false');
  });

  it('builds the shuffle URL by interpolating the shuffle variable', () => {
    const action = urlActionFor('me/player/shuffle');
    expect(action).toContain(`<string>https://api.spotify.com/v1/me/player/shuffle?state=${OBJ}</string>`);
    expect(action).toContain('<string>WFTextTokenString</string>');
    expect(action).toMatch(
      /<key>VariableName<\/key>\s*<string>shuffle<\/string>/,
    );
  });

  it('still takes the start position from the app rather than choosing one', () => {
    // Offset and shuffle travel together from handoff.js — an in-order playlist arrives
    // as `offset: 0`, so there is no number in here to keep in step with the app.
    expect(plist).toMatch(/<key>VariableName<\/key>\s*<string>offset<\/string>/);
  });

  it('returns to the app before the fade-in rather than at the end of the run', () => {
    // x-success only fires when the whole run finishes, which is the wait this avoids.
    // So there is an explicit switch-apps action, and it sits after the play call and
    // before the fade-in ramp — the order is the whole point.
    const openApp = plist.indexOf('is.workflow.actions.openapp');
    const play = plist.indexOf('me/player/play');
    const fadeIn = plist.lastIndexOf('is.workflow.actions.setvolume');
    expect(openApp).toBeGreaterThan(play);
    expect(openApp).toBeLessThan(fadeIn);
    expect(plist).toContain('com.apple.mobilesafari');
  });

  it('is a well-formed plist that `shortcuts sign` can take', () => {
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(plist.trimEnd().endsWith('</plist>')).toBe(true);
    execFileSync('plutil', ['-lint', built], { stdio: 'ignore' });
  });
});
