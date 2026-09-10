// The settings screen — one screen, two sections, reachable from the grid.
//
// #5, #6 and #8 all landed here rather than becoming three screens:
//   Fade     (#5) — one duration, both directions, global. No per-playlist override.
//   Rotation (#8) — every playlist on the account, tap to add or remove. Adding appends
//                   to the end. This is the ONLY way membership changes now that #9 has
//                   removed description tags.
//   Full volume (#6) — a per-member toggle living on that playlist's row, not in a
//                   separate list and not behind a long-press (which would collide with
//                   #3's drag).
//
// Deliberately not here: no search box, no per-playlist fade, no reordering, no export.
// Each of those was asked about and declined.
//
// Rows update in place rather than being rebuilt. Adding renumbers everything after it,
// so a tap has to touch every row's badge — but re-creating the <img> elements on every
// tap would flicker the cover art of a list that can be hundreds long.

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fadeLabel(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
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
  main.append(art);

  const text = el('span', 'pl-text');
  text.append(el('span', 'pl-name', candidate.name ?? ''));
  const meta = el('span', 'pl-meta');
  text.append(meta);
  main.append(text);

  // The badge is the add/remove affordance AND, once a member, the position — which is
  // how "adding appends to the end" is visible at all. Read-only: reordering is #3.
  main.append(el('span', 'pl-badge'));
  li.append(main);

  // Only rendered for members, but the row's height comes from the artwork, so a row
  // gaining or losing this never changes the list's layout.
  const toggle = el('button', 'pl-nofadein');
  toggle.type = 'button';
  toggle.dataset.action = 'nofadein';
  toggle.textContent = 'full volume';
  li.append(toggle);

  return li;
}

function applyRow(li, candidate) {
  const main = li.querySelector('.pl-main');
  const meta = li.querySelector('.pl-meta');
  const badge = li.querySelector('.pl-badge');
  const toggle = li.querySelector('.pl-nofadein');

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
  badge.textContent = candidate.inRotation ? String(candidate.position) : '+';

  toggle.hidden = !candidate.inRotation;
  toggle.setAttribute('aria-pressed', String(candidate.nofadein === true));
  toggle.classList.toggle('is-on', candidate.nofadein === true);
  toggle.setAttribute(
    'aria-label',
    candidate.nofadein
      ? `${candidate.name} starts at full volume. Tap to fade it in instead.`
      : `${candidate.name} fades in. Tap to start it at full volume instead.`,
  );
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
 * @param {Array}   opts.candidates   from buildCandidates()
 * @param {(id: string) => Array} opts.onToggleMember    returns the new candidate list
 * @param {(id: string) => Array} opts.onToggleNofadein  returns the new candidate list
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
  candidates = [],
  onToggleMember = () => candidates,
  onToggleNofadein = () => candidates,
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

  // ---- Rotation (#8) + full volume (#6) ---------------------------------------------
  const rotation = el('section', 'settings-section');
  const rotHead = el('div', 'section-head');
  rotHead.append(el('h2', null, 'Rotation'));
  const count = el('span', 'rot-count');
  rotHead.append(count);
  rotation.append(rotHead);
  rotation.append(el('p', 'section-note', 'Tap a playlist to add it to the grid or take it off. New ones go on the end.'));

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
    for (const c of candidates) {
      const li = buildRow(c);
      applyRow(li, c);
      rows.set(c.id, li);
      list.append(li);
    }
    setCount(candidates);

    // Removing renumbers everything below it, so a tap re-applies every row's state.
    // Attribute and text updates only — the artwork is never re-created.
    const refresh = (next) => {
      if (!Array.isArray(next)) return;
      for (const c of next) {
        const li = rows.get(c.id);
        if (li) applyRow(li, c);
      }
      setCount(next);
    };

    list.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-action]');
      if (!button || !list.contains(button)) return;
      const id = button.closest('.pl-row')?.dataset.id;
      if (!id) return;
      refresh(button.dataset.action === 'nofadein' ? onToggleNofadein(id) : onToggleMember(id));
    });

    rotation.append(list);
  }

  page.append(rotation);
  root.append(page);
}
