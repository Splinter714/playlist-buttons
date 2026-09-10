// The settings screen — one screen, two sections, reachable from the grid.
//
// #5, #6, #8 and now #3 all landed here rather than becoming separate screens:
//   Fade     (#5) — one duration, both directions, global. No per-playlist override.
//   Rotation (#8) — every playlist on the account, tap to add or remove. Adding appends
//                   to the end. This is the ONLY way membership changes now that #9 has
//                   removed description tags.
//   No fade  (#6) — a per-member toggle living on that playlist's row, not in a
//                   separate list and not behind a long-press.
//   No shuffle (#10) — a SECOND, independent per-member toggle beside it. Two pills, not
//                   one three-way control: a playlist can start loud, start at track 1,
//                   both or neither.
//   Order    (#3) — drag a member's handle. This moved here off the grid: the grid is a
//                   live remote, so rearranging there needed a whole mode to turn
//                   tap-to-play off, while this screen is already the one where the
//                   rotation is decided and a tap here has never played anything.
//
// THE LIST IS SORTED, and that is what makes dragging mean anything. Members come first,
// in rotation order — which IS button order — and everything else follows in whatever
// order the account returned it. A list interleaving the two could not be dragged into
// an order at all: button 3 might sit forty rows below button 4.
//
// Deliberately not here: no search box, no per-playlist fade, no export. Each of those
// was asked about and declined.
//
// Rows update and MOVE in place rather than being rebuilt. Adding renumbers everything
// after it and lifts the row into the member block, so a tap touches every row's badge
// and re-sorts the list — but re-creating the <img> elements on every tap would flicker
// the cover art of a list that can be hundreds long, so nodes are moved, never remade.

import { attachDragReorder } from './drag.js';
import { SHORTCUT_URL } from './config.js';

/** The two per-playlist flags, and what each pill says. Both name the exception. */
export const FLAG_LABELS = [
  ['nofadein', 'no fade'],
  ['inorder', 'no shuffle'],
];

/** The Shortcut section. Says what the shortcut is for before it asks anyone to go get it. */
export const SHORTCUT_HEADING = 'Shortcut';
export const SHORTCUT_NOTE =
  'The fade runs in an iOS shortcut called PlaylistButtons. Until it is installed on this '
  + 'phone under exactly that name, tapping a button does nothing.';
export const SHORTCUT_LINK_TEXT = 'Get the shortcut';

/** What the Rotation section says it does, now that order is set here too (#3). */
export const ROTATION_NOTE =
  'Tap a playlist to add it to the grid or take it off. New ones go on the end — drag the handles to reorder.';

/** The divider between the rotation and the rest of the account. */
export const REST_HEADING = 'Everything else';

/** Only members are draggable, and only by their handle — the row body is still a tap. */
const MEMBER_SELECTOR = '.pl-row.is-member';
const HANDLE_SELECTOR = '.pl-handle';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fadeLabel(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Members first, in button order; everything else after, in account order.
 *
 * Exported because it is the rule the whole screen rests on: the drag reorders DOM
 * siblings, so "in the rotation" and "in button order" have to be true of the DOM before
 * a finger touches it.
 */
export function sortForDisplay(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const members = list.filter((c) => c?.inRotation).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const rest = list.filter((c) => !c?.inRotation);
  return [...members, ...rest];
}

/** Build one row. Membership state is applied separately, by applyRow. */
function buildRow(candidate) {
  const li = el('li', 'pl-row');
  li.dataset.id = candidate.id;

  const main = el('button', 'pl-main');
  main.type = 'button';
  main.dataset.action = 'member';

  const art = el('span', 'pl-art');
  if (candidate.image) {
    const img = document.createElement('img');
    img.src = candidate.image;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => img.remove(), { once: true });
    art.append(img);
  }
  // The button number sits ON the cover art, because on the grid the cover art IS the
  // button. It used to sit in the row's flow between the name and the pills, where it
  // read as floating in the middle of nothing — and where it moved horizontally
  // depending on how wide the pills beside it happened to be.
  const badge = el('span', 'pl-badge');
  badge.setAttribute('aria-hidden', 'true');
  art.append(badge);
  main.append(art);

  const text = el('span', 'pl-text');
  text.append(el('span', 'pl-name', candidate.name ?? ''));
  const meta = el('span', 'pl-meta');
  text.append(meta);
  main.append(text);

  // The add affordance, at the row's trailing edge — the same column the handle takes
  // once the playlist is a member, so the rightmost thing on every row is whatever that
  // row's next gesture is.
  const add = el('span', 'pl-add', '+');
  add.setAttribute('aria-hidden', 'true');
  main.append(add);
  li.append(main);

  // Only shown for members, but the row's height comes from the artwork, so a row gaining
  // or losing these never changes the list's layout. Both pills are built the same way
  // and sit side by side — the flags are independent, so neither is nested under the other.
  const flags = el('span', 'pl-flags');
  for (const [action, label] of FLAG_LABELS) {
    const toggle = el('button', `pl-flag pl-flag--${action}`);
    toggle.type = 'button';
    toggle.dataset.action = action;
    toggle.textContent = label;
    flags.append(toggle);
  }
  li.append(flags);

  // The drag handle (#3). aria-hidden and not focusable: it is a pointer-only affordance,
  // and the position it changes is already spoken in the row's own label. Pretending it
  // is a button would promise a keyboard interaction that does not exist.
  const handle = el('span', 'pl-handle');
  handle.setAttribute('aria-hidden', 'true');
  li.append(handle);

  return li;
}

