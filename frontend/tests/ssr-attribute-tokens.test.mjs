// No template token may be written as a bare expression in a Svelte ATTRIBUTE.
//
// WHY THIS FILE EXISTS — the reported 500, in full:
//
//   [500] GET /export
//   ReferenceError: name is not defined
//       at src/routes/export/+page.svelte:1122:77
//
// Line 1122 was a tooltip: title="Clip name — … Renders as {name} in the filename.". In Svelte an
// attribute `{name}` is an EXPRESSION, not text, so the browser resolved it to the DOM global
// `window.name` — and `svelte-check` PASSED, because in browser types that global exists. It died
// only under SSR, where there is no `window`, so a FULL page load (GET /export, a restart, or the
// review page's `location.href = '/export'`) threw and SvelteKit replaced the page's CONTENT while
// the app shell survived.
//
// That combination is the danger: type-checks clean, works in the browser, dies on the
// server-rendered path. Every other test here reads the built SPA shell, where nothing is
// server-rendered at request time, so nothing could have caught it.
//
// THE RULE: a `{token}` inside an attribute VALUE must be a real binding. To DISPLAY a token name
// in docs text, escape it as `&#123;name&#125;` — it renders as a literal brace and cannot be
// parsed as an expression.
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}  ${detail}`); failures++; }
};

const pageSrc = readFileSync(new URL('../src/routes/export/+page.svelte', import.meta.url), 'utf8');

console.log('=== THE {name} TOOLTIP (the reproduction) ===');
check(
  'the token is escaped as an entity, so it renders literally and cannot be an expression',
  pageSrc.includes('&#123;name&#125;'),
);
check(
  'the bare-expression form is GONE — this is the exact line that threw',
  !pageSrc.includes('Renders as {name}'),
);

console.log('\n=== THE GENERAL FORM: no attribute expression may hit a DOM global ===');
// The traps: each is a real global in a browser and a ReferenceError on the server. Named
// explicitly so a failure message teaches rather than just pointing at a line number.
const GLOBALS = ['name', 'status', 'length', 'top', 'origin', 'closed', 'parent', 'self', 'event'];
for (const g of GLOBALS) {
  const inAttribute = new RegExp(`="[^"]*\\{\\s*${g}\\s*\\}[^"]*"`);
  check(
    `{${g}} is never used as state inside an attribute`,
    !inAttribute.test(pageSrc),
    `${g} is a browser global and undefined under SSR`,
  );
}

console.log('\n=== AND THE SCAN FINDS THE REAL EXPRESSIONS (not nothing) ===');
// A scanner that matches zero patterns would pass the check above for the wrong reason. These are
// the attribute expressions the page legitimately uses.
const attrExprs = [...pageSrc.matchAll(/\b(?:title|aria-label|placeholder|alt)="[^"]*\{([^}]*)\}[^"]*"/g)]
  .map((m) => (m[1] ?? '').trim());
check(
  'the scan sees the page\'s real attribute expressions',
  attrExprs.length > 0,
  `found ${attrExprs.length}`,
);
check(
  'every one of them is a dotted path or a known page binding, never a lone unknown word',
  attrExprs.every((e) => /[.(]/.test(e) || ['selected', 'batch', 'item', 'entry', 'clip', 'job', 'Math', '__APP_VERSION__', 'fmtDur', 'fmtTime', 'nameOf', 'nameDraft'].includes(e)),
  attrExprs.filter((e) => !/[.(]/.test(e) && !['selected', 'batch', 'item', 'entry', 'clip', 'job', 'Math', '__APP_VERSION__', 'fmtDur', 'fmtTime', 'nameOf', 'nameDraft'].includes(e)).join(' | '),
);

console.log('\n=== RESULT ===');
if (failures > 0) { console.log(`  ${failures} failure(s)`); process.exit(1); }
console.log('  ALL PASS');
