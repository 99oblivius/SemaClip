/**
 * User-entered path resolution.
 *
 * Paths a user TYPES (or a folder picker returns) are not paths the app can use as-is:
 *
 *   - `~/Videos/SemaClip` is a literal tilde to the OS. `exportDir` has stored that exact
 *     string as its default since it was added and nothing ever expanded it, so the export
 *     directory was a relative path named `~` under the process's working directory.
 *     Whether that worked depended on the CWD, which is why it looked fine.
 *   - A relative path is worse than useless here: it resolves against whatever directory the
 *     app was launched from, so the same project lands in different places on two launches.
 *     This is a desktop tool started by a shell, a desktop entry, or an AppImage, and those
 *     CWDs differ — which is why the fix is to refuse relatives rather than to resolve them.
 *
 * The rule is: expand `~`, require an absolute path, unify separators, drop the trailing one.
 * Nothing here touches the filesystem, so an unusable value never reaches `ensureDir` and the
 * rule is unit-testable.
 */

/** Host separator. Anything that LEAVES this process (a spawn, a shell, the OS) needs it. */
export function separator(): string {
  return Deno.build.os === "windows" ? "\\" : "/";
}

/** The user's home directory, or null when the platform does not report one. */
export function homeDir(): string | null {
  if (Deno.build.os === "windows") {
    const profile = Deno.env.get("USERPROFILE");
    if (profile && profile.trim().length > 0) return profile.trim();
    const drive = Deno.env.get("HOMEDRIVE");
    const path = Deno.env.get("HOMEPATH");
    if (drive && path) return `${drive}${path}`;
    return null;
  }
  const home = Deno.env.get("HOME");
  return home && home.trim().length > 0 ? home.trim() : null;
}

/** Is this an absolute path ON THIS PLATFORM? (A POSIX-style "/x" is not one on Windows.) */
export function isAbsolutePath(path: string): boolean {
  if (Deno.build.os === "windows") {
    return /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path);
  }
  return path.startsWith("/");
}

/**
 * Resolve a user-supplied path to an absolute, host-separated path.
 *
 * Throws with a message naming exactly what is wrong: the caller shows it to the user, and
 * silently substituting a default directory would put their downloads somewhere they did not
 * choose.
 */
export function resolveUserPath(input: string): string {
  const raw = (input ?? "").trim();
  if (raw.length === 0) throw new Error("Path is empty.");

  const sep = separator();
  let path = raw;

  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
    const home = homeDir();
    if (!home) throw new Error(`Cannot expand "~": this system does not report a home directory.`);
    path = path.length === 1 ? home : `${home}${path.slice(1)}`;
  } else if (path.startsWith("~")) {
    // `~otheruser/...` would need a passwd lookup; refuse rather than guess.
    throw new Error(`Only "~" (your own home) can be expanded, not "${raw}".`);
  }

  if (!isAbsolutePath(path)) {
    throw new Error(
      `"${raw}" is not an absolute path — it would resolve against the app's launch directory.`,
    );
  }

  // One separator, and no trailing one: a trailing separator survives into string
  // concatenation and yields "dir//name" — the class of bug that made `explorer.exe` fail
  // on a mixed-separator path.
  const unified = path.replace(/[\\/]+/g, sep);
  const stripped = Deno.build.os === "windows"
    ? unified.replace(/\\+$/, "")
    : unified.replace(/\/+$/, "");
  return stripped.length > 0 ? stripped : sep;
}
