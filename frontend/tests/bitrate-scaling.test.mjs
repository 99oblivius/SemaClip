/**
 * The export bitrate suggestion scales with PIXEL RATE, per codec.
 *
 * This exists because the answer to "are the preset bitrates hardcoded for 1080p?" must stay no. The
 * numbers were once keyed on HEIGHT alone, which gave H.264, H.265, VP9 and AV1 the same figure and
 * ignored frame rate entirely; these assertions fail if that ever comes back.
 *
 * The EXPONENT (0.75) is a VMAF-matched measurement over five resolutions and a 16x pixel-rate span —
 * see the derivation in `shared/types.ts`. What is asserted here is the SHAPE, not the constant, so a
 * future re-measurement can change the number without rewriting these.
 */
import { strict as assert } from 'node:assert';
import { sensibleBitrateKbps } from '../../shared/types.ts';

// A 4x pixel rate must NOT mean 4x the bits: bpp falls as resolution rises.
const k1080 = sensibleBitrateKbps('h264', 1920, 1080, 60);
const k540 = sensibleBitrateKbps('h264', 960, 540, 60);
const quadrupleRatio = k1080 / k540;
assert.ok(
  quadrupleRatio > 1.6 && quadrupleRatio < 3.4,
  `4x pixel rate moved the suggestion ${quadrupleRatio.toFixed(2)}x — a value at/below ~1.6 is a ` +
  `hardcode, at/above ~3.4 means the exponent regressed to linear: ${quadrupleRatio}`,
);

// Frame rate is a real input, not decoration.
assert.ok(
  sensibleBitrateKbps('h264', 1920, 1080, 60) > sensibleBitrateKbps('h264', 1920, 1080, 30),
  '60fps must suggest more than 30fps at the same resolution',
);

// Monotonic across the useful range, and it must never invert.
const rungs = [[320, 180], [480, 270], [640, 360], [960, 540], [1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]];
const values = rungs.map(([w, h]) => sensibleBitrateKbps('h264', w, h, 60));
for (let i = 1; i < values.length; i++) {
  assert.ok(
    values[i] > values[i - 1],
    `${rungs[i][0]}x${rungs[i][1]} (${values[i]}) must exceed ${rungs[i - 1][0]}x${rungs[i - 1][1]} (${values[i - 1]})`,
  );
}

// 4K must be a sensible ceiling for a real deliverable, not a floor or an absurdity.
const k4k = sensibleBitrateKbps('h264', 3840, 2160, 60);
assert.ok(k4k > 6000 && k4k < 60000, `4K60 H.264 suggestion out of range: ${k4k}`);

// Per codec: H.265/VP9/AV1 buy size, so each must come in UNDER H.264 at the same resolution.
for (const codec of ['h265', 'vp9', 'av1']) {
  const v = sensibleBitrateKbps(codec, 1920, 1080, 60);
  assert.ok(v < k1080, `${codec} (${v}) must be below H.264 (${k1080}) at equal resolution`);
}

// Degenerate inputs must not produce a zero/NaN bitrate — a 0 would emit `-b:v 0k`.
for (const [w, h] of [[0, 0], [1, 1]]) {
  const v = sensibleBitrateKbps('h264', w, h, 60);
  assert.ok(Number.isFinite(v) && v >= 300, `${w}x${h} produced ${v}`);
}
assert.ok(Number.isFinite(sensibleBitrateKbps('h264', 1920, 1080, 0)), 'fps 0 must not yield NaN');

console.log('PASS bitrate scales per pixel rate and per codec (not a 1080p hardcode)');
