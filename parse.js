// Fast Markdown parser: renders CommonMark 0.31.2 + GFM exactly like
// marked 18.1.3 with default options, byte for byte. Dependency-free,
// stateless: every parse() call builds fresh state and keeps nothing.
//
// Design: two phases. A block phase splits the input into lines and walks
// them, emitting block HTML and recursing into containers (block quotes,
// list items). An inline phase turns each paragraph / heading / table cell
// text into HTML with a single left-to-right scan plus a delimiter stack
// for emphasis. Output is accumulated as string pieces and joined once.

const PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const ASCII_PUNCT = new Set();
for (let i = 0; i < PUNCT.length; i++) ASCII_PUNCT.add(PUNCT[i]);

function isPunct(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_PUNCT.has(ch);
  // marked's punctuation class is P (punctuation) or S (symbol)
  return /[\p{P}\p{S}]/u.test(ch);
}
function isAlnum(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  return /[\p{L}\p{N}]/u.test(ch);
}
function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '\u00a0' || ch === '\u1680' || (ch >= '\u2000' && ch <= '\u200a') || ch === '\u2028' || ch === '\u2029' || ch === '\u202f' || ch === '\u205f' || ch === '\u3000' || ch === '\ufeff';
}

// Escape text for HTML output, keeping valid entities intact:
// & is escaped only when it does not start a valid entity reference
// (&name; &amp;#123; &#x1F; with marked's digit limits). < > " '
// are always escaped.
function escNoEncode(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      // & followed by a valid entity? keep it
      const rest = s.slice(i + 1);
      if (/^(?:#\d{1,7};|#[Xx][0-9A-Fa-f]{1,6};|[A-Za-z0-9_]+;)/.test(rest)) continue;
      if (i > start) out += s.slice(start, i);
      out += '&amp;';
      start = i + 1;
    } else if (c === 60 || c === 62 || c === 34 || c === 39) {
      if (i > start) out += s.slice(start, i);
      out += c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
      start = i + 1;
    }
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

// Escape text for HTML output: & < > " ' (all & escaped)
function escText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

// Escape an attribute value (same set as text for our purposes).
function escAttr(s) {
  return escText(s);
}

// marked's URL cleaning: encodeURI, keeping % intact.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

// Decode a numeric character reference body like "#35" or "#x3c".
// Returns the rendered (escaped) string, or null when invalid.
function decodeNumeric(body) {
  let cp;
  if (body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88) {
    if (body.length < 3) return null;
    cp = parseInt(body.slice(2), 16);
    if (Number.isNaN(cp)) return null;
  } else {
    if (body.length < 2) return null;
    cp = parseInt(body.slice(1), 10);
    if (Number.isNaN(cp)) return null;
  }
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
  let ch;
  try {
    ch = String.fromCodePoint(cp);
  } catch (e) {
    return '\uFFFD';
  }
  return escText(ch);
}

// Try to read an HTML entity at text[pos] ('&'). On success returns
// [rendered, nextPos]; named entities pass through verbatim, numeric
// ones are decoded. Returns null when there is no entity here.
function readEntity(text, pos) {
  let i = pos + 1;
  if (i >= text.length) return null;
  const c = text[i];
  if (c === '#') {
    let j = i + 1;
    if (text[j] === 'x' || text[j] === 'X') {
      j++;
      const start = j;
      while (j < text.length && /[0-9a-fA-F]/.test(text[j])) j++;
      if (j === start || j - start > 6 || j >= text.length || text[j] !== ';') return null;
      const dec = decodeNumeric(text.slice(i, j));
      if (dec === null) return null;
      return [dec, j + 1];
    }
    const start = j;
    while (j < text.length && text[j] >= '0' && text[j] <= '9') j++;
    if (j === start || j - start > 7 || j >= text.length || text[j] !== ';') return null;
    const dec = decodeNumeric(text.slice(i, j));
    if (dec === null) return null;
    return [dec, j + 1];
  }
  if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_') {
    let j = i;
    while (j < text.length && /[a-zA-Z0-9_]/.test(text[j])) j++;
    if (j < text.length && text[j] === ';') {
      return [text.slice(pos, j + 1), j + 1];
    }
  }
  return null;
}

// Visual column width of leading whitespace, and the index just past it.
// Tabs advance to the next multiple of 4.
function leadInfo(s) {
  let col = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return { col, pos: i };
}

// Remove n visual columns from the start of s, where s starts at
// absolute column `base`. A tab that is only partly consumed is
// replaced by the remaining spaces.
function stripCols(s, n, base) {
  base = base || 0;
  let col = 0;
  let i = 0;
  let extra = '';
  while (i < s.length && col < n) {
    const ch = s[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') {
      const w = 4 - ((base + col) % 4);
      if (col + w <= n) { col += w; i++; }
      else { extra = ' '.repeat(col + w - n); col = n; i++; }
    } else break;
  }
  return extra + s.slice(i);
}

// Expand the leading whitespace run of s to spaces, where s starts
// at absolute column `base`. Returns [expanded, wsCharLen]: the
// expanded whitespace string and how many characters of s it covers.
function expandLeadingWs(s, base) {
  let col = 0;
  let i = 0;
  let out = '';
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
    if (s[i] === ' ') { out += ' '; col++; i++; }
    else {
      const w = 4 - ((base + col) % 4);
      out += ' '.repeat(w);
      col += w;
      i++;
    }
  }
  return [out, i];
}

function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

// Normalize a link label: collapse whitespace runs to one space,
// trim, and case-fold.
function normalizeLabel(label) {
  // marked's F: trim, collapse whitespace, then the
  // lower-upper-lower chain (folds ẞ to ss, matching SS)
  return label.replace(/\s+/g, ' ').trim().toLowerCase().toUpperCase().toLowerCase();
}

// ---------------- inline parsing ----------------
// Node kinds: 0 text (already escaped), 1 emphasis delimiter,
// 2 code span (escaped), 3 hard break, 4 raw html, 5 link,
// 6 image, 7 em/strong/del wrapper.

function textNode(s) { return { t: 0, s }; }

function pushText(out, s) {
  if (s === '') return;
  const last = out[out.length - 1];
  if (last && last.t === 0) last.s += s;
  else out.push(textNode(s));
}

// Process backslash escapes and entities in a raw fragment (link
// destinations and titles), then HTML-escape it.
function processEscapesAndEntities(raw) {
  let out = '';
  let start = 0;
  let i = 0;
  const flush = (to) => { if (to > start) out += escText(raw.slice(start, to)); };
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length && ASCII_PUNCT.has(raw[i + 1])) {
      flush(i);
      out += escText(raw[i + 1]);
      i += 2;
      start = i;
    } else if (ch === '&') {
      const ent = readEntity(raw, i);
      if (ent) {
        flush(i);
        out += ent[0];
        i = ent[1];
        start = i;
      } else {
        i++;
      }
    } else i++;
  }
  flush(raw.length);
  return out;
}

// Find a code span starting at text[i] (a run of n backticks).
// Returns [escapedContent, nextPos] or null when there is no closer.
function scanCodeSpan(text, i, n) {
  let j = i + n;
  while (j < text.length) {
    if (text[j] === '`') {
      let k = j;
      while (k < text.length && text[k] === '`') k++;
      if (k - j === n) {
        let content = text.slice(i + n, j);
        content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        return [content, k];
      }
      j = k;
    } else j++;
  }
  return null;
}

// Try to match an inline HTML tag at text[i] ('<'). Returns
// [rawTag, nextPos] or null.
function parseHtmlTag(text, i) {
  const s = text;
  const n = s.length;
  if (s.startsWith('<!--', i)) {
    // <!--> and <!---> are complete comments on their own
    if (s[i + 4] === '>') return [s.slice(i, i + 5), i + 5];
    if (s[i + 4] === '-' && s[i + 5] === '>') return [s.slice(i, i + 6), i + 6];
    const end = s.indexOf('-->', i + 4);
    if (end === -1) return null;
    return [s.slice(i, end + 3), end + 3];
  }
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    if (end === -1) return null;
    return [s.slice(i, end + 2), end + 2];
  }
  if (s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    if (end === -1) return null;
    return [s.slice(i, end + 3), end + 3];
  }
  if (s.startsWith('<!', i)) {
    const c = s[i + 2];
    if (c && ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'))) {
      const end = s.indexOf('>', i + 2);
      if (end === -1) return null;
      return [s.slice(i, end + 1), end + 1];
    }
    return null;
  }
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (j >= n || !/[A-Za-z]/.test(s[j])) return null;
  while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++;
  if (closing) {
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (j < n && s[j] === '>') return [s.slice(i, j + 1), j + 1];
    return null;
  }
  // open tag: attributes (each must be preceded by whitespace)
  while (true) {
    let ws = 0;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j++; ws++; }
    if (j >= n) return null;
    if (s[j] === '>') return [s.slice(i, j + 1), j + 1];
    if (s[j] === '/' && s[j + 1] === '>') return [s.slice(i, j + 2), j + 2];
    if (s[j] === '/') return null;
    if (ws === 0) return null;
    // attribute name
    if (!/[A-Za-z_:]/.test(s[j])) return null;
    while (j < n && /[A-Za-z0-9_.:-]/.test(s[j])) j++;
    // whitespace before '=' belongs to this attribute, but
    // whitespace before the next attribute must be left for it
    const saveJ = j;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (j < n && s[j] === '=') {
      j++;
      while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
      if (j >= n) return null;
      const q = s[j];
      if (q === '"' || q === "'") {
        j++;
        while (j < n && s[j] !== q) j++;
        if (j >= n) return null;
        j++;
      } else {
        if (s[j] === '>' || s[j] === '"' || s[j] === "'" || s[j] === '=' || s[j] === '<' || s[j] === '`') return null;
        while (j < n && !/[ \t\n"'=<>`]/.test(s[j])) j++;
      }
    } else {
      j = saveJ;
    }
  }
}

// Try an autolink <...> at text[i]. Returns [href, text, nextPos] or null.
function parseAutolink(text, i) {
  const s = text;
  let j = i + 1;
  // scheme: [A-Za-z][A-Za-z0-9+.-]{1,31}:
  if (/[A-Za-z]/.test(s[j] || '')) {
    let k = j;
    while (k < s.length && /[A-Za-z0-9+.-]/.test(s[k])) k++;
    if (k - j >= 2 && k - j <= 32 && s[k] === ':') {
      let m = k + 1;
      while (m < s.length && s[m] !== '>' && s[m] !== ' ' && s[m] !== '\t' && s[m] !== '\n' && s[m] !== '<' && s[m].charCodeAt(0) >= 32) m++;
      if (m < s.length && s[m] === '>') {
        const url = s.slice(i + 1, m);
        return [url, url, m + 1];
      }
    }
  }
  // email: scan to '>' (or a delimiter), then validate the address
  let m = i + 1;
  while (m < s.length && s[m] !== '>' && s[m] !== ' ' && s[m] !== '\t' && s[m] !== '\n' && s[m] !== '<' && s[m].charCodeAt(0) >= 32) m++;
  if (m < s.length && s[m] === '>') {
    const addr = s.slice(i + 1, m);
    if (/^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(addr)) {
      return ['mailto:' + addr, addr, m + 1];
    }
  }
  return null;
}

