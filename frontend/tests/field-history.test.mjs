// Undo/redo and revert-on-close for the project-settings fields.
//
// Reported: "Editing fields in the project setting don't have undo redo, and should also be made
// to revert when the settings page is closed." The panel bound six values straight to inputs, so
// an edit left no trace and neither behaviour was possible after the fact — hence the history is
// maintained as the user types rather than reconstructed.
//
// Run with vite-node: plain `node` cannot resolve the TS import.
import {
  adoptServerValues,
  canRedo,
  canUndo,
  commit,
  createHistory,
  rebase,
  redo,
  revertTarget,
  sameSnapshot,
  undo,
  HISTORY_LIMIT,
} from '../src/lib/components/field-history.ts';

let failures = 0;
function check(name, cond) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const SERVER = {
  title: 'Weskie Wednesday',
  streamer: 'weskie',
  game: 'Just Chatting',
  streamLink: 'https://www.twitch.tv/videos/1',
  vodPath: '/cache/vods/s1/weskie - video.mp4',
  chatPath: '/cache/vods/s1/weskie.chat.json',
};

const edit = (over) => ({ ...SERVER, ...over });

// ── Undo / redo ──────────────────────────────────────────────────────────────────
let h = createHistory(SERVER);
check('a fresh history has nothing to undo or redo', !canUndo(h) && !canRedo(h));

h = commit(h, edit({ title: 'Edited once' }));
check('an edit becomes undoable', canUndo(h));
check('the present holds the edit', h.present.title === 'Edited once');

h = commit(h, edit({ title: 'Edited twice' }));
h = undo(h);
check('undo steps back one edit, not to the original', h.present.title === 'Edited once');
h = undo(h);
check('undo again reaches the original', h.present.title === SERVER.title);
check('at the origin there is nothing left to undo', !canUndo(h));

h = redo(h);
check('redo returns the first edit', h.present.title === 'Edited once');
h = redo(h);
check('redo again reaches the last edit', h.present.title === 'Edited twice');
check('nothing left to redo', !canRedo(h));

// A new edit after an undo must drop the redo branch, or redo would jump to an abandoned future.
h = undo(h);
h = commit(h, edit({ title: 'A different branch' }));
check('a new edit invalidates the redo branch', !canRedo(h));
check('  ...and the branch is what is present', h.present.title === 'A different branch');

// ── A no-op commit must not create a step ────────────────────────────────────────
// bind:value fires per keystroke; a step per character makes Ctrl+Z meaningless.
let n = createHistory(SERVER);
n = commit(n, { ...SERVER });
check('committing an unchanged snapshot adds no undo step', !canUndo(n));

// ── The baseline is what closing reverts to ──────────────────────────────────────
let b = createHistory(SERVER);
b = commit(b, edit({ title: 'unsaved' }));
b = commit(b, edit({ game: 'unsaved game' }));
check('revert-on-close returns the SERVER values, not the first edit',
  sameSnapshot(revertTarget(b), SERVER));
check('  ...and it does not have to walk the undo history to get there', canUndo(b));

// After a successful save, the baseline moves so closing keeps the saved values.
let sv = createHistory(SERVER);
sv = commit(sv, edit({ title: 'saved title' }));
sv = rebase(sv, sv.present);
check('after a save, closing keeps the saved values',
  revertTarget(sv).title === 'saved title');
check('  ...and the undo history survives the save', canUndo(sv));
sv = undo(sv);
check('  ...so undo still reaches pre-save values', sv.present.title === SERVER.title);

// ── Server values arriving mid-edit must not clobber ─────────────────────────────
let a = createHistory(SERVER);
a = commit(a, edit({ title: 'half-typed' }));
const dirty = true;
const afterPoll = adoptServerValues(a, edit({ title: 'from the server' }), dirty);
check('a poll while editing does NOT overwrite the pending edit',
  afterPoll.present.title === 'half-typed');

const cleanAdopt = adoptServerValues(createHistory(SERVER), edit({ title: 'server moved on' }), false);
check('with nothing pending, server values are adopted',
  cleanAdopt.present.title === 'server moved on');
check('  ...and become the new revert target',
  sameSnapshot(revertTarget(cleanAdopt), edit({ title: 'server moved on' })));
check('  ...with no stale undo history', !canUndo(cleanAdopt));

// ── The history is bounded from the OLD end ──────────────────────────────────────
let big = createHistory(SERVER);
for (let i = 0; i < HISTORY_LIMIT + 25; i++) big = commit(big, edit({ title: `edit ${i}` }));
check(`history is bounded at ${HISTORY_LIMIT}`, big.past.length === HISTORY_LIMIT);
check('  ...and keeps the RECENT steps, not the oldest',
  big.past[big.past.length - 1].title === `edit ${HISTORY_LIMIT + 23}`);

console.log(failures === 0 ? '  all field-history checks passed' : `  ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
