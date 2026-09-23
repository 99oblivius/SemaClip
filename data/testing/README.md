# Testing Data

This directory was intended as a held-out set used exclusively for evaluation: data
placed here should not be used during model development, calibration, or parameter
tuning, so it can measure generalization.

**It is no longer a clean hold-out, and the docs should not pretend otherwise:**

- `fixtures/jfk.wav` (11s) is the fixture the engine end-to-end test runs on in CI
  (`server/tests/engine-e2e.test.ts`). It is shared test input, not evaluation data.
- the dense-chat slice (4.01 h, 17,473 chat comments) has already been used for Phase 1
  validation — ROADMAP.md's Phase 1 status cites it, and `detection/scripts/dense-run.ts`
  reads it by path. Its directory is named after the real channel locally and that name
  is deliberately not repeated here.

Treat any NEW data added here as held out. Do not cite those two entries as unseen.
