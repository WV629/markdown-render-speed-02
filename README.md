# markdown-render-speed-02

A fast, dependency-free Markdown renderer that returns exactly the HTML
[marked](https://github.com/markedjs/marked) 18.1.3 renders with its
default options (GFM on, breaks off, pedantic off) — but faster.

## Layout

- `parse.js` — the entry. `parse(markdown)` returns the HTML string.
  It is a single ES module with no dependencies.
- `main.ts` — the program the harness runs: it reads
  `/input/cases.json`, renders each case with `parse`, and writes
  `/output/html.json`.
- `package.json` — `{"type": "module"}`, so Node treats `parse.js` as
  an ES module.

## How it works

Two passes, both written from scratch:

1. **Block pass** (`lexBlocks` and friends). The source is cut into
   block tokens — headings, code fences, lists, blockquotes, tables,
   HTML blocks, paragraphs — and link-reference definitions are
   collected into one map for the whole document, so a definition at
   the bottom still applies to a paragraph at the top.
2. **Render pass**. Block tokens become HTML directly, and each inline
   source (a paragraph, a heading, a table cell) is rendered straight
   to a string — no inline token tree is built. The inline pass keeps
   a masked twin of the source, of the same length, in which
   reference-link labels, whole links, code spans and tags are hidden
   behind inert filler, so emphasis delimiters inside them can never
   act as openers or closers. That masking is what makes cases like
   `` [a `b`](http://x) parser __c__ by same `d` must. `` come out
   exactly as marked renders them.

Speed comes from doing less work per character: a first-character
dispatch in the block and inline loops, a text-scan fast path for
plain runs, and no per-token object allocation on the inline path.

## Checking it locally

With the competition kit unpacked next to this repository, and Node 22
on the path:

```sh
# practice set: all 720 cases must match marked byte for byte
node /path/to/kit/cli/makefun.mjs grade-local --kit /path/to/kit \
  --bot . --driver process
```

The kit's `practice/input/cases.json` and
`practice/reference/expected.json` are the same 720 cases; a small
diff script that compares `parse` against them lives outside this
repository.

## License

MIT — see `LICENSE`.
