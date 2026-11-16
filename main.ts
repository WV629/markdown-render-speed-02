// Driver for the markdown-render-speed entry.
//
// The harness runs `node /bot/main.ts` on Node 22. It reads every case from
// /input/cases.json (a JSON array of { id, markdown }), renders each one on
// its own with parse() from ./parse.js, and writes /output/html.json: a JSON
// array of the HTML strings, one per case and in the cases' order.
//
// Outside a container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for
// /input and /output. Nothing here is timed on its own; the work is all in
// parse.js, so this file just moves the data through as plainly as possible.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as {
  id: string;
  markdown: string;
}[];

// Render in order, one fresh parse per case: parse keeps no state between
// calls, so the order here cannot change any result.
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