// Parse a link destination starting at text[i] (after '(' and skipped
// whitespace). Returns [rawDest, nextPos] or null.
function parseLinkDest(text, i) {
  const s = text;
  if (s[i] === '<') {
    let j = i + 1;
    let dest = '';
    while (j < s.length && s[j] !== '>') {
      const ch = s[j];
      if (ch === '\n') return null;
      if (ch === '<') return null;
      if (ch === '\\' && j + 1 < s.length && ASCII_PUNCT.has(s[j + 1])) { dest += s[j + 1]; j += 2; continue; }
      if (ch.charCodeAt(0) < 32) return null;
      dest += ch;
      j++;
    }
    if (j >= s.length) return null;
    return [dest, j + 1, 'angle'];
  }
  let j = i;
  let depth = 0;
  let dest = '';
  while (j < s.length) {
    const ch = s[j];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch.charCodeAt(0) < 32) break;
    if (ch === '\\' && j + 1 < s.length && ASCII_PUNCT.has(s[j + 1])) { dest += s[j + 1]; j += 2; continue; }
    if (ch === '(') { depth++; dest += ch; j++; continue; }
    if (ch === ')') {
      if (depth === 0) break;
      depth--; dest += ch; j++; continue;
    }
    dest += ch;
    j++;
  }
  // an empty destination is allowed (only when ')' follows)
  // the 4th element is the number of unclosed '(' in the raw
  // destination (marked's ke check runs on the raw text, so
  // escaped parens do not count)
  return [dest, j, 'bare', depth];
}

// Parse a link title starting at text[i] (after skipped whitespace).
// Returns [rawTitle, nextPos] or null.
function parseLinkTitle(text, i, defTitle) {
  const s = text;
  const q = s[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    let title = '';
    while (j < s.length && s[j] !== q) {
      if (s[j] === '\\' && j + 1 < s.length && ASCII_PUNCT.has(s[j + 1])) { title += s[j + 1]; j += 2; continue; }
      // in a definition, a single-quoted title may not contain a
      // blank line (a newline must not be followed by one)
      if (defTitle && q === "'" && s[j] === '\n' && s[j + 1] === '\n') return null;
      title += s[j];
      j++;
    }
    if (j >= s.length) return null;
    return [title, j + 1];
  }
  if (q === '(') {
    let j = i + 1;
    let title = '';
    while (j < s.length && s[j] !== ')') {
      if (s[j] === '(') return null;
      if (s[j] === '\\' && j + 1 < s.length && ASCII_PUNCT.has(s[j + 1])) { title += s[j + 1]; j += 2; continue; }
      title += s[j];
      j++;
    }
    if (j >= s.length) return null;
    return [title, j + 1];
  }
  return null;
}

function skipWs(text, i) {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n')) i++;
  return i;
}

// Scan a bracketed label starting at text[i] ('['). Returns
// [label, nextPos] where nextPos is just past the matching ']',
// or null when the brackets do not balance.
function scanLabel(text, i) {
  const s = text;
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\' && j + 1 < s.length && ASCII_PUNCT.has(s[j + 1])) { j += 2; continue; }
    if (ch === '`') {
      let k = j;
      while (k < s.length && s[k] === '`') k++;
      // marked's label regex only allows a backtick run inside a
      // code span (any closer length, closing before the label's
      // bracket) or a run of 2+ backticks immediately before the
      // closing bracket; a lone backtick makes the label invalid
      let m = k;
      let closeEnd = -1;
      while (m < s.length) {
        if (s[m] === ']') break;
        if (s[m] === '`') {
          let e = m;
          while (e < s.length && s[e] === '`') e++;
          closeEnd = e;
          break;
        }
        if (s[m] === '\\' && m + 1 < s.length) { m += 2; continue; }
        m++;
      }
      if (closeEnd !== -1) { j = closeEnd; continue; }
      if (k - j >= 2 && s[k] === ']') { j = k; continue; }
      return null;
    }
    if (ch === '[') {
      // at most two nested pairs in a label: the label's own
      // brackets, one nested pair, and one pair inside that
      depth++;
      if (depth > 3) return null;
      j++;
      continue;
    }
    if (ch === ']') {
      depth--;
      if (depth === 0) return [s.slice(i + 1, j), j + 1];
      j++;
      continue;
    }
    j++;
  }
  return null;
}

