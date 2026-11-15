// parse.js — a fast, dependency-free Markdown parser.
//
// Renders CommonMark 0.31.2 plus GitHub Flavored Markdown (tables, task
// lists, strikethrough, extended autolinks) to exactly the HTML that marked
// 18.1.3 produces with its default options (gfm on, breaks off, pedantic
// off, async off). Where marked departs from the spec, marked wins: this
// file is a from-scratch reimplementation of that behaviour, not of the
// spec text.
//
// Design (my own layout, same observable behaviour):
//   1. `parse` normalises line endings, then the block lexer walks the
//      source top to bottom and cuts it into block tokens (headings,
//      code, quotes, lists, tables, paragraphs, ...). Some tokens carry
//      their inline source unparsed in an `inlineQueue`; those are lexed
//      after the block pass, which is what lets a link reference defined
//      later in the document resolve a link used earlier.
//   2. The inline lexer walks a token's text and cuts it into inline
//      tokens (emphasis, links, code spans, autolinks, ...), with the
//      same delimiter-run rules marked uses, including its masking pass
//      that hides link destinations and code spans from emphasis.
//   3. The renderer walks the token tree and writes HTML strings.
//
// The whole module is stateless: `parse` builds fresh lexer state on every
// call, keeps nothing between calls, and reads no files, clocks or env.

/* ------------------------------------------------------------------ */
/* Regex construction                                                  */
/* ------------------------------------------------------------------ */

// Small builder for composing big patterns out of named pieces, the way
// you would write a grammar: start from a template source, then substitute
// a placeholder word (or pattern) with another pattern's source. A stray
// `^` anchor inside an inserted piece is dropped, because an anchor only
// means something at the very start of the final pattern.
function rx(template, flags = "") {
  let src = typeof template === "string" ? template : template.source;
  const api = {
    sub(pattern, piece) {
      let p = piece;
      if (p && typeof p.build === "function") p = p.build();
      p = typeof p === "string" ? p : p.source;
      p = p.replace(/(^|[^[])\^/g, "$1");
      src = src.replace(pattern, p);
      return api;
    },
    build() {
      return new RegExp(src, flags);
    },
  };
  return api;
}

// Memoised builder for the little per-indent patterns the list walker
// needs (next bullet, hr, fence start, heading start, html start, quote
// start). Only the indent levels 0..3 are ever built; deeper indents reuse
// the level-3 pattern, exactly as marked does.
function memoRegex(make) {
  const cache = [];
  return (indent) => {
    const n = Math.max(0, Math.min(3, indent - 1));
    return cache[n] || (cache[n] = make(n));
  };
}

// Unicode classes used by the emphasis and autolink rules.
const PUNCT = /[\p{P}\p{S}]/u; // any punctuation or symbol
const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u; // punctuation, symbol or space
const NOT_PUNCT_OR_SPACE = /[^\s\p{P}\p{S}]/u; // a "word" character
const PUNCT_NO_TILDE = /(?!~)[\p{P}\p{S}]/u; // punctuation/symbol, not ~
const PUNCT_SPACE_NO_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_OR_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;

/* ------------------------------------------------------------------ */
/* Shared helper patterns (the "other" table)                          */
/* ------------------------------------------------------------------ */

const BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";

const OTHER = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand:
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^[])\^/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  // Builders for the per-indent line tests used while gathering list items.
  listItemRegex: (bullet) =>
    new RegExp(`^( {0,3}${bullet})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: memoRegex(
    (n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`),
  ),
  hrRegex: memoRegex(
    (n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`),
  ),
  fencesBeginRegex: memoRegex((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: memoRegex((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: memoRegex(
    (n) =>
      new RegExp(
        `^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
        "i",
      ),
  ),
  blockquoteBeginRegex: memoRegex((n) => new RegExp(`^ {0,${n}}>`)),
};

/* ------------------------------------------------------------------ */
/* Block patterns (GFM set)                                            */
/* ------------------------------------------------------------------ */

// The paragraph body: one or more lines, where a following line is only
// taken if it does not start a new block (hr, heading, setext underline,
// blockquote, fence, list, html, table) and is not a blank-ish line.
const PARAGRAPH_BODY = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;

// The setext-heading detector: a paragraph-like run followed by a line of
// `=` or `-`. The leading negative lookahead keeps a run that starts with a
// block opener from being read as a setext heading.
const SETEXT_TEMPLATE =
  /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;

// An HTML comment, used inside the HTML-block pattern.
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// The raw-HTML block pattern, built from its seven alternatives:
// script/pre/style/textarea, comment, processing instruction, declaration,
// CDATA, a block-level open/close tag, an open tag of any other element
// followed by a blank line, a close tag followed by a blank line.
const HTML_BLOCK = rx(
  "^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))",
  "i",
)
  .sub("comment", HTML_COMMENT)
  .sub("tag", BLOCK_TAGS)
  .sub(
    "attribute",
    / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/,
  )
  .build();

// A link reference definition: `[label]: destination "optional title"`.
// The label may span lines and contain escapes; the destination may be in
// `<>` or bare; the title may be in double quotes, single quotes or parens.
const LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const LINK_TITLE =
  /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
const DEF = rx(
  /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/,
)
  .sub("label", LABEL)
  .sub("title", LINK_TITLE)
  .build();

const HR_INLINE = " {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)";

// A table: header line, delimiter line, then body rows until a blank line
// or a line that starts another block.
const TABLE = rx(
  "^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)",
)
  .sub("hr", HR_INLINE)
  .sub("heading", " {0,3}#{1,6}(?:\\s|$)")
  .sub("blockquote", " {0,3}>")
  .sub("code", "(?: {4}| {0,3}\t)[^\\n]")
  .sub("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)")
  .sub("list", " {0,3}(?:[*+-]|1[.)])[ \\t]")
  .sub(
    "html",
    rx(" {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").sub(
      "tag",
      BLOCK_TAGS,
    ),
  )
  .build();

// The paragraph pattern for GFM: like PARAGRAPH_BODY, but a table delimiter
// line also ends the paragraph, and a list only interrupts when its marker
// is `1.`/`1)` or a bullet followed by a space and non-space.
function paragraphPattern(listPattern) {
  return rx(PARAGRAPH_BODY)
    .sub("hr", HR_INLINE)
    .sub("heading", " {0,3}#{1,6}(?:\\s|$)")
    .sub("|lheading", "")
    .sub("table", TABLE)
    .sub("blockquote", " {0,3}>")
    .sub("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)")
    .sub("list", listPattern)
    .sub(
      "html",
      rx(" {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").sub(
        "tag",
        BLOCK_TAGS,
      ),
    )
    .build();
}

