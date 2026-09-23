// The owner's second wave of review-page UI fixes, each asserted against the code path that decides
// it rather than against a rendering.
//
//   1. "Export this clip" must report progress. It used to POST `/api/clips/:id/export`, which runs
//      the WHOLE encode before answering — so the button sat inert for the length of an encode, with
//      no bar, no ETA and no cancel. It now enqueues onto the durable queue, which reports all three.
//      A source-level check, because "did it take the async path" is exactly what regressed.
//   3. The clip end handle was drawn 3px against the start's 2px; the asymmetry read as a different
//      KIND of mark. Both boundaries now share one width.
//   4. The timeline is NOT focusable: `tabindex={0}` made it a tab stop that outlives the
//      interaction, and it takes no keyboard input at all (no keydown handler in Timeline.svelte).
//   5. Text selectability is OFF by default and opted back in where copying matters.
//   6. The preview page's clip panel had TWO export buttons wired to the same handler, plus a
//      "Play from start" whose label undersold what it did. One export button, no Actions column.
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}  ${detail}`); failures++; }
};

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const EXPORT_PAGE = read('../src/routes/export/+page.svelte');
const REVIEW_PAGE = read('../src/routes/stream/[id]/+page.svelte');
const TIMELINE = read('../src/lib/components/Timeline.svelte');
const CLIP_DETAIL = read('../src/lib/components/ClipDetail.svelte');
const CHAT = read('../src/lib/components/ChatView.svelte');
const DELETE_MODAL = read('../src/lib/components/DeleteConfirmModal.svelte');
const APP_CSS = read('../src/app.css');
const BUILD_CSS = (() => {
  // The emitted bundle is what the browser actually gets; a Tailwind-layer mistake shows up here
  // and nowhere else. Absent before a build, so it is checked only when present.
  try {
    const { readdirSync } = require('node:fs');
    const dir = new URL('../build/_app/immutable/assets/', import.meta.url);
    const png = readdirSync(dir).find((f) => f.endsWith('.css'));
    return png ? readFileSync(new URL(png, dir), 'utf8') : null;
  } catch { return null; }
})();

// ── 1. "Export this clip" reports progress ────────────────────────────────────────────────────────
console.log('\n=== 1. "Export this clip" runs on the observable queue ===');
{
  // The single-export mutation must enqueue, not call the synchronous route.
  const singleExport = EXPORT_PAGE.match(/const exportMutation = createMutation\(\(\) => \(\{([\s\S]*?)\n  \}\)\);/);
  check('the single-export mutation was found', !!singleExport);
  if (singleExport) {
    check(
      'it ENQUEUES onto the durable queue',
      /apiClient\.enqueueExports\(/.test(singleExport[1]),
      'it must not call the synchronous single-clip export',
    );
    check(
      'it does NOT call the synchronous route',
      !/apiClient\.exportClip\(/.test(singleExport[1]),
      'apiClient.exportClip awaits the whole encode — the reported silent export',
    );
    check(
      'it sends an EXPLICIT clipIds (a deliberate re-send)',
      /clipIds:\s*\[/.test(singleExport[1]),
      'the implicit batch filters out already-exported clips; a re-send must be explicit',
    );
    check(
      'it sends NO filename, so the server renders the per-clip name',
      /filename:\s*null/.test(singleExport[1]),
      'a rendered name has no tokens left and renders verbatim for every clip',
    );
    check(
      'it invalidates the export queue so the progress bar re-reads',
      /invalidateQueries\(\{\s*queryKey:\s*\['export-queue'\]/.test(singleExport[1]),
      'without this the queue query never refetches and no progress appears',
    );
  }
  // The progress UI itself must exist and be driven by the queue.
  check(
    'the export page renders progress from the queue view',
    /getExportQueue|export-queue/.test(EXPORT_PAGE),
  );
  check(
    'the synchronous route is no longer reachable from the UI',
    !/apiClient\.exportClip\(/.test(EXPORT_PAGE),
  );
}

// ── 3. The two boundary handles are drawn identically ─────────────────────────────────────────────
console.log('\n=== 3. Both clip boundaries share one width ===');
{
  const drawRange = TIMELINE.match(/const drawRange = \(([\s\S]*?)\n    \};/);
  check('drawRange was found', !!drawRange);
  if (drawRange) {
    const body = drawRange[1];
    const widths = [...body.matchAll(/lineWidth = (\d+)/g)].map((m) => Number(m[1]));
    check(
      'the range draws exactly one line width (shared by start and end)',
      new Set(widths).size === 1,
      `found line widths ${widths.join(', ')} — the end was 3px against the start's 2px`,
    );
    // The two boundary strokes must both exist and use that shared width.
    const strokes = (body.match(/ctx\.stroke\(\)/g) ?? []).length;
    check('both boundaries are stroked', strokes >= 2, `found ${strokes} strokes`);
    check(
      'no separate start/end width assignment survived',
      !/lineWidth\s*=\s*isEnd\s*\?/.test(body),
    );
  }
}