// Simulate marked's backpedal on a URL candidate: the longest
// prefix that consists of runs of non-punctuation, parenthesized
// groups, & not starting an entity at the end, and punctuation
// runs that do not reach the end. Returns the kept length.
function backpedalMatch(s) {
  let i = 0;
  const punct = '?!.,:;*_\'"~)';
  const nonPunct = (ch) => !punct.includes(ch) && ch !== '(' && ch !== '&';
  while (i < s.length) {
    let j = i;
    while (j < s.length && nonPunct(s[j])) j++;
    if (j > i) { i = j; continue; }
    if (s[i] === '(') {
      const close = s.indexOf(')', i);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (s[i] === '&') {
      if (/^&[A-Za-z0-9_]+;$/.test(s.slice(i))) break;
      i++;
      continue;
    }
    if (punct.includes(s[i])) {
      let k = i;
      while (k < s.length && punct.includes(s[k])) k++;
      if (k === s.length) {
        if (k - 1 > i) { i = k - 1; continue; }
        break;
      }
      i = k;
      continue;
    }
    break;
  }
  return i;
}

// Trim an extended-autolink candidate's end the way marked does:
// apply the backpedal repeatedly until it stops changing.
function trimAutolinkEnd(text, start, end) {
  let cur = end;
  for (;;) {
    const next = backpedalMatch(text.slice(start, cur)) + start;
    if (next === cur) return cur;
    cur = next;
  }
}

function isEmailLocal(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '.' || ch === '_' || ch === '+' || ch === '-';
}
function isDomainChar(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '-' || ch === '_';
}

// Does text start with http://, https:// or ftp:// at i
// (case-insensitive)? Raw char comparisons, no toLowerCase.
function startsProtocol(s, i) {
  const a = s[i];
  if (a === 'h' || a === 'H') {
    const b = s[i + 1];
    if (b !== 't' && b !== 'T') return false;
    const c = s[i + 2];
    if (c !== 't' && c !== 'T') return false;
    const d = s[i + 3];
    if (d !== 'p' && d !== 'P') return false;
    if (s[i + 4] === ':' && s[i + 5] === '/' && s[i + 6] === '/') return true;
    if ((s[i + 4] === 's' || s[i + 4] === 'S') && s[i + 5] === ':' && s[i + 6] === '/' && s[i + 7] === '/') return true;
    return false;
  }
  if (a === 'f' || a === 'F') {
    if (s[i + 1] !== 't' && s[i + 1] !== 'T') return false;
    if (s[i + 2] !== 'p' && s[i + 2] !== 'P') return false;
    return s[i + 3] === ':' && s[i + 4] === '/' && s[i + 5] === '/';
  }
  return false;
}

// ASCII email-local chars [A-Za-z0-9._+-] as a charCode table, for
// the inline fast path (avoids a function call per character).
const EMAIL_LOCAL_T = new Uint8Array(128);
for (const c of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-') EMAIL_LOCAL_T[c.charCodeAt(0)] = 1;

// Try an extended autolink starting at text[i]. Returns
// [href, display, nextPos] or null. The caller decides which
// starts are eligible (protocols anywhere, www. after a boundary,
// mailto:/xmpp: after a non-alphanumeric, emails at a local-part
// start); this function only validates the match itself.
function tryExtendedAutolink(text, i, inUndEm) {
  const s = text;
  const n = s.length;
  // mailto: / xmpp: + email
  for (const proto of ['mailto:', 'xmpp:']) {
    if (s.startsWith(proto, i)) {
      const em = matchEmailAt(s, i + proto.length, inUndEm);
      if (em === -1) return null;
      let end = em;
      if (proto === 'xmpp:' && s[end] === '/') {
        let k = end + 1;
        while (k < n && /[A-Za-z0-9@.]/.test(s[k])) k++;
        if (k > end + 1) end = k;
      }
      const disp = s.slice(i, end);
      return [disp, disp, end];
    }
  }
  // protocol:// or www.
  let scheme = null;
  let after = 0;
  if (s.startsWith('www.', i)) { scheme = 'http://'; after = i + 4; }
  else if (startsProtocol(s, i)) {
    scheme = '';
    const la = s[i].toLowerCase();
    if (la === 'f') after = i + 6;
    else if (s[i + 4] === 's' || s[i + 4] === 'S') after = i + 8;
    else after = i + 7;
  }
  if (scheme !== null) {
    if (after >= n || !isDomainChar(s[after])) return null;
    let j = after;
    while (j < n && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '<') j++;
    const end = trimAutolinkEnd(s, i, j);
    if (end <= after) return null;
    const disp = s.slice(i, end);
    return [scheme + disp, disp, end];
  }
  // bare email
  const em = matchEmailAt(s, i, inUndEm);
  if (em !== -1) {
    const disp = s.slice(i, em);
    return ['mailto:' + disp, disp, em];
  }
  return null;
}

// Match marked's url-email pattern at s[i]. Returns the end index
// or -1. Local part [A-Za-z0-9._+-]+, @, domain labels with at
// least one dot, and the next char must not be a word char or '-'.
function matchEmailAt(s, i, inUndEm) {
  const n = s.length;
  let j = i;
  while (j < n && isEmailLocal(s[j])) j++;
  if (j === i || j >= n || s[j] !== '@') return -1;
  j++;
  // first label: [A-Za-z0-9-_]+
  if (j >= n || !isDomainChar(s[j])) return -1;
  while (j < n && isDomainChar(s[j])) j++;
  let labels = 0;
  while (j < n && s[j] === '.') {
    let k = j + 1;
    while (k < n && isDomainChar(s[k])) k++;
    // a dot-group label is [A-Za-z0-9-_]*[A-Za-z0-9]: it must end
    // on an alphanumeric, so trim any trailing _ or -
    while (k > j + 1 && !isAlnum(s[k - 1])) k--;
    if (k === j + 1) {
      // a dot not followed by a label: the email ends here, but
      // only when at least one dot-group already matched
      if (labels < 1) return -1;
      break;
    }
    labels++;
    j = k;
  }
  if (labels < 1) return -1;
  if (j < n) {
    const c = s[j];
    // a trailing _ blocks the email, unless it is an emphasis
    // closer for an unmatched _ opener (marked tokenizes the
    // emphasis first, so the email inside it never sees the _)
    if (c === '_' && inUndEm) return j;
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '-') return -1;
  }
  return j;
}

// Try to parse a link or image starting at text[i] ('[' or '![').
// Returns {node, nextPos} or null when it is not a link.
// Process a link destination the way marked does: backslash
// escapes and numeric character references are decoded, named
// entities pass through, a bare & becomes &amp;. Unlike
// processEscapesAndEntities, < > " ' are NOT escaped here -
// encodeURI in cleanUrl percent-encodes them.
function processDest(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && ASCII_PUNCT.has(s[i + 1])) { out += s[i + 1]; i += 2; continue; }
    if (ch === '&') {
      const ent = readEntity(s, i);
      if (ent) { out += ent[0]; i = ent[1]; continue; }
      out += '&amp;';
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// Balanced-paren scan of a bare link destination (marked's ke):
// returns -2 when a '(' is left unclosed, the index of an
// unmatched ')' when one occurs, -1 otherwise.
function parenBalance(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// Skip spaces/tabs and at most one newline (the whitespace allowed
// between a link destination and its title).
function skipWsOneNL(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  if (s[i] === '\n') {
    i++;
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  }
  return i;
}

// Does the label contain a '<' that starts an HTML tag or autolink
// whose match runs past the label's closing ']'? (marked's Be.)
// labelStart is the index of the first label char in text,
// labelEnd the index of the closing ']'.
function labelHasUnclosedTag(text, labelStart, labelEnd) {
  const s = text;
  let p = labelStart;
  while (p < labelEnd) {
    const ch = s[p];
    if (ch === '\\' && p + 1 < labelEnd) { p += 2; continue; }
    if (ch === '`') {
      let k = p;
      while (k < s.length && s[k] === '`') k++;
      const cs = scanCodeSpan(s, p, k - p);
      if (cs) { p = cs[1]; continue; }
      p = k;
      continue;
    }
    if (ch === '<') {
      const tag = parseHtmlTag(s, p);
      if (tag && p + tag[0].length > labelEnd) return true;
      const al = parseAutolink(s, p);
      if (al && al[2] > labelEnd) return true;
      p++;
      continue;
    }
    p++;
  }
  return false;
}

// Does a node tree contain a non-autolink link node anywhere?
function hasLinkNode(nodes) {
  for (const node of nodes) {
    if (node.t === 5 && !node.auto) return true;
    if ((node.t === 5 || node.t === 6 || node.t === 7) && node.kids && hasLinkNode(node.kids)) return true;
  }
  return false;
}

function tryLink(text, i, refs, inLink, inRaw) {
  const s = text;
  let isImage = false;
  let p = i;
  if (s[p] === '!') {
    if (s[p + 1] !== '[') return null;
    isImage = true;
    p++;
  }
  // Note: links inside a link label ARE parsed (marked's De
  // discards the outer link when one is found - see hasLinkNode
  // below); only extended autolinks are suppressed in labels.
  const lab = scanLabel(s, p);
  if (!lab) return null;
  const labelText = lab[0];
  const labelEnd = lab[1] - 1;
  if (labelHasUnclosedTag(s, p + 1, labelEnd)) return null;
  let after = lab[1];
  let dest = null;
  let title = null;
  let inlineOk = false;
  if (s[after] === '(') {
    // inline link; when it fails, fall back to the shortcut
    // reference link (marked tries link, then reflink)
    let q = skipWs(s, after + 1);
    const d = parseLinkDest(s, q);
    if (d && !(d[2] === 'bare' && d[3] > 0)) {
      dest = d[0];
      q = skipWsOneNL(s, d[1]);
      let titleOk = true;
      if (q !== d[1] && (s[q] === '"' || s[q] === "'" || s[q] === '(')) {
        const t = parseLinkTitle(s, q);
        if (!t) titleOk = false;
        else {
          title = t[0];
          q = skipWs(s, t[1]);
        }
      }
      if (titleOk && s[q] === ')') {
        after = q + 1;
        inlineOk = true;
      }
    }
  }
  if (!inlineOk) {
    // reference / collapsed / shortcut link
    dest = null;
    title = null;
    let refLabel = null;
    if (s[after] === '[') {
      const lab2 = scanRefLabel(s, after);
      if (lab2) {
        refLabel = lab2[0] === '' ? labelText : lab2[0];
        after = lab2[1];
      }
    }
    if (refLabel === null) refLabel = labelText;
    const ref = refs.get(normalizeLabel(refLabel));
    if (!ref) return null;
    dest = ref.dest;
    title = ref.title;
  }
  const href = cleanUrl(processDest(dest));
  if (href === null) return null;
  const titleEsc = title === null || title === undefined ? null : processEscapesAndEntities(title);
  if (isImage) {
    const altKids = scanInline(labelText, refs, true, inRaw)[0];
    const alt = renderPlain(altKids);
    return { node: { t: 6, src: href, title: titleEsc, alt, kids: altKids }, nextPos: after };
  }
  const kids = scanInline(labelText, refs, true, inRaw)[0];
  // a link whose label contains a link is discarded (the inner
  // link wins)
  if (hasLinkNode(kids)) return null;
  return { node: { t: 5, href, title: titleEsc, kids }, nextPos: after };
}

// Scan a reference label [..] at text[i]: no nested brackets are
// allowed (marked's le). Returns [label, nextPos] or null.
function scanRefLabel(text, i) {
  const s = text;
  let j = i + 1;
  let start = j;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\' && j + 1 < s.length) { j += 2; continue; }
    if (ch === '[') return null;
    if (ch === ']') return [s.slice(start, j), j + 1];
    if (ch === '\n') {
      let k = j + 1;
      while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
      if (k >= s.length || s[k] === '\n') return null;
    }
    j++;
  }
  return null;
}

// Render inline nodes the way marked's textRenderer does for image
// alt text: plain text (already escaped) and code content as-is,
// HTML tags escaped, links/em/del recurse into their children,
// images recurse into their label, line breaks drop out.
function renderPlain(nodes) {
  resolveEmphasis(nodes);
  const parts = [];
  renderPlainInto(nodes, parts);
  return parts.join('');
}
function renderPlainInto(nodes, parts) {
  for (const node of nodes) {
    switch (node.t) {
      case 0:
        parts.push(node.s);
        break;
      case 1:
        parts.push(escText(node.ch.repeat(node.n)));
        break;
      case 2:
        parts.push(escNoEncode(node.s));
        break;
      case 3:
        break;
      case 4:
        parts.push(escText(node.s));
        break;
      case 5:
        renderPlainInto(node.kids, parts);
        break;
      case 6:
        renderPlainInto(node.kids, parts);
        break;
      case 7:
        renderPlainInto(node.kids, parts);
        break;
    }
  }
}

function isLocalChar(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '.' || ch === '!' || ch === '#' || ch === '$' || ch === '%' || ch === '&' || ch === "'" || ch === '*' || ch === '+' || ch === '/' || ch === '=' || ch === '?' || ch === '^' || ch === '_' || ch === '`' || ch === '{' || ch === '|' || ch === '}' || ch === '~' || ch === '-';
}
function isAutolinkBoundary(ch) {
  return ch === '' || isWhitespace(ch) || ch === '*' || ch === '_' || ch === '~' || ch === '(';
}

// The main inline scan. Returns a node list; emphasis delimiters
// are left unresolved for resolveEmphasis(). inLink starts true
// when scanning a link label (extended autolinks are suppressed
// there); inRaw0 is the raw-block state inherited from the caller
// (inside <pre>/<code>/<kbd>/<script> text is not escaped).
// ---------------- delimiter masking (marked's #n pipeline) ----------------
// marked searches for emphasis/del closers in a MASKED copy of the
// inline source: reflink labels, code spans, inline links and HTML
// tags are replaced by same-length filler, so a delimiter inside
// one of them cannot close emphasis. A mismatched backtick run can
// make the mask swallow a fake code span (e.g. the `` `` `` in a
// link label pairing with a later `` `` ``), hiding real delimiters
// between them. The three regexes below are marked 18.1.3's own
// (gfm rules: reflinkSearch, anyPunctuationOutsideCode, blockSkip,
// link), applied in its order, so delimiter visibility matches
// marked exactly. All replacements preserve length, so positions
// in the masked string line up with the original.
const MASK_REFLINK_SEARCH = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const MASK_ANY_PUNCT = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_BLOCK_SKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const MASK_LINK = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;

// marked's linkInText: does e contain an inline link or a known
// reflink (used when a reflink's label itself holds a link)?
function linkInTextMask(e, refs) {
  if (!e.includes('[')) return false;
  for (const n of e.matchAll(MASK_BLOCK_SKIP)) {
    if (MASK_LINK.test(n[0]) && e.charAt(n.index - 1) !== '!') return true;
  }
  for (const n of e.matchAll(MASK_REFLINK_SEARCH)) {
    const s = n[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !refs.has(normalizeLabel(s.slice(r + 1, -1)))) && !(r > 1 && linkInTextMask(s.slice(1, r - 1), refs))) return true;
  }
  return false;
}

// marked's #n: mask reflink labels, then escaped punctuation and
// code-span contents, then links/code spans/HTML tags.
function maskInline(text, refs) {
  let t = text;
  if (refs.size > 0 && text.includes('[')) {
    const rs = MASK_REFLINK_SEARCH;
    const repl = (r) => {
      const o = r.lastIndexOf('[');
      if (!refs.has(normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const i = r.slice(1, o - 1);
        if (linkInTextMask(i, refs)) return '[' + i.replace(rs, repl) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(rs, repl);
  }
  // anyPunctuationOutsideCode can only match a backtick run or a
  // backslash escape; blockSkip only a link, a code span or a tag
  // (the passes above only remove such characters, never add them,
  // so testing the original text is exact)
  if (text.includes('`') || text.includes('\\')) {
    t = t.replace(MASK_ANY_PUNCT, (n, s, r) => r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  }
  if (text.includes('[') || text.includes('`') || text.includes('<')) {
    t = t.replace(MASK_BLOCK_SKIP, (n, s, r) => { const o = r ? r.length : 0; return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']'; });
  }
  return t;
}

function scanInline(text, refs, inLink, inRaw0) {
  const out = [];
  const n = text.length;
  let i = 0;
  let runStart = -1;
  let inRaw = !!inRaw0;
  // unmatched _ openers seen so far in this scan: an email inside
  // _ emphasis is not blocked by its trailing _ closer
  let openUnd = 0;
  // masked copy for delimiter visibility (marked's #n pipeline),
  // computed lazily on the first delimiter; only when a maskable
  // construct (backtick, '[', '<') exists can a delimiter be hidden
  let masked = null;
  let maskChecked = false;
  const ensureMask = () => {
    if (!maskChecked) {
      maskChecked = true;
      if (text.includes('`') || text.includes('[') || text.includes('<')) masked = maskInline(text, refs);
    }
    return masked;
  };
  // true when every char of the run [a, b) is visible in the masked
  // source (a delimiter run never straddles a mask boundary)
  const runVisible = (a, b) => {
    const m = ensureMask();
    if (m === null) return true;
    for (let j = a; j < b; j++) if (m[j] !== text[j]) return false;
    return true;
  };
  const flushRun = (to) => {
    if (runStart >= 0 && to > runStart) {
      pushText(out, inRaw ? text.slice(runStart, to) : escText(text.slice(runStart, to)));
      runStart = -1;
    }
  };
  while (i < n) {
    const ch = text[i];
    // fast path: plain text runs
    if (ch !== '`' && ch !== '\\' && (ch !== '&' || inRaw) && ch !== '<' && ch !== '[' && ch !== '!' && ch !== '*' && ch !== '_' && ch !== '~' && ch !== '\n') {
      // extended autolinks: protocols anywhere, www. after a
      // boundary, mailto:/xmpp: after a non-alphanumeric, emails at
      // a local-part start (suppressed inside link labels)
      let ext = null;
      if (!inLink) {
        const code = text.charCodeAt(i);
        if ((code === 104 || code === 72 || code === 102 || code === 70) && startsProtocol(text, i)) {
          ext = tryExtendedAutolink(text, i, openUnd > 0);
        } else if (code === 119 && text.charCodeAt(i + 1) === 119 && text.startsWith('www.', i) && (i === 0 || isAutolinkBoundary(text[i - 1]))) {
          ext = tryExtendedAutolink(text, i, openUnd > 0);
        } else if ((code === 109 && text.charCodeAt(i + 1) === 97 && text.startsWith('mailto:', i)) || (code === 120 && text.charCodeAt(i + 1) === 109 && text.startsWith('xmpp:', i))) {
          if (i === 0 || !isAlnum(text[i - 1])) ext = tryExtendedAutolink(text, i, openUnd > 0);
        } else if (code < 128 && EMAIL_LOCAL_T[code] === 1 && (i === 0 || !(text.charCodeAt(i - 1) < 128 && EMAIL_LOCAL_T[text.charCodeAt(i - 1)] === 1) || (text[i - 1] === '_' && openUnd > 0))) {
          ext = tryExtendedAutolink(text, i, openUnd > 0);
        }
      }
      if (ext) {
        flushRun(i);
        const href = cleanUrl(ext[0]);
        if (href !== null) {
          out.push({ t: 5, href, title: null, auto: true, kids: [textNode(escText(ext[1]))] });
          i = ext[2];
          continue;
        }
      }
      if (runStart < 0) runStart = i;
      i++;
      continue;
    }
    flushRun(i);
    if (ch === '\n') {
      // hard break when the preceding text ends with 2+ spaces;
      // the break consumes the newline and any following spaces
      // or tabs, and only applies when non-whitespace follows
      const last = out[out.length - 1];
      if (last && last.t === 0) {
        const m = / {2,}$/.exec(last.s);
        if (m) {
          let k = i + 1;
          while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
          if (k < n) {
            last.s = last.s.slice(0, last.s.length - m[0].length);
            if (last.s === '') out.pop();
            out.push({ t: 3 });
            i++;
            while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
            continue;
          }
        }
        last.s += '\n';
      } else {
        out.push(textNode('\n'));
      }
      i++;
      continue;
    }
    if (ch === '`') {
      let k = i;
      while (k < n && text[k] === '`') k++;
      const cs = scanCodeSpan(text, i, k - i);
      if (cs) {
        out.push({ t: 2, s: cs[0] });
        i = cs[1];
      } else {
        pushText(out, escText(text.slice(i, k)));
        i = k;
      }
      continue;
    }
    if (ch === '\\') {
      if (i + 1 < n && text[i + 1] === '\n') {
        // backslash hard break: also consumes following spaces
        // and tabs, and only applies when non-whitespace follows
        let k = i + 2;
        while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
        if (k < n) {
          out.push({ t: 3 });
          i += 2;
          while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
          continue;
        }
        pushText(out, '\\');
        i++;
        continue;
      }
      if (i + 1 < n && ASCII_PUNCT.has(text[i + 1])) {
        pushText(out, escText(text[i + 1]));
        i += 2;
        continue;
      }
      pushText(out, '\\');
      i++;
      continue;
    }
    if (ch === '&') {
      const ent = readEntity(text, i);
      if (ent) {
        pushText(out, ent[0]);
        i = ent[1];
      } else {
        pushText(out, '&amp;');
        i++;
      }
      continue;
    }
    if (ch === '<') {
      const al = parseAutolink(text, i);
      if (al) {
        const href = cleanUrl(al[0]);
        if (href !== null) {
          out.push({ t: 5, href, title: null, auto: true, kids: [textNode(escText(al[1]))] });
          i = al[2];
          continue;
        }
      }
      const tag = parseHtmlTag(text, i);
      if (tag) {
        out.push({ t: 4, s: tag[0] });
        // <a ...> opens a link context (extended autolinks stop),
        // </a> closes it; <pre>/<code>/<kbd>/<script> switch the
        // following text to raw (unescaped) mode
        if (/^<a /i.test(tag[0])) inLink = true;
        else if (/^<\/a>/i.test(tag[0])) inLink = false;
        if (/^<(pre|code|kbd|script)(\s|>)/i.test(tag[0])) inRaw = true;
        else if (/^<\/(pre|code|kbd|script)(\s|>)/i.test(tag[0])) inRaw = false;
        i = tag[1];
        continue;
      }
      pushText(out, '&lt;');
      i++;
      continue;
    }
    if (ch === '[' || ch === '!') {
      const link = tryLink(text, i, refs, inLink, inRaw);
      if (link) {
        out.push(link.node);
        i = link.nextPos;
        continue;
      }
      pushText(out, ch === '[' ? '[' : '!');
      i++;
      continue;
    }
    if (ch === '*' || ch === '_') {
      let k = i;
      while (k < n && text[k] === ch) k++;
      const len = k - i;
      const before = i === 0 ? '' : text[i - 1];
      const after = k < n ? text[k] : '';
      const beforeWs = before === '' || isWhitespace(before);
      const afterWs = after === '' || isWhitespace(after);
      const beforePunct = isPunct(before);
      const afterPunct = isPunct(after);
      const leftFlank = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const rightFlank = !beforeWs && (!beforePunct || afterWs || afterPunct);
      let canOpen, canClose;
      if (ch === '*') {
        canOpen = leftFlank;
        canClose = rightFlank;
      } else {
        canOpen = leftFlank && (!rightFlank || beforePunct);
        canClose = rightFlank && (!leftFlank || afterPunct);
      }
      out.push({ t: 1, ch, n: len, open: canOpen, close: canClose, vis: runVisible(i, k) });
      if (ch === '_') {
        if (canOpen && !canClose) openUnd++;
        else if (canClose && !canOpen) openUnd = Math.max(0, openUnd - 1);
        else if (canOpen && canClose) { if (openUnd > 0) openUnd--; else openUnd++; }
      }
      i = k;
      continue;
    }
    if (ch === '~') {
      let k = i;
      while (k < n && text[k] === '~') k++;
      const len = k - i;
      if (len <= 2) {
        const after = k < n ? text[k] : '';
        if (after !== '' && !isWhitespace(after) && after !== '~') {
          // marked's del scan: a counter starts at the opener's
          // length; a run of the same length preceded by
          // whitespace is opener-like (adds), any other run of
          // the same length is a closer (subtracts); the del
          // closes when the counter reaches 0
          let p = len;
          let j = k;
          let closeEnd = -1;
          while (j < n) {
            if (text[j] === '\\' && j + 1 < n) { j += 2; continue; }
            if (text[j] === '~') {
              let m = j;
              while (m < n && text[m] === '~') m++;
              if (m - j === len && j !== k) {
                // a ~ run hidden by the mask cannot close del
                if (!runVisible(j, m)) { j = m; continue; }
                const beforeRun = text[j - 1];
                if (isWhitespace(beforeRun)) p += len;
                else {
                  p -= len;
                  if (p <= 0) { closeEnd = m; break; }
                }
              }
              j = m;
              continue;
            }
            j++;
          }
          if (closeEnd !== -1) {
            const inner = text.slice(k, closeEnd - len);
            const kids = scanInline(inner, refs, inLink, inRaw)[0];
            out.push({ t: 7, tag: 'del', kids });
            i = closeEnd;
            continue;
          }
        }
      }
      pushText(out, escText(text.slice(i, k)));
      i = k;
      continue;
    }
    // unreachable in practice; keep the loop total
    if (runStart < 0) runStart = i;
    i++;
  }
  flushRun(n);
  return [out, inLink, inRaw];
}

// Resolve emphasis/strong delimiters in a node list, following
// marked's emStrong scan: for each opener (left to right), scan
// forward with a counter m (the opener's length, plus the lengths
// of opener-like runs encountered, minus the lengths of closer
// runs). A both-ways closer whose length sums with the opener's
// to a multiple of 3 is skipped (rule of 3). The opener matches
// the first closer that brings m to 0. Mutates the list in place.
function resolveEmphasis(nodes) {
  let i = 0;
  while (i < nodes.length) {
    const opener = nodes[i];
    if (opener.t !== 1 || !opener.open) { i++; continue; }
    const ch = opener.ch;
    const openLen = opener.n;
    let m = openLen;
    let f = 0;
    let matchIdx = -1;
    let use = 0;
    let capped = 0;
    let skippedPair = false;
    for (let j = i + 1; j < nodes.length; j++) {
      const cand = nodes[j];
      if (cand.t !== 1 || cand.ch !== ch) continue;
      // a delimiter hidden by the mask is invisible to marked's
      // closer search: it can neither close nor add to the counter
      if (cand.vis === false) continue;
      if (!cand.open && !cand.close) continue;
      // marked's emStrong closer regex has a leading alternative
      // ^[^_*]*?__[^_*]*?\*[^_*]*?(?=__): a delimiter inside a
      // double-delimiter pair of the other char is skipped by the
      // scan (it belongs to the inner strong, not to this opener)
      if (!skippedPair) {
        const opp = ch === '*' ? '_' : '*';
        let back = -1;
        for (let k = j - 1; k > i; k--) {
          const nd = nodes[k];
          if (nd.t !== 1) continue;
          if (nd.vis === false) continue;
          if (nd.ch === opp && nd.n >= 2 && nd.open) { back = k; break; }
          if (nd.ch === ch || nd.ch === opp) break;
        }
        if (back !== -1) {
          let fwd = -1;
          for (let k = j + 1; k < nodes.length; k++) {
            const nd = nodes[k];
            if (nd.t !== 1) continue;
            if (nd.vis === false) continue;
            if (nd.ch === opp && nd.n >= 2 && nd.close) { fwd = k; break; }
            if (nd.ch === ch || nd.ch === opp) break;
          }
          if (fwd !== -1) { skippedPair = true; continue; }
        }
      }
      const b = cand.n;
      const openOnly = cand.open && !cand.close;
      const bothWays = cand.open && cand.close;
      if (openOnly) {
        // opener-like run: adds to the counter
        m += b;
        continue;
      }
      if (bothWays) {
        // rule of 3: skip a both-ways closer when the opener's
        // length is not a multiple of 3 and the two lengths sum
        // to a multiple of 3
        if (openLen % 3 !== 0 && (openLen + b) % 3 === 0) {
          f += b;
          continue;
        }
      }
      // a closer (close-only or both-ways): subtract
      m -= b;
      if (m > 0) continue;
      // match: use 1 or 2 delimiters (marked's min(k,b) parity)
      capped = Math.min(b, b + m + f);
      use = (Math.min(openLen, capped) % 2 === 1) ? 1 : 2;
      // never use more delimiters than either side has
      if (use > openLen) use = 1;
      if (use > b) use = 1;
      matchIdx = j;
      break;
    }
    if (matchIdx === -1) {
      // no closer for this opener: marked retries each starting
      // position, so try a shorter opener (emit one delimiter
      // as literal text and retry the remainder)
      if (opener.n > 1) {
        opener.n -= 1;
        nodes.splice(i, 0, textNode(escText(ch)));
        i++;
        continue;
      }
      nodes[i] = textNode(escText(ch));
      i++;
      continue;
    }
    const closer = nodes[matchIdx];
    const tag = use === 2 ? 'strong' : 'em';
    const kids = nodes.slice(i + 1, matchIdx);
    // leftover delimiters stay inside the wrapper (marked's
    // em/strong text is the raw with `use` chars sliced off each
    // end, so the remainders are the first/last chars of the
    // inner text and can form inner emphasis). Only `capped`
    // of the closer's run is part of the match; any extra
    // delimiters stay outside, after the wrapper.
    const closerInside = capped - use;
    const closerOutside = closer.n - capped;
    if (opener.n - use > 0) kids.unshift({ t: 1, ch, n: opener.n - use, open: opener.open, close: opener.close, vis: opener.vis });
    if (closerInside > 0) kids.push({ t: 1, ch, n: closerInside, open: closer.open, close: closer.close, vis: closer.vis });
    // resolve emphasis inside the wrapper first (marked
    // tokenizes the inner content recursively)
    resolveEmphasis(kids);
    const wrap = { t: 7, tag, kids };
    const repl = [wrap];
    if (closerOutside > 0) repl.push({ t: 1, ch, n: closerOutside, open: closer.open, close: closer.close, vis: closer.vis });
    nodes.splice(i, matchIdx - i + 1, ...repl);
    // continue after the wrapper
    i = i + 1;
  }
  // leftover delimiters become literal text
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.t === 1) {
      nodes[i] = textNode(escText(node.ch.repeat(node.n)));
    }
  }
}

function renderNodes(nodes) {
  resolveEmphasis(nodes);
  const parts = [];
  renderInto(nodes, parts);
  return parts.join('');
}

function renderInto(nodes, parts) {
  for (const node of nodes) {
    switch (node.t) {
      case 0: parts.push(node.s); break;
      case 1: parts.push(escText(node.ch.repeat(node.n))); break;
      case 2: parts.push('<code>', escText(node.s), '</code>'); break;
      case 3: parts.push('<br>'); break;
      case 4: parts.push(node.s); break;
      case 5: {
        parts.push('<a href="', node.auto ? escText(node.href) : escNoEncode(node.href), '"');
        if (node.title !== null && node.title !== undefined) parts.push(' title="', node.title, '"');
        parts.push('>');
        resolveEmphasis(node.kids);
        renderInto(node.kids, parts);
        parts.push('</a>');
        break;
      }
      case 6: {
        parts.push('<img src="', escNoEncode(node.src), '" alt="', node.alt.replace(/"/g, '&quot;'), '"');
        if (node.title !== null && node.title !== undefined) parts.push(' title="', node.title, '"');
        parts.push('>');
        break;
      }
      case 7: {
        parts.push('<', node.tag, '>');
        resolveEmphasis(node.kids);
        renderInto(node.kids, parts);
        parts.push('</', node.tag, '>');
        break;
      }
    }
  }
}

// Render inline markdown text to HTML. Deferred: returns a thunk
// so that link reference definitions collected anywhere in the
// document (even later) are visible when the inline text is
// rendered. The block pass only assembles thunks and strings;
// joinOut resolves them after the whole block pass has run.
function inline(text, refs, ctx) {
  if (text === '') return '';
  // marked's inLink/inRawBlock state persists across blocks within
  // one parse (an unclosed <a> or <pre> tag affects later blocks),
  // so the thunk reads and writes the shared ctx state when it is
  // resolved (in document order by joinOut)
  return () => {
    const res = scanInline(text, refs, ctx.inLink, ctx.inRaw);
    ctx.inLink = res[1];
    ctx.inRaw = res[2];
    return renderNodes(res[0]);
  };
}

// Resolve an output array of strings, thunks and nested arrays
// into one HTML string.
function joinOut(out) {
  const parts = [];
  for (const item of out) {
    if (typeof item === 'function') parts.push(item());
    else if (Array.isArray(item)) parts.push(joinOut(item));
    else parts.push(item);
  }
  return parts.join('');
}

// ---------------- link reference definitions ----------------
// Try to parse a link reference definition starting at L[i].
// Returns the number of lines consumed, or 0 when it is not one.
// Parse a link reference definition starting at L[i]. The label,
// destination and title may each span lines (marked's def regex
// runs on the source text, not a single line). Returns the number
// of lines consumed, or 0 when there is no definition here.
function parseLinkDef(L, i, refs) {
  const line = L[i];
  const info = leadInfo(line);
  if (info.col > 3) return 0;
  const rest = line.slice(info.pos);
  if (rest[0] !== '[') return 0;
  // gather up to 40 lines of source text to parse the def from
  const maxLines = Math.min(L.length - i, 40);
  let src = rest;
  for (let k = 1; k < maxLines; k++) src += '\n' + L[i + k];
  const def = parseDefFromString(src);
  if (!def) return 0;
  const key = normalizeLabel(def.label);
  if (!refs.has(key)) refs.set(key, { dest: def.dest, title: def.title });
  // lines consumed: the line index of the def's content end + 1
  return src.slice(0, def.contentEnd).split('\n').length;
}

// Parse a link reference definition from a source string (starting
// at the '['). Returns {label, dest, title, contentEnd} or null.
function parseDefFromString(src) {
  let j = 1;
  let label = '';
  // label (marked's le): no brackets, backslash escapes, a newline
  // is allowed when the next line is not blank
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\' && j + 1 < src.length) { label += src[j] + src[j + 1]; j += 2; continue; }
    if (ch === '[') return null;
    if (ch === ']') { j++; break; }
    if (ch === '\n') {
      let k = j + 1;
      while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k >= src.length || src[k] === '\n') return null;
      label += '\n';
      j++;
      continue;
    }
    label += ch;
    j++;
  }
  if (label.trim() === '') return null;
  if (src[j] !== ':') return null;
  j++;
  // skip spaces/tabs, optionally one newline + spaces/tabs
  while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
  if (src[j] === '\n') {
    j++;
    while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
  }
  if (j >= src.length) return null;
  // destination
  let dest = '';
  if (src[j] === '<') {
    // '<...>' destination: any chars except newline/control
    // ('<' is allowed inside, unlike inline links)
    j++;
    let closed = false;
    while (j < src.length) {
      const ch = src[j];
      if (ch === '>') { j++; closed = true; break; }
      if (ch === '\n' || ch.charCodeAt(0) < 32) return null;
      if (ch === '\\' && j + 1 < src.length && ASCII_PUNCT.has(src[j + 1])) { dest += src[j + 1]; j += 2; continue; }
      dest += ch;
      j++;
    }
    if (!closed) return null;
  } else {
    let depth = 0;
    const start = j;
    while (j < src.length) {
      const ch = src[j];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch.charCodeAt(0) < 32) break;
      if (ch === '\\' && j + 1 < src.length && ASCII_PUNCT.has(src[j + 1])) { dest += src[j + 1]; j += 2; continue; }
      if (ch === '(') { depth++; dest += ch; j++; continue; }
      if (ch === ')') {
        if (depth === 0) break;
        depth--; dest += ch; j++; continue;
      }
      dest += ch;
      j++;
    }
    if (j === start) return null;
    // an unclosed '(' in the destination fails the definition
    if (depth > 0) return null;
  }
  const destEnd = j;
  // a title needs whitespace before it: spaces/tabs and at most
  // one newline
  let q = j;
  while (q < src.length && (src[q] === ' ' || src[q] === '\t')) q++;
  let hadWs = q > j;
  if (src[q] === '\n') {
    q++;
    while (q < src.length && (src[q] === ' ' || src[q] === '\t')) q++;
    hadWs = true;
  }
  if (hadWs && (src[q] === '"' || src[q] === "'" || src[q] === '(')) {
    const t = parseLinkTitle(src, q, true);
    if (t) {
      let r = t[1];
      while (r < src.length && (src[r] === ' ' || src[r] === '\t')) r++;
      if (r >= src.length || src[r] === '\n') {
        return { label, dest, title: t[0], contentEnd: t[1] };
      }
    }
    // the title did not work out: fall back to a definition
    // without a title (marked's regex backtracks the same way)
  }
  // no title: only whitespace may follow the destination
  let r = destEnd;
  while (r < src.length && (src[r] === ' ' || src[r] === '\t')) r++;
  if (r >= src.length || src[r] === '\n') {
    return { label, dest, title: null, contentEnd: destEnd };
  }
  return null;
}

// ---------------- block helpers ----------------

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'nav',
  'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'section', 'source',
  'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr',
  'track', 'ul',
]);

