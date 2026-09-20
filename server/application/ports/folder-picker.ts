/**
 * The OS folder chooser.
 *
 * ── WHY THIS IS A SPAWNED PROCESS AND NOT AN API CALL ─────────────────────────────────────
 * The runtime has NO dialog API. Measured on the shipped payload: the `op_desktop_*` set is
 * alert / confirm / prompt / clipboard / notifications, and nothing else — there is no
 * `showOpenDialog`. So the chooser is either the platform's own tool or our own helper.
 *
 * ── WHY NOT xdg-desktop-portal ON LINUX ───────────────────────────────────────────────────
 * It was implemented first and is not usable from a one-shot process. MEASURED: the request
 * object `FileChooser.OpenFile` returns belongs to the CALLER's D-Bus connection
 * (`/org/freedesktop/portal/desktop/request/1_754/<token>`), so when the calling process exits
 * the request is gone — `Request.Close` answered `UnknownMethod: Object does not exist` and no
 * Response was ever delivered. Staying connected for the dialog's lifetime needs a D-Bus
 * binding this app does not have (no PyGObject, no dbus-python) or a compiled helper.
 * `gdbus monitor` cannot see the Response either: it sees broadcasts, and Response is UNICAST.
 *
 * ── WHAT IT IS ────────────────────────────────────────────────────────────────────────────
 *   Linux:   `zenity`, then `yad` — both are the desktop's GTK FileChooser, so the places
 *            sidebar (mounted external drives, network shares, bookmarks) is there.
 *   Windows: a small STA helper driving the MODERN `IFileOpenDialog` + `FOS_PICKFOLDERS`
 *            (not the classic tree-only `FolderBrowserDialog`), emitted from the app's own
 *            embedded files so the payload needs no extra build input.
 *
 * Both halves were verified on their platform: the Linux path returned a real directory from
 * a real click, and the Windows path returned the expected path with the dialog's own capture
 * confirming it was the modern chooser.
 *
 * ── THE CONTRACT ──────────────────────────────────────────────────────────────────────────
 * `pick()` returns the chosen absolute path, or null when the user CANCELLED. A cancel and a
 * failure are different answers and must never be confused: cancelling is a decision, and
 * reporting it as an error (or falling through to the next mechanism, which would open a
 * SECOND dialog after the user just declined one) is exactly the kind of dishonesty this
 * codebase forbids. `source` names the mechanism that answered.
 */
export interface FolderPickResult {
  path: string | null;
  /** Which mechanism answered: "zenity" | "yad" | "windows-dialog", or a failure reason. */
  source: string;
  /** True when the user cancelled — a real answer, not an error. */
  cancelled: boolean;
  /** Set when the picker could not run at all (no mechanism available, spawn failure). */
  error: string | null;
}

export interface FolderPickerPort {
  /** Open the OS chooser. `initialDir` positions it when the mechanism supports that. */
  pick(opts?: { title?: string; initialDir?: string | null }): Promise<FolderPickResult>;
  /** True when a mechanism exists on this system. */
  available(): Promise<boolean>;
}