// ── 4. The timeline is not focusable ──────────────────────────────────────────────────────────────
console.log('\n=== 4. The timeline is not focusable ===');
{
  // Strip comments first: the explanation below the markup QUOTES `tabindex={0}`, which would
  // otherwise make this check pass on its own documentation.
  const withoutComments = TIMELINE.replace(/<!--[\s\S]*?-->/g, '');
  check(
    'no tabindex anywhere in the timeline component',
    !/tabindex/.test(withoutComments),
    'a tab stop that outlives the interaction is the reported focus problem',
  );
  check(
    'no interactive slider role',
    !/role="slider"/.test(withoutComments),
    'the timeline takes no keyboard input, so a slider role promises keys that do not exist',
  );
  check(
    'the component still declares what it IS to assistive tech',
    /role="application"/.test(withoutComments) && /aria-label=/.test(withoutComments),
    'removing focusability must not remove the accessible name',
  );
  check(
    'there is genuinely no keydown handler in Timeline (the reason it must not be focusable)',
    !/function handleKey/.test(TIMELINE) && !/onkeydown/.test(withoutComments),
  );
  // The endpoint handles are drag targets, not buttons.
  check(
    'the endpoint handles carry no tabindex',
    !/tabindex/.test(withoutComments),
  );
}

// ── 5. Text selection is off by default, opted in where it matters ───────────────────────────────
console.log('\n=== 5. Text selectability ===');
{
  check(
    'the global default is no-selection',
    /user-select:\s*none/.test(APP_CSS) && /body\s*\{[\s\S]{0,200}user-select:\s*none/.test(APP_CSS.replace(/\n/g, ' ')),
    'the default must be non-selectable',
  );
  check(
    'a `.selectable` opt-in exists',
    /\.selectable\s*\{[\s\S]*?user-select:\s*text/.test(APP_CSS),
  );
  check(
    'form fields stay selectable (typing needs selection)',
    /input,\s*textarea/.test(APP_CSS) && /contenteditable/.test(APP_CSS),
  );
  check(
    'error text stays selectable (users copy it)',
    /\.text-error/.test(APP_CSS),
  );
  check(
    'code/pre stay selectable',
    /pre,\s*code/.test(APP_CSS) || /\bpre\b/.test(APP_CSS),
  );
  // Chat is the one place a user genuinely wants to copy a line out.
  check(
    'chat messages opt back in',
    /class="selectable[^"]*"/.test(CHAT),
    'chat text is worth copying',
  );
  // The chat scroll container must NOT force select-none, or it would defeat the message opt-in.
  check(
    'the chat scroll container no longer forces select-none',
    !/overflow-hidden select-none/.test(CHAT),
    'a container-wide select-none cancels the per-message opt-in',
  );
  // ── The regression the default caused: a name you must RETYPE has to be copyable ──
  // The project name is what the delete dialog asks the user to type verbatim to confirm. Making
  // the whole app non-selectable silently removed the ability to copy it, so a long VOD title —
  // the worst case for hand-transcription, in a destructive dialog — had to be typed by eye.
  check(
    'the delete dialog\'s project block is selectable',
    /class="selectable[^"]*"/.test(DELETE_MODAL),
    'the name the user must retype to confirm must be copy-able',
  );
  check(
    'the project block still renders the stream title',
    /\{stream\.title \?\? /.test(DELETE_MODAL),
  );
  check(
    'the dialog still requires the name to be typed (the copy is for THAT field)',
    /const canDelete = \$derived\(typed === confirmText\)/.test(DELETE_MODAL),
    'if the confirm gate went away, copyability would be moot',
  );
  check(
    'no other destructive dialog asks for a typed name (so no second site is missing it)',
    (() => {
      const { readdirSync } = require('node:fs');
      const dir = new URL('../src/', import.meta.url);
      const found = [];
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = new URL(e.name, d.href.endsWith('/') ? d : new URL(d.href + '/'));
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.svelte')) {
            const s = readFileSync(p, 'utf8');
            if (/type the .*name/i.test(s)) found.push(e.name);
          }
        }
      };
      walk(dir);
      return found.length <= 1;
    })(),
    'a second typed-confirm dialog would need the same opt-in',
  );

  if (BUILD_CSS) {
    console.log('  (built CSS found — asserting the emitted rules too)');
    check('the bundle emits user-select:none', /user-select:none/.test(BUILD_CSS));
    check('the bundle emits the text opt-in', /user-select:text/.test(BUILD_CSS));
    check(
      'the bundle keeps fields selectable inside the global rule',
      /input,textarea,\[contenteditable=true\][^{]*\{[^}]*user-select:text/.test(BUILD_CSS),
    );
  } else {
    console.log('  (no build present — bundle assertions skipped)');
  }
}