// ATX heading: returns [level, contentText] or null.
function matchAtx(rest) {
  if (rest[0] !== '#') return null;
  let n = 0;
  while (n < rest.length && rest[n] === '#') n++;
  if (n > 6) return null;
  if (n < rest.length && rest[n] !== ' ' && rest[n] !== '\t') return null;
  let content = rest.slice(n);
  // strip a closing sequence of #s preceded by space/tab
  const m = /[ \t]+#+[ \t]*$/.exec(content);
  if (m) content = content.slice(0, content.length - m[0].length);
  return [n, content.trim()];
}

// Fenced code start: returns [fenceChar, fenceLen, info] or null.
function matchFence(rest) {
  const ch = rest[0];
  if (ch !== '`' && ch !== '~') return null;
  let n = 0;
  while (n < rest.length && rest[n] === ch) n++;
  if (n < 3) return null;
  const info = rest.slice(n).trim();
  if (ch === '`' && info.includes('`')) return null;
  return [ch, n, info];
}

// Thematic break?
function isHr(rest) {
  const ch = rest[0];
  if (ch !== '*' && ch !== '-' && ch !== '_') return false;
  let count = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === ch) count++;
    else if (c !== ' ' && c !== '\t') return false;
  }
  return count >= 3;
}

// Setext underline: returns 1 for '=', 2 for '-', else 0. The
// line must be a run of one character with only trailing
// whitespace after it (no spaces between the marks).
function setextLevel(rest) {
  if (rest === '') return 0;
  const ch = rest[0];
  if (ch !== '=' && ch !== '-') return 0;
  let i = 0;
  while (i < rest.length && rest[i] === ch) i++;
  while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) i++;
  if (i !== rest.length) return 0;
  return ch === '=' ? 1 : 2;
}

