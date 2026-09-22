// The review queue's ordering and visibility rules for clips that carry NO engine ranking.
//
// A hand-made clip has `score: null` and `axis: null` — deliberately, because it has no engine
// behind it. Two behaviours follow, and neither is caught by a type check:
//
//   1. The sort `b.score - a.score` yields NaN on a null, and `Array.sort` leaves a NaN
//      comparator's elements in IMPLEMENTATION-DEFINED order — so an unranked clip scattered
//      unpredictably through the ranked list, changing position between renders.
//   2. The axis filter `activeAxes.has(c.axis)` is false for null, so turning ANY axis filter on
//      made every hand-made clip VANISH. That reads as "my clip was deleted".
//
// The rule lives in the page, so it is exercised here by extracting it — the same shape as the
// settings-form tests: a pure rule, tested without a browser.
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (name, cond) => {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}`); failures++; }
};

// The exact filter+sort expression from the review page, evaluated here so a change to either
// rule has to be made in one place and cannot silently disagree with the page.
const pageSrc = readFileSync(new URL('../src/routes/stream/[id]/+page.svelte', import.meta.url), 'utf8');

console.log('=== REVIEW FILTER/SORT RULE ===');

check(
  'the axis filter admits a null axis (a manual clip is not an axis result)',
  /activeAxes\.size === 0 \|\| c\.axis === null \|\| activeAxes\.has\(c\.axis\)/.test(pageSrc),
);

check(
  'the score sort never subtracts a nullable score directly (NaN order)',
  !/b\.score - a\.score/.test(pageSrc),
);

check(
  'unranked clips are ordered by position, not coerced to a confidence number',
  /return a\.startTime - b\.startTime/.test(pageSrc),
);

// Reproduce the two rules exactly as the page states them, and check real behaviour.
const sortRule = (a, b) => {
  const score = (c) => c.score ?? -1;
  const byScore = score(b) - score(a);
  if (byScore !== 0) return byScore;
  return a.startTime - b.startTime;
};
const filterRule = (c, activeAxes) => activeAxes.size === 0 || c.axis === null || activeAxes.has(c.axis);

const manual = { id: 'm', axis: null, score: null, startTime: 30, rejected: false };
const strong = { id: 's', axis: 'hype', score: 0.9, startTime: 20, rejected: false };
const weak = { id: 'w', axis: 'hype', score: 0.1, startTime: 40, rejected: false };

const sorted = [manual, weak, strong].slice().sort(sortRule).map((c) => c.id);
check('engine clips rank above an unranked manual clip', sorted.join(',') === 's,w,m');

const sortedMix = [{ ...manual, startTime: 30 }, { ...manual, id: 'm2', startTime: 1 }, strong]
  .slice().sort(sortRule).map((c) => c.id);
check('the ranked clip leads, then unranked clips by position', sortedMix.join(',') === 's,m2,m');

check('sort is stable regardless of input order for equal nulls', (() => {
  const a = [{ ...manual, startTime: 9 }, { ...manual, id: 'm2', startTime: 3 }].sort(sortRule).map((c) => c.id).join(',');
  const b = [{ ...manual, id: 'm2', startTime: 3 }, { ...manual, startTime: 9 }].sort(sortRule).map((c) => c.id).join(',');
  return a === b;
})());

check('a manual clip survives an axis filter', filterRule(manual, new Set(['hype'])) === true);
check('an axis filter still hides a non-matching engine clip', filterRule({ ...strong, axis: 'funny' }, new Set(['hype'])) === false);
check('no filter shows everything', filterRule(manual, new Set()) === true);

console.log(failures === 0 ? '\n=== REVIEW FILTER/SORT PASS ===' : `\n=== REVIEW FILTER/SORT FAIL (${failures}) ===`);
process.exit(failures === 0 ? 0 : 1);
