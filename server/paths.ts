/** Absolute repo root, resolved from this file's location (server/paths.ts → repo root is one level up). */
export const REPO_ROOT = new URL("../", import.meta.url).pathname;