// HTML block type of a line (indent already stripped, up to 3).
// Returns 0 when the line does not start an HTML block.
function htmlBlockType(rest) {
  if (rest[0] !== '<') return 0;
  const low = rest.toLowerCase();
  if (low.startsWith('<!--')) return 2;
  if (low.startsWith('<?')) return 3;
  if (low.startsWith('<![cdata[')) return 5;
  if (low.startsWith('<!')) {
    const c = rest[2];
    if (c && /[A-Za-z]/.test(c)) return 4;
    return 0;
  }
  // type 1: pre / script / style / textarea
  for (const name of ['pre', 'script', 'style', 'textarea']) {
    if (low.startsWith('<' + name)) {
      const after = rest[1 + name.length];
      if (after === undefined || after === ' ' || after === '\t' || after === '>' || after === '/') return 1;
    }
  }
  // tag name
  let j = 1;
  let closing = false;
  if (rest[j] === '/') { closing = true; j++; }
  if (j >= rest.length || !/[A-Za-z]/.test(rest[j])) return 0;
  const start = j;
  while (j < rest.length && /[A-Za-z0-9-]/.test(rest[j])) j++;
  const name = rest.slice(start, j).toLowerCase();
  const after = rest[j];
  if (BLOCK_TAGS.has(name)) {
    if (after === undefined || after === ' ' || after === '\t' || after === '>' || after === '/') return 6;
    return 0;
  }
  // type 7: complete open or close tag, nothing but whitespace after
  if (!closing) {
    // re-parse as a full tag to check it is complete on this line
    const tag = parseHtmlTag(rest, 0);
    if (tag && tag[0].length === rest.trimEnd().length && rest.slice(tag[0].length).trim() === '') return 7;
    return 0;
  }
  // closing tag of a non-block tag
  let k = j;
  while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) k++;
  if (k < rest.length && rest[k] === '>') {
    if (rest.slice(k + 1).trim() === '') return 7;
  }
  return 0;
}

// Strip a blockquote marker from a line. Returns the remaining line
// or null when the line has no marker. The whitespace run after the
// marker is expanded to spaces (tab-stop aware) and then one space
// is removed, matching how marked treats `>` followed by a tab.
function stripQuote(line) {
  const info = leadInfo(line);
  if (info.col > 3) return null;
  let s = line.slice(info.pos);
  if (s[0] !== '>') return null;
  s = s.slice(1);
  const base = info.col + 1;
  const [expanded, wsLen] = expandLeadingWs(s, base);
  if (expanded.length > 0) {
    return expanded.slice(1) + s.slice(wsLen);
  }
  return s;
}

// Is a paragraph open at the end of this line, looking through
// any number of blockquote markers and list markers to the
// innermost line (a lazy continuation can join a paragraph
// nested inside a quote inside a list item, and vice versa)?
function paraOpenForLine(line) {
  let cur = line;
  while (true) {
    const sq = stripQuote(cur);
    if (sq !== null) { cur = sq; continue; }
    const info = leadInfo(cur);
    if (info.col <= 3) {
      const lm = matchListMarker(cur.slice(info.pos), info.col);
      if (lm) {
        cur = firstLineContent(cur, info.col, lm);
        continue;
      }
    }
    break;
  }
  if (isBlank(cur)) return false;
  const info = leadInfo(cur);
  const rest = cur.slice(info.pos);
  return !interruptsParagraph(rest, info.col, false) && setextLevel(rest) === 0;
}

