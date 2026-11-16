// parse.js — a fast, dependency-free Markdown renderer.
//
// Written from scratch for the markdown-render-speed-02 competition. It
// returns exactly the HTML marked 18.1.3 renders with its default options
// (GFM on, breaks off, pedantic off), but it is built as two passes of my
// own: a block pass that cuts the source into block tokens and collects
// link-reference definitions, then a render pass that turns tokens into
// HTML and runs the inline pass (escapes, code spans, links, emphasis,
// autolinks, strikethrough) directly to a string, without building an
// inline token tree first. The inline pass keeps a masked copy of the
// source so emphasis delimiters hidden inside links, code spans and HTML
// tags can never act as openers or closers.
//
// SPDX-License-Identifier: MIT

// ---------------------------------------------------------------- helpers

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape HTML special chars. When `encode` is true, `&` is always escaped;
// otherwise a `&` that already starts a valid entity or numeric reference
// is left alone (marked's escapeTestNoEncode behaviour).
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
const ESC_NOENC_TEST = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_NOENC_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function esc(s, encode) {
  if (encode) return ESC_TEST.test(s) ? s.replace(ESC_RE, (c) => ESC[c]) : s;
  return ESC_NOENC_TEST.test(s) ? s.replace(ESC_NOENC_RE, (c) => ESC[c]) : s;
}

const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
// Turn numeric character references into characters; a bare `&` that is
// not part of a valid reference becomes `&amp;`. Named entities are left
// alone here — the browser resolves them, and marked does the same.
function unescapeEntities(s) {
  if (!NUM_REF.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const n = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}

// Encode a link href the way marked does: encodeURI, then put back the
// literal `%` characters that were already percent-encoded.
function encodeHref(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch { return null; }
}

// A link label, normalised for lookup: trim, collapse inner whitespace to
// single spaces, then lower/upper/lower case folding (marked's `F`).
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Strip trailing characters from `s`: when `not` is false, strip trailing
// copies of `ch`; when true, strip trailing characters that are not `ch`.
// (marked's `L`: used to drop trailing newlines, and to count trailing
// backslashes before a closing paren.)
function trimEndChars(s, ch, not) {
  const n = s.length;
  let k = 0;
  for (; k < n;) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !not) k++;
    else if (c !== ch && not) k++;
    else break;
  }
  return s.slice(0, n - k);
}

// First line of `s` (without its newline), without allocating a split
// array the way `s.split('\n', 1)[0]` does.
// Does `s` end with two consecutive blank-ish lines (`\n` + optional
// spaces/tabs + `\n` + optional spaces/tabs)? A scan from the end
// instead of the `/\n[ \t]*\n[ \t]*$/` regex, which walks the whole
// string looking for a match that can only end at the string's end.
function endsDoubleBlank(s) {
  let i = s.length - 1;
  while (i >= 0 && (s[i] === ' ' || s[i] === '\t')) i--;
  if (i < 0 || s[i] !== '\n') return false;
  i--;
  while (i >= 0 && (s[i] === ' ' || s[i] === '\t')) i--;
  return i >= 0 && s[i] === '\n';
}

function firstLineOf(s) {
  const nl = s.indexOf('\n');
  return nl < 0 ? s : s.slice(0, nl);
}

// Expand tabs to spaces the way marked does when it measures indentation.
function expandTabs(s, offset) {
  let t = offset || 0;
  let out = '';
  for (const c of s) {
    if (c === '\t') { const r = 4 - (t % 4); out += ' '.repeat(r); t += r; }
    else { out += c; t++; }
  }
  return out;
}

