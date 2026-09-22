// The export page's NEW surfaces: the format list, the extension it promises, the name field, and the
// vod header.
//
// WHY THIS FILE EXISTS: four of these are cases where the page and the SERVER must agree about
// something the page only PREVIEWS, and a preview that disagrees with the artifact is worse than no
// preview — the user reads the preview to decide. A hardcoded `.mp4` on the filename line labelled a
// WebM or MKV export as an MP4, and the MKV container (added last) is exactly the case a two-branch
// ternary could not express.
import { readFileSync } from 'node:fs';
import { pairForFormat, EXPORT_FORMATS, CONTAINER_AUDIO_MATRIX, AUDIO_CODECS } from '../../shared/types.ts';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}  ${detail}`); failures++; }
};

const pageSrc = readFileSync(new URL('../src/routes/export/+page.svelte', import.meta.url), 'utf8');
const serverSrc = readFileSync(
  new URL('../../server/application/use-cases/ExportClip.ts', import.meta.url), 'utf8',
);

console.log('=== THE FORMAT LIST ===');
// The offered formats, in order, read out of the page's own literal.
const formatBlock = pageSrc.match(/const formats:[^=]*=\s*\[([\s\S]*?)\n  \];/);
check('the formats list is present', Boolean(formatBlock));
const listed = [...(formatBlock?.[1] ?? '').matchAll(/value:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
check(
  'the page offers exactly the five EXPORT_FORMATS, in the declared order',
  JSON.stringify(listed) === JSON.stringify([...EXPORT_FORMATS]),
  `page: ${listed.join(', ')}  |  shared: ${EXPORT_FORMATS.join(', ')}`,
);

console.log('\n=== THE RETIRED FORMAT IS GONE, THE NEW ONE IS IN ===');
check('MKV H.264 is offered', listed.includes('mkv_h264'));
check('MP4 AV1 is NOT offered', !listed.includes('mp4_av1'), listed.join(','));
// AV1 survives once, in WebM — the codec is not withdrawn, only its MP4 home.
check('WebM AV1 is offered', listed.includes('webm_av1'));
// MKV sits THIRD — the owner moved it up, so it reads as part of the H.264 family rather than as a
// trailer after the WebM pair.
check('MKV sorts THIRD', listed[2] === 'mkv_h264', listed.join(','));
check('the WebM pair still follows it', listed[3] === 'webm_vp9' && listed[4] === 'webm_av1', listed.join(','));
// The order the owner asked for: the two MP4 entries, then MKV, then the WebM pair.
check(
  'MP4 H.264 and MP4 H.265 come first',
  listed[0] === 'mp4_h264' && listed[1] === 'mp4_h265',
  listed.join(','),
);

console.log('\n=== THE PREVIEW EXTENSION FOLLOWS THE CONTAINER ===');
// This is the defect the change fixes, stated as an assertion on the source: the filename preview used
// to render a literal `.mp4` regardless of the selected format.
check(
  'the preview does NOT hardcode .mp4 after the sample name',
  !/\{sampleName\}\.mp4/.test(pageSrc),
  'the preview would promise an .mp4 filename for a WebM or MKV export',
);
check('the preview uses a derived extension', /\{sampleName\}\{extension\}/.test(pageSrc));
check(
  'the extension is derived from the format pair, not from its own list',
  /const extension = \$derived\(\{.*\}\[pair\.container\]\)/.test(pageSrc),
  'a second per-format table would be a second owner of the mapping',
);
// And the table it uses must agree with the SERVER's, which is what names the actual file.
for (const [container, ext] of [['mp4', '.mp4'], ['webm', '.webm'], ['mkv', '.mkv']]) {
  check(
    `the page maps ${container} to ${ext}`,
    new RegExp(`${container}:\\s*'\\${ext}'`).test(pageSrc),
  );
  check(
    `the server maps ${container} to ${ext}`,
    new RegExp(`${container}:\\s*"\\${ext}"`).test(serverSrc),
    'the server names the file; if it disagrees the artifact gets the wrong name',
  );
}
// The server's mapping is a table, not a ternary — a ternary cannot express a third container.
check(
  'the server derives the extension from a table, not a webm/mp4 ternary',
  !/container === "webm" \? "\.webm" : "\.mp4"/.test(serverSrc),
  'a two-branch ternary silently gives MKV a .mp4 name',
);

console.log('\n=== THE NAME FIELD ===');
check('a Name section exists above the Filename section', /tracking-wider text-ash">Name<\/h2>/.test(pageSrc));
check(
  'Name comes BEFORE Filename in the markup (it is an input to the template)',
  pageSrc.indexOf('>Name</h2>') < pageSrc.indexOf('>Filename</h2>'),
);
check('the field binds to a draft, not straight to the clip', /bind:value=\{nameDraft\}/.test(pageSrc));
check(
  'the rename commits on BLUR, not on every keystroke',
  /onblur=\{\(\) => renameSelected\(nameDraft\)\}/.test(pageSrc),
  'committing per keystroke would PATCH once per character',
);
check('Enter commits', /if \(e\.key === 'Enter'\) \(e\.target as HTMLInputElement\)\.blur\(\)/.test(pageSrc));
check('Escape reverts the field', /if \(e\.key === 'Escape'\) nameDraft = selected \? nameOf\(selected\.clip\) : ''/.test(pageSrc));
check(
  'the rename goes through the SAME update route the preview page uses',
  /apiClient\.updateClip\(clipId, \{ title \}\)/.test(pageSrc),
);
check(
  'the draft is seeded per CLIP ID, so a background refetch cannot erase typing',
  /if \(id !== seededForId\)/.test(pageSrc),
  'seeding on the clip object would re-seed on every unrelated cache event',
);
check(
  'an optimistic rename is dropped when the request fails',
  /renameClip failed/.test(pageSrc) && /const \{ \[vars\.clipId\]: _dropped, \.\.\.rest \}/.test(pageSrc),
);
// The guard is a BLOCK now, so this asserts the behaviour rather than one line's exact shape: a
// blank name must return BEFORE the mutation is reached, or clearing the field would send a request
// the server refuses (an HTTP 500, raw, on the most likely action in the section).
const renameFnRegion = pageSrc.slice(
  pageSrc.indexOf('function renameSelected'),
  pageSrc.indexOf('const renameMutation'),
);
check(
  'a blank name returns before anything is sent (clearing the field is a deliberate act)',
  /if \(trimmed\.length === 0\) \{[\s\S]*?return;\s*\}/.test(renameFnRegion) &&
    renameFnRegion.indexOf('trimmed.length === 0') < renameFnRegion.indexOf('renameMutation.mutate'),
  'the guard must precede the mutate call',
);
check(
  'the filename facts read through the rename helper, so the preview follows immediately',
  /name: nameOf\(item\.clip\) \|\| null/.test(pageSrc),
);

console.log('\n=== THE VOD NAME MOVED TO THE HEADER ===');
check(
  'the vod name is rendered once at the top of the main content',
  /font-display text-base font-medium text-ink" title=\{selected\.streamTitle\}/.test(pageSrc),
);
// The footer of each list row must no longer carry it: long titles wrapped the row.
const listRowRegion = pageSrc.slice(pageSrc.indexOf('filenameForItem.get(item.clipId)'), pageSrc.indexOf('filenameForItem.get(item.clipId)') + 900);
check(
  'a list row no longer repeats the vod name',
  !/\{item\.streamTitle\}/.test(listRowRegion),
  'the stream title still appears in the row body',
);
check(
  'a list row still carries the filename and the time range',
  /filenameForItem\.get\(item\.clipId\)/.test(listRowRegion) && /fmtTime\(item\.clip\.startTime\)/.test(listRowRegion),
);
// The unavailable-entries list must KEEP it — those rows have no filename to identify them by.
check(
  'an unavailable entry still names its stream (it has no filename to show)',
  /\{entry\.streamTitle\} · clip unavailable/.test(pageSrc),
);

console.log('\n=== THE AUDIO LIST GREW, AND LABELS ITSELF ===');
check(
  'the audio options come from the shared matrix for the CURRENT container',
  /AUDIO_CODECS\.filter\(\(c\) => c !== 'none' && CONTAINER_AUDIO_MATRIX\[pair\.container\]\.includes\(c\)\)/.test(pageSrc),
);
check(
  'every codec has a human label and a note (no raw PCM_S16LE in the UI)',
  /pcm_s16le: \{ label: 'PCM 16'/.test(pageSrc) && /AUDIO_INFO\[a\]\.label/.test(pageSrc),
);
check(
  'the label table covers EVERY audio codec, so no key can be undefined at runtime',
  AUDIO_CODECS.every((c) => new RegExp(`^\\s*${c}: \\{ label:`, 'm').test(pageSrc)),
  AUDIO_CODECS.filter((c) => !new RegExp(`^\\s*${c}: \\{ label:`, 'm').test(pageSrc)).join(', '),
);
// WebM must not offer the MP4-only codecs, which the matrix enforces on the server too.
check(
  'WebM offers only opus/vorbis as real codecs',
  CONTAINER_AUDIO_MATRIX.webm.filter((c) => c !== 'none').join(',') === 'opus,vorbis',
);
check(
  'MP4 offers the popular lossy set plus both PCM depths',
  ['aac', 'mp3', 'flac', 'pcm_s16le', 'pcm_s24le'].every((c) => CONTAINER_AUDIO_MATRIX.mp4.includes(c)),
);
check(
  'MKV offers everything, because it is the archival container',
  ['aac', 'opus', 'vorbis', 'mp3', 'flac', 'pcm_s16le', 'pcm_s24le'].every((c) => CONTAINER_AUDIO_MATRIX.mkv.includes(c)),
);
for (const f of EXPORT_FORMATS) {
  const { container } = pairForFormat(f);
  check(`the container for ${f} has at least one audio codec`, CONTAINER_AUDIO_MATRIX[container].length > 0);
}

console.log('\n=== RESULT ===');
if (failures > 0) { console.log(`  ${failures} failure(s)`); process.exit(1); }
console.log('  ALL PASS');
