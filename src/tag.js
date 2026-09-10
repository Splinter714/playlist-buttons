// Parsing and rewriting of the `[game ...]` tag that lives in a Spotify playlist
// description. Pure — no DOM, no network, no storage. This is the highest-risk logic
// in the project, so it is deliberately isolated and heavily tested.
//
// Canonical form (README):   Late night driving stuff. [game order:3 nofadein]
//
// KNOWN UNKNOWN: Spotify sometimes hands descriptions back HTML-escaped, and it is not
// yet confirmed whether square brackets survive a write/read round trip intact. So the
// matcher runs against the RAW description text and accepts escaped bracket forms
// alongside literal ones. Matching on the raw text (rather than on a decoded copy) is
// what lets a rewrite splice the tag in place and leave every other byte of the
// description untouched.

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lbrack: '[', lsqb: '[', rbrack: ']', rsqb: ']',
};

const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;

/**
 * Decode HTML entities. Runs repeatedly (bounded) so a double-escaped string like
 * `&amp;#91;` still resolves — Spotify's sanitizer has been seen to double up.
 */
export function decodeHtmlEntities(input, maxPasses = 3) {
  let out = String(input ?? '');
  for (let pass = 0; pass < maxPasses; pass++) {
    const next = out.replace(ENTITY_RE, (whole, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
        try { return String.fromCodePoint(code); } catch { return whole; }
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? whole : named;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

// Bracket delimiters, literal or escaped.
const OPEN = String.raw`(?:\[|&#0*91;|&#x0*5b;|&lbrack;|&lsqb;)`;
const CLOSE = String.raw`(?:\]|&#0*93;|&#x0*5d;|&rbrack;|&rsqb;)`;
// group 1: opening bracket, 2: the `game` keyword incl. leading space, 3: the rest of
// the tag body, 4: closing bracket.
const TAG_RE = new RegExp(`(${OPEN})(\\s*game\\b)([\\s\\S]*?)(${CLOSE})`, 'i');

const ORDER_RE = /\border\s*:\s*(\d+)\b/i;
const NOFADEIN_RE = /\bnofadein\b/i;

/**
 * Parse the `[game ...]` tag out of a description.
 *
 * @returns {{
 *   hasTag: boolean, order: number|null, nofadein: boolean,
 *   rewritable: boolean, bodyStart: number, bodyEnd: number
 * }}
 * `rewritable` is false when the tag could only be found in a decoded copy of the
 * description — in that case we know what it says but cannot safely splice it back
 * into the raw text, so writes are refused rather than risking clobbering it.
 */
export function parseTag(description) {
  const raw = String(description ?? '');
  const m = TAG_RE.exec(raw);

  if (m) {
    const body = decodeHtmlEntities(m[3]);
    const bodyStart = m.index + m[1].length + m[2].length;
    return {
      hasTag: true,
      order: readOrder(body),
      nofadein: NOFADEIN_RE.test(body),
      rewritable: true,
      bodyStart,
      bodyEnd: bodyStart + m[3].length,
    };
  }

  // Fallback: the brackets may be escaped in a form the matcher above does not know.
  // Decode everything and try again, for read-only purposes.
  const decoded = decodeHtmlEntities(raw);
  if (decoded !== raw) {
    const d = TAG_RE.exec(decoded);
    if (d) {
      const body = d[3];
      return {
        hasTag: true,
        order: readOrder(body),
        nofadein: NOFADEIN_RE.test(body),
        rewritable: false,
        bodyStart: -1,
        bodyEnd: -1,
      };
    }
  }

  return { hasTag: false, order: null, nofadein: false, rewritable: false, bodyStart: -1, bodyEnd: -1 };
}

function readOrder(body) {
  const m = ORDER_RE.exec(body);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isSafeInteger(n) ? n : null;
}

export function hasGameTag(description) {
  return parseTag(description).hasTag;
}

/**
 * Write `order:N` into the tag, returning the new description.
 *
 * Everything outside the tag body is preserved byte for byte — that is the whole point
 * of splicing rather than regenerating. If there is no tag, or the tag was only found
 * in a decoded copy, the description comes back untouched.
 */
export function setOrder(description, order) {
  const raw = String(description ?? '');
  if (!Number.isSafeInteger(order) || order < 0) return raw;

  const tag = parseTag(raw);
  if (!tag.hasTag || !tag.rewritable) return raw;

  const body = raw.slice(tag.bodyStart, tag.bodyEnd);
  const newBody = ORDER_RE.test(body)
    ? body.replace(ORDER_RE, `order:${order}`)
    : ` order:${order}${body}`;

  return raw.slice(0, tag.bodyStart) + newBody + raw.slice(tag.bodyEnd);
}
