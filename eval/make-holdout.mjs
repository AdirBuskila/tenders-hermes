#!/usr/bin/env node
/**
 * Produce an examples-free copy of the criteria for honest evaluation.
 *
 * WHY THIS EXISTS. `criteria/relevance.md` embeds the client's own labelled
 * examples, and `eval/labelled.json` is those same examples. Scoring one
 * against the other measures whether the model can read its own prompt — it
 * came back 100%/100%, which is exactly the number that proves nothing. That
 * is train-on-test contamination, and shipping it as an accuracy claim is how
 * an otherwise good project loses its credibility in review.
 *
 * Stripping the examples leaves only the stated rules. Scoring *that* answers
 * the question worth asking: do the criteria as written reproduce the client's
 * judgments, or are they only reciting answers they were handed?
 *
 * The examples stay in the production criteria — few-shot guidance genuinely
 * helps the classifier, and there is no reason to make production worse. This
 * variant exists solely so the eval number means something.
 *
 * Usage:
 *   node eval/make-holdout.mjs > criteria/relevance.holdout.md
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'criteria', 'relevance.md');

// The examples live under this heading and end at the next top-level heading.
const EXAMPLES_HEADING = '## דוגמאות מתויגות';

function main() {
  const text = readFileSync(SRC, 'utf8');

  const start = text.indexOf(EXAMPLES_HEADING);
  if (start === -1) {
    console.error(`[holdout] heading not found: ${EXAMPLES_HEADING} — has the criteria file been restructured?`);
    process.exit(1);
  }

  // Find the next "## " heading after the examples block.
  const rest = text.slice(start + EXAMPLES_HEADING.length);
  const nextHeadingOffset = rest.search(/\n## /);
  if (nextHeadingOffset === -1) {
    console.error('[holdout] no heading follows the examples block; refusing to guess where it ends');
    process.exit(1);
  }

  const end = start + EXAMPLES_HEADING.length + nextHeadingOffset + 1;

  const stripped =
    text.slice(0, start) +
    '## דוגמאות מתויגות\n\n' +
    '_(הוסרו לצורך הערכה — ראו eval/make-holdout.mjs)_\n\n' +
    text.slice(end);

  const removed = end - start;
  process.stderr.write(
    `[holdout] removed ${removed} chars of labelled examples; ${stripped.length} chars remain\n`,
  );

  process.stdout.write(stripped);
}

main();
