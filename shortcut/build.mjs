#!/usr/bin/env node
// Generates shortcut/dist/PlaylistButtons.shortcut — the unsigned, old-format
// shortcut plist that the web app hands off to.
//
//   npm run shortcut:build
//   shortcuts sign --mode anyone -i shortcut/dist/PlaylistButtons.shortcut \
//                                -o shortcut/dist/signed/PlaylistButtons.shortcut
//   The signed file must be named PlaylistButtons.shortcut exactly — the imported
//   shortcut takes its name from the filename, and the app's URL asks for
//   name=PlaylistButtons. Use `npm run shortcut:sign`, which gets this right.
//
// See shortcut/README.md for install steps and for which action identifiers
// here are confirmed against a real shortcut vs. which are educated guesses.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Tuning knobs — these are the values to change when tuning the fade by ear.
// ---------------------------------------------------------------------------

/** Number of volume steps in each ramp. More steps = smoother, more overhead. */
const STEPS = 20;

/** Seconds to wait after transferring to a device before retrying playback. */
const DEVICE_TRANSFER_SETTLE_SECONDS = 0.5;

const API = 'https://api.spotify.com/v1';

// ---------------------------------------------------------------------------
// plist serialisation
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Marker so we can round-trip real numbers that happen to be integral. */
const real = (n) => ({ __real: n });

function plistValue(v, indent) {
  const pad = '\t'.repeat(indent);
  if (v === null || v === undefined) throw new Error('null in plist');
  if (typeof v === 'boolean') return `${pad}<${v}/>`;
  if (typeof v === 'object' && '__real' in v) return `${pad}<real>${v.__real}</real>`;
  if (typeof v === 'number') {
    return Number.isInteger(v) ? `${pad}<integer>${v}</integer>` : `${pad}<real>${v}</real>`;
  }
  if (typeof v === 'string') return `${pad}<string>${esc(v)}</string>`;
  if (Array.isArray(v)) {
    if (v.length === 0) return `${pad}<array/>`;
    const body = v.map((x) => plistValue(x, indent + 1)).join('\n');
    return `${pad}<array>\n${body}\n${pad}</array>`;
  }
  const keys = Object.keys(v);
  if (keys.length === 0) return `${pad}<dict/>`;
  const body = keys
    .map((k) => `${'\t'.repeat(indent + 1)}<key>${esc(k)}</key>\n${plistValue(v[k], indent + 1)}`)
    .join('\n');
  return `${pad}<dict>\n${body}\n${pad}</dict>`;
}

const toPlist = (root) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
  '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0">\n' +
  plistValue(root, 0) +
  '\n</plist>\n';

// ---------------------------------------------------------------------------
// Deterministic UUIDs, so rebuilding produces a byte-identical file.
// ---------------------------------------------------------------------------

let uuidCounter = 0;
function uuid() {
  // Namespaced, sequential, uppercase — Shortcuts only needs uniqueness.
  const n = (uuidCounter++).toString(16).padStart(12, '0').toUpperCase();
  return `50424254-0000-4000-8000-${n}`;
}

// ---------------------------------------------------------------------------
// Value builders (WFTextTokenString / WFTextTokenAttachment)
// ---------------------------------------------------------------------------

const OBJ = '￼'; // object-replacement char that stands in for an attachment

/** Reference to a named variable, e.g. one made by Set Variable. */
const varRef = (name) => ({ Type: 'Variable', VariableName: name });

/** Reference to an earlier action's output. */
const outRef = (id, name) => ({ Type: 'ActionOutput', OutputUUID: id, OutputName: name });

/**
 * Build a WFTextTokenString from alternating literal strings and refs.
 * text`Bearer ${varRef('token')}` style, but as a plain call:
 *   tokenString('Bearer ', varRef('token'))
 */
function tokenString(...parts) {
  let string = '';
  const attachmentsByRange = {};
  for (const part of parts) {
    if (typeof part === 'string') {
      string += part;
    } else {
      attachmentsByRange[`{${string.length}, 1}`] = part;
      string += OBJ;
    }
  }
  return { Value: { attachmentsByRange, string }, WFSerializationType: 'WFTextTokenString' };
}

