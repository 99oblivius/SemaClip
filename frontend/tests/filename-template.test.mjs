// The export filename template, and the two call sites that must not disagree.
//
// WHY THIS EXISTS: the template used to be rendered inline in the export page, and the export LIST
// needs the same answer for every row — so there are now two call sites on one rule. The failure this
// guards is the pair drifting: the list showing one filename while the preview (and the export)
// produce another.
//
// The tokens are pinned by value here. `{name}` replaced `{axis}`, which named an ENGINE concept on a
// control that also names hand-made clips — a hand-made clip has no axis, so the token was
// inapplicable to exactly the clips a user creates themselves; the engine now writes the matched axis
// into the clip's NAME at creation. `{platform}` is gone entirely: it invented a platform concept by
// taking the first word of the preset's name.
import { renderFilenameTemplate, FILENAME_TOKENS } from '../src/lib/filename.ts';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}  ${detail}`); failures++; }
};

const at = (over = {}) => ({
  channel: 'Weskie',
  name: 'hype',
  startTime: 754,          // 12m34s
  streamTitle: 'Wednesday Scuffed Stream #77',
  now: new Date('2026-09-22T10:00:00Z'),
  ...over,
});

console.log('=== TOKENS ===');
const out = renderFilenameTemplate('{date}-{channel}-{name}-{ts}', at());
check('date/channel/name/ts render', out === '2026-09-22-weskie-hype-1234', out);

check('the retired {axis} token is no longer advertised', !FILENAME_TOKENS.includes('axis'),
  FILENAME_TOKENS.join(','));
check('the retired {platform} token is no longer advertised', !FILENAME_TOKENS.includes('platform'),
  FILENAME_TOKENS.join(','));
check('{name} IS advertised', FILENAME_TOKENS.includes('name'), FILENAME_TOKENS.join(','));

check(
  'ts is mmss and zero-padded for a clip under ten minutes',
  renderFilenameTemplate('{ts}', at({ startTime: 65 })) === '0105',
  renderFilenameTemplate('{ts}', at({ startTime: 65 })),
);
check(
  'ts at zero is 0000, not empty',
  renderFilenameTemplate('{ts}', at({ startTime: 0 })) === '0000',
);
check(
  'the title token is slugged and capped at 30',
  renderFilenameTemplate('{title}', at()).length <= 30 &&
    renderFilenameTemplate('{title}', at()).startsWith('wednesday-scuffed'),
  renderFilenameTemplate('{title}', at()),
);

console.log('\n=== {name} KEEPS ITS CASE (the load-bearing rule) ===');
// A clip's name is the user's own text and its casing is part of it, exactly as the DB treats it.
// Any lowercasing in the sanitiser makes the first three of these collapse into one another.
check('mixed case survives', renderFilenameTemplate('{name}', at({ name: 'Take One' })) === 'Take-One',
  renderFilenameTemplate('{name}', at({ name: 'Take One' })));
check('ALL CAPS survives', renderFilenameTemplate('{name}', at({ name: 'BEST MOMENT' })) === 'BEST-MOMENT',
  renderFilenameTemplate('{name}', at({ name: 'BEST MOMENT' })));
check(
  'two names differing ONLY by case render differently',
  renderFilenameTemplate('{name}', at({ name: 'Take One' })) !==
    renderFilenameTemplate('{name}', at({ name: 'take one' })),
);
check('a name that is already a bare word is not slugged further',
  renderFilenameTemplate('{name}', at({ name: 'hype' })) === 'hype',
  renderFilenameTemplate('{name}', at({ name: 'hype' })));

console.log('\n=== {name} PATH SAFETY ===');
check('forward slash folded', renderFilenameTemplate('{name}', at({ name: 'a/b' })) === 'a-b',
  renderFilenameTemplate('{name}', at({ name: 'a/b' })));
check('backslash folded', renderFilenameTemplate('{name}', at({ name: 'a\\b' })) === 'a-b',
  renderFilenameTemplate('{name}', at({ name: 'a\\b' })));
check(
  'the windows-illegal set is folded',
  renderFilenameTemplate('{name}', at({ name: 'a:b*c?d"e<f>g|h' })) === 'a-b-c-d-e-f-g-h',
  renderFilenameTemplate('{name}', at({ name: 'a:b*c?d"e<f>g|h' })),
);
check(
  'a traversal attempt cannot escape the export directory',
  !/[\\/]/.test(renderFilenameTemplate('{name}', at({ name: '../../etc/passwd' }))),
  renderFilenameTemplate('{name}', at({ name: '../../etc/passwd' })),
);
check('accents fold to ascii', renderFilenameTemplate('{name}', at({ name: 'café' })) === 'cafe',
  renderFilenameTemplate('{name}', at({ name: 'café' })));

console.log('\n=== an ABSENT name drops the segment, never a placeholder word ===');
// A placeholder would put a label nobody chose into a filename.
check('null renders empty', renderFilenameTemplate('{name}', at({ name: null })) === '');
check('undefined renders empty', renderFilenameTemplate('{name}', at({ name: undefined })) === '');
check(
  'the separator left behind is cleaned up',
  renderFilenameTemplate('{date}-{name}-{ts}', at({ name: null })) === '2026-09-22-1234',
  renderFilenameTemplate('{date}-{name}-{ts}', at({ name: null })),
);
check(
  'no invented fallback word appears',
  !/manual|undefined|null/.test(renderFilenameTemplate('{name}', at({ name: null }))),
);

console.log('\n=== HOSTILE / DEGENERATE INPUT ===');
check(
  'a missing channel does not leave a doubled separator',
  !renderFilenameTemplate('{date}-{channel}-{name}', at({ channel: null })).includes('--'),
  renderFilenameTemplate('{date}-{channel}-{name}', at({ channel: null })),
);
check(
  'path separators cannot escape the export directory',
  !/[\\/]/.test(renderFilenameTemplate('{title}', at({ streamTitle: '../../etc/passwd' }))),
  renderFilenameTemplate('{title}', at({ streamTitle: '../../etc/passwd' })),
);
check(
  'a template of only separators cannot produce an empty name',
  renderFilenameTemplate('{channel}', at({ channel: null })) === '',
);
check(
  'an UNKNOWN token is left alone rather than silently dropped',
  renderFilenameTemplate('{date}-{nope}', at()) === '2026-09-22-{nope}',
  renderFilenameTemplate('{date}-{nope}', at()),
);
check(
  // The renderer must never silently edit text it does not recognise; migration 0.7.0 repairs the
  // STORED templates, which is the only place a retired token can be rewritten safely.
  'a retired token renders literally, because the migration repairs stored rows and not the renderer',
  renderFilenameTemplate('{date}-{axis}', at()).endsWith('{axis}'),
  renderFilenameTemplate('{date}-{axis}', at()),
);
check(
  'a negative start time does not produce a negative stamp',
  renderFilenameTemplate('{ts}', at({ startTime: -5 })) === '0000',
);
check(
  'a very long title is capped, not unbounded',
  renderFilenameTemplate('{title}', at({ streamTitle: 'x'.repeat(500) })).length <= 30,
);
check(
  'a very long NAME is capped, not unbounded',
  renderFilenameTemplate('{name}', at({ name: 'x'.repeat(500) })).length <= 60,
);

console.log('\n=== TOKEN COVERAGE ===');
// Every advertised token must actually be replaced — a token documented in the UI but not
// substituted here would show as literal braces in a filename.
for (const t of FILENAME_TOKENS) {
  const rendered = renderFilenameTemplate(`{${t}}`, at());
  check(`{${t}} is substituted`, !rendered.includes(`{${t}}`), rendered);
}

console.log('\n=== THE PAGE AND THE LIST USE THIS RULE, NOT THEIR OWN ===');
const { readFileSync } = await import('node:fs');
const pageSrc = readFileSync(new URL('../src/routes/export/+page.svelte', import.meta.url), 'utf8');
check(
  'the export page renders filenames through the shared rule',
  /renderFilenameTemplate\(/.test(pageSrc),
);
check(
  'the page no longer carries its own inline token chain',
  !/\.replace\('\{(platform|axis)\}'/.test(pageSrc),
);
check(
  'the export list rows are given a rendered filename (not the stream title)',
  /filenameForItem\.get\(item\.clipId\)/.test(pageSrc),
);
check(
  'the page reads the name through one helper, so an in-page rename shows immediately',
  /name:\s*nameOf\(item\.clip\)/.test(pageSrc),
);
check(
  'that helper resolves title-else-axis, matching the display precedence',
  /namesFor\[clip\.id\]\s*\?\?\s*clip\.title\s*\?\?\s*clip\.axis/.test(pageSrc),
);

console.log('\n=== RESULT ===');
if (failures > 0) { console.log(`  ${failures} failure(s)`); process.exit(1); }
console.log('  ALL PASS');
