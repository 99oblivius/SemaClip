/**
 * The export filename renderer — a re-export of the SHARED implementation.
 *
 * ── WHY THIS FILE IS NOW ALMOST EMPTY ───────────────────────────────────────────────────────
 * This module used to be the owner. It could not stay the owner once the SERVER had to render the
 * same template: the server cannot import a path that only resolves inside the frontend's bundler,
 * and a second copy of the rule is exactly how two sides drift apart.
 *
 * The bug that forced the move: the page rendered the template for its own preview but sent the RAW
 * TEMPLATE STRING to the server, which wrote it literally. Every export was named
 * `date---channel---name---ts.mp4`, so three exports of three different clips produced ONE file that
 * overwrote itself. The server now renders what it is handed, through this same function.
 *
 * The implementation lives in `shared/types.ts`, which BOTH sides already import. This file remains
 * so the page's imports keep reading the way they did.
 */
export {
  FILENAME_TOKENS,
  looksLikeFilenameTemplate,
  renderFilenameTemplate,
} from "$shared/types";
export type { FilenameFacts, FilenameToken } from "$shared/types";