/** A bare attachment — used where a field takes a value rather than text. */
const tokenAttachment = (ref) => ({ Value: ref, WFSerializationType: 'WFTextTokenAttachment' });

// WFItemType codes inside a WFDictionaryFieldValue.
const ITEM_TEXT = 0;
const ITEM_DICT = 1;
const ITEM_NUMBER = 3;

/**
 * Build a WFDictionaryFieldValue from { key: entry } where each entry is
 * { type, value }. Used for HTTP headers and JSON request bodies.
 */
function dictField(entries) {
  return {
    Value: {
      WFDictionaryFieldValueItems: Object.entries(entries).map(([key, entry]) => ({
        WFItemType: entry.type,
        WFKey: tokenString(key),
        WFValue: entry.value,
      })),
    },
    WFSerializationType: 'WFDictionaryFieldValue',
  };
}

const text = (...parts) => ({ type: ITEM_TEXT, value: tokenString(...parts) });
const number = (...parts) => ({ type: ITEM_NUMBER, value: tokenString(...parts) });
const nested = (entries) => ({ type: ITEM_DICT, value: dictField(entries) });

// ---------------------------------------------------------------------------
// Action builders
// ---------------------------------------------------------------------------

const actions = [];

/**
 * UUID of the most recently emitted action. Set Variable needs it: without an
 * explicit WFInput naming what to store, Set Variable silently stores nothing and
 * every later reference to that variable comes back empty. Verified on-device — a
 * probe reading a variable set without WFInput returned "", while the same variable
 * set with it returned the value.
 */
let lastUUID = null;

/**
 * Emit an action. A UUID is assigned automatically so the next action can reference
 * this one's output — EXCEPT for control flow, which must stay UUID-less: every
 * conditional in the working reference shortcut has no UUID, and adding one renders
 * the condition blank on device. Pass `{ noUUID: true }` for those.
 */
const act = (identifier, parameters = {}, { noUUID = false } = {}) => {
  const params = { ...parameters };
  if (!noUUID && !params.UUID) params.UUID = uuid();
  if (params.UUID) lastUUID = params.UUID;
  actions.push({ WFWorkflowActionIdentifier: identifier, WFWorkflowActionParameters: params });
};

const comment = (t) => act('is.workflow.actions.comment', { WFCommentActionText: t });

/** Get Dictionary from Input. Returns its output UUID. */
/**
 * Get Dictionary from Input, reading Shortcut Input explicitly.
 *
 * Without WFInput this action takes whatever the previous action produced. That is
 * fine mid-chain (after an HTTP response, say), but the first use here is preceded by
 * a Comment, which produces nothing — so the dictionary came back empty and every
 * value unpacked from it was blank, surfacing as "Math error" on the first
 * calculation. Naming ExtensionInput makes it independent of what sits above it.
 *
 * Pass `fromPrevious: true` where the dictionary really should come from the
 * preceding action rather than the shortcut's own input.
 */
function getDictionaryFromInput({ fromPrevious = false } = {}) {
  const id = uuid();
  const params = { UUID: id };
  params.WFInput = fromPrevious
    ? prevRef('Contents of URL')
    : { Value: { Type: 'ExtensionInput' }, WFSerializationType: 'WFTextTokenAttachment' };
  act('is.workflow.actions.detect.dictionary', params);
  return id;
}

/** Get Value for Key. Operates on the previous action's output. */
function getValueForKey(key) {
  const input = prevRef('Dictionary');
  const id = uuid();
  act('is.workflow.actions.getvalueforkey', { UUID: id, WFDictionaryKey: key, WFInput: input });
  return id;
}