// ── 6. One Export button, and no Actions column ───────────────────────────────────────────────────
console.log('\n=== 6. The preview clip panel ===');
{
  // In the panel's markup (comments stripped), count the export buttons.
  const markup = CLIP_DETAIL.replace(/<!--[\s\S]*?-->/g, '');
  // Count CONTROLS WIRED TO onExport, not labels that read "Export": a label check passed while a
  // button still said "Export" but had been rewired to `onDiscard`, which is the exact kind of weak
  // assertion that lets a regression through.
  const exportWired = (markup.match(/onclick=\{onExport\}/g) ?? []).length;
  check(
    'exactly ONE control is wired to onExport',
    exportWired === 1,
    `found ${exportWired} — there were two, both calling onExport`,
  );
  const exportLabels = (markup.match(/>\s*Export\b|Export clip/g) ?? []).length;
  check(
    'exactly one control is LABELLED Export',
    exportLabels === 1,
    `found ${exportLabels} labels`,
  );
  check(
    'no "Play from start" control remains',
    !/Play from start/.test(markup),
    'its two neighbours duplicated it; it was one of three redundant actions',
  );
  check(
    'the Actions column is gone',
    !/Actions/.test(markup),
    'the column held only the two redundant buttons',
  );
  check(
    'the onPlay prop is gone',
    !/onPlay/.test(markup),
    'a prop with no consumer is dead surface',
  );
  check(
    'the endpoint column adapts to the available width instead of being 1/3',
    !/grid-cols-3/.test(markup) && /grid-cols-2|grid-cols-1/.test(markup),
    'Endpoints must occupy the freed width, not a fixed third',
  );
  // The page must not still pass onPlay or hold the dead handler chain.
  check(
    'the review page no longer passes onPlay',
    !/onPlay=/.test(REVIEW_PAGE),
  );
  check(
    'the playClip chain is gone from the page',
    !/function playClip/.test(REVIEW_PAGE),
  );
  const VIDEO_PLAYER = read('../src/lib/components/VideoPlayer.svelte');
  check(
    'the now-unreachable auto-advance chain is gone from the player',
    !/autoAdvanceClip/.test(VIDEO_PLAYER) && !/export function playClip/.test(VIDEO_PLAYER),
    'autoAdvanceClip was only ever set by playClip',
  );
  check(
    'the onClipEnd prop is gone too',
    !/onClipEnd/.test(VIDEO_PLAYER) && !/onClipEnd=/.test(REVIEW_PAGE),
  );
  // What actually must SURVIVE: the panel's own export button and the endpoints.
  check(
    'the surviving control really calls onExport (not just the prop existing)',
    /onclick=\{onExport\}/.test(markup),
    'the prop declaration alone would satisfy a naive /onExport/ check',
  );
  check('the Endpoints column remains', /Endpoints/.test(markup));

  // ── Follow-ups to item 6 ────────────────────────────────────────────────────────────────────────
  console.log('\n=== 6b. Peak removed, endpoints inline, cross always visible ===');

  // `Peak` is gone from the panel: it earned its place when selecting a clip jumped the playhead
  // there and the timeline drew a tick, and both of those were removed, leaving a number nothing
  // acted on. It also went stale on any trim.
  check(
    'no Peak row in the clip panel',
    !/Peak/.test(markup),
    'the panel must not render a peak row',
  );
  check(
    'the frontend no longer READS clip.peakTime anywhere (comments excepted)',
    ![...CLIP_DETAIL.replace(/<!--[\s\S]*?-->/g, '').matchAll(/clip\.peakTime/g)].length,
    'a field displayed nowhere and acted on nowhere is dead surface',
  );
  check(
    'peakTime is still on the wire type (engine evidence, not deleted data)',
    /peakTime/.test(read('../..//shared/types.ts')) || /peakTime/.test(read('../../shared/types.ts')),
    'removing a FIELD would lose engine evidence; only the UI row was removed',
  );

  // The three span facts share ONE row now, so the column's height is free for engine data.
  const endpointsBlock = markup.match(/Endpoints<\/div>\s*<div class="([^"]+)"/);
  check('the endpoints block was found', !!endpointsBlock);
  if (endpointsBlock) {
    check(
      'the endpoints row is INLINE (a wrapping row), not a stacked column',
      /flex/.test(endpointsBlock[1]) && !/flex-col/.test(endpointsBlock[1]),
      `class was "${endpointsBlock[1]}" — flex-col stacks one fact per row`,
    );
  }
  check(
    'Start, End and Dur all render in that one row',
    /\bStart\b/.test(markup) && /\bEnd\b/.test(markup) && /\bDur\b/.test(markup),
  );
  check(
    'the old per-fact justify-between rows are gone',
    !/justify-between"><span class="text-ash-dim">Start/.test(markup),
    'three separate justify-between rows is the stacked layout that was replaced',
  );
  check(
    'no border-t divider on a Dur row (there is no longer a last row to divide)',
    !/border-t border-border pt-1/.test(markup),
  );

  // The export list's remove control must be visible at rest.
  check(
    'the export-list cross is always visible (no opacity-0 gate)',
    !/opacity-0[^"]*group-hover/.test(EXPORT_PAGE),
    'a hover-revealed control does not exist until you already know it is there',
  );
  check(
    'the remove button still calls removeFromExportList',
    /removeMutation\.mutate\(item\.clipId\)/.test(EXPORT_PAGE),
  );
  check(
    'the orphaned `group` class was removed from the row',
    !/class="group relative/.test(EXPORT_PAGE),
    'with the only group-hover gone, the marker class is dead',
  );
}

console.log(`\n=== RESULT ===\n  ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exitCode = 1;
