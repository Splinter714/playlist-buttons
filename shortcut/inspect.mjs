#!/usr/bin/env node
// Read the ACTUAL shape of a working shortcut, and diff it against what build.mjs emits.
//
//   npm run shortcut:inspect -- ~/path/to/Working.shortcut
//   npm run shortcut:inspect -- ~/path/to/Working.shortcut downloadurl url
//
// This exists because every plist shape in build.mjs that was reasoned about rather than
// copied has been wrong, and each wrong one cost a rebuild-import-test cycle on a phone.
// The shapes that work were "lifted verbatim from a shortcut that works" — this is the
// tool for doing that lifting, instead of guessing and rebuilding again.
//
// Point it at a shortcut you have fixed BY HAND and it will tell you, per action type,
// which parameter keys yours carries that the generated one does not and vice versa. That
// difference is the fix, and it comes from evidence rather than from another theory.
//
// Reads binary or XML plists. Uses `plutil` where it exists (macOS) and falls back to
// python3's plistlib, so it runs the same way on a Linux CI box as on the Mac.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED = resolve(root, 'shortcut', 'dist', 'PlaylistButtons.shortcut');

function have(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A .shortcut is a plist — binary from the Shortcuts app, XML from build.mjs. Both here. */
function readPlist(path) {
  if (!existsSync(path)) {
    console.error(`No such file: ${path}`);
    process.exit(1);
  }
  if (have('plutil')) {
    return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path], {
      maxBuffer: 64 * 1024 * 1024,
    }));
  }
  if (have('python3')) {
    return JSON.parse(execFileSync('python3', [
      '-c',
      'import json,plistlib,sys;print(json.dumps(plistlib.load(open(sys.argv[1],"rb")),default=str))',
      path,
    ], { maxBuffer: 64 * 1024 * 1024 }));
  }
  console.error('Need either plutil (macOS) or python3 to read a plist.');
  process.exit(1);
}

const short = (id) => String(id).replace(/^is\.workflow\.actions\./, '');

function actionsOf(plist) {
  const list = plist?.WFWorkflowActions;
  if (!Array.isArray(list)) {
    console.error('That file has no WFWorkflowActions — is it a shortcut?');
    process.exit(1);
  }
  return list;
}

/**
 * Parameter KEYS per action identifier. Keys, not values: two shortcuts doing the same
 * thing differ in every URL and UUID, and none of that matters. A missing or extra key is
 * what makes an action import broken.
 */
function shapes(actions) {
  const byId = new Map();
  actions.forEach((a, i) => {
    const id = short(a.WFWorkflowActionIdentifier);
    const keys = Object.keys(a.WFWorkflowActionParameters ?? {}).filter((k) => k !== 'UUID');
    if (!byId.has(id)) byId.set(id, { count: 0, keys: new Map(), indexes: [] });
    const entry = byId.get(id);
    entry.count += 1;
    entry.indexes.push(i);
    for (const k of keys) entry.keys.set(k, (entry.keys.get(k) ?? 0) + 1);
  });
  return byId;
}

const [refPath, ...only] = process.argv.slice(2);
if (!refPath) {
  console.error('Usage: npm run shortcut:inspect -- <working.shortcut> [action ...]');
  console.error('  e.g. npm run shortcut:inspect -- ~/Downloads/PlaylistButtons.shortcut downloadurl url');
  process.exit(1);
}

const ref = readPlist(resolve(process.cwd(), refPath));
if (!existsSync(GENERATED)) {
  console.error(`No generated shortcut at ${GENERATED} — run \`npm run shortcut:build\` first.`);
  process.exit(1);
}
const gen = readPlist(GENERATED);

const refActions = actionsOf(ref);
const genActions = actionsOf(gen);
const refShapes = shapes(refActions);
const genShapes = shapes(genActions);

console.log(`yours     ${refPath}  — ${refActions.length} actions`);
console.log(`generated ${GENERATED}  — ${genActions.length} actions`);
console.log('');

const ids = [...new Set([...refShapes.keys(), ...genShapes.keys()])].sort();
let differences = 0;

for (const id of ids) {
  const r = refShapes.get(id);
  const g = genShapes.get(id);
  const rKeys = new Set(r ? r.keys.keys() : []);
  const gKeys = new Set(g ? g.keys.keys() : []);
  const missing = [...rKeys].filter((k) => !gKeys.has(k));
  const extra = [...gKeys].filter((k) => !rKeys.has(k));
  const same = missing.length === 0 && extra.length === 0 && Boolean(r) && Boolean(g);
  if (same) continue;
  differences += 1;

  console.log(`${id}   yours x${r?.count ?? 0}, generated x${g?.count ?? 0}`);
  if (!r) console.log('  not in yours at all — the generator emits something you removed');
  if (!g) console.log('  not generated at all — you added this by hand');
  // The actionable half: a key a working action carries and the generated one does not.
  if (missing.length) console.log(`  MISSING from generated: ${missing.join(', ')}`);
  if (extra.length) console.log(`  EXTRA in generated:     ${extra.join(', ')}`);
  console.log('');
}

if (!differences) console.log('No parameter-key differences. The shapes match.\n');

// Full dumps, for when the keys match but a value is shaped wrong inside — which is how
// an action can look right in the editor and still do nothing.
for (const id of only) {
  const key = short(id);
  console.log(`──── every "${key}" in YOURS, in full ────`);
  refActions
    .filter((a) => short(a.WFWorkflowActionIdentifier) === key)
    .forEach((a, i) => console.log(`[${i}]`, JSON.stringify(a.WFWorkflowActionParameters, null, 2)));
  console.log('');
  console.log(`──── every "${key}" in GENERATED, in full ────`);
  genActions
    .filter((a) => short(a.WFWorkflowActionIdentifier) === key)
    .forEach((a, i) => console.log(`[${i}]`, JSON.stringify(a.WFWorkflowActionParameters, null, 2)));
  console.log('');
}
