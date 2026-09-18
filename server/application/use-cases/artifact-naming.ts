/**
 * Artifact file naming.
 *
 * Boilerplate names (`proxy.mp4`, `hq.mp4`, `video.mp4`) are opaque in a
 * folder the user browses, and several projects look identical at a glance.
 * Artifact names carry the project's own identity instead:
 *
 *   `{slug} - proxy.mp4`  /  `{slug} - video.mp4`  /  `{slug}.chat.json`
 *
 * Rules: filesystem-safe characters only, no whitespace, bounded length, and
 * NEVER a collision with a sibling artifact or an existing file. The slug is
 * derived from the stream title when one exists, else the streamer, else the
 * id prefix — so a folder always says what it holds.
 */

/** Max length of the slug portion, keeping room for the suffix. */
export const MAX_SLUG_LENGTH = 60;

/**
 * Reduce a title to a safe, stable, whitespace-free slug.
 * Keeps ASCII letters/digits and `-`/`_`, folds everything else to `-`.
 */
export function slugify(input: string): string {
  const base = (input ?? "")
    .normalize("NFKD")
    // Drop combining marks so accented titles fold to ASCII rather than '-'.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const trimmed = base.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
  return trimmed;
}

/**
 * The identity used in artifact filenames for a stream. Falls back through
 * title → streamer → id prefix so a name always exists, even for an untitled
 * import.
 */
export function streamSlug(stream: {
  id: string;
  title?: string | null | undefined;
  streamer?: string | null | undefined;
}): string {
  for (const candidate of [stream.title, stream.streamer]) {
    const slug = slugify(candidate ?? "");
    if (slug.length > 0) return slug;
  }
  return `stream-${stream.id.slice(0, 8)}`;
}

export type ArtifactRole = "video" | "proxy" | "chat" | "video-index" | "proxy-index";

/** Filename for an artifact role, given the project's slug. */
export function artifactName(role: ArtifactRole, slug: string): string {
  switch (role) {
    case "video":
      return `${slug} - video.mp4`;
    case "proxy":
      return `${slug} - proxy.mp4`;
    case "chat":
      return `${slug}.chat.json`;
    case "video-index":
      return `${slug} - video.fragments`;
    case "proxy-index":
      return `${slug} - proxy.fragments`;
  }
}

/**
 * The index sidecar for a media file: same name with `.fragments`.
 * Keeps the two in lockstep so a rename can never orphan an index.
 */
export function indexPathFor(mediaPath: string): string {
  return mediaPath.replace(/\.mp4$/i, ".fragments");
}

/** Legacy names still recognised when reading existing projects. */
export const LEGACY_NAMES: Record<ArtifactRole, string[]> = {
  video: ["video.mp4", "hq.mp4", "video.ts", "hq.ts"],
  proxy: ["proxy.mp4", "proxy.ts", "scrub.mp4", "scrub.ts"],
  chat: ["chat.json"],
  "video-index": ["video.fragments", "hq.fragments", "video.chunks", "hq.chunks"],
  "proxy-index": ["proxy.fragments", "proxy.chunks", "scrub.chunks"],
};

/**
 * The distinguishing tail of each role's canonical name.
 *
 * A role is identifiable from a filename ALONE — no slug, no download mode, no per-part
 * bookkeeping. This is what makes artifact identity stable: whichever artifact was downloaded
 * first, in whatever mode, and whatever the user subsequently did to the folder, `- video.mp4`
 * is the video and `- proxy.mp4` is the proxy.
 */
export const ROLE_SUFFIX: Record<ArtifactRole, string> = {
  video: " - video.mp4",
  proxy: " - proxy.mp4",
  chat: ".chat.json",
  "video-index": " - video.fragments",
  "proxy-index": " - proxy.fragments",
};

/**
 * Which file in a directory listing fills a given role, or null when the artifact is absent.
 *
 * Canonical project-named files win, then legacy boilerplate. When the slug is known the exact
 * name is preferred, which keeps a stray look-alike file from being adopted as this project's
 * artifact; without it the suffix still identifies the role unambiguously.
 *
 * Identity by role rather than by mode is load-bearing: an earlier revision decided which
 * artifact a file was from `includeProxy` and from which part the downloader happened to be
 * running, so a completed proxy was reported as the video, and reconciliation adopted
 * `- proxy.mp4` as the project's main video (a 540p file would then have been the export
 * source). Both are impossible when the name decides.
 */
export function findArtifact(
  role: ArtifactRole,
  names: readonly string[],
  slug?: string | null,
): string | null {
  const exact = new Map(names.map((n) => [n.toLowerCase(), n]));
  if (slug) {
    const canonical = exact.get(artifactName(role, slug).toLowerCase());
    if (canonical) return canonical;
  }
  const suffix = ROLE_SUFFIX[role].toLowerCase();
  const bySuffix = names.filter((n) => n.toLowerCase().endsWith(suffix)).sort()[0];
  if (bySuffix) return bySuffix;
  for (const legacy of LEGACY_NAMES[role]) {
    const hit = exact.get(legacy);
    if (hit) return hit;
  }
  return null;
}

/**
 * True when a PATH's filename fills the given role.
 *
 * Used to read states written before a file's slot said what it was: an older revision recorded
 * the project's single video in the `proxy` slot (the file itself was always `- video.mp4`), so a
 * reader that trusted the slot reported a completed proxy as the video, or lost the video
 * entirely. The filename is the durable fact, so it decides.
 */
export function pathFillsRole(path: string, role: ArtifactRole): boolean {
  const base = path.replace(/^.*[\\/]/, "");
  return findArtifact(role, [base], null) !== null;
}

/** Every name a role may occupy, canonical first — for deletion sweeps. */
export function candidateNames(role: ArtifactRole, slug: string): string[] {
  return [artifactName(role, slug), ...LEGACY_NAMES[role]];
}