// Split a table row on unescaped pipes, honouring `\|`, and drop empty
// leading/trailing cells. Pads or trims to `count` cells when given.
function splitRow(s, count) {
  const t = s.replace(/\|/g, (m, off, str) => {
    let back = false, p = off;
    for (; --p >= 0 && str[p] === '\\';) back = !back;
    return back ? '|' : ' |';
  });
  const cells = t.split(' |');
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Remove blank lines from the end of an indented code block's text,
// keeping at most one trailing blank line worth of newlines (marked's
// `ge`: a block ending in more than one blank line is trimmed to the
// last non-blank line plus one newline).
function trimCodeEnd(s) {
  const lines = s.split('\n');
  let end = lines.length - 1;
  for (; end >= 0 && /^[ \t]*$/.test(lines[end]);) end--;
  return lines.length - end <= 2 ? s : lines.slice(0, end + 1).join('\n');
}

// Are the parens in `s` balanced? Returns -1 when balanced, -2 when an
// opener is left unclosed, or the index of the first unmatched closer.
function parenBalance(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// Do the `<...>` tags in `s` look like real tags / autolinks, so that a
// `[text](...)` starting inside them must not be treated as a link?
// (marked's `Be`: an `<` is fine only when it starts a tag or autolink
// that ends inside the text.)
function hasTagBefore(src, text, bang, rules) {
  if (!text.includes('<')) return false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '`') {
      const m = rules.inline.code.exec(text.slice(i));
      if (m) { i += m[0].length - 1; continue; }
    }
    if (text[i] !== '<') continue;
    const rest = src.slice(bang + i);
    const m = rules.inline.tag.exec(rest) || rules.inline.autolink.exec(rest);
    if (m) {
      if (m[0].length > text.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}

// ---------------------------------------------------------------- regexes
//
// The patterns below are the ones marked 18.1.3 uses for the GFM rule
// set. Byte-identical output needs the same acceptance language, so the
// patterns match marked's; the code that runs them is my own. `tmpl`
// builds a pattern from a template string, substituting other patterns
// into named slots, and drops a leading `^` from a substituted pattern
// (an anchor only means something at the very start).

function tmpl(pat, flags) {
  let src = typeof pat === 'string' ? pat : pat.source;
  const api = {
    replace(search, repl) {
      let r = typeof repl === 'string' ? repl : repl.source;
      r = r.replace(/(^|[^\[])\^/g, '$1');
      src = src.replace(search, r);
      return api;
    },
    regex() { return new RegExp(src, flags); },
    source() { return src; },
  };
  return api;
}

const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HTML_ATTR = / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/;
const HR_SRC = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const W_SRC = ' {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HR_RE = new RegExp('^' + W_SRC);
const HEADING_BEGIN_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const HTML_BEGIN_SRC = ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';

// --- small shared patterns
const RE_CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const RE_OUTPUT_LINK = /\\([\[\]])/g;
const RE_INDENT_CODE_COMP = /^(\s+)(?:```)/;
const RE_BEGIN_SPACE = /^\s+/;
const RE_END_HASH = /#$/;
const RE_START_SPACE = /^ /;
const RE_END_SPACE = / $/;
const RE_END_SPACE_TAB = /[ \t]$/;
const RE_NON_SPACE = /[^ ]/;
const RE_NEWLINE_G = /\n/g;
const RE_TAB_G = /\t/g;
const RE_LEAD_SPACE_TAB = /^[ \t]+/;
const RE_MULTI_SPACE_G = /\s+/g;
const RE_BLANK = /^[ \t]*$/;
const RE_BQ_START = /^ {0,3}>/;
const RE_BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const RE_BQ_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const RE_BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const RE_LIST_NEST = /^ {1,4}(?=( {4})*[^ ])/g;
const RE_LIST_TASK = /^\[[ xX]\][ \t]+\S/;
const RE_LIST_TASK_REP = /^\[[ xX]\][ \t]+/;
const RE_LIST_CHECKBOX = /\[[ xX]\]/;
const RE_ANY_LINE = /\n.*\n/;
const RE_HREF_BRACKETS = /^<(.*)>$/;
const RE_TABLE_DELIM = /[:|]/;
const RE_TABLE_ALIGN_CHARS = /^\||\| *$/g;
const RE_TABLE_ROW_BLANK = /\n[ \t]*$/;
const RE_TABLE_RIGHT = /^ *-+: *$/;
const RE_TABLE_CENTER = /^ *:-+: *$/;
const RE_TABLE_LEFT = /^ *:-+ *$/;
const RE_START_A = /^<a /i;
const RE_END_A = /^<\/a>/i;
const RE_START_PRE = /^<(pre|code|kbd|script)(\s|>)/i;
const RE_END_PRE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const RE_START_ANGLE = /^</;
const RE_END_ANGLE = />$/;
const RE_UNICODE_ALNUM = /[\p{L}\p{N}]/u;
const RE_NOT_SPACE_START = /^\S*/;
const RE_END_NEWLINE = /\n$/;
const RE_CR = /\r\n|\r/g;

// Indent-dependent block-start tests. Marked builds these through a
// helper that clamps the indent to `max(0, min(3, n - 1))` — the same
// regex is reused for every indent past 3 — so this does the same.
const _reCache = new Map();
function cachedRe(key, make) {
  let r = _reCache.get(key);
  if (!r) { r = make(); _reCache.set(key, r); }
  return r;
}
const clampIndent = (n) => Math.max(0, Math.min(3, n - 1));
const listItemRe = (bull) => cachedRe('li:' + bull, () => new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`));
const nextBulletRe = (n) => { const k = clampIndent(n); return cachedRe('nb:' + k, () => new RegExp(`^ {0,${k}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\\n|$))`)); };
const hrAtRe = (n) => { const k = clampIndent(n); return cachedRe('hr:' + k, () => new RegExp(`^ {0,${k}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)); };
const fencesBeginRe = (n) => { const k = clampIndent(n); return cachedRe('fe:' + k, () => new RegExp(`^ {0,${k}}(?:\`\`\`|~~~)`)); };
const headingBeginRe = (n) => { const k = clampIndent(n); return cachedRe('he:' + k, () => new RegExp(`^ {0,${k}}#{1,6}(?:\\s|$)`)); };
const htmlBeginRe = (n) => { const k = clampIndent(n); return cachedRe('ht:' + k, () => new RegExp(`^ {0,${k}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')); };
const bqBeginRe = (n) => { const k = clampIndent(n); return cachedRe('bq:' + k, () => new RegExp(`^ {0,${k}}>`)); };

// --- block patterns (GFM)
const BLOCK_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const BLOCK_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const BLOCK_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const BLOCK_HR = HR_RE;
const BLOCK_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BLOCK_TEXT = /^[^\n]+/;
const BLOCK_LIST = tmpl(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, BULLET).regex();
const LABEL_RE = /(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const LABEL_LOOK = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const TITLE_RE = /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
const BLOCK_DEF = tmpl(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', LABEL_LOOK).replace('title', TITLE_RE).regex();
const HTML_BLOCK = tmpl('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i')
  .replace('comment', HTML_COMMENT).replace('tag', BLOCK_TAGS).replace('attribute', HTML_ATTR).regex();

// Setext heading (GFM): the second lookahead also stops at a table
// delimiter row, so a `---` under text is a heading, not a table.
const LHEADING_BASE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const BLOCK_LHEADING = tmpl(LHEADING_BASE)
  .replace(/bull/g, BULLET)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, HR_SRC)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).regex();

// GFM table: header line, delimiter line, then body rows until a line
// that starts another block.
const BLOCK_TABLE = tmpl('^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', W_SRC)
  .replace('heading', HEADING_BEGIN_SRC)
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', HTML_BEGIN_SRC)
  .replace('tag', BLOCK_TAGS).regex();

// Paragraph: one or more lines, stopping before a blank line or a line
// that starts a block which may interrupt a paragraph.
const PARA_BASE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const BLOCK_PARA = tmpl(PARA_BASE)
  .replace('hr', W_SRC)
  .replace('heading', HEADING_BEGIN_SRC)
  .replace('|lheading', '')
  .replace('table', BLOCK_TABLE)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', HTML_BEGIN_SRC)
  .replace('tag', BLOCK_TAGS).regex();
const BQ_PARA = tmpl(PARA_BASE)
  .replace('hr', W_SRC)
  .replace('heading', HEADING_BEGIN_SRC)
  .replace('|lheading', '')
  .replace('|table', '')
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)')
  .replace('html', HTML_BEGIN_SRC)
  .replace('tag', BLOCK_TAGS).regex();
const BLOCK_BQ = tmpl(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace('paragraph', BQ_PARA).regex();

// --- inline patterns (GFM)
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_NT = /(?!~)[\p{P}\p{S}]/u;          // punctuation except ~
const PUNCT_SPACE_NT = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_NT = /(?:[^\s\p{P}\p{S}]|~)/u;
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;

const INLINE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const INLINE_TAG = tmpl('^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', tmpl(HTML_COMMENT).replace('(?:-->|$)', '-->').regex())
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).regex();
const INLINE_AUTOLINK = tmpl(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).regex();
const EMAIL_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const MAILTO_RE = tmpl(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, EMAIL_RE).regex();
const SCHEME_RE = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const URL_EMAIL = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const INLINE_URL = tmpl(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', MAILTO_RE).replace('protocol', SCHEME_RE).replace('email', URL_EMAIL).regex();
const BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Cheap pre-check for the autolink-URL regex: it can only match when
// the text ahead starts with `www.`, a scheme (`http`/`https`/`ftp`),
// a `mailto:`/`xmpp:` prefix, or an email local part followed by `@`.
// Running the full regex on every text run costs a scan of the first
// word; this guard replaces it with a few character comparisons.
function urlMaybe(rest) {
  const c = rest.charCodeAt(0);
  if (c === 119 && rest.startsWith('www.')) return true; // w
  if (c === 109 && rest.startsWith('mailto:')) return true; // m
  if (c === 120 && rest.startsWith('xmpp:')) return true; // x
  if (c === 104 || c === 72) { // h/H: http(s)
    if ((rest.charCodeAt(1) | 32) === 116 && (rest.charCodeAt(2) | 32) === 116
      && (rest.charCodeAt(3) | 32) === 112) return true;
  }
  if (c === 102 || c === 70) { // f/F: ftp
    if ((rest.charCodeAt(1) | 32) === 116 && (rest.charCodeAt(2) | 32) === 112) return true;
  }
  // Email: a local-part run ([A-Za-z0-9._+-]) ending at `@`.
  if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
    || c === 46 || c === 95 || c === 43 || c === 45) {
    for (let i = 1; i < rest.length; i++) {
      const d = rest.charCodeAt(i);
      if (d === 64) return true; // @
      if (!((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122)
        || d === 46 || d === 95 || d === 43 || d === 45)) return false;
    }
  }
  return false;
}
const INLINE_TEXT = tmpl(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', SCHEME_RE)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', /(?<![^\s*_~(])www\./).regex();

// Link labels: `re` is the label used inside `[...](...)`, `le` the one
// used for definitions and reference links.
const BRACKET_RE = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL_IN_LINK = tmpl(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace('brackets', BRACKET_RE).regex();
const INLINE_LINK = tmpl(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', LABEL_IN_LINK)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/).regex();
const INLINE_REFLINK = tmpl(/^!?\[(label)\]\[(ref)\]/).replace('label', LABEL_IN_LINK).replace('ref', LABEL_LOOK).regex();
const INLINE_NOLINK = tmpl(/^!?\[(ref)\](?:\[\])?/).replace('ref', LABEL_LOOK).regex();
const LT_LABEL = tmpl(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace('brackets', BRACKET_RE).regex();
const BE_RE = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const REFLINK_SEARCH = tmpl('reflink|nolink(?!\\()', 'g')
  .replace('reflink', tmpl(/^!?\[(label)\]\[(ref)\]/).replace('label', LT_LABEL).replace('ref', BE_RE).regex())
  .replace('nolink', tmpl(/^!?\[(ref)\](?:\[\])?/).replace('ref', BE_RE).regex()).regex();

// Emphasis delimiters. The left-delimiter pattern reports the character
// after the run (punctuation in group 1/3, other in group 2/4); the
// right-delimiter patterns scan the masked source for a run that can
// close, reporting the run in one of groups 1-6.
const LDELIM_BASE = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const EM_LDELIM = tmpl(LDELIM_BASE, 'u').replace(/punct/g, PUNCT_NT).regex();
const RDELIM_AST_BASE = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const EM_RDELIM_AST = tmpl(RDELIM_AST_BASE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_NT).replace(/punctSpace/g, PUNCT_SPACE_NT).replace(/punct/g, PUNCT_NT).regex();
const RDELIM_UND_BASE = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
const EM_RDELIM_UND = tmpl(RDELIM_UND_BASE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE).replace(/punctSpace/g, PUNCT_SPACE).replace(/punct/g, PUNCT).regex();
const DEL_LDELIM = tmpl(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').replace(/punct/g, PUNCT).regex();
const DEL_RDELIM_BASE = '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
const DEL_RDELIM = tmpl(DEL_RDELIM_BASE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE).replace(/punctSpace/g, PUNCT_SPACE).replace(/punct/g, PUNCT).regex();

// Masking patterns: punctuation runs outside code spans, and whole
// links / code spans / tags, are hidden from the emphasis scan.
const ANY_PUNCT = tmpl(/\\(punct)/, 'gu').replace(/punct/g, PUNCT).regex();
const ANY_PUNCT_OUTSIDE_CODE = tmpl(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').replace(/punct/g, PUNCT).regex();
const BLOCK_SKIP = tmpl(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/).regex();
const PUNCT_TEST = tmpl(/^((?![*_])punctSpace)/, 'u').replace(/punctSpace/g, PUNCT_SPACE).regex();

// ---------------------------------------------------------------- block pass
//
// The block pass cuts the source into tokens and collects link-reference
// definitions into `ctx.links`. Inline rendering happens later, once the
// whole document's definitions are known — a link defined at the bottom
// of the document still applies to a paragraph at the top. Tokens are
// plain objects: { t:'paragraph', raw, text }, { t:'list', ... }, and so
// on. `top` says whether we are at the document's top level (only there
// may a paragraph start); `inBq` says we are inside a blockquote chunk,
// where a paragraph may continue the previous one.

// Per-parse context. Fresh for every parse() call.
function newCtx() {
  return { links: Object.create(null), top: true };
}

function lexBlocks(src, ctx, into, inBq) {
  into = into || [];
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    let tok = null;
    let m;
    // First-character dispatch: a block starting with an ordinary
    // character (not a newline, space, tab, or one of `# - _ * + > < [`
    // backtick, tilde, digit) can only be a table, a setext heading, a
    // paragraph or plain text, so the other nine rules cannot match and
    // are skipped outright.
    const c0 = src.charCodeAt(0);
    const plainStart = c0 !== 10 && c0 !== 32 && c0 !== 9
      && c0 !== 96 && c0 !== 126 && c0 !== 35 && c0 !== 45 && c0 !== 95
      && c0 !== 42 && c0 !== 43 && c0 !== 62 && c0 !== 60 && c0 !== 91
      && !(c0 >= 48 && c0 <= 57);
    if (!plainStart) {
    // Blank lines. A single newline just extends the previous token's
    // raw text; anything longer becomes a space token of its own.
    m = BLOCK_NEWLINE.exec(src);
    if (m && m[0].length > 0) {
      src = src.substring(m[0].length);
      const prev = into[into.length - 1];
      if (m[0].length === 1 && prev !== undefined) prev.raw += '\n';
      else into.push({ t: 'space', raw: m[0] });
      continue;
    }
    // Indented code. A paragraph absorbs a following indented block as
    // literal text instead (marked's paragraph/code merge).
    m = BLOCK_CODE.exec(src);
    if (m) {
      const raw = trimCodeEnd(m[0]);
      const text = raw.replace(RE_CODE_REMOVE_INDENT, '');
      src = src.substring(m[0].length);
      const prev = into[into.length - 1];
      if (prev && (prev.t === 'paragraph' || prev.t === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
        prev.text += '\n' + text;
      } else into.push({ t: 'code', raw, text, lang: undefined });
      continue;
    }
    // Fenced code.
    m = BLOCK_FENCES.exec(src);
    if (m) {
      let text = m[3] || '';
      const fence = m[0].match(RE_INDENT_CODE_COMP);
      if (fence !== null) {
        const ind = fence[1];
        text = text.split('\n').map((line) => {
          const sp = line.match(RE_BEGIN_SPACE);
          if (sp === null) return line;
          return line.slice(Math.min(sp[0].length, ind.length));
        }).join('\n');
      }
      const lang = m[2] ? m[2].trim().replace(ANY_PUNCT, '$1') : m[2];
      src = src.substring(m[0].length);
      into.push({ t: 'code', raw: m[0], text, lang });
      continue;
    }
    // ATX heading.
    m = BLOCK_HEADING.exec(src);
    if (m) {
      let text = m[2].trim();
      if (RE_END_HASH.test(text)) {
        const stripped = trimEndChars(text, '#');
        if (!stripped || RE_END_SPACE_TAB.test(stripped)) text = stripped.trim();
      }
      src = src.substring(m[0].length);
      into.push({ t: 'heading', raw: trimEndChars(m[0], '\n'), depth: m[1].length, text });
      continue;
    }
    // Thematic break.
    m = BLOCK_HR.exec(src);
    if (m) {
      src = src.substring(m[0].length);
      into.push({ t: 'hr', raw: trimEndChars(m[0], '\n') });
      continue;
    }
    // Blockquote (handled by its own function: it re-lexes its content
    // in chunks, and may re-lex a nested quote or list at the end).
    tok = lexBlockquote(src, ctx);
    if (tok) { src = src.substring(tok.raw.length); into.push(tok); continue; }
    // List.
    tok = lexList(src, ctx);
    if (tok) { src = src.substring(tok.raw.length); into.push(tok); continue; }
    // HTML block.
    m = HTML_BLOCK.exec(src);
    if (m) {
      const raw = trimCodeEnd(m[0]);
      src = src.substring(m[0].length);
      into.push({ t: 'html', raw, text: raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style' });
      continue;
    }
    // Link reference definition. A paragraph absorbs a following
    // definition line into its own text instead of registering it.
    m = BLOCK_DEF.exec(src);
    if (m) {
      if (!RE_START_ANGLE.test(m[2]) && parenBalance(m[2]) !== -1) { /* not a def */ }
      else {
        const tag = normLabel(m[1]);
        const href = m[2] ? m[2].replace(RE_HREF_BRACKETS, '$1').replace(ANY_PUNCT, '$1') : '';
        const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT, '$1') : m[3];
        src = src.substring(m[0].length);
        const prev = into[into.length - 1];
        if (prev && (prev.t === 'paragraph' || prev.t === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + trimEndChars(m[0], '\n');
          prev.text += '\n' + trimEndChars(m[0], '\n');
        } else {
          if (!ctx.links[tag]) ctx.links[tag] = { href, title };
          into.push({ t: 'def', tag, raw: trimEndChars(m[0], '\n'), href, title });
        }
        continue;
      }
    }
    }
    // GFM table.
    tok = lexTable(src);
    if (tok) { src = src.substring(tok.raw.length); into.push(tok); continue; }
    // Setext heading.
    m = BLOCK_LHEADING.exec(src);
    if (m) {
      const text = m[1].trim();
      src = src.substring(m[0].length);
      into.push({ t: 'heading', raw: trimEndChars(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text });
      continue;
    }
    // Paragraph (top level only, or continuing one inside a quote).
    if (ctx.top) {
      m = BLOCK_PARA.exec(src);
      if (m) {
        const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
        const raw = m[0];
        src = src.substring(raw.length);
        const prev = into[into.length - 1];
        if (inBq && prev && prev.t === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
          prev.text += '\n' + text;
        } else into.push({ t: 'paragraph', raw, text });
        continue;
      }
    }
    // Plain text (only reached when not at top level).
    m = BLOCK_TEXT.exec(src);
    if (m) {
      const raw = m[0];
      src = src.substring(raw.length);
      const prev = into[into.length - 1];
      if (prev && prev.t === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
        prev.text += '\n' + raw;
      } else into.push({ t: 'text', raw, text: raw });
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  ctx.top = true;
  return into;
}

function lexTable(src) {
  const m = BLOCK_TABLE.exec(src);
  if (!m || !RE_TABLE_DELIM.test(m[2])) return null;
  const head = splitRow(m[1]);
  const aligns = m[2].replace(RE_TABLE_ALIGN_CHARS, '').split('|');
  if (head.length !== aligns.length) return null;
  const align = aligns.map((a) =>
    RE_TABLE_RIGHT.test(a) ? 'right'
    : RE_TABLE_CENTER.test(a) ? 'center'
    : RE_TABLE_LEFT.test(a) ? 'left' : null);
  const rows = m[3] && m[3].trim()
    ? m[3].replace(RE_TABLE_ROW_BLANK, '').split('\n') : [];
  return {
    t: 'table',
    raw: trimEndChars(m[0], '\n'),
    header: head.map((c, i) => ({ text: c, align: align[i] })),
    rows: rows.map((r) => splitRow(r, head.length).map((c, i) => ({ text: c, align: align[i] }))),
  };
}

function lexBlockquote(src, ctx) {
  const m = BLOCK_BQ.exec(src);
  if (!m) return null;
  let lines = trimEndChars(m[0], '\n').split('\n');
  let raw = '', text = '';
  const tokens = [];
  while (lines.length > 0) {
    let inQuote = false;
    const chunk = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (RE_BQ_START.test(lines[p])) { chunk.push(lines[p]); inQuote = true; }
      else if (!inQuote) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const chunkStr = chunk.join('\n');
    const stripped = chunkStr
      .replace(RE_BQ_MARKER_WS, (g, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(RE_BQ_SETEXT, '\n    $1')
      .replace(RE_BQ_SETEXT2, '');
    raw = raw ? raw + '\n' + chunkStr : chunkStr;
    text = text ? text + '\n' + stripped : stripped;
    const savedTop = ctx.top;
    ctx.top = true;
    lexBlocks(stripped, ctx, tokens, true);
    ctx.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last && (last.t === 'code' || last.t === 'heading' || last.t === 'hr' || last.t === 'html' || last.t === 'table')) break;
    if (last && last.t === 'blockquote') {
      const rest = lines.join('\n');
      const joined = last.raw + '\n' + rest.replace(RE_BQ_SETEXT2, '');
      const relexed = lexBlockquote(joined, ctx);
      tokens[tokens.length - 1] = relexed;
      const leftover = joined.substring(relexed.raw.length).replace(/^\n/, '');
      const leftCount = leftover ? leftover.split('\n').length : 0;
      const extra = leftCount ? lines.slice(0, -leftCount) : lines;
      if (extra.length > 0) raw = raw + '\n' + extra.join('\n');
      text = text.substring(0, text.length - last.text.length) + relexed.text;
      lines = lines.slice(extra.length);
      if (lines.length > 0 && RE_BQ_START.test(lines[0])) continue;
      break;
    }
    if (last && last.t === 'list') {
      const joined = last.raw + '\n' + lines.join('\n');
      const relexed = lexList(joined, ctx);
      tokens[tokens.length - 1] = relexed;
      const extraCount = relexed.raw.length > last.raw.length
        ? joined.slice(last.raw.length + 1, relexed.raw.length).split('\n').length : 0;
      if (extraCount > 0) {
        const y = lines.slice(0, extraCount).join('\n');
        raw = raw + '\n' + y;
        text = text + '\n' + y;
      }
      lines = lines.slice(extraCount);
      continue;
    }
  }
  return { t: 'blockquote', raw, text, tokens };
}

function lexList(src, ctx) {
  const m = BLOCK_LIST.exec(src);
  if (!m) return null;
  const all = src;
  let rest = src;
  const marker = m[1].trim();
  const ordered = marker.length > 1;
  const list = {
    t: 'list', raw: '', ordered,
    start: ordered ? +marker.slice(0, -1) : '', loose: false, items: [],
  };
  const bullPat = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
  const itemRe = listItemRe(bullPat);
  let sawBlank = false;
  while (rest) {
    let itemBlank = false;
    let content = '';
    const it = itemRe.exec(rest);
    if (!it || BLOCK_HR.test(rest)) break;
    const startPos = all.length - rest.length;
    rest = rest.substring(it[0].length);
    const firstLine = firstLineOf(it[2]);
    const indent = it[1].length;
    let markerText = firstLine.replace(RE_LEAD_SPACE_TAB, (v) => expandTabs(v, indent));
    let nextLine = firstLineOf(rest);
    let isEmpty = !markerText.trim();
    let width = 0;
    if (isEmpty && RE_BLANK.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      itemBlank = true;
    }
    if (!itemBlank) {
      if (isEmpty) width = indent + 1;
      else {
        width = markerText.search(RE_NON_SPACE);
        width = width > 4 ? 1 : width;
        content = markerText.slice(width);
        width += indent;
      }
      const nextBullet = nextBulletRe(width);
      const hrHere = hrAtRe(width);
      const fencesHere = fencesBeginRe(width);
      const headingHere = headingBeginRe(width);
      const htmlHere = htmlBeginRe(width);
      const bqHere = bqBeginRe(width);
      while (rest) {
        const line = firstLineOf(rest);
        nextLine = line;
        // Most lines start with a non-space character, for which the
        // leading-whitespace replace is a no-op; skip calling it then.
        const stripped = (line.charCodeAt(0) === 32 || line.charCodeAt(0) === 9)
          ? line.replace(RE_LEAD_SPACE_TAB, (v) => expandTabs(v)) : line;
        // First-character dispatch: only the block-start tests whose
        // first character matches the line's first non-space character
        // can match, so a plain prose line runs none of the six.
        const ns = stripped.search(RE_NON_SPACE);
        const fc = ns < 0 ? -1 : stripped.charCodeAt(ns);
        let blocked = false;
        if (fc === 96 || fc === 126) blocked = fencesHere.test(line);
        else if (fc === 35) blocked = headingHere.test(line);
        else if (fc === 60) blocked = htmlHere.test(line);
        else if (fc === 62) blocked = bqHere.test(line);
        else if (fc === 42 || fc === 43 || fc === 45 || (fc >= 48 && fc <= 57)) {
          blocked = nextBullet.test(line)
            || ((fc === 45 || fc === 42) && hrHere.test(line));
        } else if (fc === 95) blocked = hrHere.test(line);
        if (blocked) break;
        if (ns >= width || !line.trim()) {
          content += '\n' + stripped.slice(width);
        } else {
          if (isEmpty || (markerText.includes('\t')
              ? markerText.replace(RE_TAB_G, '    ').search(RE_NON_SPACE)
              : markerText.search(RE_NON_SPACE)) >= 4
            || fencesHere.test(markerText) || headingHere.test(markerText)
            || htmlHere.test(markerText) || hrHere.test(markerText)) break;
          const setext = /^ {0,3}(?:=+|-+) *$/.test(line)
            && BLOCK_LHEADING.test(markerText + '\n' + line)
            ? '    ' + stripped.replace(/^ {0,3}/, '') : line;
          content += '\n' + setext;
        }
        // `isEmpty` and `markerText` follow the current line from here
        // on, exactly as marked reassigns y and m each round.
        isEmpty = !line.trim();
        rest = rest.substring(line.length + 1);
        markerText = stripped.slice(width);
      }
    }
    const itemRaw = all.slice(startPos, all.length - rest.length);
    if (!list.loose) {
      if (sawBlank) list.loose = true;
      else if (endsDoubleBlank(itemRaw)) sawBlank = true;
    }
    list.items.push({
      t: 'list_item', raw: itemRaw,
      task: RE_LIST_TASK.test(content), loose: false, text: content, tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = all.slice(0, all.length - rest.length).trimEnd();
  for (const item of list.items) {
    ctx.top = false;
    item.tokens = lexBlocks(item.text, ctx, [], false);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.t === 'space');
      if (spaces.length > 0 && spaces.some((t) => RE_ANY_LINE.test(t.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && first && (first.t === 'text' || first.t === 'paragraph')) {
      item.text = item.text.replace(RE_LIST_TASK_REP, '');
      first.raw = first.raw.replace(RE_LIST_TASK_REP, '');
      first.text = first.text.replace(RE_LIST_TASK_REP, '');
      const cb = RE_LIST_CHECKBOX.exec(item.raw);
      if (cb) {
        const box = { t: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
        item.checked = box.checked;
        if (list.loose && first && (first.t === 'paragraph' || first.t === 'text')) {
          first.lead = box;
        } else item.tokens.unshift(box);
      }
    } else if (item.task) item.task = false;
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.tokens) if (tok.t === 'text') tok.t = 'paragraph';
    }
  }
  return list;
}

// ---------------------------------------------------------------- inline pass
//
// Inline rendering works straight to a string. Each inline source gets a
// masked twin of the same length: reference-link labels, whole links,
// code spans and tags are replaced by inert filler, and punctuation runs
// outside code spans become `+` runs, so the emphasis scan can tell
// whether a `*` or `_` is really visible. The mask is only consulted by
// the emphasis / strikethrough closers; the HTML itself is always built
// from the original source.

// Shared inline state, kept on the parse context: `inLink` survives from
// one block token to the next (an unclosed `<a>` stays open, as in
// marked), `inRawBlock` is reset for every new inline source.
function newInlineState() {
  return { inLink: false, inRawBlock: false, linkEmitted: false };
}

// Does `src` contain a link (inline or reference) at all? Used while
// masking reference labels: a label that itself contains a link must not
// be hidden, or its inner link would stop working.
function linkInText(src, ctx) {
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(BLOCK_SKIP)) {
    if (INLINE_LINK.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(REFLINK_SEARCH)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(ctx.links, normLabel(s.slice(r + 1, -1))))
      && !(r > 1 && linkInText(s.slice(1, r - 1), ctx))) return true;
  }
  return false;
}

// The masking pipeline, in marked's order: reference-label masking,
// punctuation masking outside code spans, then whole-link / code / tag
// masking. Every replacement keeps the string's length, so offsets into
// the masked string are offsets into the original.
function maskSource(src, ctx) {
  let t = src;
  if (src.includes('[')) {
    const sub = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, ctx)) {
          return '[' + inner.replace(REFLINK_SEARCH, sub) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(REFLINK_SEARCH, sub);
  }
  // Punctuation runs outside code spans become `+` runs, except that a
  // match at offset 0 keeps its first character (so the very first
  // character of the source still reads as itself). The pattern only
  // matches code spans and escaped punctuation, so with no backtick and
  // no backslash in the string there is nothing to replace.
  if (t.includes('`') || t.includes('\\')) {
    t = t.replace(ANY_PUNCT_OUTSIDE_CODE, (n, ticks, offset) =>
      offset ? '+'.repeat(n.length)
      : ticks ? ticks + n.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks
      : n);
  }
  // Whole links, code spans and tags become `[aaa...]`. None of those
  // can occur without one of `[`, backtick or `<` in the source.
  if (t.includes('[') || t.includes('`') || t.includes('<')) {
    t = t.replace(BLOCK_SKIP, (n) => '[' + 'a'.repeat(n.length - 2) + ']');
  }
  return t;
}

// Where in the masked source can a run of each delimiter last close
// an opener? One pass over the masked source, recording the last run
// of `*`, `_` and `~` whose preceding character is not whitespace.
function lastCloserAll(masked) {
  let star = -1, und = -1, tilde = -1;
  for (let i = 0; i < masked.length;) {
    const c = masked[i];
    if (c !== '*' && c !== '_' && c !== '~') { i++; continue; }
    let j = i;
    while (j < masked.length && masked[j] === c) j++;
    const prev = i === 0 ? '\n' : masked[i - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (c === '*') star = i;
      else if (c === '_') und = i;
      else tilde = i;
    }
    i = j;
  }
  return { star, und, tilde };
}

// Code-point length of a delimiter run plus its following character:
// only that final character can be astral, so only it needs the check
// (a spread would allocate an array on every emphasis attempt).
function runCodeLen(s) {
  const n = s.length;
  const last = s.charCodeAt(n - 1);
  return n - (last >= 0xDC00 && last <= 0xDFFF ? 1 : 0);
}

// UTF-16 length of the first code point of `s`: 2 when it starts with
// a high surrogate, 1 otherwise.
function firstCodeLen(s) {
  const first = s.charCodeAt(0);
  return first >= 0xD800 && first <= 0xDBFF ? 2 : 1;
}

// Try to read an emphasis or strong span starting at `pos` in `src`.
// `prev` is the character before the run (or ''), and `getMask`
// materialises the masked source and its last-closer indexes on first
// use. Returns { raw, inner } or null.
function tryEmStrong(src, pos, prev, getMask) {
  const e = src.slice(pos);
  const s = EM_LDELIM.exec(e);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const delim = s[0][0];
  // Fast rejection without the mask: a `_` opener followed by a word
  // character while preceded by one (an identifier like `foo_bar`) can
  // never open. When the preceding character is a word character the
  // delimiter run cannot extend to the left, so this test is exact; the
  // same check runs again below with the masked predecessor.
  if (s[4] && RE_UNICODE_ALNUM.test(prev)) return null;
  const { masked, star, und } = getMask();
  const closer = delim === '*' ? star : und;
  const sameBefore = prev === delim;
  const i = pos;
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  const beforeRun = l === 0 ? '' : masked[l - 1];
  const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || !!PUNCT_TEST.exec(beforeRun);
  if (l < i) prev = beforeRun;
  const prevIsPunct = l < i ? beforeIsPunct : !!PUNCT_TEST.exec(prev);
  if (s[4] && RE_UNICODE_ALNUM.test(prev)) return null;
  const afterPunct = s[1] || s[3] || '';
  // An opener must be left-flanking (or at the start): it may not be
  // followed by punctuation while preceded by a word character.
  if (afterPunct && prev && !prevIsPunct) return null;
  const k = runCodeLen(s[0]) - 1; // delimiters in the opening run
  let need = k, extra = 0;
  const runTotal = i - l + k;
  const canCloseOdd = !!beforeRun.trim() && (!!afterPunct || (delim === '*' && !beforeIsPunct));
  const rx = delim === '*' ? EM_RDELIM_AST : EM_RDELIM_UND;
  const afterOpen = i + k;
  if (closer < afterOpen) return null;
  const rest = masked.slice(pos + k);
  const limit = closer - afterOpen;
  rx.lastIndex = 0;
  let m;
  while ((m = rx.exec(rest)) !== null && !(m.index > limit)) {
    const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
    if (!g) continue;
    const b = g.length;
    if (m[3] || m[4]) { need += b; continue; }
    if (m[5] || m[6] || canCloseOdd) {
      if (sameBefore && (m[5] || m[6])) break;
      if (runTotal % 3 && !((runTotal + b) % 3)) { extra += b; continue; }
    }
    need -= b;
    if (need > 0) continue;
    const use = Math.min(b, b + need + extra);
    const firstLen = firstCodeLen(m[0]);
    const raw = e.slice(0, k + m.index + firstLen + use);
    if (Math.min(k, use) % 2) return { raw, inner: raw.slice(1, -1), strong: false };
    return { raw, inner: raw.slice(2, -2), strong: true };
  }
  return null;
}

// Try to read a `~~...~~` strikethrough span starting at `pos`.
function tryDel(src, pos, prev, getMask) {
  const e = src.slice(pos);
  const s = DEL_LDELIM.exec(e);
  if (!s) return null;
  // Same left-flanking gate as emphasis: no opener when followed by
  // punctuation and preceded by a word character.
  if ((s[1] || '') && prev && !PUNCT_TEST.exec(prev)) return null;
  const { masked, tilde } = getMask();
  const closer = tilde;
  const open = runCodeLen(s[0]) - 1; // 1 or 2 tildes
  let need = open;
  const afterOpen = pos + open;
  if (closer < afterOpen) return null;
  const rest = masked.slice(pos + open);
  const limit = closer - afterOpen;
  DEL_RDELIM.lastIndex = 0;
  let m;
  while ((m = DEL_RDELIM.exec(rest)) !== null && !(m.index > limit)) {
    const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
    if (!g) continue;
    const len = g.length;
    if (len !== open) continue;
    if (m[3] || m[4]) { need += len; continue; }
    need -= len;
    if (need > 0) continue;
    const use = Math.min(len, len + need);
    const firstLen = firstCodeLen(m[0]);
    const raw = e.slice(0, open + m.index + firstLen + use);
    return { raw, inner: raw.slice(open, -open) };
  }
  return null;
}

// The characters and prefixes at which a plain-text run must stop, so
// the inline loop can hand control back to the special-case branches:
// a backslash, a tag or code-span opener, a link or image opener, an
// emphasis or strikethrough delimiter, an underscore at a word boundary,
// a hard break, a bare `@` that starts an email, or the start of a
// `www.` / scheme / `mailto:` autolink. A match that cannot start one
// of those (an underscore inside a word, a `www.` after a letter, a
// `mailto:` after a word character, a bare `@`) is skipped over.
const TEXT_STOP = /[\\`<[!*~_@]| {2,}\n|www\.|https?:\/\/|ftp:\/\/|mailto:|xmpp:/gi;
const isWordCode = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90)
  || (c >= 97 && c <= 122) || c === 95;
const isAlnumCode = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isEmailCode = (c) => isAlnumCode(c) || c === 46 || c === 33 || c === 35 || c === 36
  || c === 37 || c === 38 || c === 39 || c === 42 || c === 43 || c === 47 || c === 61
  || c === 63 || c === 94 || c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126
  || c === 45;

// End index of the plain-text run at the start of `rest`: the position
// where marked's text rule would stop, so the run appended here is
// exactly the text the text rule would have matched. Returns 0 when the
// first character needs special handling.
function textScanEnd(rest) {
  // Where an email-character run followed by `@` starts, for a `@` at or
  // after `q` (or -1 when there is none in the run). The text rule stops
  // at that start, whatever precedes it, so a stop found later in the
  // run must give way to it. Results are memoised: the stops arrive in
  // order, so a later scan only re-walks what an earlier one covered.
  let memoEnd = -1, memoAt = -1, memoE0 = -1;
  const emailRunStart = (q) => {
    if (q < memoEnd) return memoAt < 0 ? -1 : memoE0;
    let i = q;
    while (i < rest.length && isEmailCode(rest.charCodeAt(i))) i++;
    memoEnd = i;
    if (i >= rest.length || rest.charCodeAt(i) !== 64) { memoAt = -1; return -1; }
    memoAt = i;
    let e0 = i;
    while (e0 > 0 && isEmailCode(rest.charCodeAt(e0 - 1))) e0--;
    memoE0 = e0;
    return e0;
  };
  TEXT_STOP.lastIndex = 0;
  let m;
  while ((m = TEXT_STOP.exec(rest)) !== null) {
    const q = m.index;
    // An email starting before this stop fires first.
    const e0 = emailRunStart(q);
    if (e0 >= 0 && e0 < q) return e0;
    const lower = m[0].toLowerCase();
    if (lower === 'www.') {
      if (q === 0) return 0;
      const p = rest[q - 1];
      if (p === ' ' || p === '\t' || p === '\n' || p === '\r' || p === '\f' || p === '\v'
        || p === '*' || p === '_' || p === '~' || p === '(') return q;
      TEXT_STOP.lastIndex = q + 1;
      continue;
    }
    if (lower === 'mailto:' || lower === 'xmpp:') {
      if (q === 0) return 0;
      if (!isAlnumCode(rest.charCodeAt(q - 1))) return q;
      TEXT_STOP.lastIndex = q + 1;
      continue;
    }
    if (m[0] === '_') {
      if (q === 0) return 0;
      if (isWordCode(rest.charCodeAt(q - 1))) { TEXT_STOP.lastIndex = q + 1; continue; }
      return q;
    }
    if (m[0] === '@') {
      if (e0 === q) { TEXT_STOP.lastIndex = q + 1; continue; } // bare @: plain text
      if (e0 === 0) return 0; // the email starts here; let the loop link it
      return e0;
    }
    return q;
  }
  return rest.length;
}

// Escape a plain-text run the way the text rule does. Most runs need
// no escaping at all, so one cheap test replaces two function calls
// and their scans; a run inside a raw block is pushed as-is.
function escText(raw, plain, inRawBlock) {
  if (inRawBlock) return raw;
  if (plain) return raw.includes('&') ? unescapeEntities(raw) : raw;
  return ESC_TEST.test(raw) ? esc(unescapeEntities(raw)) : raw;
}

// Render one inline source to HTML (`plain` renders to plain text, the
// way marked's TextRenderer does for image alt text). `parenPossible`
// says whether a `(` ... `)` link can occur here at all.
function inlineRun(src, ctx, parenPossible, plain) {
  const st = ctx.istate;
  if (!src) return '';
  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  // The masked twin and the last-closer indexes are built lazily: most
  // sources with a delimiter in them never open emphasis at all (an
  // underscore inside an identifier, a lone asterisk), and for those the
  // masking passes are pure overhead. The first emphasis or
  // strikethrough attempt that can actually open materialises them once
  // and reuses them for the rest of this source. When the source holds
  // no link, code span, tag or escaped punctuation, the masking passes
  // change nothing and the source itself is the masked twin.
  let mask = null;
  const getMask = () => {
    if (!mask) {
      const needsWork = src.includes('[') || src.includes('`') || src.includes('<')
        || src.includes('\\');
      const masked = needsWork ? maskSource(src, ctx) : src;
      mask = { masked, ...lastCloserAll(masked) };
    }
    return mask;
  };
  const linkParen = parenPossible && src.includes(')');
  const out = [];
  let pos = 0;
  let guard = Infinity;
  let prevChar = '';
  let prevWasText = false;
  const n = src.length;

  // Inline a nested source (link text, emphasis content) with its own
  // masking, sharing the link/raw-block state.
  const nested = (s) => inlineRun(s, ctx, linkParen, plain);
  const nestedPlain = (s) => inlineRun(s, ctx, linkParen, true);

  while (pos < n) {
    if (n - pos < guard) guard = n - pos;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    if (!prevWasText) prevChar = '';
    prevWasText = false;
    const rest = src.slice(pos);
    const c = rest[0];
    let m;

    // Fast path: a plain-text run up to the next special character,
    // appended in one go instead of one regex match per token.
    const scanEnd = textScanEnd(rest);
    if (scanEnd > 0) {
      const raw = rest.slice(0, scanEnd);
      out.push(escText(raw, plain, st.inRawBlock));
      if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
      prevWasText = true;
      pos += scanEnd;
      continue;
    }

    // Backslash escape.
    if (c === '\\' && (m = INLINE_ESCAPE.exec(rest))) {
      out.push(plain ? m[1] : esc(m[1]));
      pos += m[0].length;
      continue;
    }
    // Raw HTML tag (also drives the inLink / inRawBlock state).
    if (c === '<' && (m = INLINE_TAG.exec(rest))) {
      const tag = m[0];
      if (!st.inLink && RE_START_A.test(tag)) st.inLink = true;
      else if (st.inLink && RE_END_A.test(tag)) st.inLink = false;
      if (!st.inRawBlock && RE_START_PRE.test(tag)) st.inRawBlock = true;
      else if (st.inRawBlock && RE_END_PRE.test(tag)) st.inRawBlock = false;
      out.push(tag);
      pos += tag.length;
      continue;
    }
    // Inline link [text](href "title") / ![alt](src).
    if ((c === '[' || (c === '!' && rest[1] === '[')) && linkParen && (m = INLINE_LINK.exec(rest))) {
      const link = tryLinkMatch(m, rest, ctx, linkParen, plain, nested, nestedPlain);
      if (link !== null) { out.push(link.html); pos += link.len; continue; }
    }
    // Reference link [text][ref], [text][] or [text].
    if ((c === '[' || (c === '!' && rest[1] === '['))) {
      const ref = tryRefMatch(rest, ctx, linkParen, plain, nested, nestedPlain);
      if (ref !== null) {
        if (ref.single) {
          out.push(plain ? ref.ch : esc(ref.ch));
          prevChar = ref.ch;
          prevWasText = true;
          pos += 1;
        } else { out.push(ref.html); pos += ref.len; }
        continue;
      }
    }
    // Emphasis / strong.
    if ((c === '*' || c === '_') && needsMask) {
      const em = tryEmStrong(src, pos, prevChar, getMask);
      if (em) {
        const inner = nested(em.inner);
        out.push(plain ? inner : em.strong ? `<strong>${inner}</strong>` : `<em>${inner}</em>`);
        pos += em.raw.length;
        continue;
      }
    }
    // Code span.
    if (c === '`' && (m = INLINE_CODE.exec(rest))) {
      let text = m[2].replace(RE_NEWLINE_G, ' ');
      if (RE_NON_SPACE.test(text) && RE_START_SPACE.test(text) && RE_END_SPACE.test(text)) {
        text = text.substring(1, text.length - 1);
      }
      out.push(plain ? text : `<code>${esc(text, true)}</code>`);
      pos += m[0].length;
      continue;
    }
    // Hard break: two or more spaces (or a backslash) before a newline.
    if (c === ' ' || c === '\\') {
      if ((m = INLINE_BR.exec(rest))) {
        out.push(plain ? '' : '<br>');
        pos += m[0].length;
        continue;
      }
    }
    // Strikethrough.
    if (c === '~' && needsMask) {
      const del = tryDel(src, pos, prevChar, getMask);
      if (del) {
        const inner = nested(del.inner);
        out.push(plain ? inner : `<del>${inner}</del>`);
        pos += del.raw.length;
        continue;
      }
    }
    // Autolink <scheme:...> / <email>.
    if (c === '<' && (m = INLINE_AUTOLINK.exec(rest))) {
      const isMail = m[2] === '@';
      const text = m[1];
      const href = isMail ? 'mailto:' + text : text;
      out.push(renderLink(href, null, text, true, plain));
      pos += m[0].length;
      continue;
    }
    // GFM autolink: www., scheme://, email (never inside a link).
    if (!st.inLink && urlMaybe(rest) && (m = INLINE_URL.exec(rest))) {
      let text, href;
      if (m[2] === '@') { text = m[0]; href = 'mailto:' + m[0]; }
      else {
        let u = m[0];
        let prevU;
        do { prevU = u; u = BACKPEDAL.exec(u)?.[0] ?? ''; } while (prevU !== u);
        text = u;
        href = m[1] === 'www.' ? 'http://' + u : u;
      }
      out.push(renderLink(href, null, text, true, plain));
      pos += text.length;
      continue;
    }
    // Plain text run.
    m = INLINE_TEXT.exec(rest);
    if (m) {
      const raw = m[0];
      out.push(escText(raw, plain, st.inRawBlock));
      if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
      prevWasText = true;
      pos += raw.length;
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  return out.join('');
}

// Render an autolink / bare URL as a link (or its bare text when the
// href cannot be encoded, as marked does).
function renderLink(href, title, text, autolink, plain) {
  if (plain) return text;
  const encoded = encodeHref(href);
  if (encoded === null) return esc(text, true);
  const hrefOut = esc(encoded, autolink);
  let out = `<a href="${hrefOut}"`;
  if (title) out += ` title="${esc(title)}"`;
  return out + `>${esc(text, true)}</a>`;
}

// Turn an inline-link regex match into output. Returns null when the
// match is not a link after all (escaped closer, unbalanced parens, a
// `<` inside the text that is not a tag, or a nested link inside the
// link text). `len` is how many source characters the link consumes.
function tryLinkMatch(m, rest, ctx, parenPossible, plain, nested, nestedPlain) {
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasTagBefore(rest, m[1], bang, { inline: { code: INLINE_CODE, tag: INLINE_TAG, autolink: INLINE_AUTOLINK } })) return null;
  let href = m[2].trim();
  if (RE_START_ANGLE.test(href)) {
    if (!RE_END_ANGLE.test(href)) return null;
    const stripped = trimEndChars(href.slice(0, -1), '\\');
    if ((href.length - stripped.length) % 2 === 0) return null;
  } else {
    const bal = parenBalance(m[2]);
    if (bal === -2) return null;
    if (bal > -1) {
      const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + bal;
      m = [m[0].substring(0, cut).trim(), m[1], m[2].substring(0, bal), ''];
      href = m[2];
    }
  }
  const tail = trimEndChars(m[0].slice(0, -1), '\\');
  if ((m[0].length - tail.length) % 2 === 0) return null;
  let url = m[2];
  const title = m[3] ? m[3].slice(1, -1) : '';
  url = url.trim();
  if (RE_START_ANGLE.test(url)) url = url.slice(1, -1);
  const def = {
    href: url && url.replace(ANY_PUNCT, '$1'),
    title: title && title.replace(ANY_PUNCT, '$1'),
  };
  return finishLink(m, def, ctx, parenPossible, plain, nested, nestedPlain);
}

// Turn a reference-link regex match into output, or a single literal
// character when the reference is not defined.
function tryRefMatch(rest, ctx, parenPossible, plain, nested, nestedPlain) {
  const m = INLINE_REFLINK.exec(rest) || INLINE_NOLINK.exec(rest);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasTagBefore(rest, m[1], bang, { inline: { code: INLINE_CODE, tag: INLINE_TAG, autolink: INLINE_AUTOLINK } })) return null;
  const def = ctx.links[normLabel(m[2] || m[1])];
  if (!def) return { single: true, ch: m[0].charAt(0) };
  return finishLink(m, def, ctx, parenPossible, plain, nested, nestedPlain);
}

// Shared tail of link / reference-link handling: render the link text,
// honouring the no-nested-links rule.
function finishLink(m, def, ctx, parenPossible, plain, nested, nestedPlain) {
  const st = ctx.istate;
  const isImage = m[0].charAt(0) === '!';
  const textSrc = m[1].replace(RE_OUTPUT_LINK, '$1');
  const savedInLink = st.inLink;
  const savedEmitted = st.linkEmitted;
  st.inLink = true;
  st.linkEmitted = false;
  const innerHtml = nested(textSrc);
  const innerEmitted = st.linkEmitted;
  // The plain rendering (image alt text, or a link inside plain text)
  // is tokenized here too, while inLink is still set: marked tokenizes
  // the link text once with inLink on, so a bare URL after a backslash
  // is not swallowed into an autolink inside alt text, and a hard break
  // after one still counts. Only built when it is actually used.
  const plainHtml = (isImage || plain) ? nestedPlain(textSrc) : null;
  st.linkEmitted = savedEmitted;
  st.inLink = savedInLink;
  if (!isImage) {
    if (innerEmitted) return null;
    st.linkEmitted = true;
  }
  if (plain) return { html: plainHtml, len: m[0].length };
  if (isImage) {
    const alt = plainHtml;
    const encoded = encodeHref(def.href);
    if (encoded === null) return { html: esc(alt), len: m[0].length };
    let out = `<img src="${esc(encoded)}" alt="${esc(alt)}"`;
    if (def.title) out += ` title="${esc(def.title)}"`;
    return { html: out + '>', len: m[0].length };
  }
  const encoded = encodeHref(def.href);
  if (encoded === null) return { html: innerHtml, len: m[0].length };
  let out = `<a href="${esc(encoded)}"`;
  if (def.title) out += ` title="${esc(def.title)}"`;
  return { html: out + `>${innerHtml}</a>`, len: m[0].length };
}

// ---------------------------------------------------------------- rendering
//
// Block tokens become HTML here. Inline sources go through `inlineTop`,
// which resets the raw-block flag the way marked resets it before every
// inline source, then renders straight to a string.

function inlineTop(src, ctx) {
  ctx.istate.inRawBlock = false;
  return inlineRun(src, ctx, true, false);
}

function renderBlocks(tokens, ctx) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.t) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'def': break;
      case 'html': out += tok.text; break;
      case 'heading':
        out += `<h${tok.depth}>${inlineTop(tok.text, ctx)}</h${tok.depth}>\n`;
        break;
      case 'code': {
        const lang = (tok.lang || '').match(RE_NOT_SPACE_START)?.[0];
        const text = tok.text ? tok.text.replace(RE_END_NEWLINE, '') + '\n' : '';
        out += lang
          ? `<pre><code class="language-${esc(lang)}">${esc(text, true)}</code></pre>\n`
          : `<pre><code>${esc(text, true)}</code></pre>\n`;
        break;
      }
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(tok.tokens, ctx)}</blockquote>\n`;
        break;
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
        let items = '';
        for (const item of tok.items) {
          items += `<li>${renderBlocks(item.tokens, ctx)}</li>\n`;
        }
        out += `<${tag}${start}>\n${items}</${tag}>\n`;
        break;
      }
      case 'checkbox':
        out += `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
        break;
      case 'paragraph': {
        const lead = tok.lead
          ? `<input ${tok.lead.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> ` : '';
        out += `<p>${lead}${inlineTop(tok.text, ctx)}</p>\n`;
        break;
      }
      case 'text': {
        const lead = tok.lead
          ? `<input ${tok.lead.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> ` : '';
        out += `${lead}${inlineTop(tok.text, ctx)}`;
        break;
      }
      case 'table': {
        let head = '';
        for (const cell of tok.header) head += renderTableCell(cell, ctx, true);
        let body = '';
        for (const row of tok.rows) {
          let cells = '';
          for (const cell of row) cells += renderTableCell(cell, ctx, false);
          body += `<tr>\n${cells}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${body}</table>\n`;
        break;
      }
      default:
        throw new Error(`Token with "${tok.t}" type was not found.`);
    }
  }
  return out;
}

function renderTableCell(cell, ctx, header) {
  const tag = header ? 'th' : 'td';
  const align = cell.align ? ` align="${cell.align}"` : '';
  return `<${tag}${align}>${inlineTop(cell.text, ctx)}</${tag}>\n`;
}

// ---------------------------------------------------------------- entry point

export function parse(markdown) {
  const src = markdown.replace(RE_CR, '\n');
  const ctx = newCtx();
  ctx.istate = newInlineState();
  const tokens = lexBlocks(src, ctx, [], false);
  return renderBlocks(tokens, ctx);
}
