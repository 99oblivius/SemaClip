// Every frontend call that MUTATES download state must refresh the downloads query.
//
// The regression this exists to catch, reported twice: starting a VOD download from the
// Library showed no progress container until the page was refreshed or navigated away
// and back. Cause: the import mutations invalidated only ['streams'], while the
// container renders from DOWNLOADS_KEY — so the surface that changed never learned.
//
// Why a structural test rather than a rendered one: the failure is a MISSING
// invalidation in a call site, and there are five such call sites across four files.
// Rendering each one needs a browser, a router and a query client, and would still miss
// the sixth call site somebody adds next month. This asserts the invariant directly over
// the source, so a new mutating site that forgets fails here.
//
// Run: npx vite-node tests/download-mutation-invalidates.test.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n         ${detail}`}`);
  if (!cond) failures++;
}

const ROOT = new URL('../src', import.meta.url).pathname;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    // A broken symlink must be SKIPPED, not thrown on: src/lib/shared is a symlink
    // into the repo root and following it either loops or hits a missing target.
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.svelte') || p.endsWith('.ts')) out.push(p);
  }
  return out;
}

// The apiClient methods that CHANGE download state. Starting one of these must make the
// downloads query refetch, or the progress surface stays stale.
const MUTATORS = [
  'importByUrl',
  'importByFile',
  'downloadPiece',
  'cancelPiece',
  'resumeDownload',
  'deleteDownload',
];

// Split a file into `createMutation(() => ({ ... }))` blocks by brace matching, so a
// multi-line mutationFn is covered. A regex window missed exactly that case while this
// bug was being diagnosed, which is why the brace matcher is here.
function mutationBlocks(src) {
  const blocks = [];
  const marker = 'createMutation(() => ({';
  let idx = src.indexOf(marker);
  while (idx !== -1) {
    let depth = 0;
    let end = idx + marker.length - 1; // points at the opening brace
    for (let i = end; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    blocks.push(src.slice(idx, end + 1));
    idx = src.indexOf(marker, end);
  }
  return blocks;
}

console.log('download mutators must refresh DOWNLOADS_KEY');
let found = 0;
for (const file of walk(ROOT)) {
  const src = readFileSync(file, 'utf8');
  for (const block of mutationBlocks(src)) {
    const calls = MUTATORS.filter((m) => block.includes(`apiClient.${m}(`));
    if (calls.length === 0) continue;
    found++;
    const rel = relative(ROOT, file);
    const ok = block.includes('DOWNLOADS_KEY') && block.includes('markDownloadsChanged');
    check(
      `${rel}: ${calls.join(', ')}`,
      ok,
      ok ? '' : 'onSuccess must call markDownloadsChanged() AND invalidateQueries(DOWNLOADS_KEY).\n' +
        'Without it the progress container only appears after a refresh, because the\n' +
        'container renders from that query.',
    );
  }
}

// A guard against the test silently covering nothing if the call sites are renamed.
check('found at least 5 mutating call sites', found >= 5, `found ${found}`);

// And the reverse: the Library page must actually import the key it invalidates.
const library = readFileSync(join(ROOT, 'routes/+page.svelte'), 'utf8');
check(
  'Library page imports DOWNLOADS_KEY',
  library.includes('DOWNLOADS_KEY') && library.includes('from \'$lib/api/downloads\''),
);

console.log(failures === 0 ? '\nall download mutators refresh the query' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
