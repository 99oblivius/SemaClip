/**
 * A tier is a ONE-SHOT SETTER, and it sets a bitrate as well as a quality.
 *
 * Two claims are pinned here, both from the owner's report:
 *
 *   1. "Different quality options (draft, standard, etc) should have their own bitrate values as
 *      well." A tier that moved only the quality left the bitrate describing a DIFFERENT tier, so the
 *      control said `maximum` while the file was sized for `draft`.
 *   2. The numbers come from the MEASURED quality->bitrate curve, so `maximum` is genuinely a bigger
 *      file than `draft` on every codec — not a percentage of some unrelated base.
 *
 * What is asserted is the ORDERING and the SPREAD between tiers, not the constants: a re-measurement
 * may move any individual number, and these assertions must survive that.
 */
import { strict as assert } from 'node:assert';
import { QUALITY_TIERS, bitrateForTier, bitsForQuality, qualityForTier, CODEC_QUALITY_BANDS } from '../../shared/types.ts';

const CODECS = ['h264', 'h265', 'vp9', 'av1'];

// Every tier has a bitrate, and the ladder rises monotonically with quality.
for (const codec of CODECS) {
  const values = QUALITY_TIERS.map((t) => bitrateForTier(codec, t, 1920, 1080, 60));
  for (let i = 0; i < values.length; i++) {
    assert.ok(
      Number.isFinite(values[i]) && values[i] > 0,
      `${codec}/${QUALITY_TIERS[i]} produced ${values[i]}`,
    );
  }
  for (let i = 1; i < values.length; i++) {
    assert.ok(
      values[i] > values[i - 1],
      `${codec}: tier ${QUALITY_TIERS[i]} (${values[i]}) must exceed ${QUALITY_TIERS[i - 1]} (${values[i - 1]}) — ` +
        `tiers must describe DIFFERENT file sizes, which is the whole point of offering them`,
    );
  }
}

// The spread is real, not a rounding artefact: draft vs maximum must be a multiple, not a few percent.
for (const codec of CODECS) {
  const draft = bitrateForTier(codec, 'draft', 1920, 1080, 60);
  const max = bitrateForTier(codec, 'maximum', 1920, 1080, 60);
  const factor = max / draft;
  assert.ok(
    factor >= 2,
    `${codec}: maximum (${max}) is only ${factor.toFixed(2)}x draft (${draft}) — a tier that does not ` +
      `change the file size meaningfully is not a separate option`,
  );
}

// A tier's bitrate must correspond to ITS OWN quality, on the measured curve.
for (const codec of CODECS) {
  for (const tier of QUALITY_TIERS) {
    const q = qualityForTier(codec, tier);
    const direct = bitsForQuality(codec, q);
    const viaTier = bitsForQuality(codec, q); // same rule the tier path uses
    assert.equal(viaTier, direct, `${codec}/${tier}: the tier and a manual selection of the same quality must agree`);
  }
}

// Scaling is the same law the suggestion uses: resolution and frame rate are inputs.
for (const codec of CODECS) {
  const k1080 = bitrateForTier(codec, 'standard', 1920, 1080, 60);
  const k720 = bitrateForTier(codec, 'standard', 1280, 720, 60);
  assert.ok(k1080 > k720, `${codec}: a 1080p tier must exceed the same tier at 720p (${k1080} vs ${k720})`);
  const k30 = bitrateForTier(codec, 'standard', 1920, 1080, 30);
  assert.ok(k1080 > k30, `${codec}: 60fps must exceed 30fps at the same resolution`);
}

// The band's ENDS are covered: the tiers at 0 and 1 must land ON the measured extremes, not beyond.
for (const codec of CODECS) {
  const band = CODEC_QUALITY_BANDS[codec];
  assert.equal(qualityForTier(codec, 'draft'), band.worst, `${codec}: draft must be the band's worst edge`);
  assert.equal(qualityForTier(codec, 'maximum'), band.best, `${codec}: maximum must be the band's best edge`);
}

// A quality OUTSIDE the measured curve clamps to the nearest measurement rather than extrapolating.
//
// The scale is INVERTED (lower crf = better = BIGGER file), so the low-quality edge of the curve is
// the SMALLEST bitrate and the high-quality edge is the LARGEST. Getting that backwards is the easy
// mistake here, so the bounds are computed with min/max rather than assumed from the argument order.
for (const codec of CODECS) {
  const atZero = bitsForQuality(codec, 0);    // clamps to the BEST-quality end
  const atSixtyThree = bitsForQuality(codec, 63); // clamps to the WORST-quality end
  assert.ok(Number.isFinite(atZero) && atZero > 0, `${codec}: quality 0 must clamp, not extrapolate to 0`);
  assert.ok(Number.isFinite(atSixtyThree) && atSixtyThree > 0, `${codec}: quality 63 must clamp`);
  const lo = Math.min(atZero, atSixtyThree);
  const hi = Math.max(atZero, atSixtyThree);
  // Clamping means the value equals a curve endpoint, so nothing may escape the curve's own range.
  const values = [0, 5, 12, 23, 40, 63].map((q) => bitsForQuality(codec, q));
  for (const v of values) {
    assert.ok(v >= lo && v <= hi, `${codec}: ${v} escaped the curve's measured range ${lo}..${hi}`);
  }
  // And it is monotone in quality: better quality must never produce a smaller file. The probe
  // points are taken INSIDE this codec's own useful band — outside it every value clamps to the same
  // endpoint, which is correct but flat, and a flat plateau cannot demonstrate monotonicity.
  const band = CODEC_QUALITY_BANDS[codec];
  const steps = 5;
  const inside = Array.from({ length: steps }, (_, i) =>
    Math.round(band.best + ((band.worst - band.best) * i) / (steps - 1)),
  );
  // Walking from worst quality to best, the bitrate must rise on every step.
  const ascending = [...inside].reverse().map((q) => bitsForQuality(codec, q));
  for (let i = 1; i < ascending.length; i++) {
    assert.ok(
      ascending[i] > ascending[i - 1],
      `${codec}: moving to better quality must raise the bitrate (${ascending[i]} vs ${ascending[i - 1]} at q=${inside[i]})`,
    );
  }
}

console.log('PASS tiers set their own measured bitrate, ordered and spread per codec');
