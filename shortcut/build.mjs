#!/usr/bin/env node
// Generates shortcut/dist/PlaylistButtons.shortcut — the unsigned, old-format
// shortcut plist that the web app hands off to.
//
//   npm run shortcut:build
//   shortcuts sign --mode anyone -i shortcut/dist/PlaylistButtons.shortcut \
//                                -o shortcut/dist/PlaylistButtons.signed.shortcut
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
const STEPS = 12;

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
const act = (identifier, parameters = {}) => {
  actions.push({ WFWorkflowActionIdentifier: identifier, WFWorkflowActionParameters: parameters });
};

const comment = (t) => act('is.workflow.actions.comment', { WFCommentActionText: t });

/** Get Dictionary from Input. Returns its output UUID. */
function getDictionaryFromInput() {
  const id = uuid();
  act('is.workflow.actions.detect.dictionary', { UUID: id });
  return id;
}

/** Get Value for Key. Operates on the previous action's output. */
function getValueForKey(key) {
  const id = uuid();
  act('is.workflow.actions.getvalueforkey', { UUID: id, WFDictionaryKey: key });
  return id;
}

const setVariable = (name) => act('is.workflow.actions.setvariable', { WFVariableName: name });

const getVariable = (name) =>
  act('is.workflow.actions.getvariable', { WFVariable: tokenAttachment(varRef(name)) });

/** Get Item from List — first item only, which is all we need. */
function getFirstItem() {
  const id = uuid();
  act('is.workflow.actions.getitemfromlist', { UUID: id, WFItemSpecifier: 'First Item' });
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
const urlAction = (url) =>
  act('is.workflow.actions.url', {
    UUID: uuid(),
    WFURLActionURL: typeof url === 'string' ? url : url,
  });

/**
 * Get Contents of URL. Emits the preceding URL action too, so a request is one
 * call here. Omitting WFHTTPMethod means GET; omitting WFHTTPBodyType with
 * WFJSONValues present means a JSON body — both match a known-good shortcut.
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
function ifContains(substring) {
  const group = uuid();
  act('is.workflow.actions.conditional', {
    GroupingIdentifier: group,
    WFCondition: 'Contains',
    WFConditionalActionString: tokenString(substring),
    WFControlFlowMode: 0,
  });
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
//    in a shuffled queue; false for a playlist marked "in order", which also arrives with
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

// 6. A successful play returns 204 with an empty body; any failure returns a
//    JSON body containing "error". The commonest is "no active device", so on
//    any error pick a device and retry against it explicitly. Passing
//    ?device_id= both transfers and plays, which is one call instead of a
//    separate PUT /me/player transfer.
comment('If play failed, find a device and retry against it');
getVariable('playResult');
const playFailed = ifContains('error');

httpRequest({ url: `${API}/me/player/devices`, headers: authHeaders() });
getDictionaryFromInput();
getValueForKey('devices');
getFirstItem();
getValueForKey('id');
setVariable('deviceId');

wait(real(DEVICE_TRANSFER_SETTLE_SECONDS));

httpRequest({
  url: tokenString(`${API}/me/player/play?device_id=`, varRef('deviceId')),
  method: 'PUT',
  headers: authHeaders(),
  json: playBody(),
});
setVariable('retryResult');

// 7. Still failing: put the volume back where we found it and say why.
comment('Still failing: restore volume and report');
getVariable('retryResult');
const retryFailed = ifContains('error');
setVolume(tokenAttachment(varRef('V0')));
showAlert(
  'Playlist Buttons',
  tokenString("Couldn't start playback.\n\n", varRef('retryResult'))
);
stopShortcut();
endIf(retryFailed);

endIf(playFailed);

// 8. Fade back in to V0. upMs of 0 makes every wait 0, so the ramp collapses to
//    an effectively instant jump back to V0 — which is what nofadein wants,
//    without needing a separate branch.
ramp({
  label: `Fade in over upMs, in ${STEPS} steps (upMs of 0 lands on V0 immediately)`,
  durationVar: 'upMs',
  fractionParts: [varRef('V0'), ' * ', varRef('Repeat Index'), ` / ${STEPS}`],
});

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
  `  shortcuts sign --mode anyone -i ${out} -o ${resolve(here, 'dist', 'PlaylistButtons.signed.shortcut')}`
);