// The blockquote pattern: a run of lines where each line either starts
// with `>` or, while the quote is open, continues the paragraph inside it.
const BLOCKQUOTE = rx(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .sub("paragraph", paragraphPattern(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/))
  .build();

// The setext pattern for GFM: same as the template, but a table delimiter
// line also counts as a block opener that keeps the run from being a heading.
const SETEXT_GFM = rx(SETEXT_TEMPLATE)
  .sub(/bull/g, / {0,3}(?:[*+-]|\d{1,9}[.)])/)
  .sub(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .sub(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .sub(/blockquote/g, / {0,3}>/)
  .sub(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .sub(/hr/g, HR_INLINE)
  .sub(/html/g, / {0,3}<[^\n>]+>\n/)
  .sub(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .build();

const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences:
    /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  blockquote: BLOCKQUOTE,
  list: rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
    .sub(/bull/g, / {0,3}(?:[*+-]|\d{1,9}[.)])/)
    .build(),
  html: HTML_BLOCK,
  def: DEF,
  table: TABLE,
  lheading: SETEXT_GFM,
  paragraph: paragraphPattern(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/),
  text: /^[^\n]+/,
};

/* ------------------------------------------------------------------ */
/* Inline patterns (GFM set)                                           */
/* ------------------------------------------------------------------ */

// The pieces the inline rules are built from.
const INLINE_LABEL =
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/;
const BRACKETED = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const INLINE_LABEL_NESTED = rx(INLINE_LABEL).sub("brackets", BRACKETED).build();
const LABEL_NO_NL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const LABEL_REF = /(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const LINK_HREF = /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/;
const LINK_TITLE_INLINE = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/;
const EMAIL_LOCAL = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
const EMAIL_GFM = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
// The same email shape without a capture group: used inside the
// `mailto:`/`xmpp:` protocol alternative, where a group would shift the
// numbering of the groups the url tokenizer reads.
const EMAIL_GFM_PLAIN = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const SCHEME = /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/;
const URL_PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;

// Inline link: `[text](destination "title")`, with an optional `!` for images.
const INLINE_LINK = rx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .sub("label", INLINE_LABEL_NESTED)
  .sub("href", LINK_HREF)
  .sub("title", LINK_TITLE_INLINE)
  .build();

// Reference link `[text][ref]` and shortcut link `[text]`.
const REFLINK = rx(/^!?\[(label)\]\[(ref)\]/)
  .sub("label", INLINE_LABEL_NESTED)
  .sub("ref", LABEL_NO_NL)
  .build();
const NOLINK = rx(/^!?\[(ref)\](?:\[\])?/).sub("ref", LABEL_NO_NL).build();

// The autolink `<scheme:...>` / `<email>`.
const AUTOLINK = rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .sub("scheme", SCHEME)
  .sub("email", EMAIL_LOCAL)
  .build();

// Raw HTML tag (inline): comment, close tag, open tag, processing
// instruction, declaration, CDATA.
const INLINE_TAG = rx(
  "^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>",
)
  .sub("comment", rx(HTML_COMMENT).sub("(?:-->|$)", "-->").build())
  .sub(
    "attribute",
    /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/,
  )
  .build();

// Emphasis delimiters. The left-delimiter rule looks at the run of `*`/`_`
// and the character class of what follows it; the right-delimiter rules
// scan for a run that can close, given the punctuation/space classes
// around it. The GFM variants treat `~` as punctuation for this purpose.
const EM_STRONG_LEFT = rx(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, "u")
  .sub(/punct/g, PUNCT_NO_TILDE)
  .build();
const EM_STRONG_RIGHT_AST = rx(
  "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)",
  "gu",
)
  .sub(/notPunctSpace/g, NOT_PUNCT_SPACE_OR_TILDE)
  .sub(/punctSpace/g, PUNCT_SPACE_NO_TILDE)
  .sub(/punct/g, PUNCT_NO_TILDE)
  .build();
const EM_STRONG_RIGHT_UND = rx(
  "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)",
  "gu",
)
  .sub(/notPunctSpace/g, NOT_PUNCT_OR_SPACE)
  .sub(/punctSpace/g, PUNCT_OR_SPACE)
  .sub(/punct/g, PUNCT)
  .build();

// Strikethrough delimiters.
const DEL_LEFT = rx(/^~~?(?:((?!~)punct)|[^\s~])/, "u").sub(/punct/g, PUNCT).build();
const DEL_RIGHT = rx(
  "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)",
  "gu",
)
  .sub(/notPunctSpace/g, NOT_PUNCT_OR_SPACE)
  .sub(/punctSpace/g, PUNCT_OR_SPACE)
  .sub(/punct/g, PUNCT)
  .build();

// The emphasis-masking pieces: what counts as a link, a code span or a
// raw tag while the mask hides them from emphasis parsing.
const LOOKBEHIND_OK = true; // Node 22 supports lookbehind
const BLOCK_SKIP = rx(/link|precode-code|html/, "g")
  .sub(
    "link",
    /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/,
  )
  .sub("precode-", LOOKBEHIND_OK ? "(?<!`)()" : "(^^|[^`])")
  .sub("code", /(?<b>`+)[^`]+\k<b>(?!`)/)
  .sub("html", /<(?! )[^<>]*?>/)
  .build();

// The reference-link search used by the mask: full `[text][ref]` and
// shortcut `[text]`, built from a looser label that may itself hold
// brackets, code spans and escapes.
const REFLINK_LABEL_LOOSE = rx(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
)
  .sub("brackets", BRACKETED)
  .build();
const REFLINK_SEARCH = rx("reflink|nolink(?!\\()", "g")
  .sub(
    "reflink",
    rx(/^!?\[(label)\]\[(ref)\]/)
      .sub("label", REFLINK_LABEL_LOOSE)
      .sub("ref", LABEL_REF)
      .build(),
  )
  .sub(
    "nolink",
    rx(/^!?\[(ref)\](?:\[\])?/).sub("ref", LABEL_REF).build(),
  )
  .build();

// Extended autolink (GFM): `www.`, a scheme, or a bare email address.
const EXTENDED_URL = rx(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .sub(
    "emailProtocol",
    rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).sub(/email/g, EMAIL_GFM_PLAIN).build(),
  )
  .sub("protocol", URL_PROTOCOL)
  .sub("email", EMAIL_GFM)
  .build();

// Plain text: the catch-all that consumes a run of ordinary characters,
// stopping before anything that could start another inline construct
// (backslash, `<`, `[`, backtick, `*`, `~`, `_` at a word boundary, an
// autolink scheme or `www.`, an email address, or a hard break).
const INLINE_TEXT = rx(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
)
  .sub("protocol", URL_PROTOCOL)
  .sub(/emailProtocol/g, /(?:mailto|xmpp):/)
  .sub("wwwStart", LOOKBEHIND_OK ? "(?<![^\\s*_~(])www\\." : "www\\.")
  .build();

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  text: INLINE_TEXT,
  tag: INLINE_TAG,
  autolink: AUTOLINK,
  link: INLINE_LINK,
  reflink: REFLINK,
  nolink: NOLINK,
  emStrongLDelim: EM_STRONG_LEFT,
  emStrongRDelimAst: EM_STRONG_RIGHT_AST,
  emStrongRDelimUnd: EM_STRONG_RIGHT_UND,
  delLDelim: DEL_LEFT,
  delRDelim: DEL_RIGHT,
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  url: EXTENDED_URL,
  _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  punctuation: rx(/^((?![*_])punctSpace)/, "u").sub(/punctSpace/g, PUNCT_OR_SPACE).build(),
  blockSkip: BLOCK_SKIP,
  reflinkSearch: REFLINK_SEARCH,
  anyPunctuation: rx(/\\(punct)/, "gu").sub(/punct/g, PUNCT).build(),
  anyPunctuationOutsideCode: rx(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, "gu")
    .sub(/punct/g, PUNCT)
    .build(),
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// Escape HTML special characters. With `encode`, every `&` is escaped;
// without it, `&` is left alone when it already starts a character
// reference (named, decimal or hex), which is how raw text keeps entities.
function escapeHtml(text, encode) {
  if (encode) {
    if (OTHER.escapeTest.test(text)) return text.replace(OTHER.escapeReplace, (c) => HTML_ESCAPES[c]);
  } else if (OTHER.escapeTestNoEncode.test(text)) {
    return text.replace(OTHER.escapeReplaceNoEncode, (c) => HTML_ESCAPES[c]);
  }
  return text;
}

// Decode numeric character references in a run of text, and turn a bare
// `&` that does not start a reference into `&amp;`. Named entities are
// left as-is here: they are only decoded where marked decodes them (link
// destinations and titles go through the same step via the same rule —
// actually they are not decoded at all, which is why this only handles
// numeric references and stray ampersands).
function decodeEntities(text) {
  if (!OTHER.numericCharacterReference.test(text)) return text;
  return text.replace(OTHER.numericCharacterReferenceOrAmpersand, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return "&amp;";
    const code = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\uFFFD";
    if (code === 38) return "&amp;";
    return String.fromCodePoint(code);
  });
}

// Sanitise a link destination: percent-encode it, but keep literal `%`
// that was already a percent-escape. Returns null when it cannot be
// encoded (a lone surrogate), in which case the link renders as plain text.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(OTHER.percentDecode, "%");
  } catch {
    return null;
  }
}

// Split a table row on unescaped pipes, honouring the column count.
function splitTableRow(row, columns) {
  const cells = row
    .replace(OTHER.findPipe, (pipe, offset, str) => {
      let escaped = false;
      for (let p = offset - 1; p >= 0 && str[p] === "\\"; p--) escaped = !escaped;
      return escaped ? "|" : " |";
    })
    .split(OTHER.splitPipe);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (columns) {
    if (cells.length > columns) cells.splice(columns);
    else while (cells.length < columns) cells.push("");
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(OTHER.slashPipe, "|");
  return cells;
}

// Strip the trailing run of `char` from `text` (or, with `stripOther`,
// the trailing run of characters that are NOT `char`). Used to peel
// closing hashes off a heading, backslashes off a link destination, and
// newlines off a token's raw text.
function stripTrailing(text, char, stripOther = false) {
  const n = text.length;
  if (n === 0) return "";
  let i = 0;
  for (; i < n;) {
    const c = text.charAt(n - i - 1);
    if (c === char && !stripOther) i++;
    else if (c !== char && stripOther) i++;
    else break;
  }
  return text.slice(0, n - i);
}

// Remove trailing blank lines from an indented code block, keeping at most
// one trailing newline's worth of blankness (marked keeps the block when
// only one blank line trails it).
function stripTrailingBlankLines(text) {
  const lines = text.split("\n");
  let last = lines.length - 1;
  for (; last >= 0 && OTHER.blankLine.test(lines[last]); last--) {}
  return lines.length - last <= 2 ? text : lines.slice(0, last + 1).join("\n");
}

// Normalise a link label for lookup: trim, collapse runs of whitespace to
// a single space, and fold case (lower, then upper, then lower again,
// which is marked's way of getting a stable Unicode-insensitive key).
function normaliseLabel(label) {
  return label.trim().replace(OTHER.multipleSpaceGlobal, " ").toLowerCase().toUpperCase().toLowerCase();
}

// Expand tabs to spaces, tracking the visual column (a tab jumps to the
// next multiple of 4).
function expandTabs(text, startColumn = 0) {
  let column = startColumn;
  let out = "";
  for (const ch of text) {
    if (ch === "\t") {
      const width = 4 - (column % 4);
      out += " ".repeat(width);
      column += width;
    } else {
      out += ch;
      column++;
    }
  }
  return out;
}

// Find the index of the closing paren that balances `open`/`close` in
// `text`, skipping backslash escapes. -1 when there is no closing paren,
// -2 when the parens never balance (an unmatched opener remains).
function findClosingParen(text, [open, close]) {
  if (text.indexOf(open) === -1 && text.indexOf(close) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === open) depth++;
    else if (text[i] === close && --depth < 0) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Compensate the indentation of a fenced code block's lines when the
// opening fence was indented: remove up to that many leading spaces from
// each line.
function compensateFenceIndent(raw, body) {
  const m = raw.match(OTHER.indentCodeCompensation);
  if (m === null) return body;
  const indent = m[1];
  return body
    .split("\n")
    .map((line) => {
      const lead = line.match(OTHER.beginningSpace);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join("\n");
}

// Check whether the link text `label` (starting at offset `at` in the
// source `src`) hides a raw tag or autolink that runs past the end of the
// label. When it does, the link is not a link at all.
function linkTextHidesTag(src, label, at) {
  if (!label.includes("<")) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === "\\") {
      i++;
      continue;
    }
    if (label[i] === "`") {
      const code = INLINE.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== "<") continue;
    const rest = src.slice(at + i);
    const tag = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (tag) {
      if (tag[0].length > label.length - i) return true;
      i += tag[0].length - 1;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Block tokenizing                                                    */
/* ------------------------------------------------------------------ */

// The tokenizer turns a source string into tokens. It holds a back
// reference to the lexer that owns it, because heading/table/paragraph
// tokens queue their text for inline lexing through the lexer.
class Tokenizer {
  constructor() {
    this.lexer = null;
  }

  space(src) {
    const m = BLOCK.newline.exec(src);
    if (m && m[0].length > 0) return { type: "space", raw: m[0] };
  }

  code(src) {
    const m = BLOCK.code.exec(src);
    if (m) {
      const raw = stripTrailingBlankLines(m[0]);
      const text = raw.replace(OTHER.codeRemoveIndent, "");
      return { type: "code", raw, codeBlockStyle: "indented", text };
    }
  }

  fences(src) {
    const m = BLOCK.fences.exec(src);
    if (m) {
      const raw = m[0];
      const text = compensateFenceIndent(raw, m[3] || "");
      return {
        type: "code",
        raw,
        lang: m[2] ? m[2].trim().replace(INLINE.anyPunctuation, "$1") : m[2],
        text,
      };
    }
  }

  heading(src) {
    const m = BLOCK.heading.exec(src);
    if (m) {
      let text = m[2].trim();
      if (OTHER.endingHash.test(text)) {
        const stripped = stripTrailing(text, "#");
        if (!stripped || OTHER.endingSpaceTabChar.test(stripped)) text = stripped.trim();
      }
      return {
        type: "heading",
        raw: stripTrailing(m[0], "\n"),
        depth: m[1].length,
        text,
        tokens: this.lexer.inline(text),
      };
    }
  }

  hr(src) {
    const m = BLOCK.hr.exec(src);
    if (m) return { type: "hr", raw: stripTrailing(m[0], "\n") };
  }

  blockquote(src) {
    const m = BLOCK.blockquote.exec(src);
    if (!m) return;
    const lines = stripTrailing(m[0], "\n").split("\n");
    let raw = "";
    let text = "";
    const tokens = [];
    while (lines.length > 0) {
      let open = false;
      const chunk = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (OTHER.blockquoteStart.test(lines[p])) {
          chunk.push(lines[p]);
          open = true;
        } else if (!open) chunk.push(lines[p]);
        else break;
      }
      lines.splice(0, p);
      const chunkRaw = chunk.join("\n");
      // Strip the `>` markers, expanding tabs after them the way the
      // marker's own width dictates, and indent any setext underline
      // so it stays an underline after the marker is gone.
      const chunkText = chunkRaw
        .replace(OTHER.blockquoteMarkerWhitespace, (whole, marker, ws) => marker + expandTabs(ws, marker.length))
        .replace(OTHER.blockquoteSetextReplace, "\n    $1")
        .replace(OTHER.blockquoteSetextReplace2, "");
      raw = raw ? `${raw}\n${chunkRaw}` : chunkRaw;
      text = text ? `${text}\n${chunkText}` : chunkText;
      const savedTop = this.lexer.state.top;
      this.lexer.state.top = true;
      this.lexer.lexBlocks(chunkText, tokens, true);
      this.lexer.state.top = savedTop;
      if (lines.length === 0) break;
      const last = tokens[tokens.length - 1];
      if (
        last?.type === "code" ||
        last?.type === "heading" ||
        last?.type === "hr" ||
        last?.type === "html" ||
        last?.type === "table"
      ) {
        break;
      }
      if (last?.type === "blockquote") {
        // A nested quote: re-run the whole quote (outer raw + the rest
        // of the lines) as one blockquote, then account for the lines
        // that re-run consumed.
        const rest = lines.join("\n");
        const combined = last.raw + "\n" + rest.replace(OTHER.blockquoteSetextReplace2, "");
        const reparsed = this.blockquote(combined);
        tokens[tokens.length - 1] = reparsed;
        const leftover = combined.substring(reparsed.raw.length).replace(/^\n/, "");
        const leftoverLines = leftover ? leftover.split("\n").length : 0;
        const consumed = leftoverLines ? lines.slice(0, -leftoverLines) : lines;
        if (consumed.length > 0) raw = `${raw}\n${consumed.join("\n")}`;
        text = text.substring(0, text.length - last.text.length) + reparsed.text;
        lines.splice(0, consumed.length);
        if (lines.length > 0 && OTHER.blockquoteStart.test(lines[0])) continue;
        break;
      }
      if (last?.type === "list") {
        // A list inside the quote may continue onto the following
        // lines: re-run it with those lines appended.
        const combined = last.raw + "\n" + lines.join("\n");
        const reparsed = this.list(combined);
        tokens[tokens.length - 1] = reparsed;
        const extra =
          reparsed.raw.length > last.raw.length
            ? combined.slice(last.raw.length + 1, reparsed.raw.length).split("\n").length
            : 0;
        if (extra > 0) {
          const taken = lines.slice(0, extra).join("\n");
          raw = `${raw}\n${taken}`;
          text = `${text}\n${taken}`;
        }
        lines.splice(0, extra);
        continue;
      }
    }
    return { type: "blockquote", raw, tokens, text };
  }

  list(src) {
    const m = BLOCK.list.exec(src);
    if (!m) return;
    const full = src;
    let bullet = m[1].trim();
    const ordered = bullet.length > 1;
    const list = {
      type: "list",
      raw: "",
      ordered,
      start: ordered ? +bullet.slice(0, -1) : "",
      loose: false,
      items: [],
    };
    bullet = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
    const itemPattern = OTHER.listItemRegex(bullet);
    let sawBlankBetween = false;
    let rest = src;
    for (; rest;) {
      let emptyItem = false;
      let itemText = "";
      let match = itemPattern.exec(rest);
      if (!match || BLOCK.hr.test(rest)) break;
      const startOffset = full.length - rest.length;
      rest = rest.substring(match[0].length);
      // The first line after the bullet, with its leading whitespace
      // expanded to spaces relative to the bullet's width.
      const firstLine = match[2].split("\n", 1)[0];
      const bulletLen = match[1].length;
      let content = firstLine.replace(OTHER.leadingSpaceTab, (ws) => expandTabs(ws, bulletLen));
      let nextLine = rest.split("\n", 1)[0];
      let isEmpty = !content.trim();
      let indent = 0;
      if (isEmpty) {
        indent = bulletLen + 1;
      } else {
        indent = content.search(OTHER.nonSpaceChar);
        indent = indent > 4 ? 1 : indent;
        itemText = content.slice(indent);
        indent += bulletLen;
      }
      // An empty item followed by a blank line ends the item there.
      if (isEmpty && OTHER.blankLine.test(nextLine)) {
        rest = rest.substring(nextLine.length + 1);
        emptyItem = true;
      }
      if (!emptyItem) {
        const nextBullet = OTHER.nextBulletRegex(indent);
        const hrAt = OTHER.hrRegex(indent);
        const fenceAt = OTHER.fencesBeginRegex(indent);
        const headingAt = OTHER.headingBeginRegex(indent);
        const htmlAt = OTHER.htmlBeginRegex(indent);
        const quoteAt = OTHER.blockquoteBeginRegex(indent);
        while (rest) {
          const line = rest.split("\n", 1)[0];
          let expanded;
          nextLine = line;
          expanded = line.replace(OTHER.leadingSpaceTab, (ws) => expandTabs(ws));
          if (
            fenceAt.test(line) ||
            headingAt.test(line) ||
            htmlAt.test(line) ||
            quoteAt.test(line) ||
            nextBullet.test(line) ||
            hrAt.test(line)
          ) {
            break;
          }
          if (expanded.search(OTHER.nonSpaceChar) >= indent || !line.trim()) {
            itemText += "\n" + expanded.slice(indent);
          } else {
            if (
              isEmpty ||
              content.replace(OTHER.tabCharGlobal, "    ").search(OTHER.nonSpaceChar) >= 4 ||
              fenceAt.test(content) ||
              headingAt.test(content) ||
              htmlAt.test(content) ||
              hrAt.test(content)
            ) {
              break;
            }
            // A setext underline directly under the item's first line
            // belongs to the item, indented so it still underlines.
            const setextLine =
              /^ {0,3}(?:=+|-+) *$/.test(line) && BLOCK.lheading.test(`${content}\n${line}`)
                ? `    ${expanded.replace(/^ {0,3}/, "")}`
                : line;
            itemText += "\n" + setextLine;
          }
          isEmpty = !line.trim();
          rest = rest.substring(line.length + 1);
          content = expanded.slice(indent);
        }
      }
      const itemRaw = full.slice(startOffset, full.length - rest.length);
      // A blank line inside one item means the *next* item makes the
      // list loose; a list already loose stays loose.
      if (!list.loose) {
        if (sawBlankBetween) list.loose = true;
        else if (OTHER.doubleBlankLine.test(itemRaw)) sawBlankBetween = true;
      }
      list.items.push({
        type: "list_item",
        raw: itemRaw,
        task: OTHER.listIsTask.test(itemText),
        loose: false,
        text: itemText,
        tokens: [],
      });
    }
    const lastItem = list.items[list.items.length - 1];
    if (!lastItem) return;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    list.raw = full.slice(0, full.length - rest.length).trimEnd();
    // Lex each item's contents on its own. An item that holds a blank
    // line makes the whole list loose.
    for (const item of list.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.lexBlocks(item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter((tok) => tok.type === "space");
        list.loose = spaces.length > 0 && spaces.some((tok) => OTHER.anyLine.test(tok.raw));
      }
    }
    // Task list items: peel the `[ ]` / `[x]` off the front and turn it
    // into a checkbox token.
    for (const item of list.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === "text" || first?.type === "paragraph")) {
        item.text = item.text.replace(OTHER.listReplaceTask, "");
        first.raw = first.raw.replace(OTHER.listReplaceTask, "");
        first.text = first.text.replace(OTHER.listReplaceTask, "");
        for (let q = this.lexer.inlineQueue.length - 1; q >= 0; q--) {
          if (OTHER.listIsTask.test(this.lexer.inlineQueue[q].src)) {
            this.lexer.inlineQueue[q].src = this.lexer.inlineQueue[q].src.replace(
              OTHER.listReplaceTask,
              "",
            );
            break;
          }
        }
        const box = OTHER.listTaskCheckbox.exec(item.raw);
        if (box) {
          const checkbox = { type: "checkbox", raw: box[0] + " ", checked: box[0] !== "[ ]" };
          item.checked = checkbox.checked;
          if (list.loose) {
            if (
              item.tokens[0] &&
              ["paragraph", "text"].includes(item.tokens[0].type) &&
              "tokens" in item.tokens[0] &&
              item.tokens[0].tokens
            ) {
              item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
              item.tokens[0].text = checkbox.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(checkbox);
            } else {
              item.tokens.unshift({
                type: "paragraph",
                raw: checkbox.raw,
                text: checkbox.raw,
                tokens: [checkbox],
              });
            }
          } else {
            item.tokens.unshift(checkbox);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const tok of item.tokens) if (tok.type === "text") tok.type = "paragraph";
      }
    }
    return list;
  }

  html(src) {
    const m = BLOCK.html.exec(src);
    if (m) {
      const raw = stripTrailingBlankLines(m[0]);
      return {
        type: "html",
        block: true,
        raw,
        pre: m[1] === "pre" || m[1] === "script" || m[1] === "style",
        text: raw,
      };
    }
  }

  def(src) {
    const m = BLOCK.def.exec(src);
    if (!m) return;
    if (!OTHER.startAngleBracket.test(m[2]) && findClosingParen(m[2], "()") !== -1) return;
    const tag = normaliseLabel(m[1]);
    const href = m[2]
      ? m[2].replace(OTHER.hrefBrackets, "$1").replace(INLINE.anyPunctuation, "$1")
      : "";
    const title = m[3]
      ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, "$1")
      : m[3];
    return { type: "def", tag, raw: stripTrailing(m[0], "\n"), href, title };
  }

  table(src) {
    const m = BLOCK.table.exec(src);
    if (!m || !OTHER.tableDelimiter.test(m[2])) return;
    const headerCells = splitTableRow(m[1]);
    const delimiters = m[2].replace(OTHER.tableAlignChars, "").split("|");
    const bodyLines = m[3]?.trim() ? m[3].replace(OTHER.tableRowBlankLine, "").split("\n") : [];
    const table = {
      type: "table",
      raw: stripTrailing(m[0], "\n"),
      header: [],
      align: [],
      rows: [],
    };
    if (headerCells.length === delimiters.length) {
      for (const d of delimiters) {
        if (OTHER.tableAlignRight.test(d)) table.align.push("right");
        else if (OTHER.tableAlignCenter.test(d)) table.align.push("center");
        else if (OTHER.tableAlignLeft.test(d)) table.align.push("left");
        else table.align.push(null);
      }
      for (let i = 0; i < headerCells.length; i++) {
        table.header.push({
          text: headerCells[i],
          tokens: this.lexer.inline(headerCells[i]),
          header: true,
          align: table.align[i],
        });
      }
      for (const line of bodyLines) {
        table.rows.push(
          splitTableRow(line, table.header.length).map((cell, i) => ({
            text: cell,
            tokens: this.lexer.inline(cell),
            header: false,
            align: table.align[i],
          })),
        );
      }
      return table;
    }
  }

  lheading(src) {
    const m = BLOCK.lheading.exec(src);
    if (m) {
      const text = m[1].trim();
      return {
        type: "heading",
        raw: stripTrailing(m[0], "\n"),
        depth: m[2].charAt(0) === "=" ? 1 : 2,
        text,
        tokens: this.lexer.inline(text),
      };
    }
  }

  paragraph(src) {
    const m = BLOCK.paragraph.exec(src);
    if (m) {
      const text = m[1].charAt(m[1].length - 1) === "\n" ? m[1].slice(0, -1) : m[1];
      return { type: "paragraph", raw: m[0], text, tokens: this.lexer.inline(text) };
    }
  }

  text(src) {
    const m = BLOCK.text.exec(src);
    if (m) return { type: "text", raw: m[0], text: m[0], tokens: this.lexer.inline(m[0]) };
  }
}

/* ------------------------------------------------------------------ */
/* Block lexer: walks the source and builds the token list             */
/* ------------------------------------------------------------------ */

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.tokenizer = new Tokenizer();
    this.tokenizer.lexer = this;
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
  }

  // Lex the whole document: block pass, then the queued inline passes.
  lex(src) {
    src = src.replace(OTHER.carriageReturn, "\n");
    this.lexBlocks(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const entry = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(entry.src, entry.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  // The main block loop. `nested` is true when lexing the inside of a
  // blockquote, where a paragraph that follows a paragraph merges into it.
  lexBlocks(src, tokens, nested = false) {
    let shortest = Infinity;
    let rest = src;
    while (rest) {
      if (rest.length < shortest) {
        shortest = rest.length;
      } else {
        throw new Error("Infinite loop on byte: " + rest.charCodeAt(0));
      }
      let tok;
      if ((tok = this.tokenizer.space(rest))) {
        rest = rest.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += "\n";
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.code(rest))) {
        rest = rest.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev?.type === "paragraph" || prev?.type === "text") {
          prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + tok.raw;
          prev.text += "\n" + tok.text;
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.tokenizer.fences(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.heading(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.hr(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.blockquote(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.list(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.html(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.def(rest))) {
        rest = rest.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev?.type === "paragraph" || prev?.type === "text") {
          prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + tok.raw;
          prev.text += "\n" + tok.raw;
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          if (!this.tokens.links[tok.tag]) {
            this.tokens.links[tok.tag] = { href: tok.href, title: tok.title };
          }
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.tokenizer.table(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.lheading(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      let paraSrc = rest;
      if (this.state.top && (tok = this.tokenizer.paragraph(paraSrc))) {
        const prev = tokens[tokens.length - 1];
        if (nested && prev?.type === "paragraph") {
          prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + tok.raw;
          prev.text += "\n" + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          tokens.push(tok);
        }
        nested = paraSrc.length !== rest.length;
        rest = rest.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.tokenizer.text(rest))) {
        rest = rest.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev?.type === "text") {
          prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + tok.raw;
          prev.text += "\n" + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }
      if (rest) throw new Error("Infinite loop on byte: " + rest.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }

  // Queue a piece of text for inline lexing; returns the token array the
  // inline pass will fill in.
  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }
}

/* ------------------------------------------------------------------ */
/* Emphasis masking                                                    */
/* ------------------------------------------------------------------ */

// Scan `src` for the last delimiter run that could close emphasis:
// for `*` and `_`, the last run whose preceding character is not
// whitespace; `~` is tracked separately for strikethrough.
function scanDelimiters(src) {
  let star = -1;
  let underscore = -1;
  let tilde = -1;
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (ch !== "*" && ch !== "_" && ch !== "~") continue;
    const prev = i === 0 ? "\n" : src[i - 1];
    let j = i + 1;
    while (j < n && src[j] === ch) j++;
    if (prev !== " " && prev !== "\t" && prev !== "\n" && prev !== "\r" && prev !== "\f") {
      if (ch === "~") tilde = i;
      else if (ch === "*") star = i;
      else underscore = i;
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastEmStrong: { "*": star, _: underscore }, lastDel: tilde };
}

// The mask cache: one stack of scans per tokenizer, because inline
// lexing recurses (an emphasis token's contents are lexed inline again).
// The top of the stack is the scan for the source currently being lexed.
const maskCache = new WeakMap();
function pushMask(tokenizer, maskedSrc) {
  const scan = scanDelimiters(maskedSrc);
  const stack = maskCache.get(tokenizer);
  if (stack) stack.push(scan);
  else maskCache.set(tokenizer, [scan]);
}
function popMask(tokenizer) {
  const stack = maskCache.get(tokenizer);
  if (stack) {
    stack.pop();
    if (stack.length === 0) maskCache.delete(tokenizer);
  }
}
function lastEmStrongIndex(tokenizer, maskedSrc, delim) {
  const stack = maskCache.get(tokenizer);
  const top = stack?.[stack.length - 1];
  if (top && top.maskedSrc === maskedSrc) return top.lastEmStrong[delim];
  return scanDelimiters(maskedSrc).lastEmStrong[delim];
}
function lastDelIndex(tokenizer, maskedSrc) {
  const stack = maskCache.get(tokenizer);
  const top = stack?.[stack.length - 1];
  if (top && top.maskedSrc === maskedSrc) return top.lastDel;
  return scanDelimiters(maskedSrc).lastDel;
}

// Build the masked copy of an inline source that emphasis parsing reads:
// link destinations, code spans and raw tags are replaced by same-length
// filler so a `*` inside them can never be mistaken for a delimiter.
// Reference links that actually resolve are masked as a whole, so their
// brackets cannot pair with anything outside them.
function maskForEmphasis(lexer, src) {
  let masked = src;
  if (lexer.tokens.links && src.includes("[")) {
    const search = INLINE.reflinkSearch;
    const maskRef = (match) => {
      const open = match.lastIndexOf("[");
      if (!Object.hasOwn(lexer.tokens.links, normaliseLabel(match.slice(open + 1, -1)))) {
        return match;
      }
      if (open > 1 && match.charAt(0) !== "!") {
        const inner = match.slice(1, open - 1);
        if (lexer.linkInText(inner)) {
          return (
            "[" + inner.replace(search, maskRef) + "][" + "a".repeat(match.length - open - 2) + "]"
          );
        }
      }
      return "[" + "a".repeat(match.length - 2) + "]";
    };
    masked = masked.replace(search, maskRef);
  }
  // Backslash escapes of punctuation become `+`s, and the contents of
  // code spans keep their fences but lose their backticks.
  masked = masked.replace(INLINE.anyPunctuationOutsideCode, (whole, fence, punct) =>
    punct
      ? "+".repeat(whole.length)
      : fence
        ? fence + whole.slice(fence.length, -fence.length).replace(/`/g, "+") + fence
        : whole,
  );
  // Links, code spans and raw tags become `[aaa...]`.
  masked = masked.replace(INLINE.blockSkip, (whole, _codeRun, emptyGroup) => {
    const prefix = emptyGroup ? emptyGroup.length : 0;
    return whole.slice(0, prefix) + "[" + "a".repeat(whole.length - prefix - 2) + "]";
  });
  return masked;
}

/* ------------------------------------------------------------------ */
/* Inline tokenizing (methods added to Tokenizer)                      */
/* ------------------------------------------------------------------ */

// Resolve an inline or reference link once its destination is known:
// lex the link text inline, and refuse the link if a link was already
// emitted inside that text (links cannot nest).
function resolveLink(match, dest, raw, lexer) {
  const isImage = match[0].charAt(0) === "!";
  const labelText = match[1].replace(OTHER.outputLinkReplace, "$1");
  const savedInLink = lexer.state.inLink;
  const savedEmitted = lexer.state.linkEmitted;
  const savedRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const innerTokens = lexer.inlineTokens(labelText);
  const innerEmitted = lexer.state.linkEmitted;
  lexer.state.linkEmitted = savedEmitted;
  lexer.state.inLink = savedInLink;
  if (!isImage) {
    if (innerEmitted) {
      lexer.state.inRawBlock = savedRawBlock;
      return undefined;
    }
    lexer.state.linkEmitted = true;
  }
  return {
    type: isImage ? "image" : "link",
    raw,
    href: dest.href,
    title: dest.title || null,
    text: labelText,
    tokens: innerTokens,
  };
}

Object.assign(Tokenizer.prototype, {
  escape(src) {
    const m = INLINE.escape.exec(src);
    if (m) return { type: "escape", raw: m[0], text: m[1] };
  },

  tag(src) {
    const m = INLINE.tag.exec(src);
    if (!m) return;
    if (!this.lexer.state.inLink && OTHER.startATag.test(m[0])) this.lexer.state.inLink = true;
    else if (this.lexer.state.inLink && OTHER.endATag.test(m[0])) this.lexer.state.inLink = false;
    if (!this.lexer.state.inRawBlock && OTHER.startPreScriptTag.test(m[0])) {
      this.lexer.state.inRawBlock = true;
    } else if (this.lexer.state.inRawBlock && OTHER.endPreScriptTag.test(m[0])) {
      this.lexer.state.inRawBlock = false;
    }
    return {
      type: "html",
      raw: m[0],
      inLink: this.lexer.state.inLink,
      inRawBlock: this.lexer.state.inRawBlock,
      block: false,
      text: m[0],
    };
  },

  link(src) {
    if (this.lexer.state.linkParenPossible === false) return;
    const m = INLINE.link.exec(src);
    if (!m) return;
    const offset = m[0].charAt(0) === "!" ? 2 : 1;
    if (linkTextHidesTag(src, m[1], offset)) return;
    let dest = m[2].trim();
    if (OTHER.startAngleBracket.test(dest)) {
      if (!OTHER.endAngleBracket.test(dest)) return;
      const stripped = stripTrailing(dest.slice(0, -1), "\\");
      if ((dest.length - stripped.length) % 2 === 0) return;
    } else {
      const close = findClosingParen(m[2], "()");
      if (close === -2) return;
      if (close > -1) {
        const cut = (m[0].indexOf("!") === 0 ? 5 : 4) + m[1].length + close;
        m[2] = m[2].substring(0, close);
        m[0] = m[0].substring(0, cut).trim();
        m[3] = "";
      }
    }
    const strippedRaw = stripTrailing(m[0].slice(0, -1), "\\");
    if ((m[0].length - strippedRaw.length) % 2 === 0) return;
    let href = m[2];
    const title = m[3] ? m[3].slice(1, -1) : "";
    href = href.trim();
    if (OTHER.startAngleBracket.test(href)) href = href.slice(1, -1);
    return resolveLink(
      m,
      {
        href: href && href.replace(INLINE.anyPunctuation, "$1"),
        title: title && title.replace(INLINE.anyPunctuation, "$1"),
      },
      m[0],
      this.lexer,
    );
  },

  reflink(src, links) {
    let m;
    if ((m = INLINE.reflink.exec(src)) || (m = INLINE.nolink.exec(src))) {
      const offset = m[0].charAt(0) === "!" ? 2 : 1;
      if (linkTextHidesTag(src, m[1], offset)) return;
      const dest = links[normaliseLabel(m[2] || m[1])];
      if (!dest) {
        const ch = m[0].charAt(0);
        return { type: "text", raw: ch, text: ch };
      }
      return resolveLink(m, dest, m[0], this.lexer);
    }
  },

  emStrong(src, masked, prev = "") {
    const m = INLINE.emStrongLDelim.exec(src);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return;
    const delim = m[0][0];
    const prevIsSame = prev === delim;
    const offset = masked.length - src.length;
    let runStart = offset;
    while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
    const beforeRun = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? "";
    const beforeIsPunct =
      beforeRun === "*" || beforeRun === "_" || !!INLINE.punctuation.exec(beforeRun);
    if (runStart < offset) prev = beforeRun;
    const prevIsPunct = runStart < offset ? beforeIsPunct : !!INLINE.punctuation.exec(prev);
    if (m[4] && prev.match(OTHER.unicodeAlphaNumeric)) return;
    const afterDelim = m[1] || m[3] || "";
    if (!afterDelim || !prev || prevIsPunct) {
      const runLen = [...m[0]].length - 1;
      let openRemaining = runLen;
      let skipped = 0;
      const totalOpen = offset - runStart + runLen;
      const canCloseAlone =
        !!beforeRun.trim() && (!!afterDelim || (delim === "*" && !beforeIsPunct));
      if (delim !== "*" && delim !== "_") return;
      const closerRe = delim === "*" ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
      const lastCloser = lastEmStrongIndex(this, masked, delim);
      const firstCloserPos = masked.length - src.length + runLen;
      if (lastCloser < firstCloserPos) return;
      const scan = masked.slice(-src.length + runLen);
      const maxIndex = lastCloser - firstCloserPos;
      let cm;
      for (closerRe.lastIndex = 0; (cm = closerRe.exec(scan)) !== null && !(cm.index > maxIndex);) {
        const g = cm[1] || cm[2] || cm[3] || cm[4] || cm[5] || cm[6];
        if (!g) continue;
        const closeLen = [...g].length;
        if (cm[3] || cm[4]) {
          openRemaining += closeLen;
          continue;
        } else if (cm[5] || cm[6] || canCloseAlone) {
          if (prevIsSame && (cm[5] || cm[6])) break;
          if (totalOpen % 3 && !((totalOpen + closeLen) % 3)) {
            skipped += closeLen;
            continue;
          }
        }
        openRemaining -= closeLen;
        if (openRemaining > 0) continue;
        const used = Math.min(closeLen, closeLen + openRemaining + skipped);
        const firstUnit = [...cm[0]][0].length;
        const raw = src.slice(0, runLen + cm.index + firstUnit + used);
        if (Math.min(runLen, used) % 2) {
          const inner = raw.slice(1, -1);
          return { type: "em", raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
        }
        const inner = raw.slice(2, -2);
        return { type: "strong", raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
  },

  codespan(src) {
    const m = INLINE.code.exec(src);
    if (m) {
      let text = m[2].replace(OTHER.newLineCharGlobal, " ");
      const hasNonSpace = OTHER.nonSpaceChar.test(text);
      const padded = OTHER.startingSpaceChar.test(text) && OTHER.endingSpaceChar.test(text);
      if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
      return { type: "codespan", raw: m[0], text };
    }
  },

  br(src) {
    const m = INLINE.br.exec(src);
    if (m) return { type: "br", raw: m[0] };
  },

  del(src, masked, prev = "") {
    const m = INLINE.delLDelim.exec(src);
    if (!m) return;
    if (!(m[1] || "") || !prev || INLINE.punctuation.exec(prev)) {
      const runLen = [...m[0]].length - 1;
      let openRemaining = runLen;
      const closerRe = INLINE.delRDelim;
      const lastCloser = lastDelIndex(this, masked);
      const firstCloserPos = masked.length - src.length + runLen;
      if (lastCloser < firstCloserPos) return;
      const scan = masked.slice(-src.length + runLen);
      const maxIndex = lastCloser - firstCloserPos;
      let cm;
      for (closerRe.lastIndex = 0; (cm = closerRe.exec(scan)) !== null && !(cm.index > maxIndex);) {
        const g = cm[1] || cm[2] || cm[3] || cm[4] || cm[5] || cm[6];
        if (!g) continue;
        const closeLen = [...g].length;
        if (closeLen !== runLen) continue;
        if (cm[3] || cm[4]) {
          openRemaining += closeLen;
          continue;
        }
        openRemaining -= closeLen;
        if (openRemaining > 0) continue;
        const used = Math.min(closeLen, closeLen + openRemaining);
        const firstUnit = [...cm[0]][0].length;
        const raw = src.slice(0, runLen + cm.index + firstUnit + used);
        const inner = raw.slice(runLen, -runLen);
        return { type: "del", raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
  },

  autolink(src) {
    const m = INLINE.autolink.exec(src);
    if (m) {
      let text;
      let href;
      if (m[2] === "@") {
        text = m[1];
        href = "mailto:" + text;
      } else {
        text = m[1];
        href = text;
      }
      return {
        type: "link",
        raw: m[0],
        text,
        href,
        autolink: true,
        tokens: [{ type: "text", raw: text, text }],
      };
    }
  },

  url(src) {
    const m = INLINE.url.exec(src);
    if (!m) return;
    let text;
    let href;
    if (m[2] === "@") {
      text = m[0];
      href = "mailto:" + text;
    } else {
      let prev;
      do {
        prev = m[0];
        m[0] = INLINE._backpedal.exec(m[0])?.[0] ?? "";
      } while (prev !== m[0]);
      text = m[0];
      href = m[1] === "www." ? "http://" + m[0] : m[0];
    }
    return {
      type: "link",
      raw: m[0],
      text,
      href,
      autolink: true,
      tokens: [{ type: "text", raw: text, text }],
    };
  },

  inlineText(src) {
    const m = INLINE.text.exec(src);
    if (m) {
      const inRaw = this.lexer.state.inRawBlock;
      return { type: "text", raw: m[0], text: inRaw ? m[0] : decodeEntities(m[0]), escaped: inRaw };
    }
  },
});

/* ------------------------------------------------------------------ */
/* Inline lexer (methods added to Lexer)                               */
/* ------------------------------------------------------------------ */

Object.assign(Lexer.prototype, {
  // Does `src` contain a link (inline or reference) anywhere inside it?
  // Used by the emphasis mask to decide which reference links to hide.
  linkInText(src) {
    if (!src.includes("[")) return false;
    for (const m of src.matchAll(INLINE.blockSkip)) {
      if (INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== "!") return true;
    }
    for (const m of src.matchAll(INLINE.reflinkSearch)) {
      const text = m[0];
      const open = text.lastIndexOf("[");
      if (
        !(
          text.charAt(0) === "!" ||
          !Object.hasOwn(this.tokens.links, normaliseLabel(text.slice(open + 1, -1)))
        ) &&
        !(open > 1 && this.linkInText(text.slice(1, open - 1)))
      ) {
        return true;
      }
    }
    return false;
  },

  // Lex an inline source into `tokens`, tracking whether an unescaped
  // `)` can appear (link destinations with parens are only tried then).
  inlineTokens(src, tokens = []) {
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && src.includes(")");
    try {
      const masked =
        src.includes("*") || src.includes("_") || src.includes("~")
          ? maskForEmphasis(this, src)
          : src;
      pushMask(this.tokenizer, masked);
      try {
        return this.inlineTokensInner(src, masked, tokens);
      } finally {
        popMask(this.tokenizer);
      }
    } finally {
      this.state.linkParenPossible = saved;
    }
  },

  inlineTokensInner(src, masked, tokens) {
    let prevWasText = false;
    let prevChar = "";
    let shortest = Infinity;
    let rest = src;
    while (rest) {
      if (rest.length < shortest) {
        shortest = rest.length;
      } else {
        throw new Error("Infinite loop on byte: " + rest.charCodeAt(0));
      }
      if (!prevWasText) prevChar = "";
      prevWasText = false;
      let tok;
      if ((tok = this.tokenizer.escape(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.tag(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.link(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.reflink(rest, this.tokens.links))) {
        rest = rest.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (tok.type === "text" && prev?.type === "text") {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.tokenizer.emStrong(rest, masked, prevChar))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.codespan(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.br(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.del(rest, masked, prevChar))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.autolink(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (!this.state.inLink && (tok = this.tokenizer.url(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.inlineText(rest))) {
        rest = rest.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== "_") prevChar = tok.raw.slice(-1);
        prevWasText = true;
        const prev = tokens[tokens.length - 1];
        if (prev?.type === "text") {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }
      if (rest) throw new Error("Infinite loop on byte: " + rest.charCodeAt(0));
    }
    return tokens;
  },
});

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

// Render a list of block tokens to HTML.
function renderBlocks(tokens) {
  let out = "";
  for (const tok of tokens) {
    switch (tok.type) {
      case "space":
        break;
      case "hr":
        out += "<hr>\n";
        break;
      case "heading":
        out += `<h${tok.depth}>${renderInline(tok.tokens)}</h${tok.depth}>\n`;
        break;
      case "code": {
        const lang = (tok.lang || "").match(OTHER.notSpaceStart)?.[0];
        const body = tok.text ? tok.text.replace(OTHER.endingNewline, "") + "\n" : "";
        const escapedBody = tok.escaped ? body : escapeHtml(body, true);
        out += lang
          ? `<pre><code class="language-${escapeHtml(lang)}">${escapedBody}</code></pre>\n`
          : `<pre><code>${escapedBody}</code></pre>\n`;
        break;
      }
      case "table": {
        let headCells = "";
        for (const cell of tok.header) headCells += renderTableCell(cell);
        let bodyRows = "";
        for (const row of tok.rows) {
          let cells = "";
          for (const cell of row) cells += renderTableCell(cell);
          bodyRows += `<tr>\n${cells}</tr>\n`;
        }
        if (bodyRows) bodyRows = `<tbody>${bodyRows}</tbody>`;
        out += `<table>\n<thead>\n<tr>\n${headCells}</tr>\n</thead>\n${bodyRows}</table>\n`;
        break;
      }
      case "blockquote":
        out += `<blockquote>\n${renderBlocks(tok.tokens)}</blockquote>\n`;
        break;
      case "list": {
        const tag = tok.ordered ? "ol" : "ul";
        const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : "";
        let items = "";
        for (const item of tok.items) items += `<li>${renderBlocks(item.tokens)}</li>\n`;
        out += `<${tag}${start}>\n${items}</${tag}>\n`;
        break;
      }
      case "checkbox":
        out += "<input " + (tok.checked ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
        break;
      case "html":
        out += tok.text;
        break;
      case "def":
        break;
      case "paragraph":
        out += `<p>${renderInline(tok.tokens)}</p>\n`;
        break;
      case "text":
        out += renderInline(tok.tokens);
        break;
      default:
        throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

function renderTableCell(cell) {
  const tag = cell.header ? "th" : "td";
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return open + renderInline(cell.tokens) + `</${tag}>\n`;
}

// Render a list of inline tokens to HTML. With `textOnly`, markup is
// stripped the way marked's text renderer does it (used for image alt
// text): strong/em/del/link/image keep only their text, code spans keep
// their raw text, breaks vanish, checkboxes keep their source.
function renderInline(tokens, textOnly = false) {
  let out = "";
  for (const tok of tokens) {
    switch (tok.type) {
      case "escape":
        out += textOnly ? tok.text : escapeHtml(tok.text);
        break;
      case "html":
        out += tok.text;
        break;
      case "link": {
        if (textOnly) {
          out += tok.tokens ? renderInline(tok.tokens, true) : tok.text;
          break;
        }
        const inner = tok.autolink ? escapeHtml(tok.text, true) : renderInline(tok.tokens);
        const href = cleanUrl(tok.href);
        if (href === null) {
          out += inner;
          break;
        }
        let a = '<a href="' + escapeHtml(href, tok.autolink) + '"';
        if (tok.title) a += ' title="' + escapeHtml(tok.title) + '"';
        out += a + ">" + inner + "</a>";
        break;
      }
      case "image": {
        const alt = tok.tokens ? renderInline(tok.tokens, true) : tok.text;
        if (textOnly) {
          out += alt;
          break;
        }
        const href = cleanUrl(tok.href);
        if (href === null) {
          out += escapeHtml(alt);
          break;
        }
        let img = `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}"`;
        if (tok.title) img += ` title="${escapeHtml(tok.title)}"`;
        out += img + ">";
        break;
      }
      case "checkbox":
        out += textOnly
          ? tok.raw
          : "<input " + (tok.checked ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
        break;
      case "strong":
        out += textOnly
          ? tok.tokens
            ? renderInline(tok.tokens, true)
            : tok.text
          : `<strong>${renderInline(tok.tokens)}</strong>`;
        break;
      case "em":
        out += textOnly
          ? tok.tokens
            ? renderInline(tok.tokens, true)
            : tok.text
          : `<em>${renderInline(tok.tokens)}</em>`;
        break;
      case "codespan":
        out += textOnly ? tok.text : `<code>${escapeHtml(tok.text, true)}</code>`;
        break;
      case "br":
        out += textOnly ? "" : "<br>";
        break;
      case "del":
        out += textOnly
          ? tok.tokens
            ? renderInline(tok.tokens, true)
            : tok.text
          : `<del>${renderInline(tok.tokens)}</del>`;
        break;
      case "text":
        if (textOnly) {
          out += tok.text;
        } else if ("tokens" in tok && tok.tokens) {
          out += renderInline(tok.tokens);
        } else if ("escaped" in tok && tok.escaped) {
          out += tok.text;
        } else {
          out += escapeHtml(tok.text);
        }
        break;
      default:
        throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

// Render `markdown` to the HTML marked 18.1.3 produces with its default
// options. Stateless: every call builds fresh lexer state and keeps
// nothing afterwards.
export function parse(markdown) {
  if (typeof markdown !== "string") {
    throw new Error(
      "marked(): input parameter is of type " +
        Object.prototype.toString.call(markdown) +
        ", string expected",
    );
  }
  const lexer = new Lexer();
  return renderBlocks(lexer.lex(markdown));
}
