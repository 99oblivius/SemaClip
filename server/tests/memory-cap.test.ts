/**
 * memoryCappedWorkers: the 2026-09-09 paging incident regression suite —
 * CPU-tier worker counts must clamp against host memory.
 */
import { memoryCappedWorkers, cpuWorkers, TRANSCRIBE_WORKER_MEM_BUDGET } from "../application/use-cases/SettingsUseCase.ts";

Deno.test("memoryCappedWorkers: 64GB host, 350MB/worker → no clamp below CPU request", () => {
  const byCpu = cpuWorkers("medium", 32); // 16
  const capped = memoryCappedWorkers(byCpu, 64 * 1024 ** 3, 350 * 1024 ** 2);
  if (capped !== byCpu) throw new Error(`${capped} ≠ ${byCpu} — clamped a healthy config`);
});

Deno.test("memoryCappedWorkers: 8GB host clamps hard (the incident machine class)", () => {
  const byCpu = cpuWorkers("fast", 32); // 32
  const perWorker = 2.3 * 1024 ** 3; // the observed full-decode RSS
  const capped = memoryCappedWorkers(byCpu, 8 * 1024 ** 3, perWorker);
  if (capped > Math.floor((8 * 0.5) / 2.3)) throw new Error(`cap too loose: ${capped}`);
  if (capped < 1) throw new Error("no worker allowed — floor violated");
});

Deno.test("memoryCappedWorkers: budget math — 0.5 × mem ÷ perWorker", () => {
  const capped = memoryCappedWorkers(100, 20 * 1024 ** 3, 5 * 1024 ** 3);
  // 10GB budget ÷ 5GB/worker = 2
  if (capped !== 2) throw new Error(`${capped} ≠ 2`);
  if (TRANSCRIBE_WORKER_MEM_BUDGET !== 0.5) throw new Error("budget constant drifted");
});

Deno.test("memoryCappedWorkers: floor of 1 even on absurd per-worker estimates", () => {
  const capped = memoryCappedWorkers(16, 4 * 1024 ** 3, 100 * 1024 ** 3);
  if (capped !== 1) throw new Error(`floor violated: ${capped}`);
});

Deno.test("memoryCappedWorkers: non-positive estimate passes through unclamped", () => {
  if (memoryCappedWorkers(7, 8 * 1024 ** 3, 0) !== 7) throw new Error("0 estimate clamped");
  if (memoryCappedWorkers(7, 8 * 1024 ** 3, -1) !== 7) throw new Error("negative estimate clamped");
});