/**
 * An attachment pointing at whatever the previous action produced.
 *
 * Generated plists do NOT inherit the implicit chaining the Shortcuts editor wires up
 * for you. Building by hand, each action's input box is filled in as you drop it in;
 * emitting the same actions as a plist leaves every consumer pointing at a bare
 * placeholder — the phone shows "Dictionary" or "URL" with nothing behind it, and the
 * action fails or silently yields empty. So every action that eats a previous value
 * has to name its input explicitly. Found the hard way: Jackson spotted that the
 * Get Value for Key actions all read "Dictionary" until he filled them in by hand.
 */
const prevRef = (outputName) => ({
  Value: { Type: 'ActionOutput', OutputUUID: lastUUID, OutputName: outputName },
  WFSerializationType: 'WFTextTokenAttachment',
});

/**
 * Store the previous action's output under a name. The WFInput is not optional —
 * see lastUUID above.
 */
const setVariable = (name) => {
  const source = lastUUID;
  act('is.workflow.actions.setvariable', {
    WFVariableName: name,
    WFInput: {
      Value: { Type: 'ActionOutput', OutputUUID: source, OutputName: 'Result' },
      WFSerializationType: 'WFTextTokenAttachment',
    },
  });
};

const getVariable = (name) =>
  act('is.workflow.actions.getvariable', { WFVariable: tokenAttachment(varRef(name)) });

/** Get Item from List — first item only, which is all we need. */
function getFirstItem() {
  const input = prevRef('List');
  const id = uuid();
  act('is.workflow.actions.getitemfromlist', {
    UUID: id,
    WFItemSpecifier: 'First Item',
    WFInput: input,
  });
  return id;
}

/** Get Device Details -> Volume. */
function getDeviceVolume() {
  const id = uuid();
  act('is.workflow.actions.getdevicedetails', { UUID: id, WFDeviceDetail: 'Current Volume' });
  return id;
}

/** Set Volume. `value` is a WFTextTokenAttachment holding a 0-1 number. */
const setVolume = (value) => act('is.workflow.actions.setvolume', { WFVolume: value });

/** Calculate Expression. Returns its output UUID. */
function calculate(...parts) {
  const id = uuid();
  act('is.workflow.actions.calculateexpression', { UUID: id, Input: tokenString(...parts) });
  return id;
}

/** Wait. `seconds` is either a plain number or a WFTextTokenAttachment. */
const wait = (seconds) => act('is.workflow.actions.delay', { WFDelayTime: seconds });

const showAlert = (title, message) =>
  act('is.workflow.actions.alert', {
    WFAlertActionTitle: title,
    WFAlertActionMessage: message,
    WFAlertActionCancelButtonShown: false,
  });

const stopShortcut = () => act('is.workflow.actions.exit');

/** URL action — Get Contents of URL takes its address from this action's output. */
/**
 * Get Contents of URL. Emits the preceding URL action too, so a request is one
 * call here. Omitting WFHTTPMethod means GET; omitting WFHTTPBodyType with
 * WFJSONValues present means a JSON body — both match a known-good shortcut.
 */
/**
 * A URL action, whose output the request below it consumes.
 *
 * `WFURLActionURL` takes a plain string, or a token string where a variable is
 * interpolated.
 */
function urlAction(url) {
  const id = uuid();
  act('is.workflow.actions.url', { UUID: id, WFURLActionURL: url });
  return id;
}

/**
 * Get Contents of URL, taking its URL from the `url` action immediately above it.
 *
 * Copied from the working reference shortcut, where all six requests are shaped this
 * way and NONE carries a `WFURL`. Two other shapes were tried and both failed on
 * device: pointing `WFURL` at the url action's output gave "No URL Specified", and
 * putting the URL inline in `WFURL` displayed correctly but never fired the request —
 * playback simply did not change, with no error.
 *
 * Note `WFHTTPBodyType` is not set. In the reference it appears only on a Form body;
 * a JSON request carries `WFJSONValues` and nothing else.
 */
