// parse.js — a fast CommonMark 0.31.2 + GFM renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 produces with
// its default options (gfm on, breaks off, pedantic off). It is an independent
// implementation written for this entry: same output, different code.
//
// Layout of one parse:
//   1. Block pass: the source is walked once, top to bottom, and cut into
//      block tokens (headings, lists, quotes, tables, code, ...). Inline
//      content is not rendered yet; each block just queues its inline source.
//   2. Inline pass: every queued source is tokenized (escapes, links,
//      emphasis, code spans, ...) and the tokens are rendered to HTML.
// The two passes are separate because link reference definitions may appear
// after the text that uses them, so all definitions must be known before
// any inline text is resolved.
//
// Emphasis is the subtle part. Whether a `*`, `_` or `~` run can close an
// emphasis span depends on what surrounds it in the whole inline source, so
// before tokenizing, a masked copy of the source is built: link labels that
// resolve, code spans, inline links and raw HTML tags are blanked out to
// `[aaa...]`, backslash-escaped punctuation is blanked to `+`, and the
// last delimiter run that could close anything is found in that masked copy.
// The masking runs in a fixed order — reference-link labels first, then
// punctuation outside code, then code/links/tags — because each step feeds
// the next one.

// ---------------------------------------------------------------------------
// Small regex builder
// ---------------------------------------------------------------------------
// Compose a pattern from pieces: `sub` splices another pattern in place of a
// placeholder word. A leading `^` on the spliced piece is dropped, since it
// would otherwise anchor the middle of the combined pattern.
function rx(src, flags) {
  let s = typeof src === 'string' ? src : src.source;
  const b = {
    sub(find, rep) {
      let r = typeof rep === 'string' ? rep : rep.source;
      r = r.replace(/(^|[^\[])\^/g, '$1');
      s = s.replace(find, () => r);
      return b;
    },
    get() { return new RegExp(s, flags); },
  };
  return b;
}

// ---------------------------------------------------------------------------
// Shared character classes and word lists
// ---------------------------------------------------------------------------
const PUNCT = /[\p{P}\p{S}]/u;                 // any punctuation or symbol
const PUNCT_NT = /(?!~)[\p{P}\p{S}]/u;         // punctuation except ~
const PUNCT_SP = /[\s\p{P}\p{S}]/u;            // whitespace or punctuation
const NOT_PUNCT_SP = /[^\s\p{P}\p{S}]/u;       // anything else (a "word" char)
const ALNUM = /[\p{L}\p{N}]/u;                 // a letter or digit

// Block-level HTML tag names (CommonMark HTML block type 6).
const TAG_NAMES = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// ---------------------------------------------------------------------------
// Block grammar
// ---------------------------------------------------------------------------
const BLK_NEWLINE = /^((?:[ \t]*(?:\n|$)))+/;
const BLK_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const BLK_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const BLK_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const BLK_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BLK_TEXT = /^[^\n]+/;

// A link reference label, as it appears in `[label]: ...` and `[label][ref]`.
// It may span lines but never a blank line, and never contains an unescaped
// `[` or `]` (a nested pair is allowed only when balanced).
const LABEL_DEF = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const LABEL_BRACKET = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
// A label as it appears inside a link: may hold nested brackets, code spans
// and escaped characters, but never a raw newline-free backtick run clash.
const LABEL_LINK = rx(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .sub('brackets', LABEL_BRACKET).get();

// Link reference definition: `[label]: <dest> "title"` (dest and title optional
// in their usual forms).
const BLK_DEF = rx(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .sub('label', LABEL_DEF)
  .sub('title', /(?:\"(?:\\[\s\S]|[^\"\\])*\"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/).get();

// A list item's first line: up to 3 spaces, a bullet or a 1-9 digit ordered
// marker, then the rest of the line.
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const BLK_LIST = rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).sub(/bull/g, BULLET).get();

// Paragraph: a run of lines, each of which does not start a new block.
// `bull` is the list-marker pattern that may interrupt a paragraph; `table`
// is the table pattern that may interrupt it (gfm only).
const PARA_BASE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function paragraphRx(bull, tableRx) {
  const b = rx(PARA_BASE);
  b.sub('hr', BLK_HR);
  b.sub('heading', ' {0,3}#{1,6}(?:\\s|$)');
  b.sub('|lheading', '');
  if (tableRx) b.sub('table', tableRx); else b.sub('|table', '');
  b.sub('blockquote', ' {0,3}>');
  b.sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)');
  b.sub('list', bull);
  b.sub('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)');
  b.sub('tag', TAG_NAMES);
  return b.get();
}

// GFM table: header line, delimiter row, then body rows that do not start
// another block.
const BLK_TABLE = rx('^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .sub('hr', BLK_HR)
  .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .sub('blockquote', ' {0,3}>')
  .sub('code', '(?: {4}| {0,3}\t)[^\\n]')
  .sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .sub('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .sub('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .sub('tag', TAG_NAMES).get();
const PARA_GFM = paragraphRx(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]', BLK_TABLE);
const PARA_LIST = paragraphRx(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/, null);

// Setext heading: one or more lines of text, then a line of `=` or `-`.
// The text lines must not start a block of their own.
const LHEADING_BASE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
function lheadingRx(withTable) {
  const b = rx(LHEADING_BASE);
  b.sub(/bull/g, BULLET);
  b.sub(/blockCode/g, /(?: {4}| {0,3}\t)/);
  b.sub(/fences/g, / {0,3}(?:`{3,}|~{3,})/);
  b.sub(/blockquote/g, / {0,3}>/);
  b.sub(/heading/g, / {0,3}#{1,6}(?:\s|$)/);
  b.sub(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/);
  b.sub(/html/g, / {0,3}<[^\n>]+>\n/);
  if (withTable) b.sub(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/);
  else b.sub(/\|table/g, '');
  return b.get();
}
const BLK_LHEADING = lheadingRx(true);

// Block quote: lines starting with `>`, where the text after the marker may
// itself be a paragraph (so lazy continuation lines are swallowed).
const BLK_BLOCKQUOTE = rx(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).sub('paragraph', PARA_LIST).get();

// Block HTML (types 1-7). Group 1 is a script/pre/style/textarea opener.
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const BLK_HTML = rx('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i')
  .sub('comment', HTML_COMMENT)
  .sub('tag', TAG_NAMES)
  .sub('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).get();

// ---------------------------------------------------------------------------
// Inline grammar
// ---------------------------------------------------------------------------
const INL_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INL_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INL_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const INL_TAG_COMMENT = rx(HTML_COMMENT).sub('(?:-->|$)', '-->').get();
const INL_TAG = rx('^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .sub('comment', INL_TAG_COMMENT)
  .sub('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).get();

// Inline link `[text](dest "title")`. Group 1 is the label, 2 the destination,
// 3 the title (with quotes).
const INL_LINK = rx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .sub('label', LABEL_LINK)
  .sub('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .sub('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/).get();
// Reference link `[text][ref]` and shortcut link `[text]` / `[text][]`.
const INL_REFLINK = rx(/^!?\[(label)\]\[(ref)\]/).sub('label', LABEL_LINK).sub('ref', LABEL_DEF).get();
const INL_NOLINK = rx(/^!?\[(ref)\](?:\[\])?/).sub('ref', LABEL_DEF).get();

// The search pattern used to mask reference links before emphasis is decided.
// `ref` here is deliberately loose: up to 999 characters, so a long label
// still masks.
const REF_LOOSE = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const REFLINK_LABEL = rx(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .sub('brackets', LABEL_BRACKET).get();
const REFLINK_SEARCH = rx('reflink|nolink(?!\\()', 'g')
  .sub('reflink', rx(/^!?\[(label)\]\[(ref)\]/).sub('label', REFLINK_LABEL).sub('ref', REF_LOOSE).get())
  .sub('nolink', rx(/^!?\[(ref)\](?:\[\])?/).sub('ref', REF_LOOSE).get()).get();

// Emphasis delimiters. The left-delimiter pattern reports the character
// after the run: group 1/3 is punctuation, group 2/4 is any other character.
// The right-delimiter patterns scan a masked copy for candidate closers.
const EM_LDELIM = rx(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u')
  .sub(/punct/g, PUNCT_NT).get();
const RDELIM_AST = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const RDELIM_UND = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
const EM_RDELIM_AST = rx(RDELIM_AST, 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_SP).sub(/punctSpace/g, PUNCT_SP).sub(/punct/g, PUNCT).get();
const EM_RDELIM_UND = rx(RDELIM_UND, 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_SP).sub(/punctSpace/g, PUNCT_SP).sub(/punct/g, PUNCT).get();
// Strikethrough `~~` delimiters.
const DEL_LDELIM = rx(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').sub(/punct/g, PUNCT).get();
const DEL_RDELIM = rx('^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)', 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_SP).sub(/punctSpace/g, PUNCT_SP).sub(/punct/g, PUNCT).get();

// Autolink `<scheme:...>` / `<user@host>`; extended autolink `www.`, `http://`,
// bare e-mail; and the backpedal that trims trailing punctuation off one.
const AUTOLINK = rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .sub('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .sub('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).get();
const EMAIL_FULL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_PROTO = rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).sub(/email/g, EMAIL_FULL).get();
const URL_PROTO = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EXT_URL = rx(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .sub('emailProtocol', EMAIL_PROTO).sub('protocol', URL_PROTO)
  .sub('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).get();
const URL_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Plain text: one chunk, stopping just before anything that could start an
// inline construct (a tag, a link, a code span, emphasis, a hard break, an
// autolink, or the start of an e-mail / URL).
const TEXT_RX = rx(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .sub('protocol', URL_PROTO)
  .sub(/emailProtocol/g, /(?:mailto|xmpp):/)
  .sub('wwwStart', '(?<![^\\s*_~(])www\\.').get();

// The three masking patterns, in the order they are applied.
const ANY_PUNCT = rx(/\\(punct)/, 'gu').sub(/punct/g, PUNCT).get();
const ANY_PUNCT_OUTSIDE_CODE = rx(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').sub(/punct/g, PUNCT).get();
const BLOCK_SKIP = rx(/link|precode-code|html/, 'g')
  .sub('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .sub('precode-', '(?<!`)()')
  .sub('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .sub('html', /<(?! )[^<>]*?>/).get();

// Punctuation test used by the emphasis rules (no /g, so exec is stateless).
const IS_PUNCT = rx(/^((?![*_])punctSpace)/, 'u').sub(/punctSpace/g, PUNCT_SP).get();

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_TEST_NE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_RE_NE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape HTML. With `encode` every `&` is escaped; without it, `&` stays when
// it already starts a valid entity or numeric reference.
function esc(html, encode) {
  if (encode) {
    return ESCAPE_TEST.test(html) ? html.replace(ESCAPE_RE, (c) => ESCAPE_MAP[c]) : html;
  }
  return ESCAPE_TEST_NE.test(html) ? html.replace(ESCAPE_RE_NE, (c) => ESCAPE_MAP[c]) : html;
}

const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
// Decode numeric character references in text (`&#38;` -> `&amp;`, `&#0;` ->
// U+FFFD). Named entities are left alone; `esc` keeps them as-is later.
function unescEnt(s) {
  if (!NUM_REF.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP, (all, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const n = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (n === 0 || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return '\uFFFD';
    return n === 38 ? '&amp;' : String.fromCodePoint(n);
  });
}

// Make a URL safe for an href/src attribute. Returns null when it cannot be
// encoded at all.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Normalize a link label for lookup: collapse whitespace, case-fold.
function labelKey(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Index of the bracket that closes the one opened at the start of `s`, or -1
// when there is none and -2 when the opener is never closed.
function findBracketClose(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1]) { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, tracking the column (a tab jumps to the next
// multiple of 4). `col` is the column the text starts at.
function tabExpand(s, col = 0) {
  let out = '', n = col;
  for (const ch of s) {
    if (ch === '\t') {
      const r = 4 - (n % 4);
      out += ' '.repeat(r);
      n += r;
    } else {
      out += ch;
      n++;
    }
  }
  return out;
}

// Strip trailing characters: with `invert`, strip trailing characters that
// are NOT `ch`; otherwise strip trailing `ch`.
function stripTrailing(s, ch, invert) {
  const n = s.length;
  if (n === 0) return '';
  let cut = 0;
  for (; cut < n;) {
    const c = s.charAt(n - cut - 1);
    if (c === ch && !invert) cut++;
    else if (c !== ch && invert) cut++;
    else break;
  }
  return s.slice(0, n - cut);
}

// Drop trailing blank lines from an indented code block, keeping at most one
// blank line after the last line of code.
function trimBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && /^[ \t]*$/.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Split a table row on unescaped pipes. With `count`, pad with empty cells
// or truncate to exactly that many cells.
function splitCells(row, count) {
  const withSpaces = row.replace(/\|/g, (m, off, full) => {
    let escaped = false, p = off;
    for (; --p >= 0 && full[p] === '\\';) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = withSpaces.split(' |');
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else for (; cells.length < count;) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// A fenced code block whose opening fence is indented has its content
// de-indented by the same amount (but never more than the content has).
function fenceIndent(raw, text) {
  const m = raw.match(/^(\s+)(?:```)/);
  if (m === null) return text;
  const ind = m[1];
  return text.split('\n').map((line) => {
    const lead = line.match(/^\s+/);
    if (lead === null) return line;
    const [sp] = lead;
    return line.slice(Math.min(sp.length, ind.length));
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Emphasis masking
// ---------------------------------------------------------------------------
// Does `src` hold a link (inline or reference) that resolves? Used while
// masking, to decide whether a `[label]` may hide emphasis delimiters.
function linkInText(src, links) {
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(BLOCK_SKIP)) {
    if (INL_LINK.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(REFLINK_SEARCH)) {
    const s = m[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(links, labelKey(s.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(s.slice(1, r - 1), links))) return true;
  }
  return false;
}

// Build the masked copy of an inline source: reference links that resolve
// are blanked to `[aaa...]` (labels are blanked too, recursively, when they
// hold a link), then escaped punctuation and code spans are normalized, then
// inline links, code spans and HTML tags are blanked. Delimiters that
// survive in the masked copy are the only ones emphasis may use. The result
// keeps the source's length, so indexes line up with the original.
function maskSrc(src, links) {
  let t = src;
  if (links && src.includes('[')) {
    const maskReflink = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(links, labelKey(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, links)) {
          return '[' + inner.replace(REFLINK_SEARCH, maskReflink) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(REFLINK_SEARCH, maskReflink);
  }
  // Escaped punctuation and code spans only exist when a backslash or a
  // backtick is present; links, code spans and HTML tags only when `[`,
  // a backtick or `<` is. Plain prose skips both passes entirely.
  if (t.includes('\\') || t.includes('`')) {
    t = t.replace(ANY_PUNCT_OUTSIDE_CODE, (n, s, r) =>
      r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  }
  if (t.includes('[') || t.includes('`') || t.includes('<')) {
    t = t.replace(BLOCK_SKIP, (n) => '[' + 'a'.repeat(n.length - 2) + ']');
  }
  return t;
}

// In the masked copy, find the last run of each delimiter kind that could
// close an emphasis span: a run whose preceding character is not blank.
// Scans backward and stops as soon as every kind present in the source has
// been found. `kinds` is a bitmask: 1 `*`, 2 `_`, 4 `~`.
// Returns the index where each such run starts, or -1 when there is none.
function scanLastCloser(a, kinds) {
  let star = -1, und = -1, tilde = -1;
  let need = kinds;
  for (let s = a.length - 1; s >= 0 && need; s--) {
    const r = a[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    let j = s;
    while (j > 0 && a[j - 1] === r) j--;
    const o = j === 0 ? '\n' : a[j - 1];
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (r === '~') { if (tilde === -1) { tilde = j; need &= ~4; } }
      else if (r === '*') { if (star === -1) { star = j; need &= ~1; } }
      else if (und === -1) { und = j; need &= ~2; }
    }
    s = j;
  }
  return { star, und, tilde };
}

// ---------------------------------------------------------------------------
// Inline tokenizers. Each takes the remaining source (and the parser state)
// and returns a token, or undefined when the construct does not start here.
// ---------------------------------------------------------------------------
function tokEscape(rest) {
  const t = INL_ESCAPE.exec(rest);
  if (!t) return undefined;
  return { type: 'escape', raw: t[0], text: t[1] };
}

function tokTag(rest, st) {
  const t = INL_TAG.exec(rest);
  if (!t) return undefined;
  if (!st.inLink && /^<a /i.test(t[0])) st.inLink = true;
  else if (st.inLink && /^<\/a>/i.test(t[0])) st.inLink = false;
  if (!st.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(t[0])) st.inRawBlock = true;
  else if (st.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(t[0])) st.inRawBlock = false;
  return { type: 'html', raw: t[0], inLink: st.inLink, inRawBlock: st.inRawBlock, block: false, text: t[0] };
}

// Would the `<` at `label[s]` start a tag or autolink that runs past the end
// of the label? If so the bracketed text is not a link at all.
function hasHtmlBeyond(src, label, off) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const m = INL_CODE.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const o = INL_TAG.exec(src.slice(off + s)) || AUTOLINK.exec(src.slice(off + s));
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// Finish a link or image token: tokenize its label text, tracking whether a
// nested link was emitted inside it. A non-image link whose label holds a
// link is dropped entirely (links do not nest).
function buildLink(match, def, raw, isImage, st) {
  const labelText = match[1].replace(/\\([\[\]])/g, '$1');
  const prevInLink = st.inLink, prevEmitted = st.linkEmitted, prevRaw = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const inner = inlineTokens(labelText, [], st);
  const nested = st.linkEmitted;
  st.linkEmitted = prevEmitted;
  st.inLink = prevInLink;
  if (!isImage) {
    if (nested) { st.inRawBlock = prevRaw; return undefined; }
    st.linkEmitted = true;
  }
  return {
    type: isImage ? 'image' : 'link', raw,
    href: def.href, title: def.title || null, text: labelText, tokens: inner,
  };
}

function tokLink(rest, st) {
  if (st.linkParenPossible === false) return undefined;
  const t = INL_LINK.exec(rest);
  if (!t) return undefined;
  const off = t[0].charAt(0) === '!' ? 2 : 1;
  if (hasHtmlBeyond(rest, t[1], off)) return undefined;
  const s = t[2].trim();
  if (s.charAt(0) === '<') {
    if (s.charAt(s.length - 1) !== '>') return undefined;
    const l = stripTrailing(s.slice(0, -1), '\\');
    if ((s.length - l.length) % 2 === 0) return undefined;
  } else {
    const l = findBracketClose(t[2], '()');
    if (l === -2) return undefined;
    if (l > -1) {
      const h = (t[0].indexOf('!') === 0 ? 5 : 4) + t[1].length + l;
      t[2] = t[2].substring(0, l);
      t[0] = t[0].substring(0, h).trim();
      t[3] = '';
    }
  }
  const r = stripTrailing(t[0].slice(0, -1), '\\');
  if ((t[0].length - r.length) % 2 === 0) return undefined;
  let href = t[2];
  const title = t[3] ? t[3].slice(1, -1) : '';
  href = href.trim();
  if (href.charAt(0) === '<') href = href.slice(1, -1);
  return buildLink(t,
    { href: href && href.replace(ANY_PUNCT, '$1'), title: title && title.replace(ANY_PUNCT, '$1') },
    t[0], t[0].charAt(0) === '!', st);
}

function tokReflink(rest, st) {
  const m = INL_REFLINK.exec(rest) || INL_NOLINK.exec(rest);
  if (!m) return undefined;
  const off = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasHtmlBeyond(rest, m[1], off)) return undefined;
  const def = st.links[labelKey(m[2] || m[1])];
  if (!def) {
    const c = m[0].charAt(0);
    return { type: 'text', raw: c, text: c };
  }
  return buildLink(m, def, m[0], m[0].charAt(0) === '!', st);
}

// Emphasis: find a left delimiter run at the start of `rest`, then scan the
// masked copy for a matching right delimiter run. `mask` is the masked copy
// of the whole inline source plus the last possible closer of each kind;
// `prev` is the character before the run ('' when there is none).
function tokEmStrong(rest, mask, prev, st) {
  const m = EM_LDELIM.exec(rest);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return undefined;
  const ch = m[0][0];
  const same = prev === ch;
  const t = mask.src;
  const i = t.length - rest.length;
  let l = i;
  while (l > 0 && t[l - 1] === ch) l--;
  const p = [...t.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || !!IS_PUNCT.exec(p);
  if (l < i) prev = p;
  const u = l < i ? h : !!IS_PUNCT.exec(prev);
  // `_` between two word characters cannot open emphasis.
  if (m[4] && prev.match(ALNUM)) return undefined;
  const d = m[1] || m[3] || '';
  if (!d || !prev || u) {
    const k = [...m[0]].length - 1;
    let g, b, mm = k, f = 0;
    const y = i - l + k;
    const canClose = !!p.trim() && (!!d || (ch === '*' && !h));
    if (ch !== '*' && ch !== '_') return undefined;
    const scan = ch === '*' ? EM_RDELIM_AST : EM_RDELIM_UND;
    const v = ch === '*' ? mask.star : mask.und;
    const q = i + k;
    if (v < q) return undefined;
    const tail = t.slice(q);
    const ee = v - q;
    scan.lastIndex = 0;
    let s;
    while ((s = scan.exec(tail)) !== null && !(s.index > ee)) {
      g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      b = [...g].length;
      if (s[3] || s[4]) { mm += b; continue; }
      else if (s[5] || s[6] || canClose) {
        if (same && (s[5] || s[6])) break;
        // Rule of three: a run whose length plus the opener's is a multiple
        // of 3 cannot close when either side can both open and close.
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      if ((mm -= b) > 0) continue;
      b = Math.min(b, b + mm + f);
      const te = [...s[0]][0].length;
      const raw = rest.slice(0, k + s.index + te + b);
      if (Math.min(k, b) % 2) {
        const inner = raw.slice(1, -1);
        return { type: 'em', raw, text: inner, tokens: inlineTokens(inner, [], st) };
      }
      const inner = raw.slice(2, -2);
      return { type: 'strong', raw, text: inner, tokens: inlineTokens(inner, [], st) };
    }
  }
  return undefined;
}

function tokCodespan(rest) {
  const t = INL_CODE.exec(rest);
  if (!t) return undefined;
  let text = t[2].replace(/\n/g, ' ');
  if (/[^ ]/.test(text) && text.charAt(0) === ' ' && text.charAt(text.length - 1) === ' ') {
    text = text.substring(1, text.length - 1);
  }
  return { type: 'codespan', raw: t[0], text };
}

function tokBr(rest) {
  const t = INL_BR.exec(rest);
  if (!t) return undefined;
  return { type: 'br', raw: t[0] };
}

// Strikethrough, same shape as emphasis but with `~` runs and no rule of
// three: the closer run must be exactly as long as the opener.
function tokDel(rest, mask, prev, st) {
  const m = DEL_LDELIM.exec(rest);
  if (!m) return undefined;
  if (!(m[1] || '') || !prev || !!IS_PUNCT.exec(prev)) {
    const o = [...m[0]].length - 1;
    let p = o;
    const t = mask.src;
    const u = mask.tilde;
    const d = t.length - rest.length + o;
    if (u < d) return undefined;
    const tail = t.slice(d);
    const k = u - d;
    DEL_RDELIM.lastIndex = 0;
    let s, g, l;
    while ((s = DEL_RDELIM.exec(tail)) !== null && !(s.index > k)) {
      g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g || [...g].length !== o) continue;
      l = [...g].length;
      if (s[3] || s[4]) { p += l; continue; }
      if ((p -= l) > 0) continue;
      l = Math.min(l, l + p);
      const te = [...s[0]][0].length;
      const raw = rest.slice(0, o + s.index + te + l);
      const inner = raw.slice(o, -o);
      return { type: 'del', raw, text: inner, tokens: inlineTokens(inner, [], st) };
    }
  }
  return undefined;
}

function tokAutolink(rest) {
  const t = AUTOLINK.exec(rest);
  if (!t) return undefined;
  const text = t[1];
  const href = t[2] === '@' ? 'mailto:' + text : text;
  return { type: 'link', raw: t[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function tokUrl(rest) {
  const t = EXT_URL.exec(rest);
  if (!t) return undefined;
  let text, href;
  if (t[2] === '@') {
    text = t[0];
    href = 'mailto:' + text;
  } else {
    let prev = t[0];
    do {
      prev = t[0];
      t[0] = URL_BACKPEDAL.exec(t[0])?.[0] ?? '';
    } while (prev !== t[0]);
    text = t[0];
    href = t[1] === 'www.' ? 'http://' + t[0] : t[0];
  }
  return { type: 'link', raw: t[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function tokText(rest, st) {
  const t = TEXT_RX.exec(rest);
  if (!t) return undefined;
  const inRaw = st.inRawBlock;
  return { type: 'text', raw: t[0], text: inRaw ? t[0] : unescEnt(t[0]), escaped: inRaw };
}

// Tokenize one inline source into `tokens`. `st` carries the parser state
// (link definitions, in-link / in-raw-block flags) shared with the block pass.
function inlineTokens(src, tokens, st) {
  const savedParen = st.linkParenPossible;
  st.linkParenPossible = savedParen && src.includes(')');
  // The masked copy is only needed when emphasis or strikethrough may occur.
  let mask = null;
  const kinds = (src.includes('*') ? 1 : 0) | (src.includes('_') ? 2 : 0) | (src.includes('~') ? 4 : 0);
  if (kinds) {
    const masked = maskSrc(src, st.links);
    const last = scanLastCloser(masked, kinds);
    mask = { src: masked, star: last.star, und: last.und, tilde: last.tilde };
  }
  let rest = src;
  let prev = '';
  let wasText = false;
  let guard = Infinity;
  while (rest) {
    if (rest.length < guard) guard = rest.length;
    else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    if (!wasText) prev = '';
    wasText = false;
    const c0 = rest.charCodeAt(0);
    let tok;
    // Dispatch on the first character: only the constructs that can start
    // with it are attempted, in the reference order, then plain text.
    if (c0 === 92) { // backslash: an escape, or a hard break `\<newline>`
      tok = tokEscape(rest) || tokBr(rest);
    } else if (c0 === 60) { // <: an HTML tag, or an autolink
      tok = tokTag(rest, st) || tokAutolink(rest);
    } else if (c0 === 91 || c0 === 33) { // [ or !: a link or reference link
      tok = tokLink(rest, st) || tokReflink(rest, st);
    } else if (c0 === 42 || c0 === 95) { // * or _: emphasis
      tok = mask ? tokEmStrong(rest, mask, prev, st) : undefined;
    } else if (c0 === 96) { // `: a code span
      tok = tokCodespan(rest);
    } else if (c0 === 126) { // ~: strikethrough
      tok = mask ? tokDel(rest, mask, prev, st) : undefined;
    } else if (c0 === 32) { // space: a hard break is two spaces + newline
      tok = tokBr(rest);
    } else if (!st.inLink && (c0 >= 48 && c0 <= 57 || c0 >= 65 && c0 <= 90 ||
        c0 >= 97 && c0 <= 122 || c0 === 43 || c0 === 45 || c0 === 46 || c0 === 95)) {
      // A word character: may start an extended autolink (www., http://,
      // mailto:, or a bare e-mail address).
      tok = tokUrl(rest);
    }
    if (tok) {
      rest = rest.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    tok = tokText(rest, st);
    if (!tok) throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    rest = rest.substring(tok.raw.length);
    if (tok.raw.slice(-1) !== '_') prev = tok.raw.slice(-1);
    wasText = true;
    const lastTok = tokens.at(-1);
    if (lastTok?.type === 'text') { lastTok.raw += tok.raw; lastTok.text += tok.text; }
    else tokens.push(tok);
  }
  st.linkParenPossible = savedParen;
  return tokens;
}

// ---------------------------------------------------------------------------
// Block tokenizers. Each takes the remaining source and returns a token, or
// undefined when the block does not start here. `st` is the parser state:
// { links, queue, top, inLink, inRawBlock, linkEmitted, linkParenPossible }.
// ---------------------------------------------------------------------------

// Queue an inline source for the second pass; returns the token array that
// will hold its tokens.
function queueInline(st, src) {
  const tokens = [];
  st.queue.push({ src, tokens });
  return tokens;
}

function blkSpace(src) {
  const t = BLK_NEWLINE.exec(src);
  if (t && t[0].length > 0) return { type: 'space', raw: t[0] };
  return undefined;
}

function blkCode(src) {
  const t = BLK_CODE.exec(src);
  if (!t) return undefined;
  const raw = trimBlankTail(t[0]);
  const text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, '');
  return { type: 'code', raw, codeBlockStyle: 'indented', text };
}

function blkFences(src) {
  const t = BLK_FENCES.exec(src);
  if (!t) return undefined;
  return {
    type: 'code', raw: t[0],
    lang: t[2] ? t[2].trim().replace(ANY_PUNCT, '$1') : t[2],
    text: fenceIndent(t[0], t[3] || ''),
  };
}

function blkHeading(src, st) {
  const t = BLK_HEADING.exec(src);
  if (!t) return undefined;
  let text = t[2].trim();
  if (/#$/.test(text)) {
    const s = stripTrailing(text, '#');
    if (!s || / $/.test(s)) text = s.trim();
  }
  return { type: 'heading', raw: stripTrailing(t[0], '\n'), depth: t[1].length, text, tokens: queueInline(st, text) };
}

function blkHr(src) {
  const t = BLK_HR.exec(src);
  if (!t) return undefined;
  return { type: 'hr', raw: stripTrailing(t[0], '\n') };
}

const BQ_START = /^ {0,3}>/;
const BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BQ_STRIP = /^ {0,3}>[ \t]?/gm;

function blkBlockquote(src, st) {
  const t = BLK_BLOCKQUOTE.exec(src);
  if (!t) return undefined;
  let lines = stripTrailing(t[0], '\n').split('\n');
  let raw = '', text = '';
  const tokens = [];
  for (; lines.length > 0;) {
    let seen = false;
    const chunk = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (BQ_START.test(lines[p])) { chunk.push(lines[p]); seen = true; }
      else if (!seen) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const joined = chunk.join('\n');
    const inner = joined
      .replace(BQ_MARKER_WS, (g, b, m) => b + tabExpand(m, b.length))
      .replace(BQ_SETEXT, '\n    $1')
      .replace(BQ_STRIP, '');
    raw = raw ? raw + '\n' + joined : joined;
    text = text ? text + '\n' + inner : inner;
    const savedTop = st.top;
    st.top = true;
    blockTokens(inner, tokens, st, true);
    st.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens.at(-1);
    if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' ||
        last?.type === 'html' || last?.type === 'table') break;
    if (last?.type === 'blockquote') {
      const g = last;
      const rest = lines.join('\n');
      const m = g.raw + '\n' + rest.replace(BQ_STRIP, '');
      const f = blkBlockquote(m, st);
      tokens[tokens.length - 1] = f;
      const y = m.substring(f.raw.length).replace(/^\n/, '');
      const r = y ? y.split('\n').length : 0;
      const a = r ? lines.slice(0, -r) : lines;
      if (a.length > 0) raw = raw + '\n' + a.join('\n');
      text = text.substring(0, text.length - g.text.length) + f.text;
      lines = lines.slice(a.length);
      if (lines.length > 0 && BQ_START.test(lines[0])) continue;
      break;
    } else if (last?.type === 'list') {
      const g = last;
      const b = g.raw + '\n' + lines.join('\n');
      const m = blkList(b, st);
      tokens[tokens.length - 1] = m;
      const f = m.raw.length > g.raw.length ? b.slice(g.raw.length + 1, m.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join('\n');
        raw = raw + '\n' + y;
        text = text + '\n' + y;
      }
      lines = lines.slice(f);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}

// The patterns a list item's continuation lines are tested against, at the
// item's content indent `n`. The indent limit in each pattern is not `n`
// itself but `n - 1` clamped to 0..3: a nested construct must be indented at
// least as far as the item's content, so a bullet at exactly `n` spaces is
// part of this item, not a new one. There are only four possible limits, so
// the six patterns are built once per limit and shared.
function dIdx(n) { return Math.max(0, Math.min(3, n - 1)); }
function contRx(n) {
  return {
    v: new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`),
    Q: new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`),
    ee: new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`),
    te: new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`),
    M: new RegExp(`^ {0,${n}}(?:</?(?:${TAG_NAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'),
    ne: new RegExp(`^ {0,${n}}>`),
  };
}
const CONT_RX = [contRx(0), contRx(1), contRx(2), contRx(3)];

const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_STRIP_TASK = /^\[[ xX]\][ \t]+/;
const LIST_CHECKBOX = /\[[ xX]\]/;
const DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const ANY_LINE = /\n.*\n/;

function blkList(src, st) {
  const t = BLK_LIST.exec(src);
  if (!t) return undefined;
  let e = src;
  const n = src;
  const pos = () => n.length - e.length;
  const r = t[1].trim(), o = r.length > 1;
  const list = { type: 'list', raw: '', ordered: o, start: o ? +r.slice(0, -1) : '', loose: false, items: [] };
  const marker = o ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`;
  const itemRx = new RegExp(`^( {0,3}${marker})((?:[ \t][^\\n]*)?(?:\\n|$))`);
  let p = false;
  for (; e;) {
    let u = false, d = '';
    const m2 = itemRx.exec(e);
    if (!m2 || BLK_HR.test(e)) break;
    const k = pos();
    e = e.substring(m2[0].length);
    const gi = m2[2].indexOf('\n');
    const g = gi === -1 ? m2[2] : m2[2].slice(0, gi);
    const b = m2[1].length;
    let m = g.replace(/^[ \t]+/, (v) => tabExpand(v, b));
    const fi = e.indexOf('\n');
    let f = fi === -1 ? e : e.slice(0, fi);
    let y = !m.trim();
    let R = 0;
    if (y) R = b + 1;
    else {
      R = m.search(/[^ ]/);
      R = R > 4 ? 1 : R;
      d = m.slice(R);
      R += b;
    }
    if (y && /^[ \t]*$/.test(f)) { e = e.substring(f.length + 1); u = true; }
    if (!u) {
      const rx = CONT_RX[dIdx(R)], n = dIdx(R);
      for (; e;) {
        const nl = e.indexOf('\n');
        const U = nl === -1 ? e : e.slice(0, nl);
        f = U;
        // The break tests are `^ {0,n}` patterns, so they can only match
        // when the line's leading whitespace is spaces (no tab) and at most
        // `n` of them, and the first other character is one of the six
        // constructs' opening characters. Anything else skips all six tests.
        let lead = 0, fc2 = '';
        while (lead < U.length) {
          const ch = U[lead];
          if (ch === ' ') { lead++; continue; }
          if (ch === '\t') { lead = -1; break; }
          fc2 = ch;
          break;
        }
        if (lead >= 0 && lead <= n && fc2) {
          let brk = false;
          if (fc2 === '*' || fc2 === '+' || fc2 === '-') brk = rx.v.test(f) || rx.Q.test(f);
          else if (fc2 === '_') brk = rx.Q.test(f);
          else if (fc2 >= '0' && fc2 <= '9') brk = rx.v.test(f);
          else if (fc2 === '`' || fc2 === '~') brk = rx.ee.test(f);
          else if (fc2 === '#') brk = rx.te.test(f);
          else if (fc2 === '<') brk = rx.M.test(f);
          else if (fc2 === '>') brk = rx.ne.test(f);
          if (brk) break;
        }
        // When the leading whitespace has no tab, the tab-expanded line's
        // first non-space index is `lead` itself.
        const c0 = U.charCodeAt(0);
        const Z = (c0 === 32 || c0 === 9) ? f.replace(/^[ \t]+/, (me) => tabExpand(me)) : f;
        const zNonSpace = lead >= 0 ? lead : Z.search(/[^ ]/);
        if (zNonSpace >= R || !f.trim()) d += '\n' + Z.slice(R);
        else {
          if (y || m.replace(/\t/g, '    ').search(/[^ ]/) >= 4 ||
              rx.ee.test(m) || rx.te.test(m) || rx.M.test(m) || rx.Q.test(m)) break;
          const qe = /^ {0,3}(?:=+|-+) *$/.test(f) && BLK_LHEADING.test(`${m}\n${f}`)
            ? `    ${Z.replace(/^ {0,3}/, '')}` : f;
          d += '\n' + qe;
        }
        y = !f.trim();
        e = e.substring(U.length + 1);
        m = Z.slice(R);
      }
    }
    const A = n.slice(k, pos());
    if (!list.loose) {
      if (p) list.loose = true;
      else if (DOUBLE_BLANK.test(A)) p = true;
    }
    list.items.push({ type: 'list_item', raw: A, task: LIST_IS_TASK.test(d), loose: false, text: d, tokens: [] });
  }
  const last = list.items.at(-1);
  if (last) { last.raw = last.raw.trimEnd(); last.text = last.text.trimEnd(); }
  else return undefined;
  list.raw = n.slice(0, pos()).trimEnd();
  for (const item of list.items) {
    st.top = false;
    item.tokens = blockTokens(item.text, [], st);
    if (!list.loose) {
      const spaces = item.tokens.filter((g) => g.type === 'space');
      if (spaces.length > 0 && spaces.some((g) => ANY_LINE.test(g.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const d0 = item.tokens[0];
    if (item.task && (d0?.type === 'text' || d0?.type === 'paragraph')) {
      item.text = item.text.replace(LIST_STRIP_TASK, '');
      d0.raw = d0.raw.replace(LIST_STRIP_TASK, '');
      d0.text = d0.text.replace(LIST_STRIP_TASK, '');
      for (let g = st.queue.length - 1; g >= 0; g--) {
        if (LIST_IS_TASK.test(st.queue[g].src)) {
          st.queue[g].src = st.queue[g].src.replace(LIST_STRIP_TASK, '');
          break;
        }
      }
      const k = LIST_CHECKBOX.exec(item.raw);
      if (k) {
        const cb = { type: 'checkbox', raw: k[0] + ' ', checked: k[0] !== '[ ]' };
        item.checked = cb.checked;
        if (list.loose) {
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) &&
              'tokens' in item.tokens[0] && item.tokens[0].tokens) {
            item.tokens[0].raw = cb.raw + item.tokens[0].raw;
            item.tokens[0].text = cb.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(cb);
          } else item.tokens.unshift({ type: 'paragraph', raw: cb.raw, text: cb.raw, tokens: [cb] });
        } else item.tokens.unshift(cb);
      }
    } else if (item.task) item.task = false;
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
    }
  }
  return list;
}

function blkHtml(src) {
  const t = BLK_HTML.exec(src);
  if (!t) return undefined;
  const raw = trimBlankTail(t[0]);
  return { type: 'html', block: true, raw, pre: t[1] === 'pre' || t[1] === 'script' || t[1] === 'style', text: raw };
}

function blkDef(src) {
  const t = BLK_DEF.exec(src);
  if (!t) return undefined;
  if (t[2].charAt(0) !== '<' && findBracketClose(t[2], '()') !== -1) return undefined;
  const tag = labelKey(t[1]);
  const href = t[2] ? t[2].replace(/^<(.*)>$/, '$1').replace(ANY_PUNCT, '$1') : '';
  const title = t[3] ? t[3].substring(1, t[3].length - 1).replace(ANY_PUNCT, '$1') : t[3];
  return { type: 'def', tag, raw: stripTrailing(t[0], '\n'), href, title };
}

function blkTable(src, st) {
  const t = BLK_TABLE.exec(src);
  if (!t || !/[:|]/.test(t[2])) return undefined;
  const header = splitCells(t[1]);
  const aligns = t[2].replace(/^\||\| *$/g, '').split('|');
  const rows = t[3]?.trim() ? t[3].replace(/\n[ \t]*$/, '').split('\n') : [];
  const table = { type: 'table', raw: stripTrailing(t[0], '\n'), header: [], align: [], rows: [] };
  if (header.length !== aligns.length) return undefined;
  for (const a of aligns) {
    if (/^ *-+: *$/.test(a)) table.align.push('right');
    else if (/^ *:-+: *$/.test(a)) table.align.push('center');
    else if (/^ *:-+ *$/.test(a)) table.align.push('left');
    else table.align.push(null);
  }
  for (let i = 0; i < header.length; i++) {
    table.header.push({ text: header[i], tokens: queueInline(st, header[i]), header: true, align: table.align[i] });
  }
  for (const row of rows) {
    table.rows.push(splitCells(row, table.header.length).map((cell, p) =>
      ({ text: cell, tokens: queueInline(st, cell), header: false, align: table.align[p] })));
  }
  return table;
}

function blkLheading(src, st) {
  const t = BLK_LHEADING.exec(src);
  if (!t) return undefined;
  const text = t[1].trim();
  return { type: 'heading', raw: stripTrailing(t[0], '\n'), depth: t[2].charAt(0) === '=' ? 1 : 2, text, tokens: queueInline(st, text) };
}

function blkParagraph(src, st) {
  const t = PARA_GFM.exec(src);
  if (!t) return undefined;
  const text = t[1].charAt(t[1].length - 1) === '\n' ? t[1].slice(0, -1) : t[1];
  return { type: 'paragraph', raw: t[0], text, tokens: queueInline(st, text) };
}

function blkText(src, st) {
  const t = BLK_TEXT.exec(src);
  if (!t) return undefined;
  return { type: 'text', raw: t[0], text: t[0], tokens: queueInline(st, t[0]) };
}

// The column of the first non-whitespace character of the first line, with
// tabs expanded to multiples of 4, and that character.
function firstCol(rest) {
  let col = 0, i = 0;
  while (i < rest.length) {
    const c = rest[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return { col, ch: rest[i] };
}

// A table needs a delimiter row right after the header line; a setext
// heading needs an `=`/`-` line before the first blank line. These cheap
// scans are necessary conditions, so a miss lets the expensive pattern be
// skipped entirely. Both are bounded to a few lines instead of the whole
// remaining source.
function tableGuard(rest) {
  const nl1 = rest.indexOf('\n');
  if (nl1 === -1) return false;
  const nl2 = rest.indexOf('\n', nl1 + 1);
  const line2 = rest.slice(nl1 + 1, nl2 === -1 ? rest.length : nl2);
  return /^ {0,3}[\|:-]/.test(line2);
}
function lheadingGuard(rest) {
  let i = 0;
  while (i < rest.length) {
    const nl = rest.indexOf('\n', i);
    const line = nl === -1 ? rest.slice(i) : rest.slice(i, nl);
    if (/^[ \t]*$/.test(line)) return false;
    if (i > 0 && /^ {0,3}[=-]/.test(line)) return true;
    if (nl === -1) return false;
    i = nl + 1;
  }
  return false;
}

// The block pass: cut `src` into block tokens, in order. `mergePara` is true
// when the first paragraph made here should merge into a preceding paragraph
// token (lazy lines inside a block quote). Returns the tokens; `st.top` is
// left true, as the next pass expects.
function blockTokens(src, tokens, st, mergePara = false) {
  let rest = src;
  let guard = Infinity;
  while (rest) {
    if (rest.length < guard) guard = rest.length;
    else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    let tok;
    const c0 = rest.charCodeAt(0);
    if (c0 === 10 || c0 === 32 || c0 === 9) {
      tok = blkSpace(rest);
      if (tok) {
        rest = rest.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(tok);
        continue;
      }
    }
    const fc = firstCol(rest);
    if (fc.col >= 4) {
      tok = blkCode(rest);
      if (tok) {
        rest = rest.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          st.queue.at(-1).src = prev.text;
        } else tokens.push(tok);
        continue;
      }
    }
    const ch = fc.ch;
    if (ch === '`' || ch === '~') tok = blkFences(rest);
    else if (ch === '#') tok = blkHeading(rest, st);
    else if (ch === '-' || ch === '_' || ch === '*') tok = blkHr(rest) || (ch !== '_' ? blkList(rest, st) : undefined);
    else if (ch === '+') tok = blkList(rest, st);
    else if (ch === '>') tok = blkBlockquote(rest, st);
    else if (ch === '<') tok = blkHtml(rest);
    else if (ch === '[') tok = blkDef(rest, st);
    else if (ch >= '0' && ch <= '9') tok = blkList(rest, st);
    if (tok) {
      rest = rest.substring(tok.raw.length);
      if (tok.type === 'def') {
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          st.queue.at(-1).src = prev.text;
        } else {
          if (!st.links[tok.tag]) st.links[tok.tag] = { href: tok.href, title: tok.title };
          tokens.push(tok);
        }
      } else tokens.push(tok);
      continue;
    }
    if (tableGuard(rest) && (tok = blkTable(rest, st))) {
      rest = rest.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (lheadingGuard(rest) && (tok = blkLheading(rest, st))) {
      rest = rest.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (st.top && (tok = blkParagraph(rest, st))) {
      const prev = tokens.at(-1);
      if (mergePara && prev?.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        st.queue.pop();
        st.queue.at(-1).src = prev.text;
      } else tokens.push(tok);
      mergePara = false;
      rest = rest.substring(tok.raw.length);
      continue;
    }
    if ((tok = blkText(rest, st))) {
      rest = rest.substring(tok.raw.length);
      const prev = tokens.at(-1);
      if (prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        st.queue.pop();
        st.queue.at(-1).src = prev.text;
      } else tokens.push(tok);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
  }
  st.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Plain-text rendering, used for image alt text: inline constructs collapse
// to the words they hold, and nothing becomes HTML.
function renderPlain(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'strong': case 'em': case 'del': case 'link': case 'image':
        out += tok.tokens ? renderPlain(tok.tokens) : tok.text;
        break;
      case 'codespan': case 'html': case 'text': case 'escape':
        out += tok.text;
        break;
      case 'br':
        break;
      case 'checkbox':
        out += tok.raw;
        break;
    }
  }
  return out;
}

function renderTextToken(tok) {
  if ('tokens' in tok && tok.tokens) return renderInline(tok.tokens);
  if ('escaped' in tok && tok.escaped) return tok.text;
  return esc(tok.text);
}

function renderInline(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape':
      case 'text':
        out += renderTextToken(tok);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'link': {
        const inner = tok.autolink ? esc(tok.text, true) : renderInline(tok.tokens);
        const clean = cleanUrl(tok.href);
        if (clean === null) { out += inner; break; }
        let a = '<a href="' + esc(clean, tok.autolink) + '"';
        if (tok.title) a += ' title="' + esc(tok.title) + '"';
        out += a + '>' + inner + '</a>';
        break;
      }
      case 'image': {
        let alt = tok.text;
        if (tok.tokens) alt = renderPlain(tok.tokens);
        const clean = cleanUrl(tok.href);
        if (clean === null) { out += esc(alt); break; }
        let img = '<img src="' + esc(clean) + '" alt="' + esc(alt) + '"';
        if (tok.title) img += ' title="' + esc(tok.title) + '"';
        out += img + '>';
        break;
      }
      case 'checkbox':
        out += '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'strong':
        out += '<strong>' + renderInline(tok.tokens) + '</strong>';
        break;
      case 'em':
        out += '<em>' + renderInline(tok.tokens) + '</em>';
        break;
      case 'codespan':
        out += '<code>' + esc(tok.text, true) + '</code>';
        break;
      case 'br':
        out += '<br>';
        break;
      case 'del':
        out += '<del>' + renderInline(tok.tokens) + '</del>';
        break;
    }
  }
  return out;
}

function renderCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) +
    renderInline(cell.tokens) + `</${tag}>\n`;
}

function renderTokens(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
      case 'def':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${tok.depth}>` + renderInline(tok.tokens) + `</h${tok.depth}>\n`;
        break;
      case 'code': {
        const lang = (tok.lang || '').match(/^\S*/)?.[0];
        const body = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
        if (lang) out += '<pre><code class="language-' + esc(lang) + '">' + esc(body, true) + '</code></pre>\n';
        else out += '<pre><code>' + esc(body, true) + '</code></pre>\n';
        break;
      }
      case 'table': {
        let head = '';
        for (const cell of tok.header) head += renderCell(cell);
        let body = '';
        for (const row of tok.rows) {
          let rowHtml = '';
          for (const cell of row) rowHtml += renderCell(cell);
          body += '<tr>\n' + rowHtml + '</tr>\n';
        }
        if (body) body = '<tbody>' + body + '</tbody>';
        out += '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' + body + '</table>\n';
        break;
      }
      case 'blockquote':
        out += '<blockquote>\n' + renderTokens(tok.tokens) + '</blockquote>\n';
        break;
      case 'list': {
        let items = '';
        for (const item of tok.items) items += '<li>' + renderTokens(item.tokens) + '</li>\n';
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
        out += '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
        break;
      }
      case 'checkbox':
        out += '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'html':
        out += tok.text;
        break;
      case 'paragraph':
        out += '<p>' + renderInline(tok.tokens) + '</p>\n';
        break;
      case 'text':
        out += renderTextToken(tok);
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
// Render one Markdown document to HTML. No state is kept between calls: every
// call lexes, tokenizes and renders from scratch, so the result depends only
// on the string passed in.
export function parse(input) {
  const src = String(input).replace(/\r\n|\r/g, '\n');
  const st = {
    links: Object.create(null),
    queue: [],
    top: true,
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
  };
  const tokens = blockTokens(src, [], st);
  for (let i = 0; i < st.queue.length; i++) {
    const item = st.queue[i];
    st.inRawBlock = false;
    inlineTokens(item.src, item.tokens, st);
  }
  return renderTokens(tokens);
}
