// Driver for this competition entry.
//
// The harness runs `node /bot/main.ts` on Node 22. It reads every case
// from /input/cases.json — a JSON array of { id, markdown } — renders
// each case on its own with parse() from ./parse.js, and writes
// /output/html.json: a JSON array of the HTML strings, one per case and
// in the cases' order.
//
// Outside a container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand
// in for /input and /output. All the work lives in parse.js; this file
// only moves the data through. Rendering is stateless, so cases are
// independent of each other and of their order.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Case = { id: string; markdown: string };

function main(): void {
  const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
  const html: string[] = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) {
    html[i] = parse(cases[i].markdown);
  }
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

main();