function httpRequest({ url, method, headers, json }) {
  urlAction(url);
  const id = uuid();
  const params = { Advanced: true, ShowHeaders: true, UUID: id };
  if (method && method !== 'GET') params.WFHTTPMethod = method;
  if (headers) params.WFHTTPHeaders = dictField(headers);
  if (json) params.WFJSONValues = dictField(json);
  act('is.workflow.actions.downloadurl', params);
  return id;
}

// Control flow. Each If / Repeat is a matched pair sharing a GroupingIdentifier;
// WFControlFlowMode is 0 = start, 1 = otherwise, 2 = end.
/**
 * If <previous output> contains `substring`.
 *
 * Copied field for field from a conditional in Jackson's own working shortcut, because
 * two earlier shapes rendered as a blank condition on device:
 *
 * - `WFConditionalActionString` is a PLAIN string, not a token string. A
 *   WFTextTokenString here leaves the condition empty.
 * - No `WFInput`. Unlike Get Value for Key and friends, a conditional chains from the
 *   preceding action implicitly, and naming an input appears to break it. This is the
 *   exception to the wiring rule above — do not "fix" it by adding one.
 * - `WFCondition` is omitted entirely; it defaults to "contains" for text.
 */
function ifContains(substring) {
  const group = uuid();
  act(
    'is.workflow.actions.conditional',
    {
      GroupingIdentifier: group,
      WFCondition: 'Contains',
      WFConditionalActionString: substring,
      WFControlFlowMode: 0,
    },
    { noUUID: true },
  );
  return group;
}

const endIf = (group) =>
  act('is.workflow.actions.conditional', {
    GroupingIdentifier: group,
    WFControlFlowMode: 2,
  });

function repeatStart(count) {
  const group = uuid();
  act('is.workflow.actions.repeat.count', {
    GroupingIdentifier: group,
    WFControlFlowMode: 0,
    WFRepeatCount: count,
  });
  return group;
}

const repeatEnd = (group) =>
  act('is.workflow.actions.repeat.count', {
    GroupingIdentifier: group,
    WFControlFlowMode: 2,
  });

// ---------------------------------------------------------------------------
// The shortcut itself
// ---------------------------------------------------------------------------

const authHeaders = () => ({
  Accept: text('application/json'),
  'Content-Type': text('application/json'),
  Authorization: text('Bearer ', varRef('token')),
});

/** Body for PUT /me/player/play — the playlist plus a shuffled start offset. */
const playBody = () => ({
  context_uri: text(varRef('context_uri')),
  offset: nested({ position: number(varRef('offset')) }),
});

/**
 * One volume ramp. `fraction` is the expression, in terms of Repeat Index,
 * giving the share of V0 to be at on each step.
 */
function ramp({ label, durationVar, fractionParts }) {
  comment(label);
  const step = calculate(varRef(durationVar), ` / ${STEPS} / 1000`);
  setVariable(`${durationVar}Step`);

  const loop = repeatStart(STEPS);
  const level = calculate(...fractionParts);
  setVolume(tokenAttachment(outRef(level, 'Calculation Result')));
  wait(tokenAttachment(varRef(`${durationVar}Step`)));
  repeatEnd(loop);
  return step;
}

comment(
  'PlaylistButtons — generated by shortcut/build.mjs. Edit the generator, not this ' +
    'shortcut, or your changes will be lost on the next build.'
);

// 1. Unpack the JSON the web app handed us.
comment('Unpack input: token, context_uri, offset, shuffle, downMs, upMs');
getDictionaryFromInput();
setVariable('input');
for (const key of ['token', 'context_uri', 'offset', 'shuffle', 'downMs', 'upMs']) {
  getVariable('input');
  getValueForKey(key);
  setVariable(key);
}

// 2. Capture the volume we started at, so both ramps are relative to it.
comment('Capture starting volume as V0');
getDeviceVolume();
setVariable('V0');

// 3. Fade out, from V0 down to silence.
ramp({
  label: `Fade out over downMs, in ${STEPS} steps`,
  durationVar: 'downMs',
  fractionParts: [varRef('V0'), ` * (${STEPS} - `, varRef('Repeat Index'), `) / ${STEPS}`],
});

