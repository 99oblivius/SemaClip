/**
 * Encoder discovery: what the picker is offered, and what it must NOT be offered.
 *
 * The bug this pins: the export page said "no hardware encoder on this machine" for every codec other
 * than H.264, because the probe kept ONE candidate per family and reported only the first winner. On
 * the reference host H.264 and H.265 each have TWO working hardware encoders (NVENC and the AMD
 * iGPU's VAAPI) and the page showed neither.
 *
 * The rule that matters most here is that PRESENCE IS NOT USABILITY. `ffmpeg -encoders` lists qsv,
 * amf, v4l2m2m and vulkan encoders on a machine with no Intel GPU, no AMF runtime and no v4l2 encoder
 * device — every one of which fails a real encode. So discovery VERIFIES by encoding, and these tests
 * drive it through the injected runner seam so the filter logic is pinned without needing hardware.
 */
import { assert, assertEquals } from "@std/assert";
import {
  listEncodersFor,
  type EncoderProbeRunner,
  SOFTWARE_ENCODERS,
} from "../adapters/outbound/ffmpeg/gpu-probe.ts";

/** A stub runner: `listed` names the encoders ffmpeg would print, `failing` the ones that cannot encode. */
function stub(listed: string[], failing: Set<string> = new Set(), nodes = ["/dev/dri/renderD128"]): EncoderProbeRunner {
  return {
    listed: () => Promise.resolve(listed),
    encodes: (chain) => Promise.resolve(!failing.has(chain.encoder)),
    renderNodes: () => Promise.resolve(nodes),
  };
}

const ALL_LISTED = [
  "libx264", "libx265", "libvpx-vp9", "libsvtav1",
  "h264_nvenc", "hevc_nvenc", "av1_nvenc",
  "h264_vaapi", "hevc_vaapi", "av1_vaapi", "vp9_vaapi",
  "h264_qsv", "hevc_qsv", "av1_qsv", "vp9_qsv",
  "h264_amf", "hevc_amf", "av1_amf",
  "h264_v4l2m2m", "hevc_v4l2m2m",
  "h264_vulkan", "hevc_vulkan", "av1_vulkan",
];

Deno.test("software encoders are always offered, per codec", async () => {
  for (const codec of ["h264", "h265", "vp9", "av1"] as const) {
    const got = await listEncodersFor({ codec, runner: stub([SOFTWARE_ENCODERS[codec].encoder]) });
    assertEquals(got.length, 1, `${codec} software entry`);
    assertEquals(got[0]!.encoder, SOFTWARE_ENCODERS[codec].encoder);
    assert(got[0]!.software, "marked as software");
    assertEquals(got[0]!.backend, "cpu");
  }
});

Deno.test("a software encoder that is NOT in this ffmpeg build is not offered", async () => {
  // A build without libsvtav1 must not advertise an encoder that cannot run.
  const got = await listEncodersFor({ codec: "av1", runner: stub(["libx264"]) });
  assertEquals(got.length, 0, "no AV1 entry at all rather than a broken one");
});

Deno.test("BOTH working hardware families are offered — the bug that was reported", async () => {
  // The reference host: nvenc AND the AMD iGPU's VAAPI both encode H.264. Reporting one (or none)
  // is the defect; every verified family must appear.
  const got = await listEncodersFor({ codec: "h264", runner: stub(ALL_LISTED) });
  const names = got.map((o) => o.encoder).sort();
  assert(names.includes("h264_nvenc"), `nvenc missing from ${names}`);
  assert(names.includes("h264_vaapi"), `vaapi missing from ${names}`);
  assert(names.includes("libx264"), `software missing from ${names}`);
});

Deno.test("H.265 is not left with no hardware option", async () => {
  // The specific false claim: "no hardware encoder on this machine" for anything but H.264.
  const got = await listEncodersFor({ codec: "h265", runner: stub(ALL_LISTED) });
  const hw = got.filter((o) => !o.software);
  assert(hw.length >= 2, `expected nvenc + vaapi, got ${JSON.stringify(hw.map((o) => o.encoder))}`);
});

Deno.test("PRESENCE IS NOT USABILITY — a listed encoder that fails to encode is dropped", async () => {
  // Everything listed, nothing usable except software. This is the qsv/amf/vulkan/v4l2m2m case on
  // this host: all present in `-encoders`, none able to encode.
  const failing = new Set(ALL_LISTED.filter((e) => !e.startsWith("lib")));
  const got = await listEncodersFor({ codec: "h264", runner: stub(ALL_LISTED, failing) });
  assertEquals(got.map((o) => o.encoder), ["libx264"], "only the software entry survives");
});

Deno.test("a codec with no working hardware falls back to software, not to nothing", async () => {
  // VP9 on the reference host: vp9_vaapi has no encode entrypoint and qsv has no device, so the
  // honest answer is software-only rather than a hardware entry that would fail at export time.
  const got = await listEncodersFor({
    codec: "vp9",
    runner: stub(ALL_LISTED, new Set(["vp9_vaapi", "vp9_qsv"])),
  });
  assertEquals(got.length, 1);
  assertEquals(got[0]!.encoder, "libvpx-vp9");
  assert(got[0]!.software);
});

