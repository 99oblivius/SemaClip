// The help overlay and the keydown handler must agree, in BOTH directions.
//
// WHY THIS FILE EXISTS: the overlay drifted from the code until it was wrong in both directions at
// once, and every row of that drift is a user-visible lie:
//
//   - `A` (accept) was documented and handled NOWHERE. The `case 'a'` branch went with the Accept
//     button; the row stayed, so the overlay taught a key that did nothing.
//   - `Q` was documented as "Hide / show snoozed clips". `handleKey` has no `q` branch at all, and
//     the state it drove (`unreviewedOnly`) was initialised `false` and never assigned — so the key
//     was dead and the filter it promised could not work even if the branch came back. Removed.
//   - `Enter (on marker)` never existed. Timeline.svelte has no keydown handler and marker jump is a
//     mouse CLICK, so the row described a keystroke for a mouse gesture.
//   - `[` / `]` and `N` are real and were NOT listed.
//
// A hand-audit fixed the current rows, but a hand-audit is what let them drift: nothing connected the
// two files. This test does — it reads the keys out of `handleKey`'s own `case` labels and the rows
// out of the overlay's own literal, and fails if either side has something the other lacks.
//
// Two exemptions are asserted rather than assumed, because a silent exemption is how Q stayed wrong:
//   - KEY ALIASES. The handler accepts both forms of the same physical key in one `case` label
//     (`case ',': case '<'`). The overlay documents the canonical form once; each alias must map to a
//     canonical form that IS documented.
//   - Esc is handled twice — in `handleKey` (back to the library) and inside the overlay (close) — so
//     its row is real in a way the handler scan cannot see.
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}  ${detail}`); failures++; }
};

const HELP = readFileSync(new URL('../src/lib/components/KeyboardHelp.svelte', import.meta.url), 'utf8');
const PAGE = readFileSync(new URL('../src/routes/stream/[id]/+page.svelte', import.meta.url), 'utf8');

// ── The handler's keys ────────────────────────────────────────────────────────────────────────────
// Isolate handleKey's body so a `case` in some other function cannot be mistaken for a shortcut.
const handleKey = (() => {
  const start = PAGE.indexOf('function handleKey');
  if (start < 0) throw new Error('handleKey not found in the review page — did it get renamed?');
  const rest = PAGE.slice(start);
  const end = rest.indexOf('\n  }\n');
  return rest.slice(0, end);
})();

/** Every single-character key the handler switches on. */
const handledChars = new Set();
for (const m of handleKey.matchAll(/case '([^']+)'/g)) {
  if (m[1].length === 1) handledChars.add(m[1].toLowerCase());
}

// ── The overlay's rows ────────────────────────────────────────────────────────────────────────────
const groupsBlock = HELP.match(/const groups:[^=]*=\s*\[([\s\S]*?)\n  \];/);
if (!groupsBlock) throw new Error("the overlay's `groups` literal was not found");
const groupsSrc = groupsBlock[1];

const rows = [];
{
  // Each group is `{ title: 'X', keys: [ ... ], }` — the array closes with a comma before the object.
  for (const g of groupsSrc.matchAll(/\{\s*title:\s*'([^']+)',\s*keys:\s*\[([\s\S]*?)\]\s*,?\s*\}/g)) {
    for (const k of g[2].matchAll(/\{\s*key:\s*'([^']+)',\s*action:\s*'([^']*)'\s*\}/g)) {
      rows.push({ group: g[1], key: k[1], action: k[2] });
    }
  }
}
check('the overlay literal parses into rows', rows.length > 20, `parsed ${rows.length}`);

const isMouseGroup = (t) => /mouse/i.test(t);
const keyRows = rows.filter((r) => !isMouseGroup(r.group));
const mouseRows = rows.filter((r) => isMouseGroup(r.group));
check('the overlay has a mouse group', mouseRows.length > 0, `${mouseRows.length} mouse rows`);

// A documented NON-character key, mapped to the character the handler actually sees.
const NAMED_KEYS = new Map([['Space', ' ']]);

// Rows whose binding is a NAMED event key rather than a character. Each must match the handler.
const STRUCTURAL_ROWS = new Map([
  ['← / →', /case 'ArrowLeft'[\s\S]{0,400}case 'ArrowRight'/],
  ['Shift+← / →', /case 'ArrowLeft'[\s\S]{0,400}case 'ArrowRight'/],
]);

/** The single characters a row documents. Chords contribute their BASE key, ranges expand. */
function rowChars(label) {
  const out = new Set();

  // A named-by-event-key row (arrows).
  if (STRUCTURAL_ROWS.has(label)) return { chars: out, derived: false };

  // A numeric range: '1–7' documents seven separate single-key toggles.
  const range = label.match(/^(\d)\s*[–-]\s*(\d)$/);
  if (range) {
    for (let i = Number(range[1]); i <= Number(range[2]); i++) out.add(String(i));
    return { chars: out, derived: false };
  }

  // A named key ('Space').
  if (NAMED_KEYS.has(label)) {
    out.add(NAMED_KEYS.get(label));
    return { chars: out, derived: false };
  }

  let derived = false;
  for (const tok of label.split('/')) {
    const t = tok.trim();
    if (!t) continue;
    // A bare '+' is the KEY, not a modifier prefix — splitting it would yield an empty base.
    const base = t === '+' ? '+' : t.split('+').pop().trim();
    if (base.length === 1 && /[a-z0-9,\[\]<>.?+='-]/i.test(base)) out.add(base.toLowerCase());
    else derived = true;
  }
  return { chars: out, derived };
}

// Keys the handler accepts as an ALIAS of another binding — same physical key, one `case` label.
// The overlay documents the canonical form, so each alias must resolve to something documented.
const ALIASES = new Map([
  ['<', ','], // case ',': case '<'
  ['>', '.'], // case '.': case '>'
  ['=', '+'], // case '+': case '='
  ['_', '-'], // case '-': case '_'
]);

// ── Direction 1: every documented key must be handled ─────────────────────────────────────────────
console.log('\n=== DIRECTION 1: documented => handled ===');
{
  const named = [];
  for (const row of keyRows) {
    const { chars, derived } = rowChars(row.key);
    if (STRUCTURAL_ROWS.has(row.key)) {
      named.push(row.key);
      check(
        `'${row.key}' maps to a real named case in the handler`,
        STRUCTURAL_ROWS.get(row.key).test(handleKey),
        'no matching ArrowLeft/ArrowRight case',
      );
      continue;
    }
    if (chars.size === 0) {
      named.push(row.key);
      // Esc is the only row with no character of its own: it is handled in handleKey AND inside the
      // overlay, which is asserted in its own section below.
      check(`'${row.key}' is accounted for`, /^esc$/i.test(row.key), 'unparsed key row');
      continue;
    }
    if (derived && chars.size === 1) named.push(`${row.key} -> '${[...chars][0]}'`);
    const missing = [...chars].filter((c) => !handledChars.has(c));
    check(
      `'${row.key}' (${row.action}) is handled`,
      missing.length === 0,
      `NOT HANDLED: ${missing.join(', ')} — a DEAD ROW; remove it from the overlay`,
    );
  }
  if (named.length) console.log(`  note: named/normalised rows: ${named.join('; ')}`);
}

// ── Direction 2: a handled key must not be invisible (the Q / A failures) ─────────────────────────
console.log('\n=== DIRECTION 2: handled => documented (or a declared alias) ===');
{
  const documented = new Set();
  for (const row of keyRows) for (const c of rowChars(row.key).chars) documented.add(c);

  const undocumented = [];
  for (const c of [...handledChars].sort()) {
    if (documented.has(c)) continue;
    // An alias counts as documented when its canonical key is.
    const canonical = ALIASES.get(c);
    if (canonical && documented.has(canonical)) continue;
    undocumented.push(c);
  }
  check(
    'every handled key is documented (or an alias of one that is)',
    undocumented.length === 0,
    `handled but invisible to the user: ${undocumented.map((c) => `'${c}'`).join(', ')}`,
  );

  // Every declared alias must actually be handled AND its canonical form documented — otherwise the
  // exemption is stale and is hiding a real gap.
  for (const [alias, canonical] of ALIASES) {
    check(`alias '${alias}' is handled and '${canonical}' is documented`, handledChars.has(alias) && documented.has(canonical));
  }

  check("'[' and ']' are documented", documented.has('[') && documented.has(']'));
  check("'+' and '-' are documented", documented.has('+') && documented.has('-'));
  check("'n' is documented (owner's request)", documented.has('n'));
  check("'e' is documented", documented.has('e'));
}

// ── The keys the owner called out ─────────────────────────────────────────────────────────────────
console.log("\n=== THE OWNER'S THREE ITEMS ===");
check("'N' for new clip is in the overlay", rows.some((r) => r.key === 'N'));
check("'Q' is GONE from the overlay", !rows.some((r) => /(^|[^A-Za-z])Q([^A-Za-z]|$)/.test(r.key)));
check('no dead `A`/accept row', !rows.some((r) => r.key === 'A' && /accept/i.test(r.action)));
check(
  'the phantom "Enter (on marker)" row is gone',
  !rows.some((r) => /enter/i.test(r.key) && /marker/i.test(r.action)),
);
// A key documented but unhandled is the `A` bug; assert the handler really has no such branch.
check("no 'a' branch remains in the handler", !handledChars.has('a'));
check("no 'q' branch remains in the handler", !handledChars.has('q'));

// A documented mouse gesture must exist as a handler in Timeline.svelte, so "how do I do X" cannot
// point at a gesture nobody implemented.
console.log('\n=== MOUSE ROWS POINT AT REAL GESTURES ===');
{
  const TIMELINE = readFileSync(new URL('../src/lib/components/Timeline.svelte', import.meta.url), 'utf8');
  const GESTURE_EVIDENCE = [
    ['Left click', /onSeek|handleMouseDown/],
    ['Left drag', /isProxybing|isDraggingEndpoint|window\.addEventListener\('mousemove'/],
    ['Middle drag', /e\.button === 1/],
    ['Click clip mark', /onSelectClip/],
    ['Drag handles', /isDraggingEndpoint/],
    ['Click a flag', /markerClick/],
    ['Scroll', /handleWheel|onwheel/],
  ];
  for (const [label, re] of GESTURE_EVIDENCE) {
    check(`mouse row '${label}' exists and its gesture is implemented`, mouseRows.some((r) => r.key === label) && re.test(TIMELINE));
  }
}

// ── The double-handled Esc ────────────────────────────────────────────────────────────────────────
console.log('\n=== THE DOUBLE-HANDLED Esc ===');
check('Esc is in the overlay', rows.some((r) => r.key === 'Esc'));
check('Esc is handled by handleKey too', handleKey.includes("case 'Escape'"));
check(
  'the overlay handles Esc itself (so the row is real on both paths)',
  /onkeydown=\{\(e\) => e\.key === 'Escape'/.test(HELP),
);

console.log(`\n=== RESULT ===\n  ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exitCode = 1;
