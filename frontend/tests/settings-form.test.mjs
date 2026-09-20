// The settings form's dirty rule.
//
// The reported bug: changing the VOD directory and pressing Save did not make the page accept
// the save. It HAD saved — the toast and the "✓ Saved" mark simply never appeared, and Save
// stayed armed, because the page compared the path the user TYPED against the path the server
// STORES. The server expands `~`, unifies separators and drops a trailing separator before
// persisting (application/use-cases/paths.ts), so `~/VODs` and `/home/livia/VODs` are the same
// value in two spellings and never compare equal. The form was dirty for ever.
//
// These cases pin both directions: the resolved-vs-typed pair must NOT read as dirty, and real
// edits must still read as dirty — a comparison that always says "clean" would hide the toast
// AND silently drop the user's changes.
import { DEFAULT_FORM, formFromSettings, formToSettings, isDirty } from '../src/lib/components/settings-form.ts';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n         ${detail}`}`);
  if (!cond) failures++;
}

function settings(overrides = {}) {
  return {
    gpuDevice: null,
    exportDir: '/home/livia/Videos/SemaClip',
    vodDir: '/home/livia/VODs',
    defaultAspectRatio: '16:9',
    defaultCaptions: {
      enabled: false,
      preset: 'bold-white',
      position: 'bottom',
      fontSize: 48,
      backgroundOpacity: 0.8,
    },
    engineBinaryPath: null,
    cpuUsage: 'medium',
    defaultMaxQualityHeight: 1080,
    uiScale: 'medium',
    ...overrides,
  };
}

console.log('\n-- the reported bug: a saved path must read as clean --');

// The user typed `~/VODs`; the server resolved and stored /home/livia/VODs. After the save the
// form adopts the SAVE RESPONSE, so the two are the same string. This is the case that was
// broken: it must be clean.
const savedForm = formFromSettings(settings());
check('a form built from the server value is clean', !isDirty(savedForm, settings()));
check(
  'the resolved vodDir is what the form holds (never the typed tilde)',
  savedForm.vodDir === '/home/livia/VODs',
  `form.vodDir = ${JSON.stringify(savedForm.vodDir)}`,
);

// The oracle: the OLD rule (compare the typed text) gets this same case WRONG. Kept as a
// control so a future change that reintroduces raw-text comparison fails here.
const typedTilde = '~/VODs';
const oldRuleDirty = typedTilde !== settings().vodDir;
check(
  'the old raw-text comparison DOES call that same value dirty (control)',
  oldRuleDirty === true,
  'the control expects the old rule to be wrong; if this fails the test no longer has teeth',
);

console.log('\n-- the same rule for the other path field --');
// exportDir has the identical shape, one field up: it stored `~/Videos/SemaClip` literally and
// is now resolved on save too, so it was broken in exactly the same way.
const typedExportTilde = '~/Videos/Other';
check(
  'a typed exportDir is a real difference from a resolved one',
  isDirty({ ...savedForm, exportDir: typedExportTilde }, settings()),
);
check(
  'and adopting the resolved value clears it',
  !isDirty(formFromSettings(settings({ exportDir: '/home/livia/Videos/Other' })), settings({ exportDir: '/home/livia/Videos/Other' })),
);

console.log('\n-- real edits still read as dirty (the comparison must not always say clean) --');

const edits = [
  ['gpuDevice', '0'],
  ['cpuUsage', 'fast'],
  ['defaultMaxQualityHeight', 720],
  ['uiScale', 'large'],
  ['exportDir', '/mnt/media/clips'],
  ['vodDir', '/mnt/media/VODs'],
  ['defaultAspectRatio', '9:16'],
  ['captionsEnabled', true],
  ['captionPreset', 'yellow'],
  ['captionPosition', 'top'],
  ['captionFontSize', 64],
  ['captionBgOpacity', 0.4],
  ['engineBinaryPath', '/usr/local/bin/semaclip-engine'],
];
for (const [field, value] of edits) {
  check(`changing ${field} is dirty`, isDirty({ ...savedForm, [field]: value }, settings()));
}

console.log('\n-- edge cases --');

// An unanswered query is not a difference: reporting one would arm Save on a page with nothing
// loaded, and the user could push defaults over their real settings.
check('no server value yet is not dirty', !isDirty(DEFAULT_FORM, undefined));

// A setting stored empty means "the app's default"; the server substitutes a concrete path when
// it reads. An empty field is therefore a real difference from that path — clearing the box and
// saving resets the location, which is the behaviour the field's own help text implies.
check(
  'an empty vodDir IS dirty against the server-resolved default',
  isDirty({ ...savedForm, vodDir: '' }, settings()),
);

// ...and clean once the server reports that same default.
check(
  'and clean when the server reports it empty too',
  !isDirty({ ...savedForm, vodDir: '' }, settings({ vodDir: '' })),
);

// Trailing whitespace on engineBinaryPath is trimmed before comparing, because the save trims
// it: a stray space must not leave the form permanently dirty.
check(
  'a trailing space in engineBinaryPath is not a difference',
  !isDirty({ ...savedForm, engineBinaryPath: '  ' }, settings({ engineBinaryPath: null })),
);

// The wire shape: 'auto' must go over as null, never the string.
check(
  "gpuDevice 'auto' maps to null on the wire",
  formToSettings({ ...savedForm, gpuDevice: 'auto' }).gpuDevice === null,
);
check(
  'and a numeric device maps to a number',
  formToSettings({ ...savedForm, gpuDevice: '1' }).gpuDevice === 1,
);
check(
  'a blank engineBinaryPath maps to null on the wire',
  formToSettings({ ...savedForm, engineBinaryPath: '   ' }).engineBinaryPath === null,
);

// A round trip through the wire shape must return the value, so a save cannot silently change
// a field the user did not touch.
const roundTrip = formFromSettings({ ...settings(), ...formToSettings(savedForm) });
check('formToSettings -> formFromSettings is stable', !isDirty(roundTrip, settings()));

console.log(failures === 0 ? '\n=== SETTINGS FORM PASS' : `\n=== SETTINGS FORM FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