/** One flag pill: pressed state, the tint that goes with it, and what a tap will do. */
function applyFlag(toggle, on, label) {
  toggle.setAttribute('aria-pressed', String(on === true));
  toggle.classList.toggle('is-on', on === true);
  toggle.setAttribute('aria-label', label);
}

function applyRow(li, candidate) {
  const main = li.querySelector('.pl-main');
  const meta = li.querySelector('.pl-meta');
  const badge = li.querySelector('.pl-badge');
  const add = li.querySelector('.pl-add');
  const flags = li.querySelector('.pl-flags');
  const handle = li.querySelector('.pl-handle');

  li.classList.toggle('is-member', candidate.inRotation);
  main.setAttribute('aria-pressed', String(candidate.inRotation));
  main.setAttribute(
    'aria-label',
    candidate.inRotation
      ? `${candidate.name} — button ${candidate.position}. Tap to remove from the rotation.`
      : `${candidate.name} — tap to add to the rotation.`,
  );

  const tracks = candidate.trackTotal ?? 0;
  meta.textContent = `${tracks} track${tracks === 1 ? '' : 's'}`;
  badge.textContent = candidate.inRotation ? String(candidate.position) : '';
  badge.hidden = !candidate.inRotation;
  add.hidden = candidate.inRotation;
  handle.hidden = !candidate.inRotation;

  flags.hidden = !candidate.inRotation;
  applyFlag(
    li.querySelector('.pl-flag--nofadein'),
    candidate.nofadein,
    candidate.nofadein
      ? `${candidate.name} starts at full volume. Tap to fade it in instead.`
      : `${candidate.name} fades in. Tap to start it at full volume instead.`,
  );
  applyFlag(
    li.querySelector('.pl-flag--inorder'),
    candidate.inorder,
    candidate.inorder
      ? `${candidate.name} plays in order from track 1. Tap to shuffle it instead.`
      : `${candidate.name} shuffles from a random track. Tap to play it in order instead.`,
  );
}

/**
 * Put the existing nodes into `nodes` order with as few moves as possible.
 *
 * Nodes, never markup: a moved <li> keeps its already-decoded cover art, which is the
 * whole reason this screen updates in place instead of re-rendering.
 */
function arrange(list, nodes) {
  let cursor = list.firstChild;
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextSibling;
    else list.insertBefore(node, cursor);
  }
}

/**
 * @param {HTMLElement} root
 * @param {object} opts
 * @param {boolean} opts.loggedIn
 * @param {boolean} opts.loading      no cache yet and the first fetch is still in flight
 * @param {number}  opts.fadeMs
 * @param {number}  opts.minFadeMs
 * @param {number}  opts.maxFadeMs
 * @param {number}  opts.stepFadeMs
 * @param {string}  opts.shortcutUrl  where to go to get the PlaylistButtons shortcut
 * @param {Array}   opts.candidates   from buildCandidates()
 * @param {(id: string) => Array} opts.onToggleMember    returns the new candidate list
 * @param {(id: string) => Array} opts.onToggleNofadein  returns the new candidate list
 * @param {(id: string) => Array} opts.onToggleInorder   returns the new candidate list
 * @param {(ids: string[]) => Array} opts.onReorder      returns the new candidate list
 * @param {(active: boolean) => void} opts.onDragChange  a drag started / finished
 * @param {(ms: number) => void}  opts.onFadeChange
 * @param {() => void} opts.onLogin
 */
