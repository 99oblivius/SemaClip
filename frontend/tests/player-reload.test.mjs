// The player must reload when its media was REPLACED, not only when it grew.
//
// ── THE BUG THIS PINS ───────────────────────────────────────────────────────────
// Deleting a video and downloading it again left the player showing the old media for an
// extremely long time. The stall detector compared the download frontier against
// `frontierAtLastReload`, a high-water mark that was NEVER reset, so after a delete the mark
// still held the DELETED file's size. The new download starts at zero, which made
// `frontier <= mark + growth` true forever — no reload, no new video.
//
// The ORIGINAL predicate is kept here as an oracle and asserted to get the replacement case
// WRONG, so this cannot quietly become a test that passes against the broken logic. (Run with
// vite-node: plain `node` cannot resolve the TS import.)
import { shouldReloadMedia } from '../src/lib/components/player-reload.ts';

const STALL_MS = 1500;
const MIN_GROWTH = 128 * 1024;

let failures = 0;
function check(name, cond) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

function decision(over = {}) {
  return {
    frontierBytes: 0,
    frontierAtLastReload: 0,
    sinceProgressMs: 5000,
    paused: false,
    inFlight: false,
    stallMs: STALL_MS,
    minGrowth: MIN_GROWTH,
    ...over,
  };
}

/** The ORIGINAL predicate, kept verbatim as the oracle. */
function oldLogic(a) {
  if (a.paused || a.inFlight) return false;
  if (a.sinceProgressMs < a.stallMs) return false;
  return a.frontierBytes > a.frontierAtLastReload + a.minGrowth;
}

// The reported case: a 1GB video was deleted, the re-download is at 2MB, and the mark still
// holds the deleted file's size.
const replaced = decision({ frontierBytes: 2 * 1024 * 1024, frontierAtLastReload: 1024 * 1024 * 1024 });
check('replacement: a frontier BELOW the mark reloads immediately', shouldReloadMedia(replaced) === true);
check('  ...and the OLD logic ignored it (this is the bug)', oldLogic(replaced) === false);

// Ordinary growth still behaves.
const grew = decision({ frontierBytes: 10 * 1024 * 1024, frontierAtLastReload: 5 * 1024 * 1024 });
check('growth reloads', shouldReloadMedia(grew) === true);
check('  ...and the old logic agreed on growth', oldLogic(grew) === true);

const tooSmall = decision({ frontierBytes: 5 * 1024 * 1024 + MIN_GROWTH, frontierAtLastReload: 5 * 1024 * 1024 });
check('growth at exactly the threshold does not reload', shouldReloadMedia(tooSmall) === false);

// Guards.
check('paused does not reload', shouldReloadMedia(decision({ ...replaced, paused: true })) === false);
check('in-flight does not reload', shouldReloadMedia(decision({ ...replaced, inFlight: true })) === false);
check('not-yet-stalled does not reload', shouldReloadMedia(decision({ ...replaced, sinceProgressMs: 100 })) === false);

// A finished file must not reload forever.
check('a completed download stops reloading', shouldReloadMedia(decision({
  frontierBytes: Number.MAX_SAFE_INTEGER,
  frontierAtLastReload: Number.MAX_SAFE_INTEGER,
})) === false);

// The reload-loop guard: after a reload the mark equals the frontier, so the next tick must
// not reload again or the player would thrash.
check('an unchanged frontier does not reload again', shouldReloadMedia(decision({
  frontierBytes: 7_000_000,
  frontierAtLastReload: 7_000_000,
})) === false);


// ── REAL NUMBERS from the VM, so the case is not hypothetical ────────────────────
// After the first download completes, the effect sets `frontierBytes` to MAX and the mark
// catches up to it. Then the video is deleted (the view reports bytes=0), and the re-download
// grows from a small value. These are the actual figures measured against the real backend.
const AFTER_FIRST_DOWNLOAD = Number.MAX_SAFE_INTEGER;      // playableIsGrowing false -> MAX
const RE_DOWNLOAD_FIRST_TICK = 11_932_070;                  // measured at t+0.7s
const RE_DOWNLOAD_LATER = 520_590_619;                      // measured at t+7.9s

const restart = decision({
  frontierBytes: RE_DOWNLOAD_FIRST_TICK,
  frontierAtLastReload: AFTER_FIRST_DOWNLOAD,
});
check('a re-download reloads on its FIRST tick, not after the file completes',
  shouldReloadMedia(restart) === true);
check('  ...and the old logic would have waited (the reported slow display)',
  oldLogic(restart) === false);

// And it keeps working as the new file grows past the point the old mark would have allowed.
const later = decision({
  frontierBytes: RE_DOWNLOAD_LATER,
  frontierAtLastReload: RE_DOWNLOAD_FIRST_TICK,
});
check('subsequent growth of the new file still reloads normally', shouldReloadMedia(later) === true);

console.log(failures === 0 ? '  all player-reload checks passed' : `  ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
