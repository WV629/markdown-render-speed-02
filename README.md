# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/WV629/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/WV629/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown parser that renders CommonMark 0.31.2 plus
GitHub Flavored Markdown exactly like marked 18.1.3 does — byte for byte —
but quicker. `parse.js` is a single self-contained ES module with no imports
and no dependencies; `main.ts` is the harness driver that reads
`/input/cases.json` and writes `/output/html.json`.

## Run it

```sh
node main.ts
```

Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in
for `/input` and `/output`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=wkn1wnrf&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