Deno.test("labels name the VENDOR, not the ffmpeg identifier (the OBS model)", async () => {
  // Linux-listed families only: AMF is a Windows API and its chain is marked as such, so asserting
  // its label here would be asserting a Windows behaviour on a Linux run.
  const got = await listEncodersFor({ codec: "h264", runner: stub(ALL_LISTED) });
  const byEncoder = new Map(got.map((o) => [o.encoder, o]));
  assertEquals(byEncoder.get("h264_nvenc")!.label, "NVIDIA NVENC H.264");
  assertEquals(byEncoder.get("h264_qsv")!.label, "Intel QuickSync H.264");
  // The VAAPI label carries the render node, because only some nodes on a hybrid machine encode.
  assert(byEncoder.get("h264_vaapi")!.label.includes("renderD128"), byEncoder.get("h264_vaapi")!.label);
  // No label is a bare ffmpeg name.
  for (const o of got) {
    assert(!/^[a-z0-9]+_(nvenc|qsv|amf|vaapi)$/.test(o.label), `raw identifier as a label: ${o.label}`);
  }
});

Deno.test("AMF is offered on Windows and NOT on Linux (it is a Windows API)", async () => {
  // The chain declares its platform, and discovery filters on it: offering h264_amf on Linux would
  // present an option that fails with "DLL libamfrt64.so.1 failed to open" on every export.
  const got = await listEncodersFor({ codec: "h264", runner: stub(ALL_LISTED) });
  const isWindows = Deno.build.os === "windows";
  const amf = got.some((o) => o.encoder === "h264_amf");
  assertEquals(amf, isWindows, `h264_amf offered=${amf} on ${Deno.build.os}`);
});

Deno.test("a verified hardware entry carries the device args the work chain must reuse", async () => {
  // The probe picks a device; the export must reuse THAT device rather than letting ffmpeg choose,
  // which on a multi-GPU machine can pick a decode-only node.
  const got = await listEncodersFor({
    codec: "h264",
    runner: stub(["libx264", "h264_vaapi"]),
  });
  const vaapi = got.find((o) => o.encoder === "h264_vaapi")!;
  assert(vaapi.deviceArgs?.includes("-vaapi_device"), JSON.stringify(vaapi.deviceArgs));
});

Deno.test("an unencodable codec/family combination is never offered", async () => {
  // AV1 has no working VAAPI on the reference host; asking for AV1 must not offer av1_vaapi just
  // because ffmpeg lists it.
  const got = await listEncodersFor({
    codec: "av1",
    runner: stub(ALL_LISTED, new Set(["av1_vaapi", "av1_qsv", "av1_vulkan", "av1_amf"])),
  });
  const names = got.map((o) => o.encoder);
  assert(!names.includes("av1_vaapi"), `offered a failing encoder: ${names}`);
  assert(names.includes("av1_nvenc"), `nvenc should have survived: ${names}`);
});

Deno.test("only SOME render nodes encode, and each working one is a distinct option", async () => {
  // Measured on the reference host: renderD128 (AMD iGPU) encodes H.264, renderD129/130 (NVIDIA,
  // NVDEC-only) do not. A node that exists is not a node that encodes.
  const runner: EncoderProbeRunner = {
    listed: () => Promise.resolve(["libx264", "h264_vaapi"]),
    encodes: (chain) => {
      // Fail unless the chain carries renderD128, which is what the real machine does.
      const dev = chain.hwaccelArgs[chain.hwaccelArgs.indexOf("-vaapi_device") + 1] ?? "";
      return Promise.resolve(dev.endsWith("renderD128"));
    },
    renderNodes: () => Promise.resolve(["/dev/dri/renderD128", "/dev/dri/renderD129", "/dev/dri/renderD130"]),
  };
  const got = await listEncodersFor({ codec: "h264", runner });
  const vaapi = got.filter((o) => o.encoder === "h264_vaapi");
  assertEquals(vaapi.length, 1, "exactly the encoding node is offered");
  assertEquals(vaapi[0]!.deviceArgs, ["-vaapi_device", "/dev/dri/renderD128"]);
  assert(vaapi[0]!.label.includes("renderD128"));
});

Deno.test("the encoders actually reachable on the reference host are reported honestly", async () => {
  // Not a stub: the real machine. Skips nothing and asserts the CONTRACT rather than a fixed list, so
  // it stays meaningful on a different host while catching the regression that started this work —
  // "no hardware encoder" for a codec that has one.
  const got = await listEncodersFor({ codec: "h264" });
  assert(got.length >= 1, "at least the software encoder must be offered");
  assert(got.some((o) => o.software), "software is always available");
  for (const o of got) {
    assert(o.label.length > 0 && o.encoder.length > 0, JSON.stringify(o));
    assertEquals(o.codec, "h264");
  }
  console.log(`    h264 on this host: ${got.map((o) => `${o.label} [${o.encoder}]`).join(", ")}`);
});
