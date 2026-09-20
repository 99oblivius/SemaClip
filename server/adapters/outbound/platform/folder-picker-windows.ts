/**
 * The Windows folder chooser: the MODERN `IFileOpenDialog` with `FOS_PICKFOLDERS`.
 *
 * ── WHY NOT THE CLASSIC DIALOG ────────────────────────────────────────────────────────────
 * `SHBrowseForFolder` / `FolderBrowserDialog` is a tree-only dialog from an older era. The
 * modern chooser has the navigation pane, a breadcrumb address bar and a search box, and is
 * what the OS itself uses. Measured on the guest: the dialog that appeared carried all three
 * plus a "Select Folder" button, confirmed from a `PrintWindow` capture rather than assumed.
 *
 * ── HOW IT RUNS ───────────────────────────────────────────────────────────────────────────
 * A small C# helper compiled at runtime by `Add-Type` and run by powershell. It must be STA
 * for a modal shell dialog, and it must be spawned with `-ExecutionPolicy Bypass`: the default
 * policy refuses a script file that arrived from a share or a download (measured — the helper
 * died with "running scripts is disabled on this system").
 *
 * The helper reports the chosen path on stdout, nothing on cancel. The exit code alone cannot
 * carry that distinction, so the CONTRACT is: empty stdout + exit 0 = cancelled.
 *
 * `SHCreateItemFromParsingName` + `SetFolder` opens the dialog AT a given folder, so the
 * picker starts where the project already is. That path was verified on the guest: the dialog
 * opened at the supplied folder and returned it.
 *
 * ── WHERE THE SCRIPT COMES FROM ───────────────────────────────────────────────────────────
 * The app's own embedded files, exactly like the updater sidecar: `deno desktop --include`
 * embeds assets into the payload's virtual filesystem, which only this process can read. So
 * the script is written out to a real per-user path at pick time and executed from there —
 * the same delivery mechanism `sidecar.ts` documents, and the reason it works without adding
 * anything to the build.
 */
import { join } from "node:path";
import type { FolderPickerPort, FolderPickResult } from "@/application/ports/folder-picker.ts";
import { run } from "@/adapters/outbound/process/spawn.ts";

/** Where the embedded helper lives in the payload's virtual filesystem. */
const EMBEDDED = new URL("../../../appfiles/folder-picker.ps1", import.meta.url);

/** The script's own text, used when the payload carries no embedded copy (a dev run). */
export const FOLDER_PICKER_PS1 = String.raw`
param([string]$OutFile = '', [string]$InitialDir = '', [string]$Title = 'Choose a folder')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace SemaClipPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  internal class FileOpenDialogRCW { }
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IntPtr psi);
    void SetFolder([MarshalAs(UnmanagedType.Interface)] IShellItem psi);
    void GetFolder(out IntPtr ppsi);
    void GetCurrentSelection(out IntPtr ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IntPtr ppsi);
    void AddPlace(IntPtr psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close([MarshalAs(UnmanagedType.Error)] int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
  }
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IntPtr ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IntPtr psi, uint hint, out int piOrder);
  }
  public static class Picker {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid,
      [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);
    const uint FOS_PICKFOLDERS = 0x20;
    const uint FOS_FORCEFILESYSTEM = 0x40;
    const uint SIGDN_FILESYSPATH = 0x80058000;
    public static string Pick(string title, string initialDir) {
      var dlg = (IFileDialog)new FileOpenDialogRCW();
      uint opts;
      dlg.GetOptions(out opts);
      dlg.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
      if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);
      if (!string.IsNullOrEmpty(initialDir)) {
        Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
        IShellItem start = null;
        try { SHCreateItemFromParsingName(initialDir, IntPtr.Zero, ref iid, out start); } catch { start = null; }
        if (start != null) dlg.SetFolder(start);
      }
      int hr = dlg.Show(IntPtr.Zero);
      // C# needs a STRING literal here (two double quotes), never a pair of apostrophes.
      // The C# source lives inside a PowerShell here-string, so an apostrophe pair is NOT an
      // escaped string: it is two empty CHARACTER literals, and Add-Type fails with
      // "Empty character literal". Caught by RUNNING it on the VM: the hand-written probe scripts
      // compiled fine, and the emitted template did not (twice - the other site was a ternary).
      if (hr != 0) return "";
      IntPtr item;
      dlg.GetResult(out item);
      var shell = (IShellItem)Marshal.GetObjectForIUnknown(item);
      string path;
      shell.GetDisplayName(SIGDN_FILESYSPATH, out path);
      Marshal.ReleaseComObject(shell);
      Marshal.ReleaseComObject(dlg);
      return path == null ? "" : path;
    }
  }
}
'@
# STA is required for a modal shell dialog; -NonInteractive with a GUI thread would hang.
$result = [SemaClipPicker.Picker]::Pick($Title, $InitialDir)
if ($OutFile -ne '') {
  Set-Content -Path $OutFile -Value $result -Encoding UTF8 -NoNewline
} else {
  [Console]::Out.Write($result)
}
`;