export function renderSettings(root, {
  loggedIn = false,
  loading = false,
  fadeMs = 3000,
  minFadeMs = 0,
  maxFadeMs = 10000,
  stepFadeMs = 250,
  shortcutUrl = SHORTCUT_URL,
  candidates = [],
  onToggleMember = () => candidates,
  onToggleNofadein = () => candidates,
  onToggleInorder = () => candidates,
  onReorder = () => candidates,
  onDragChange = () => {},
  onFadeChange = () => {},
  onLogin = () => {},
} = {}) {
  root.replaceChildren();
  const page = el('div', 'settings');

  // ---- Fade (#5) -------------------------------------------------------------------
  const fade = el('section', 'settings-section');
  const fadeHead = el('div', 'section-head');
  fadeHead.append(el('h2', null, 'Fade'));
  const fadeValue = el('span', 'fade-value', fadeLabel(fadeMs));
  fadeHead.append(fadeValue);
  fade.append(fadeHead);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'fade-slider';
  slider.min = String(minFadeMs);
  slider.max = String(maxFadeMs);
  slider.step = String(stepFadeMs);
  slider.value = String(fadeMs);
  slider.setAttribute('aria-label', 'Fade duration in seconds');
  // `input` keeps the readout live under the thumb; the write is cheap enough to do on
  // every step, and doing it there means nothing is lost if the page reloads mid-drag.
  slider.addEventListener('input', () => {
    const ms = Number(slider.value);
    fadeValue.textContent = fadeLabel(ms);
    onFadeChange(ms);
  });
  fade.append(slider);
  fade.append(el('p', 'section-note', 'Used for the fade out and the fade in, for every playlist.'));
  page.append(fade);

  // ---- Shortcut --------------------------------------------------------------------
  // Above the rotation rather than below it: the rotation is a list of every playlist on
  // the account and can run to hundreds of rows, so anything after it is unreachable in
  // practice. This is also the one thing on the screen that has to be true before any of
  // the rest of the app does anything at all.
  const shortcut = el('section', 'settings-section');
  const shortcutHead = el('div', 'section-head');
  shortcutHead.append(el('h2', null, SHORTCUT_HEADING));
  shortcut.append(shortcutHead);
  shortcut.append(el('p', 'section-note', SHORTCUT_NOTE));
  const shortcutLink = el('a', 'settings-link', SHORTCUT_LINK_TEXT);
  shortcutLink.href = shortcutUrl;
  // A new context, so a half-configured rotation is never lost to a navigation away —
  // and `noopener` because the destination is off this origin.
  shortcutLink.target = '_blank';
  shortcutLink.rel = 'noopener noreferrer';
  shortcut.append(shortcutLink);
  page.append(shortcut);

  // ---- Rotation (#8) + order (#3) + no fade (#6) + no shuffle (#10) -----------------
  const rotation = el('section', 'settings-section');
  const rotHead = el('div', 'section-head');
  rotHead.append(el('h2', null, 'Rotation'));
  const count = el('span', 'rot-count');
  rotHead.append(count);
  rotation.append(rotHead);
  rotation.append(el('p', 'section-note', ROTATION_NOTE));

  const setCount = (list) => {
    const n = list.filter((c) => c.inRotation).length;
    count.textContent = `${n} button${n === 1 ? '' : 's'}`;
  };

  if (!loggedIn) {
    const notice = el('div', 'notice');
    notice.append(el('p', null, 'Connect Spotify to see your playlists.'));
    const button = el('button', 'primary', 'Log in with Spotify');
    button.type = 'button';
    button.addEventListener('click', onLogin);
    notice.append(button);
    rotation.append(notice);
    count.textContent = '';
  } else if (!candidates.length) {
    const notice = el('div', 'notice');
    notice.append(el('p', null, loading ? 'Loading your playlists…' : 'No playlists came back from Spotify.'));
    rotation.append(notice);
    count.textContent = '';
  } else {
    const list = el('ul', 'pl-list');
    const rows = new Map();
    // Where the member block ends and the rest of the account begins. A row rather than a
    // second list, so adding a playlist is one node moving across one divider instead of
    // a hand-off between two <ul>s.
    const divider = el('li', 'pl-divider', REST_HEADING);

    const layout = (next) => {
      const ordered = sortForDisplay(next);
      const members = ordered.filter((c) => c.inRotation);
      const nodes = ordered.map((c) => rows.get(c.id)).filter(Boolean);
      nodes.splice(members.length, 0, divider);
      arrange(list, nodes);
      divider.hidden = !members.length || members.length === ordered.length;
    };

    for (const c of candidates) {
      const li = buildRow(c);
      applyRow(li, c);
      rows.set(c.id, li);
      list.append(li);
    }
    list.append(divider);
    layout(candidates);
    setCount(candidates);

    // Adding or removing renumbers the rest of the block and moves the row across the
    // divider, so a tap re-applies every row's state and re-sorts the list. Attribute,
    // text and node moves only — the artwork is never re-created.
    const refresh = (next) => {
      if (!Array.isArray(next)) return;
      for (const c of next) {
        const li = rows.get(c.id);
        if (li) applyRow(li, c);
      }
      layout(next);
      setCount(next);
    };

    list.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-action]');
      if (!button || !list.contains(button)) return;
      const id = button.closest('.pl-row')?.dataset.id;
      if (!id) return;
      const handler = { nofadein: onToggleNofadein, inorder: onToggleInorder }[button.dataset.action]
        ?? onToggleMember;
      refresh(handler(id));
    });

    // #3. Handle-only and members-only: a drag can never start on the row body, where a
    // tap already means add or remove, and can never land outside the member block.
    attachDragReorder(list, {
      selector: MEMBER_SELECTOR,
      handle: HANDLE_SELECTOR,
      onReorder: (ids) => refresh(onReorder(ids)),
      onDragChange,
    });

    rotation.append(list);
  }

  page.append(rotation);
  root.append(page);
}