// Does this line start a block that can interrupt a paragraph?
// (ATX heading, fence, hr, HTML block types 1-6, blockquote, list.)
// Does a line interrupt a paragraph inside a blockquote (the
// paragraph regex used there allows any ordered number and a bare
// marker to interrupt, unlike the top-level paragraph)?
function interruptsParagraphBQ(line) {
  const info = leadInfo(line);
  if (info.col > 3) return false;
  const rest = line.slice(info.pos);
  if (rest === '') return false;
  if (rest[0] === '#') return matchAtx(rest) !== null;
  if (rest[0] === '`' || rest[0] === '~') return matchFence(rest) !== null;
  if (isHr(rest)) return true;
  if (rest[0] === '<') { const t = htmlBlockType(rest); if (t >= 1 && t <= 6) return true; }
  if (rest[0] === '>') return true;
  // a list marker (any ordered number, bare markers included)
  // followed by a space, tab, newline or end of line
  const lm = matchListMarker(rest, info.col);
  return lm !== null;
}

function interruptsParagraph(rest, ind, top) {
  if (ind > 3) return false;
  if (rest === '') return false;
  if (rest[0] === '#') return matchAtx(rest) !== null;
  if (rest[0] === '`' || rest[0] === '~') return matchFence(rest) !== null;
  if (isHr(rest)) return true;
  if (rest[0] === '<') { const t = htmlBlockType(rest); if (t >= 1 && t <= 6) return true; }
  if (rest[0] === '>') return true;
  const lm = matchListMarker(rest, ind);
  if (lm) {
    // a list marker interrupts a paragraph only when it is
    // followed by whitespace and then non-space content (a bare
    // '*' line is a paragraph continuation, not a list item).
    // At the top level (and in a blockquote) an ordered marker
    // interrupts only when it starts with 1; inside a list item
    // any ordered number interrupts.
    if (lm.empty) return false;
    if (lm.ordered) return top === false ? true : lm.start === 1;
    return true;
  }
  return false;
}

// List marker at the start of rest (leading whitespace stripped).
// `ind` is the visual column of the marker. contentIndent is the
// absolute column where the item's content starts.
// Returns {ordered, bullet, delim, start, markerLen, contentIndent,
// empty} or null.
function matchListMarker(rest, ind) {
  ind = ind || 0;
  const ch = rest[0];
  if (ch === '-' || ch === '+' || ch === '*') {
    const next = rest[1];
    if (next !== ' ' && next !== '\t' && next !== undefined) return null;
    let col = ind + 1;
    let j = 1;
    while (j < rest.length && (rest[j] === ' ' || rest[j] === '\t')) {
      if (rest[j] === ' ') col++;
      else col += 4 - (col % 4);
      j++;
    }
    const empty = j >= rest.length;
    const gap = col - (ind + 1);
    let contentIndent = ind + 2;
    if (empty) contentIndent = ind + 2;
    else if (gap >= 1 && gap <= 4) contentIndent = col;
    else contentIndent = ind + 2; // 5+ columns: content indent is marker + 1
    return { ordered: false, bullet: ch, delim: null, start: 0, markerLen: 1, contentIndent, empty };
  }
  if (ch >= '0' && ch <= '9') {
    let j = 0;
    while (j < rest.length && rest[j] >= '0' && rest[j] <= '9') j++;
    if (j === 0 || j > 9) return null;
    const delim = rest[j];
    if (delim !== '.' && delim !== ')') return null;
    const next = rest[j + 1];
    if (next !== ' ' && next !== '\t' && next !== undefined) return null;
    const start = parseInt(rest.slice(0, j), 10);
    let col = ind + j + 1;
    let k = j + 1;
    while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) {
      if (rest[k] === ' ') col++;
      else col += 4 - (col % 4);
      k++;
    }
    const empty = k >= rest.length;
    const gap = col - (ind + j + 1);
    let contentIndent = ind + j + 2;
    if (empty) contentIndent = ind + j + 2;
    else if (gap >= 1 && gap <= 4) contentIndent = col;
    else contentIndent = ind + j + 2;
    return { ordered: true, bullet: null, delim, start, markerLen: j + 1, contentIndent, empty };
  }
  return null;
}

// Remove n visual columns of indent from a line: expand the leading
// whitespace run to spaces first, then drop n of them.
function stripIndent(line, n) {
  const [expanded, wsLen] = expandLeadingWs(line, 0);
  return expanded.slice(n) + line.slice(wsLen);
}

// Content of a list item's first line: the text after the marker and
// its gap, with the gap's tabs expanded to spaces. `line` is the full
// line, `ind` the marker's column, `lm` the marker match.
function firstLineContent(line, ind, lm) {
  const info = leadInfo(line);
  const rest = line.slice(info.pos);
  const after = rest.slice(lm.markerLen);
  const [expanded, wsLen] = expandLeadingWs(after, ind + lm.markerLen);
  const gap = lm.contentIndent - (ind + lm.markerLen);
  return expanded.slice(gap) + after.slice(wsLen);
}

// Split a table row line into cells. Returns null when the line has
// no pipe at all (not a row).
// Split a table row the way marked's de() does: an unescaped
// pipe (one preceded by an even number of backslashes) is forced
// to be preceded by a space, the row is split on ' |', empty
// first/last cells are dropped, cells are trimmed and '\|' in a
// cell becomes a literal '|'. Pipes inside code spans DO split
// (there is no code-span awareness here).
function splitTableRow(line) {
  let t = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '|') {
      let k = i - 1;
      let odd = false;
      while (k >= 0 && line[k] === '\\') { odd = !odd; k--; }
      if (!odd) t += ' ';
      t += '|';
      i++;
      continue;
    }
    t += ch;
    i++;
  }
  const parts = t.split(' |');
  if (parts.length > 0 && parts[0].trim() === '') parts.shift();
  if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
  return parts.map((c) => c.trim().replace(/\\\|/g, '|'));
}

// Parse a table delimiter row. Returns an array of alignments
// ('left' | 'center' | 'right' | null) or null.
function parseDelimiterRow(line) {
  if (!line.includes('|')) return null;
  const cells = splitTableRow(line);
  let cs = cells.slice();
  if (cs.length > 0 && cs[0].trim() === '') cs = cs.slice(1);
  if (cs.length > 0 && cs[cs.length - 1].trim() === '') cs = cs.slice(0, -1);
  if (cs.length === 0) return null;
  const aligns = [];
  for (const c of cs) {
    const t = c.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    if (t.startsWith(':') && t.endsWith(':') && t.length >= 2) aligns.push('center');
    else if (t.startsWith(':')) aligns.push('left');
    else if (t.endsWith(':')) aligns.push('right');
    else aligns.push(null);
  }
  return aligns;
}

// Render one table. headerLine is the raw header line (leading ws
// stripped), aligns the delimiter alignments, bodyLines the rows.
function padCells(cells, n) {
  if (cells.length > n) return cells.slice(0, n);
  while (cells.length < n) cells.push('');
  return cells;
}

// Does a table body row stop here? Mirrors the negative lookahead
// in marked's table regex: a blank line, hr, ATX heading,
// blockquote, fence, html-block start, or a list that starts with
// a bullet or '1.' / '1)' (other ordered markers do not stop it).
// marked's table body-row lookahead: a row stops at a line that is
// only spaces ( *\n  — tabs do not count), an indented code line
// (?: {4}| {0,3}\t)[^\n], or hr/heading/blockquote/fence/list/html
function isTableCode(line) {
  if (line.startsWith('    ') && line.length > 4) return true;
  let j = 0;
  while (j < 3 && line[j] === ' ') j++;
  return line[j] === '\t' && j + 1 < line.length;
}

function tableRowStops(rest, col) {
  if (col > 3) return false;
  if (isHr(rest) || matchAtx(rest) || rest.startsWith('>') || matchFence(rest) || htmlBlockType(rest) !== 0) return true;
  const ch = rest[0];
  if (ch === '*' || ch === '+' || ch === '-') return rest[1] === ' ' || rest[1] === '\t';
  if (rest[0] === '1' && (rest[1] === '.' || rest[1] === ')')) return rest[2] === ' ' || rest[2] === '\t';
  return false;
}

function renderTable(headerLine, aligns, bodyLines, refs, ctx) {
  const ncols = aligns.length;
  const head = padCells(splitTableRow(headerLine), ncols);
  const out = [];
  out.push('<table>\n<thead>\n<tr>\n');
  for (let c = 0; c < ncols; c++) {
    const a = aligns[c];
    out.push('<th' + (a ? ' align="' + a + '"' : '') + '>');
    out.push(inline(head[c], refs, ctx));
    out.push('</th>\n');
  }
  out.push('</tr>\n</thead>\n');
  if (bodyLines.length > 0) out.push('<tbody>');
  for (const rowLine of bodyLines) {
    const cells = padCells(splitTableRow(rowLine), ncols);
    out.push('<tr>\n');
    for (let c = 0; c < ncols; c++) {
      const a = aligns[c];
      out.push('<td' + (a ? ' align="' + a + '"' : '') + '>');
      out.push(inline(cells[c], refs, ctx));
      out.push('</td>\n');
    }
    out.push('</tr>\n');
  }
  if (bodyLines.length > 0) out.push('</tbody>');
  out.push('</table>\n');
  return out;
}

// ---------------- the block loop ----------------

// Render blocks from lines L into out. tight: paragraphs in this
// range render without <p> wrappers (tight list items).
// Record a block in a render state (used by blockquotes to know
// the last block type of a chunk, and by lists to know whether a
// blank line separated two blocks in an item). Nested renders get
// their own state, so blank lines inside a nested structure do
// not mark the outer render.
function noteBlock(state, type) {
  if (!state) return;
  if (state._sawBlock && state._sawBlank) state.blankSep = true;
  state._sawBlock = true;
  state._sawBlank = false;
  state.lastType = type;
}