export class WindowsFolderPicker implements FolderPickerPort {
  constructor(private readonly sidecarDir: string) {}

  available(): Promise<boolean> {
    // powershell.exe ships with Windows; there is no scenario where it is absent. The port is
    // async (the Linux adapter has to probe for its tools), so this answers with a resolved
    // promise rather than being marked `async` for a value it already has.
    return Promise.resolve(Deno.build.os === "windows");
  }

  /** Materialise the helper as a real file this process can execute. */
  private async scriptPath(): Promise<string> {
    const target = join(this.sidecarDir, "folder-picker.ps1");
    let text: string | null = null;
    try {
      // The embedded copy is preferred: it is the one the build shipped.
      text = await Deno.readTextFile(EMBEDDED);
    } catch {
      text = FOLDER_PICKER_PS1;
    }
    try {
      await Deno.mkdir(this.sidecarDir, { recursive: true });
      await Deno.writeTextFile(target, text);
    } catch (err) {
      throw new Error(
        `Could not write the folder picker helper to ${target}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return target;
  }

  async pick(opts?: { title?: string; initialDir?: string | null }): Promise<FolderPickResult> {
    if (Deno.build.os !== "windows") {
      return { path: null, source: "windows-dialog", cancelled: false, error: "Not a Windows system." };
    }
    let script: string;
    try {
      script = await this.scriptPath();
    } catch (err) {
      return {
        path: null,
        source: "windows-dialog",
        cancelled: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // A result FILE rather than stdout parsing: the dialog writes a path that may contain
    // spaces and non-ASCII characters, and reading a file avoids every quoting question.
    const outFile = join(this.sidecarDir, "folder-picker-result.txt");
    await Deno.remove(outFile).catch(() => {});

    const args = [
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy", "Bypass",
      "-File", script,
      "-OutFile", outFile,
      "-Title", opts?.title ?? "Choose a folder",
    ];
    const initial = opts?.initialDir?.trim();
    if (initial) args.push("-InitialDir", initial);

    const result = await run("powershell.exe", { args, showWindow: false });
    if (result.code === -1) {
      return { path: null, source: "windows-dialog", cancelled: false, error: "Could not start powershell.exe." };
    }

    const chosen = await Deno.readTextFile(outFile).then((t) => t.trim()).catch(() => "");
    await Deno.remove(outFile).catch(() => {});
    if (chosen) return { path: chosen, source: "windows-dialog", cancelled: false, error: null };
    if (result.code === 0) {
      // The dialog ran and the user declined. A real answer.
      return { path: null, source: "windows-dialog", cancelled: true, error: null };
    }
    const detail = new TextDecoder().decode(result.stderr).trim().split("\n").pop() ?? "";
    return {
      path: null,
      source: "windows-dialog",
      cancelled: false,
      error: `The folder dialog failed (exit ${result.code})${detail ? `: ${detail}` : ""}`,
    };
  }
}
