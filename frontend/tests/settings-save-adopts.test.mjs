// The settings page must ADOPT the save response into the form.
//
// The reported bug: "changing the settings for vod download path and pressing save doesn't make
// it accept the save even though it did save."
//
// The page held the value the user TYPED (`~/VODs`) and compared it against the value the server
// STORES (`/home/livia/VODs` — the server expands `~`, unifies separators, drops a trailing one,
// and refuses relatives). Two spellings of one value never compare equal, so the form was dirty
// for ever: Save stayed armed and the saved confirmation never appeared. Refetching the query is
// NOT enough to fix it — the refetched value lands in the QUERY CACHE, while the form keeps the
// text the user typed, so the two still disagree.
//
// The fix has to feed the response back into the form. This is a structural test rather than a
// rendered one for the same reason as download-mutation-invalidates.test.mjs: the failure is a
// MISSING statement in a call site, rendering the page needs a browser + router + query client,
// and a rendered test would still miss the next mutation somebody adds that forgets.
//
// Run: npx vite-node tests/settings-save-adopts.test.mjs
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n         ${detail}`}`);
  if (!cond) failures++;
}

const page = readFileSync(new URL('../src/routes/settings/+page.svelte', import.meta.url), 'utf8');

// The mutation's own success handler, so the assertions are scoped to it and cannot be satisfied
// by an unrelated statement elsewhere in the file.
const start = page.indexOf('const updateMutation = createMutation');
const end = page.indexOf('\n  }));', start);
check('the update mutation is present', start !== -1 && end !== -1);
const onSuccess = page.slice(start, end);

// THE assertion: the response is written back into the form.
check(
  'the save response is adopted into the form (not only refetched)',
  /(adoptForm|applyForm|form\s*=\s*formFromSettings)\s*\(\s*(data|result|response|saved)\b/.test(onSuccess),
  'the handler must take the mutation response and put it into the form; a bare refetch leaves ' +
    'the form holding the text the user typed, which can never equal the server-resolved value',
);

check(
  'the handler signature actually receives the response',
  /onSuccess\s*:\s*\(\s*(data|result|response|saved)\b/.test(onSuccess),
  'an onSuccess that takes no argument cannot adopt anything',
);

// The rule itself must come from the shared module, so the page cannot drift back to an inline
// comparison that forgets the normalization.
check(
  'dirty is computed by the shared rule, not inline',
  /isDirty\s*\(/.test(page) && !/const\s+dirty\s*=\s*\$derived\(\s*loaded\s*&&/.test(page),
  'an inline comparison is what shipped this bug: it is untestable and silently field-by-field',
);

// A path field must never be compared as typed. This is the specific shape of the defect: a
// `.trim()` or a tilde check in the page pretending to reproduce the server's resolution.
check(
  'the page does not attempt to reproduce path resolution itself',
  !/replace\(\s*\/~/.test(page) && !/startsWith\(\s*'~'/.test(page),
  'path resolution is the server\'s (platform-specific, needs the home directory); reimplementing ' +
    'it in the page is how the two spellings disagree again',
);

console.log(failures === 0 ? '\n=== SETTINGS SAVE-ADOPTS PASS' : `\n=== SETTINGS SAVE-ADOPTS FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
