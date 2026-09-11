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