function renderBlocks(L, ctx, tight, out, srcEndsNL, state, top) {
  if (top === undefined) top = true;
  if (srcEndsNL === undefined) srcEndsNL = ctx.srcEndsNL;
  let i = 0;
  const n = L.length;
  while (i < n) {
    const line = L[i];
    if (isBlank(line)) { if (state) state._sawBlank = true; i++; continue; }
    const info = leadInfo(line);
    const ind = info.col;
    const rest = line.slice(info.pos);

    // link reference definition
    if (ind <= 3) {
      const used = parseLinkDef(L, i, ctx.refs);
      if (used > 0) { noteBlock(state, 'def'); i += used; continue; }
    }

    // ATX heading
    if (ind <= 3) {
      const atx = matchAtx(rest);
      if (atx) {
        noteBlock(state, 'heading');
        out.push('<h' + atx[0] + '>');
        out.push(inline(atx[1], ctx.refs, ctx));
        out.push('</h' + atx[0] + '>\n');
        i++;
        continue;
      }
    }

    // fenced code
    if (ind <= 3) {
      const fence = matchFence(rest);
      if (fence) {
        noteBlock(state, 'code');
        const fch = fence[0];
        const flen = fence[1];
        const infoStr = fence[2];
        let firstWord = '';
        for (let k = 0; k < infoStr.length; k++) {
          const c = infoStr[k];
          if (c === ' ' || c === '\t') break;
          if (c === '\\' && k + 1 < infoStr.length && ASCII_PUNCT.has(infoStr[k + 1])) {
            firstWord += infoStr[k + 1];
            k++;
            continue;
          }
          firstWord += c;
        }
        const codeLines = [];
        i++;
        while (i < n) {
          const cl = L[i];
          const cinfo = leadInfo(cl);
          const crest = cl.slice(cinfo.pos);
          let cn = 0;
          let isClose = false;
          if (cinfo.col <= 3 && crest[0] === fch) {
            while (cn < crest.length && crest[cn] === fch) cn++;
            if (cn >= flen && crest.slice(cn).trim() === '') isClose = true;
          }
          if (isClose) { i++; break; }
          // backtick fences strip up to as many leading whitespace
          // characters as the opening fence line had; tilde fences
          // strip nothing (marked's Dt compensation)
          if (fch === '`' && ind > 0) {
            let ws = 0;
            while (ws < cl.length && (cl[ws] === ' ' || cl[ws] === '\t')) ws++;
            const strip = Math.min(ws, info.pos);
            codeLines.push(strip > 0 ? cl.slice(strip) : cl);
          } else {
            codeLines.push(cl);
          }
          i++;
        }
        let content = codeLines.join('\n');
        // the code text ends with exactly one newline: strip one
        // trailing newline (if any) and add one back
        if (content !== '') content = content.replace(/\n$/, '') + '\n';
        out.push('<pre><code' + (firstWord !== '' ? ' class="language-' + escNoEncode(firstWord) + '"' : '') + '>' + escText(content) + '</code></pre>\n');
        continue;
      }
    }

    // thematic break
    if (ind <= 3 && isHr(rest)) {
      noteBlock(state, 'hr');
      out.push('<hr>\n');
      i++;
      continue;
    }

    // indented code
    if (ind >= 4) {
      noteBlock(state, 'code');
      const codeLines = [];
      while (i < n) {
        const cl = L[i];
        if (isBlank(cl)) {
          // blank line: include only if a later indented line follows
          let k = i + 1;
          let found = false;
          while (k < n) {
            if (isBlank(L[k])) { k++; continue; }
            if (leadInfo(L[k]).col >= 4) found = true;
            break;
          }
          if (!found) break;
          // a blank line inside indented code keeps the remainder
          // after stripping 4 columns (e.g. 6 spaces -> ' ')
          codeLines.push(stripCols(cl, 4));
          i++;
          continue;
        }
        if (leadInfo(cl).col < 4) break;
        codeLines.push(stripCols(cl, 4));
        i++;
      }
      while (codeLines.length > 0 && codeLines[codeLines.length - 1].trim() === '') codeLines.pop();
      let content = codeLines.join('\n');
      if (content !== '') content += '\n';
      out.push('<pre><code>' + escText(content) + '</code></pre>\n');
      continue;
    }

    // HTML block
    if (ind <= 3 && rest[0] === '<') {
      const htype = htmlBlockType(rest);
      if (htype > 0) {
        noteBlock(state, 'html');
        const blockLines = [line];
        i++;
        // the end marker may already be on the opening line
        // (e.g. <style>...</style> or <!-- foo --> on one line)
        let endsOnOpen = false;
        if (htype === 1) {
          const tagName = rest.toLowerCase().match(/^<\s*(pre|script|style|textarea)/);
          if (tagName) {
            const gt = rest.indexOf('>');
            if (gt >= 0 && rest.toLowerCase().indexOf('</' + tagName[1], gt + 1) >= 0) endsOnOpen = true;
          }
        } else if (htype === 2) {
          if (rest.startsWith('<!-->') || rest.startsWith('<!--->') || rest.indexOf('-->', 4) >= 0) endsOnOpen = true;
        } else if (htype === 3) {
          if (rest.indexOf('?>', 2) >= 0) endsOnOpen = true;
        } else if (htype === 4) {
          if (rest.indexOf('>', 2) >= 0) endsOnOpen = true;
        } else if (htype === 5) {
          if (rest.indexOf(']]>', 9) >= 0) endsOnOpen = true;
        }
        if (endsOnOpen) {
          // single-line block
        } else if (htype === 6 || htype === 7) {
          // types 6 and 7 run until a blank line
          while (i < n && !isBlank(L[i])) { blockLines.push(L[i]); i++; }
        } else {
          // types 1-5 run until their end marker, ignoring blank
          // lines in between
          const endTag = htype === 1 ? null : htype === 2 ? '-->' : htype === 3 ? '?>' : htype === 4 ? '>' : ']]>';
          while (i < n) {
            const bl = L[i];
            blockLines.push(bl);
            i++;
            if (htype === 1) {
              const lowBl = bl.toLowerCase();
              const tagName = rest.toLowerCase().match(/^<\s*(pre|script|style|textarea)/);
              if (tagName && lowBl.includes('</' + tagName[1])) break;
            } else if (endTag !== null && bl.includes(endTag)) break;
          }
        }
        let text = blockLines.join('\n');
        // marked's ge(): the regex match carries the newlines after
        // the block's last line; a single trailing newline is kept,
        // two or more (a truly empty line follows) are stripped.
        // Types 6/7 end at a blank line, and the match swallows
        // that blank line, so ge() strips the newline entirely;
        // types 1-5 only carry the newlines right after the last
        // line, so a whitespace-only next line still counts as
        // one newline and the trailing newline is kept.
        if (htype === 6 || htype === 7) {
          if (i >= n && srcEndsNL) text += '\n';
        } else if (i < n) {
          if (L[i] !== '') text += '\n';
        } else if (srcEndsNL) {
          text += '\n';
        }
        out.push(text);
        continue;
      }
    }

    // blockquote
    if (ind <= 3 && rest[0] === '>') {
      noteBlock(state, 'blockquote');
      // Collect the quote's extent: '>' lines, plus lazy
      // paragraph continuation lines (not blank, not interrupting
      // the paragraph) while a paragraph is open. A blank line
      // ends the extent.
      const extent = [];
      let paraOpen = false;
      let j = i;
      while (j < n) {
        const ql = L[j];
        const stripped = stripQuote(ql);
        if (stripped !== null) {
          extent.push({ line: stripped, lazy: false, idx: j });
          // a paragraph is open if the innermost line (after
          // stripping quote and list markers) is a paragraph line
          paraOpen = paraOpenForLine(stripped);
          j++;
          continue;
        }
        if (isBlank(ql)) break;
        if (paraOpen && !interruptsParagraphBQ(ql)) {
          extent.push({ line: ql, lazy: true, idx: j });
          const lInfo = leadInfo(ql);
          const lRest = ql.slice(lInfo.pos);
          if (setextLevel(lRest) > 0) paraOpen = false;
          j++;
          continue;
        }
        break;
      }
      // Process the extent in chunks: leading lazy lines +
      // consecutive '>' lines per chunk. Consecutive chunks whose
      // blocks are paragraphs (or indented code after a paragraph)
      // merge into one unit, the way marked's blockTokens merges
      // them; a chunk ending in code/heading/hr/html/table ends
      // the quote, and a chunk ending in a list/blockquote merges
      // with the remaining lines.
      const BREAK_TYPES = { code: 1, heading: 1, hr: 1, html: 1, table: 1 };
      const sub = [];
      let pos = 0;
      let consumedThrough = i;
      let unit = null;
      const flushUnit = () => {
        if (unit) {
          for (const piece of unit.out) sub.push(piece);
          unit = null;
        }
      };
      const renderUnit = (lines, endsNL) => {
        const st = {};
        const o = [];
        renderBlocks(lines, ctx, false, o, endsNL, st);
        return { lines, out: o, state: st, endsNL };
      };
      while (pos < extent.length) {
        const chunk = [];
        let p = pos;
        let sawMarker = false;
        while (p < extent.length) {
          if (!extent[p].lazy) { chunk.push(extent[p]); sawMarker = true; p++; }
          else if (!sawMarker) { chunk.push(extent[p]); p++; }
          else break;
        }
        // the chunk's inner text: '>' lines are already stripped;
        // a lazy setext-underline line gets 4 spaces prepended so
        // it is not a setext underline
        const innerLines = [];
        for (const e of chunk) {
          if (e.lazy) {
            const li = leadInfo(e.line);
            const lr = e.line.slice(li.pos);
            if (li.col <= 3 && setextLevel(lr) > 0) innerLines.push('    ' + lr);
            else innerLines.push(e.line);
          } else {
            innerLines.push(e.line);
          }
        }
        const chunkEndsNL = innerLines.length > 0 && innerLines[innerLines.length - 1] === '';
        const firstLine = innerLines.length > 0 ? innerLines[0] : '';
        const fInfo = leadInfo(firstLine);
        const fRest = firstLine.slice(fInfo.pos);
        const firstIsPara = firstLine !== '' && !isBlank(firstLine) && !interruptsParagraph(fRest, fInfo.col) && setextLevel(fRest) === 0;
        const firstIsCode = firstLine !== '' && fInfo.col >= 4;
        if (unit && unit.state.lastType === 'paragraph' && firstIsCode) {
          // an indented-code chunk after a paragraph merges at the
          // TEXT level (marked's code-merge rule): the code text
          // is appended to the paragraph text, not re-lexed (so a
          // stripped '- bar' stays paragraph text, not a list)
          const codeLines = [];
          let q = 0;
          while (q < innerLines.length) {
            const cl = innerLines[q];
            if (isBlank(cl)) { codeLines.push(cl); q++; continue; }
            const ci = leadInfo(cl);
            if (ci.col >= 4) { codeLines.push(cl); q++; continue; }
            break;
          }
          while (codeLines.length > 0 && isBlank(codeLines[codeLines.length - 1])) codeLines.pop();
          if (codeLines.length > 0 && q === innerLines.length) {
            const codeText = codeLines.map(cl => isBlank(cl) ? '' : stripCols(cl, 4)).join('\n');
            const newParaText = unit.state.lastParaText + '\n' + codeText;
            unit.out[unit.state.lastParaThunkIdx] = inline(newParaText, ctx.refs, ctx);
            unit.state.lastParaText = newParaText;
            consumedThrough = extent[p - 1].idx + 1;
            pos = p;
            if (pos >= extent.length) break;
            continue;
          }
          // otherwise fall through to the re-render merge below
        }
        if (unit && unit.state.lastType === 'paragraph' && firstIsPara) {
          // a paragraph chunk after a paragraph merges by
          // re-rendering the combined inner lines
          const merged = unit.lines.slice();
          for (const cl of innerLines) merged.push(cl);
          unit = renderUnit(merged, chunkEndsNL);
          consumedThrough = extent[p - 1].idx + 1;
          pos = p;
          if (pos >= extent.length) break;
          continue;
        }
        // a chunk ending in a break type ends the quote
        if (unit && BREAK_TYPES[unit.state.lastType]) break;
        if (unit && (unit.state.lastType === 'list' || unit.state.lastType === 'blockquote')) {
          // merge the unit with the remaining extent lines
          const merged = unit.lines.slice();
          for (let q = pos; q < extent.length; q++) merged.push(extent[q].line);
          unit = renderUnit(merged, chunkEndsNL);
          consumedThrough = extent[extent.length - 1].idx + 1;
          break;
        }
        flushUnit();
        unit = renderUnit(innerLines, chunkEndsNL);
        consumedThrough = extent[p - 1].idx + 1;
        pos = p;
        if (pos >= extent.length) break;
      }
      flushUnit();
      i = consumedThrough;
      out.push('<blockquote>\n');
      out.push(sub);
      out.push('</blockquote>\n');
      continue;
    }

    // list
    if (ind <= 3) {
      const lm = matchListMarker(rest, ind);
      if (lm) {
        noteBlock(state, 'list');
        i = renderList(L, i, ctx, out, ind);
        continue;
      }
    }

    // paragraph (may become a setext heading or a table)
    {
      const paraLines = [];
      // paragraph lines keep their full text, including leading
      // whitespace (marked's paragraph regex captures raw lines)
      paraLines.push(line);
      i++;
      let headingLevel = 0;
      let table = null;
      while (i < n) {
        const pl = L[i];
        // a space-only line is a blank line only when a newline
        // follows it; the last line, with no trailing newline, is
        // a paragraph continuation (marked's [ \t]+\n lookahead)
        if (isBlank(pl) && !(i === n - 1 && !srcEndsNL && pl !== '')) break;
        const pInfo = leadInfo(pl);
        const pRest = pl.slice(pInfo.pos);
        const sl = setextLevel(pRest);
        if (pInfo.col <= 3 && sl > 0) {
          headingLevel = sl;
          i++;
          break;
        }
        if (paraLines.length === 1 && pInfo.col <= 3) {
          const aligns = parseDelimiterRow(pRest);
          // a table needs a ':' or '|' in the delimiter row and
          // the same number of header cells as delimiter cells
          if (aligns && /[:|]/.test(pRest) && splitTableRow(paraLines[0]).length === aligns.length) {
            table = aligns;
            i++;
            break;
          }
        }
        if (interruptsParagraph(pRest, pInfo.col, top)) break;
        // in a list item (top=false) a continuation line with
        // indent >= 4 is an indented code token merged into the
        // paragraph text with 4 columns stripped; at the top
        // level (or in a blockquote) the raw line is kept
        if (!top && pInfo.col >= 4) paraLines.push(stripCols(pl, 4));
        else paraLines.push(pl);
        i++;
      }
      if (headingLevel > 0) {
        noteBlock(state, 'heading');
        out.push('<h' + headingLevel + '>');
        out.push(inline(paraLines.join('\n').trim(), ctx.refs, ctx));
        out.push('</h' + headingLevel + '>\n');
        continue;
      }
      if (table) {
        noteBlock(state, 'table');
        const bodyLines = [];
        while (i < n && !/^ *$/.test(L[i])) {
          const bl = L[i];
          const bInfo = leadInfo(bl);
          const bRest = bl.slice(bInfo.pos);
          if (isTableCode(bl) || tableRowStops(bRest, bInfo.col)) break;
          bodyLines.push(bl);
          i++;
        }
        out.push(renderTable(paraLines[0], table, bodyLines, ctx.refs, ctx));
        continue;
      }
      noteBlock(state, 'paragraph');
      // record the paragraph text and the thunk index so a
      // blockquote code-merge can extend the paragraph text
      // without re-lexing the combined lines
      const paraText = paraLines.join('\n');
      state.lastParaText = paraText;
      if (tight) {
        state.lastParaThunkIdx = out.length;
        out.push(inline(paraText, ctx.refs, ctx));
      } else {
        out.push('<p>');
        state.lastParaThunkIdx = out.length;
        out.push(inline(paraText, ctx.refs, ctx));
        out.push('</p>\n');
      }
      continue;
    }
  }
}

