/**
 * The Windows folder-picker helper, checked as TEXT before it can ever reach Windows.
 *
 * Why this test exists: the helper's C# source is emitted from a TypeScript template, so
 * nothing in this repo's normal gates compiles it. Two defects got through that gap and were
 * only found by RUNNING the emitted script on the Windows VM:
 *
 *   1. `return '';` inside the C# body — an apostrophe pair is two empty CHARACTER literals in
 *      C#, not an empty string, so `Add-Type` failed with "Empty character literal" and the
 *      dialog never appeared. (The hand-written probe scripts compiled because they were
 *      authored directly as .ps1; the EMITTED template had to be tested.)
 *   2. A second site of the same thing in a ternary (`path == null ? '' : path`). Finding the
 *      first one did not find the second, which is why this test sweeps the whole C# body
 *      rather than grepping for a pattern a human thought of.
 *
 * It also pins the two properties that made the helper fragile on the VM:
 *   - the script must be ASCII-only. PowerShell 5.1 mis-parses a UTF-8 script without a BOM,
 *     and the failure points at the wrong line — an em-dash in the template shipped one.
 *   - the arguments the adapter passes must be the ones the script declares.
 */
import { assert, assertEquals } from "@std/assert";
import { FOLDER_PICKER_PS1 } from "@/adapters/outbound/platform/folder-picker-windows.ts";

/** The C# source only — the PowerShell below it legitimately uses '' for PS strings. */
function csharpBody(script: string): string {
  const start = script.indexOf("Add-Type -TypeDefinition @'");
  assert(start !== -1, "the helper must define its type with Add-Type");
  const end = script.indexOf("'@", start);
  assert(end !== -1, "the here-string must be terminated");
  return script.slice(start + "Add-Type -TypeDefinition @'".length, end);
}

Deno.test("helper: the C# body contains NO apostrophe-pair (C# empty charliteral)", () => {
  const body = csharpBody(FOLDER_PICKER_PS1);
  const offenders: string[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body.startsWith("''", i)) {
      offenders.push(body.slice(Math.max(0, i - 40), i + 40).replace(/\n/g, " | "));
    }
  }
  assertEquals(
    offenders,
    [],
    `'' is two empty character literals in C# and Add-Type refuses the whole script:\n${offenders.join("\n")}`,
  );
});

Deno.test("helper: the whole script is ASCII-only (PowerShell 5.1 parse hazard)", () => {
  const bad = [...FOLDER_PICKER_PS1].map((ch, i) => [i, ch] as const).filter(([, ch]) => ch.charCodeAt(0) > 127);
  assertEquals(
    bad.map(([i, ch]) => `@${i} U+${ch.charCodeAt(0).toString(16)} ${JSON.stringify(ch)}`),
    [],
    "a non-ASCII byte makes PowerShell 5.1 mis-parse the file and blame the wrong line",
  );
});

Deno.test("helper: declares the parameters the adapter passes", () => {
  // The adapter calls: -OutFile <path> -Title <t> [-InitialDir <dir>]. A parameter the script
  // does not declare is silently ignored by PowerShell, so the dialog would open anywhere and
  // the result would be lost — quietly, which is the worst way for this to fail.
  for (const param of ["$OutFile", "$InitialDir", "$Title"]) {
    assert(FOLDER_PICKER_PS1.includes(param), `the script must declare ${param}`);
  }
  // The result contract: the path goes to the FILE the adapter reads, not to stdout.
  assert(
    FOLDER_PICKER_PS1.includes("Set-Content -Path $OutFile"),
    "the chosen path must be written to -OutFile, which is where the adapter reads it",
  );
});

Deno.test("helper: uses the MODERN dialog, not the classic browser", () => {
  // The owner's requirement. CLSID_FileOpenDialog + FOS_PICKFOLDERS is the modern chooser;
  // SHBrowseForFolder / FolderBrowserDialog is the tree-only one it replaces.
  assert(FOLDER_PICKER_PS1.includes("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7"), "FileOpenDialog RCW");
  assert(FOLDER_PICKER_PS1.includes("0x20"), "FOS_PICKFOLDERS must be set, or it asks for a FILE");
  assert(!FOLDER_PICKER_PS1.includes("SHBrowseForFolder"), "the classic browser is not used");
});
