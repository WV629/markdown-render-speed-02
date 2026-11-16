# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/WV629/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/WV629/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown parser that renders CommonMark 0.31.2 plus
GitHub Flavored Markdown exactly like marked 18.1.3 does — byte for byte —
but quicker. `parse.js` is a single self-contained ES module with no imports
and no dependencies; `main.ts` is the harness driver that reads
`/input/cases.json` and writes `/output/html.json`.

## How it works

Two passes, like most Markdown parsers, with the emphasis logic kept exact:

1. **Block pass** — the source is walked once and cut into block tokens
   (headings, lists, block quotes, tables, code, HTML blocks, link reference
   definitions). Inline content is only queued here, because a link reference
   definition may appear after the text that uses it.
2. **Inline pass** — each queued source is tokenized (escapes, links, emphasis,
   code spans, autolinks, strikethrough) and rendered to HTML.

Emphasis is decided on a *masked* copy of the inline source: reference-link
labels that resolve, code spans, inline links and raw HTML tags are blanked
out first, so a delimiter run inside one of them can never close an emphasis
span. The masking runs in a fixed order — reference-link labels, punctuation
outside code, code/links/tags — which is what makes the edge cases come out
the same as marked's.

Speed comes from dispatching on the first character instead of trying every
rule at every position, from cheap guards that skip the table and setext
patterns when the source cannot hold one, and from computing the emphasis
mask only when the text actually contains a delimiter.

## Run it

```sh
node main.ts
```

Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in
for `/input` and `/output`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=wkn1wnrf&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