// 4. Shuffle, as the app asked for it (#10). Normally true, so the random offset lands
//    in a shuffled queue; false for a playlist marked "no shuffle", which also arrives with
//    `offset: 0` so it starts on track 1. The app decides; this used to be hardcoded to
//    `?state=true`.
comment('Set shuffle from the input (true normally, false for an in-order playlist)');
httpRequest({
  url: tokenString(`${API}/me/player/shuffle?state=`, varRef('shuffle')),
  method: 'PUT',
  headers: authHeaders(),
});

// 5. Start the new playlist.
comment('Start the playlist');
httpRequest({
  url: `${API}/me/player/play`,
  method: 'PUT',
  headers: authHeaders(),
  json: playBody(),
});
setVariable('playResult');

// 6. No error recovery, deliberately.
//
//    There used to be a "if the play call returned an error, find a device and retry
//    against it, otherwise restore the volume and say why" block here, built on two
//    If actions. Every shape tried for a conditional rendered with a blank condition on
//    device, across several rebuilds, and Jackson eventually pulled them out by hand to
//    get a working shortcut. So they are gone from the generator too, rather than
//    regenerating something known broken.
//
//    What that costs, should it be worth revisiting:
//      - no recovery when Spotify is not the active device. The play call just fails and
//        the music carries on unchanged.
//      - no error surfaced. A failed transition is silent; the fade dips and comes back
//        with the same playlist still playing.
//
//    Tracked separately rather than left as a comment — see the issue referenced in
//    shortcut/README.md.

// 8. Fade back in to V0. upMs of 0 makes every wait 0, so the ramp collapses to
//    an effectively instant jump back to V0 — which is what nofadein wants,
//    without needing a separate branch.
ramp({
  label: `Fade in over upMs, in ${STEPS} steps (upMs of 0 lands on V0 immediately)`,
  durationVar: 'upMs',
  fractionParts: [varRef('V0'), ' * ', varRef('Repeat Index'), ` / ${STEPS}`],
});

// 9. End on an empty result.
//
//    Without this the shortcut's result is whatever the fade-in Repeat produced — a list
//    of twelve volume numbers — and Shortcuts offers to hand that back every single run,
//    which means a prompt on every playlist change.
comment('End with no output, so Shortcuts has nothing to hand back');
act('is.workflow.actions.gettext', { WFTextActionText: '' });
stopShortcut();

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const shortcut = {
  WFWorkflowClientVersion: '1128',
  WFWorkflowClientRelease: '2.2.2',
  WFWorkflowMinimumClientVersion: 900,
  WFWorkflowIcon: {
    WFWorkflowIconGlyphNumber: 59446, // a speaker glyph
    WFWorkflowIconStartColor: 4282601983,
  },
  WFWorkflowTypes: [],
  WFWorkflowInputContentItemClasses: [
    'WFAppStoreAppContentItem',
    'WFArticleContentItem',
    'WFContactContentItem',
    'WFDateContentItem',
    'WFEmailAddressContentItem',
    'WFFolderContentItem',
    'WFGenericFileContentItem',
    'WFImageContentItem',
    'WFiTunesProductContentItem',
    'WFLocationContentItem',
    'WFDCMapsLinkContentItem',
    'WFAVAssetContentItem',
    'WFPDFContentItem',
    'WFPhoneNumberContentItem',
    'WFRichTextContentItem',
    'WFSafariWebPageContentItem',
    'WFStringContentItem',
    'WFURLContentItem',
  ],
  WFWorkflowImportQuestions: [],
  WFWorkflowActions: actions,
};

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, 'dist', 'PlaylistButtons.shortcut');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, toPlist(shortcut));

console.log(`Wrote ${out}`);
console.log(`  ${actions.length} actions, ${STEPS} steps per ramp`);
console.log('\nNext:');
console.log(
  '  npm run shortcut:sign   # signs to dist/signed/PlaylistButtons.shortcut, correctly named'
);
