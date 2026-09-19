// Chat windowing decisions — the three judgements that were wrong.
//
// ── THE BUG THIS PINS ───────────────────────────────────────────────────────────
// ChatView loaded `offset=0&limit=500` once and treated that as the whole stream. Measured against a
// 36,000-message / 2h chat file, that window covers t=0..100s, so opening a project at 1h30m showed
// the chat from the first 100 SECONDS of the broadcast. The server has always supported
// `?around=<sec>`; the client never sent it.
//
// The window is now refetched as the playhead moves, and browsing can cross window boundaries. That
// introduces three ways to be wrong, all pure functions of state and all asserted here:
//   1. WHICH window to fetch (the server picks it from `around`; the cursor must then be placed);
//   2. WHETHER the playhead should refetch at all (it must NOT while the user is browsing);
//   3. WHERE the cursor resumes when a browse crosses an edge.
//
// The ORIGINAL behaviour is kept as an oracle below and asserted to get the first case WRONG, so this
// cannot quietly become a test that passes against the broken logic.
import {
  browseCrossing,
  cursorForTime,
  REFETCH_MARGIN,
  resumeCursor,
  shouldRefetchWindow,
  WINDOW_LIMIT,
} from '../src/lib/components/chat-window.ts';

let failures = 0;
function check(name, cond) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

// A 2h stream at ~5 messages/second: 36,000 messages, times 0.0..7199.8.
function makeTimes(n = 36000, perSecond = 5) {
  return Array.from({ length: n }, (_, i) => i / perSecond);
}

const TIMES = makeTimes();

console.log('\n1. WHICH WINDOW: the cursor lands where the playhead is');

// The server returns the 500 messages around the requested time. Simulate its slice so the cursor can
// be checked against the same arithmetic the component does.
function serverSlice(times, aroundSec, limit = WINDOW_LIMIT) {
  const idx = cursorForTime(times, aroundSec);
  const start = Math.max(0, idx - Math.floor(limit / 2));
  return { messages: times.slice(start, start + limit), offset: start };
}

const at1h30 = serverSlice(TIMES, 5400);
check(
  'the window around 1h30m actually contains 1h30m',
  at1h30.messages[0] <= 5400 && at1h30.messages[at1h30.messages.length - 1] >= 5400,
);

// ORACLE: the old call was `offset=0&limit=500`, i.e. always the first 500 of the stream.
const oldWindow = TIMES.slice(0, 500);
check(
  'ORACLE — the old offset=0 window does NOT contain 1h30m (this is the bug)',
  !(oldWindow[0] <= 5400 && oldWindow[oldWindow.length - 1] >= 5400),
);
check(
  'ORACLE — that window ends after only ~100s of a 2h stream',
  Math.abs(oldWindow[oldWindow.length - 1] - 100) < 2,
);

console.log('\n2. WHETHER to refetch: playback yes, browsing no');

check(
  'a playhead in the middle of the window does not refetch',
  shouldRefetchWindow({ follow: true, windowLength: 500, cursor: 250 }) === false,
);
check(
  'a playhead past the far edge DOES refetch',
  shouldRefetchWindow({ follow: true, windowLength: 500, cursor: 500 }) === true,
);
check(
  'a playhead before the near edge DOES refetch',
  shouldRefetchWindow({ follow: true, windowLength: 500, cursor: 0 }) === true,
);
check(
  'the margin boundary is inclusive on the inside',
  shouldRefetchWindow({ follow: true, windowLength: 500, cursor: REFETCH_MARGIN }) === false,
);
check(
  'BROWSING never refetches, even with the playhead far outside the window',
  shouldRefetchWindow({ follow: false, windowLength: 500, cursor: 0 }) === false,
);
check(
  'an empty window never refetches',
  shouldRefetchWindow({ follow: true, windowLength: 0, cursor: 0 }) === false,
);

console.log('\n3. WHERE the cursor resumes after a browse crosses an edge');

check(
  'crossing the TOP resumes at the window END (continuing backwards)',
  resumeCursor('top', 500, 40) === 500,
);
check(
  'crossing the BOTTOM resumes at the window START (continuing forwards)',
  resumeCursor('bottom', 500, 40) === 40,
);
check('no browse leaves the cursor alone', resumeCursor(null, 500, 40) === null);
check(
  'a short window cannot resume past its own end',
  resumeCursor('bottom', 10, 40) === 10,
);

console.log('\n4. WHEN a browse crosses: only at a real edge of the STREAM');

const mid = { windowLength: 500, windowStart: 1000, windowEnd: 1500, totalCount: 36000 };
check(
  'running off the top mid-stream IS a crossing',
  browseCrossing({ ...mid, newIndex: 0 }) === 'top',
);
check(
  'running off the bottom mid-stream IS a crossing',
  browseCrossing({ ...mid, newIndex: 500 }) === 'bottom',
);
check(
  'the very first window has nothing above it',
  browseCrossing({ ...mid, windowStart: 0, newIndex: 0 }) === null,
);
check(
  'the very last window has nothing below it',
  browseCrossing({ ...mid, windowEnd: 36000, newIndex: 500 }) === null,
);
check(
  'a move inside the window is not a crossing',
  browseCrossing({ ...mid, newIndex: 250 }) === null,
);

console.log('\n5. The cursor tracks a moving playhead monotonically');

const before = cursorForTime(TIMES, 1000);
const after = cursorForTime(TIMES, 2000);
check('a later playhead yields a later cursor', after > before);
// The cursor is EXCLUSIVE: it is the count of messages at or before the time. `visibleMessages`
// slices up to it, so a message exactly at the playhead must fall inside the slice — an off-by-one
// here silently drops the message being followed, which is the kind of thing that looks fine in a
// screenshot and is wrong.
const c10 = cursorForTime(TIMES, 10.0);
check(
  'the cursor counts every message at or before the time',
  TIMES[c10 - 1] <= 10.0 && TIMES[c10] > 10.0,
);

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
