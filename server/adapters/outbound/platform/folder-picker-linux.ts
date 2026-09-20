/**
 * The Linux folder chooser: the desktop's own GTK FileChooser, via zenity or yad.
 *
 * Both are the same dialog the file manager opens, which is the requirement — the places
 * sidebar is where mounted external drives and network shares live, so the user can point a
 * project at any drive. See `application/ports/folder-picker.ts` for why the portal is not
 * used (it cannot work from a one-shot process: the request belongs to the caller's D-Bus
 * connection and dies with it — measured).
 *
 * Cancellation is a real answer. zenity and yad both exit 1 when the user declines, and that
 * must NOT fall through to the next tool: opening a second dialog after someone just declined
 * one is worse than doing nothing.
 */
import type { FolderPickerPort, FolderPickResult } from "@/application/ports/folder-picker.ts";
import { run } from "@/adapters/outbound/process/spawn.ts";

/** In order of preference. Both are GTK choosers; zenity is the more common install. */
const MECHANISMS = ["zenity", "yad"] as const;
const decode = (b: Uint8Array) => new TextDecoder().decode(b).trim();

export class LinuxFolderPicker implements FolderPickerPort {
  private resolved: string | null | undefined;

  /** The first mechanism present on PATH, or null. Resolved once and remembered. */
  private async mechanism(): Promise<string | null> {
    if (this.resolved !== undefined) return this.resolved;
    this.resolved = null;
    for (const candidate of MECHANISMS) {
      // `run` resolves (never rejects) with code -1 when the binary is missing, so absence is
      // a value here rather than an exception to catch.
      const probe = await run(candidate, { args: ["--version"] });
      if (probe.code !== -1) {
        this.resolved = candidate;
        break;
      }
    }
    return this.resolved;
  }

  async available(): Promise<boolean> {
    return (await this.mechanism()) !== null;
  }

  async pick(opts?: { title?: string; initialDir?: string | null }): Promise<FolderPickResult> {
    const tool = await this.mechanism();
    if (!tool) {
      return {
        path: null,
        source: "none",
        cancelled: false,
        error: "No folder chooser is available (install zenity or yad).",
      };
    }

    const title = opts?.title ?? "Choose a folder";
    const args = tool === "zenity"
      ? ["--file-selection", "--directory", `--title=${title}`]
      : ["--file", "--directory", `--title=${title}`];
    // Both treat the initial value as a path to select, so a directory must end in a
    // separator or the dialog filters for a file of that name instead of opening there.
    const initial = opts?.initialDir?.replace(/[\\/]+$/, "");
    if (initial) args.push(`--filename=${initial}/`);

    const result = await run(tool, { args });
    if (result.code === -1) {
      return { path: null, source: tool, cancelled: false, error: `Could not start ${tool}.` };
    }
    // 1 = cancelled (both tools), 0 = chosen, anything else = the tool itself failed.
    // Cancel is returned as a DECISION, never as an error and never by trying the next tool.
    if (result.code === 1) return { path: null, source: tool, cancelled: true, error: null };
    if (result.code !== 0) {
      const detail = decode(result.stderr).split("\n").pop() ?? "";
      return {
        path: null,
        source: tool,
        cancelled: false,
        error: `${tool} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`,
      };
    }
    const chosen = decode(result.stdout);
    if (!chosen) return { path: null, source: tool, cancelled: true, error: null };
    return { path: chosen, source: tool, cancelled: false, error: null };
  }
}