// Render a list starting at L[i]. Returns the next line index.
// Does a line break a list item (marked's list-continuation
// break checks)? The fence/heading/html/blockquote/bullet/hr
// checks use an indent limit of R-1 clamped to [0, 3], where R
// is the item's content indent.
function listBreakAt(line, R) {
  const maxInd = Math.max(0, Math.min(3, R - 1));
  const info = leadInfo(line);
  if (info.col > maxInd) return false;
  const rest = line.slice(info.pos);
  if (rest === '') return false;
  if (isHr(rest)) return true;
  if (matchAtx(rest)) return true;
  // a fence start: 3+ backticks or tildes (the info is not
  // checked here, unlike matchFence)
  if (rest[0] === '`' || rest[0] === '~') {
    let k = 0;
    while (k < rest.length && rest[k] === rest[0]) k++;
    if (k >= 3) return true;
  }
  if (rest[0] === '>') return true;
  const ht = htmlBlockType(rest);
  if (ht >= 1 && ht <= 6) return true;
  if (matchListMarker(rest, info.col)) return true;
  return false;
}

// Does a line look like a setext heading when appended to a
// first line's content? (the lheading test in marked's list
// tokenizer, approximated: the first line must not start a block)
function looksLikeSetext(firstContent, line) {
  const info = leadInfo(line);
  if (info.col > 3) return false;
  if (setextLevel(line.slice(info.pos)) === 0) return false;
  const fi = leadInfo(firstContent);
  if (fi.col >= 4) return false;
  const fr = firstContent.slice(fi.pos);
  if (fr === '') return false;
  return !interruptsParagraph(fr, fi.col, false);
}

function renderList(L, start, ctx, out, listIndent) {
  const firstLine = L[start];
  const firstInfo = leadInfo(firstLine);
  const firstRest = firstLine.slice(firstInfo.pos);
  const firstMarker = matchListMarker(firstRest, firstInfo.col);
  const ordered = firstMarker.ordered;
  const delim = firstMarker.delim;
  const bullet = firstMarker.bullet;
  const startNum = firstMarker.start;
  const items = [];
  let interItemBlank = false;
  let i = start;
  let curItem = null;
  let blankPending = false;
  let blankBeforeItem = false;
  while (i < L.length) {
    const line = L[i];
    if (isBlank(line)) {
      if (curItem) curItem.lines.push('');
      blankPending = true;
      blankBeforeItem = true;
      i++;
      continue;
    }
    const info = leadInfo(line);
    const ind = info.col;
    const rest = line.slice(info.pos);
    // an hr line ends the list, but only when it is not a
    // continuation of the current item (a '---' line at indent
    // >= the item's content indent is a setext underline inside
    // the item, not an hr)
    if ((curItem === null || ind < curItem.contentIndent) && ind <= 3 && isHr(rest)) break;
    const lm = ind <= 3 ? matchListMarker(rest, ind) : null;
    // new item of this list? A marker whose indent is below the
    // current item's content indent starts a sibling item; a marker
    // of a different list type at that level ends this list. For
    // bullet lists the bullet character must match too.
    if (lm && (curItem === null || ind < curItem.contentIndent)) {
      const sameType = curItem === null || (ordered && lm.ordered && lm.delim === delim) || (!ordered && !lm.ordered && lm.bullet === bullet);
      if (!sameType) break;
      if (blankPending && (items.length > 0 || curItem !== null)) interItemBlank = true;
      if (curItem) {
        items.push(curItem);
      }
      curItem = { lines: [], contentIndent: lm.contentIndent, first: true, firstContent: firstLineContent(line, ind, lm) };
      blankPending = false;
      blankBeforeItem = false;
      // first line content
      curItem.lines.push(curItem.firstContent);
      i++;
      // an empty item followed by a blank line closes the item
      // at once (marked's u flag): the blank line is consumed
      // and no continuation lines are collected for this item
      if (curItem.firstContent.trim() === '' && i < L.length && isBlank(L[i])) {
        items.push(curItem);
        curItem = null;
        i++;
        // the blank line after an empty item makes the list
        // loose when a later item follows (marked's
        // doubleBlankLine test on the empty item's raw text)
        blankPending = true;
        blankBeforeItem = true;
      }
      continue;
    }
    if (curItem === null) break;
    // a fence/heading/html/blockquote/bullet/hr line at indent
    // <= contentIndent - 1 breaks the item outright
    if (listBreakAt(line, curItem.contentIndent)) break;
    // continuation of the current item
    if (ind >= curItem.contentIndent) {
      // blank lines recorded as empty lines inside the item
      curItem.lines.push(stripIndent(line, curItem.contentIndent));
      blankPending = false;
      blankBeforeItem = false;
      i++;
      continue;
    }
    // lazy continuation: the item's last block is a paragraph
    const lastLines = curItem.lines;
    let paraOpen = false;
    if (lastLines.length > 0) {
      const last = lastLines[lastLines.length - 1];
      if (!isBlank(last)) paraOpen = paraOpenForLine(last);
    }
    if (paraOpen && !isBlank(line)) {
      // a lazy line cannot continue a fence/heading/html/hr
      // first line, an indented-code first line, or a line after
      // a blank line
      const fc = curItem.firstContent;
      const fInfo = leadInfo(fc);
      const fRest = fc.slice(fInfo.pos);
      if (blankPending) break;
      if (fInfo.col >= 4) break;
      if (matchFence(fRest) || matchAtx(fRest) || isHr(fRest) || (htmlBlockType(fRest) >= 1 && htmlBlockType(fRest) <= 6)) break;
      // a lazy setext-underline line gets 4 spaces prepended so
      // it is not a setext underline
      if (looksLikeSetext(fc, line)) {
        const li = leadInfo(line);
        curItem.lines.push('    ' + line.slice(li.pos));
      } else {
        curItem.lines.push(line);
      }
      blankPending = false;
      blankBeforeItem = false;
      i++;
      continue;
    }
    break;
  }
  if (curItem) {
    items.push(curItem);
  }
  // trailing blank lines consumed into the last item belong to
  // the parent: back up so the parent sees them as a separator
  // (a blank line between a nested list and the next block makes
  // the outer item loose)
  if (items.length > 0) {
    const lastLines = items[items.length - 1].lines;
    let trailBlank = 0;
    // trailing blank lines consumed into the last item belong to
    // the parent (never the item's first line, which is its own
    // content even when empty)
    while (trailBlank < lastLines.length - 1 && isBlank(lastLines[lastLines.length - 1 - trailBlank])) trailBlank++;
    if (trailBlank > 0) i -= trailBlank;
  }

  // Render the list. Looseness is decided by (a) a blank line
  // between two items, or (b) a blank line separating two blocks
  // inside an item (a blank line inside a nested structure does
  // not count). Each item is rendered once with a fresh state to
  // detect (b); loose lists are re-rendered with <p> wrappers.
  const tag = ordered ? 'ol' : 'ul';
  const openTag = ordered && startNum !== 1 ? '<ol start="' + startNum + '">' : '<' + tag + '>';
  const renderItem = (item, tight) => {
    let lines = item.lines;
    let task = null;
    if (lines.length > 0) {
      const fl = lines[0];
      if (fl.startsWith('[ ] ')) task = false;
      else if (fl.startsWith('[x] ') || fl.startsWith('[X] ')) task = true;
      if (task !== null) {
        lines = lines.slice();
        lines[0] = fl.slice(4);
      }
    }
    // drop trailing blank lines (a trailing one means the inner
    // text ends with a newline, for HTML-block trailing '\n')
    const itemEndsNL = lines.length > 0 && isBlank(lines[lines.length - 1]);
    while (lines.length > 0 && isBlank(lines[lines.length - 1])) lines = lines.slice(0, -1);
    const sub = [];
    const st = {};
    // a list item's content is lexed with top=false, so its
    // paragraph continuations are single-line text tokens and an
    // indented line is a code token merged into the paragraph
    // text with the indent stripped
    renderBlocks(lines, ctx, tight, sub, itemEndsNL, st, false);
    return { sub, task, state: st };
  };
  const rendered = items.map((item) => renderItem(item, true));
  let isLoose = interItemBlank;
  if (!isLoose) {
    for (const r of rendered) {
      if (r.state.blankSep) { isLoose = true; break; }
    }
  }
  const final = isLoose ? items.map((item) => renderItem(item, false)) : rendered;
  out.push(openTag + '\n');
  for (const r of final) {
    if (r.task !== null) {
      const box = '<input ' + (r.task ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
      // in a loose list the checkbox is part of the first
      // paragraph (inside the <p>); otherwise it is a token of
      // its own before the item's content
      if (isLoose && r.sub.length > 0 && r.sub[0] === '<p>') {
        out.push('<li>');
        out.push('<p>');
        out.push(box);
        for (let k = 1; k < r.sub.length; k++) out.push(r.sub[k]);
        out.push('</li>\n');
      } else {
        out.push('<li>' + box);
        out.push(r.sub);
        out.push('</li>\n');
      }
    } else {
      out.push('<li>');
      out.push(r.sub);
      out.push('</li>\n');
    }
  }
  out.push('</' + tag + '>\n');
  return i;
}

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  // A source ending in '\n' leaves a trailing '' line after the
  // split; dropping it keeps an unterminated fence from gaining an
  // extra newline of content.
  if (src.endsWith('\n')) lines.pop();
  const ctx = { refs: new Map(), srcEndsNL: src.endsWith('\n'), inLink: false, inRaw: false };
  const out = [];
  renderBlocks(lines, ctx, false, out, ctx.srcEndsNL, {});
  return joinOut(out);
}
