import type { EventBus, SettingsRepository } from "@/application/ports/outbound.ts";
import type { AppSettings } from "shared/types";

const SETTINGS_KEY = "app";

export const DEFAULT_SETTINGS: AppSettings = {
  gpuDevice: null,
  exportDir: "~/Videos/SemaClip",
  defaultAspectRatio: "16:9",
  defaultCaptions: {
    enabled: false,
    preset: "bold-white",
    position: "bottom",
    fontSize: 48,
    backgroundOpacity: 0.8,
  },
  engineBinaryPath: null,
  cpuUsage: "medium",
  defaultMaxQualityHeight: 1080,
  uiScale: "medium",
};

/** Worker budget per tier: fraction of total cores usable by workers. */
export const CPU_USAGE_FRACTION: Record<AppSettings["cpuUsage"], number> = {
  slow: 0.25,
  medium: 0.5,
  fast: 1.0,
};

/** Worker count for a tier: ceil(cores × fraction), ≥1. */
export function cpuWorkers(tier: AppSettings["cpuUsage"], totalCores: number): number {
  return Math.max(1, Math.floor(totalCores * CPU_USAGE_FRACTION[tier]));
}

/**
 * Memory ceiling for transcription workers (the 2026-09-09 incident: 16
 * whisper workers × full-VOD decode paged a 64GB machine). Per-worker RSS
 * ≈ model + whisper state + decoded audio; after the per-chunk WAV-slice
 * fix a worker holds ~modelSize + model state + slice (~350MB for base-q5),
 * but the cap keeps a misconfigured model or huge chunk budget from
 * repeating the failure regardless.
 */
export const TRANSCRIBE_WORKER_MEM_BUDGET = 0.5; // fraction of total RAM whisper workers may use
export const TRANSCRIBE_WORKER_MEM_FLOOR = 1; // always allow at least one worker

/** Clamp worker count so estimated per-worker RSS fits the memory budget.
 *  perWorkerBytes: caller-provided estimate (model + chunk PCM + overhead). */
export function memoryCappedWorkers(
  requested: number,
  totalMemBytes: number,
  perWorkerBytes: number,
): number {
  if (perWorkerBytes <= 0) return requested;
  const budget = totalMemBytes * TRANSCRIBE_WORKER_MEM_BUDGET;
  const capped = Math.floor(budget / perWorkerBytes);
  return Math.max(TRANSCRIBE_WORKER_MEM_FLOOR, Math.min(requested, capped));
}

/** Shallow-merges a persisted/incoming partial onto defaults, dropping unknown
 *  keys so a stale client can't pollute the shape. */
function coerce(raw: unknown): AppSettings {
  const base: AppSettings = structuredClone(DEFAULT_SETTINGS);
  if (typeof raw !== "object" || raw === null) return base;
  const o = raw as Record<string, unknown>;
  if (o.gpuDevice === null || typeof o.gpuDevice === "number") base.gpuDevice = o.gpuDevice as number | null;
  if (typeof o.exportDir === "string") base.exportDir = o.exportDir;
  if (o.defaultAspectRatio === "16:9" || o.defaultAspectRatio === "9:16" || o.defaultAspectRatio === "1:1") {
    base.defaultAspectRatio = o.defaultAspectRatio;
  }
  if (typeof o.defaultCaptions === "object" && o.defaultCaptions !== null) {
    const c = o.defaultCaptions as Record<string, unknown>;
    if (typeof c.enabled === "boolean") base.defaultCaptions.enabled = c.enabled;
    if (c.preset === "bold-white" || c.preset === "yellow" || c.preset === "custom") base.defaultCaptions.preset = c.preset;
    if (c.position === "bottom" || c.position === "top") base.defaultCaptions.position = c.position;
    if (typeof c.fontSize === "number" && c.fontSize > 0) base.defaultCaptions.fontSize = c.fontSize;
    if (typeof c.backgroundOpacity === "number" && c.backgroundOpacity >= 0 && c.backgroundOpacity <= 1) {
      base.defaultCaptions.backgroundOpacity = c.backgroundOpacity;
    }
  }
  if (o.engineBinaryPath === null || typeof o.engineBinaryPath === "string") {
    base.engineBinaryPath = o.engineBinaryPath as string | null;
  }
  if (o.cpuUsage === "slow" || o.cpuUsage === "medium" || o.cpuUsage === "fast") {
    base.cpuUsage = o.cpuUsage;
  }
  if (o.defaultMaxQualityHeight === null || typeof o.defaultMaxQualityHeight === "number") {
    base.defaultMaxQualityHeight = o.defaultMaxQualityHeight as number | null;
  }
  // Validate against the known steps rather than accepting any string: the
  // frontend indexes UI_SCALE_FACTOR with this, so an unknown value would render
  // at the default while the settings screen showed something else.
  if (o.uiScale === "small" || o.uiScale === "medium" || o.uiScale === "large") {
    base.uiScale = o.uiScale;
  }
  return base;
}

/**
 * App settings — persisted to the `settings` table (v1 kept them in memory;
 * every restart reset the user's GPU selection and export dir).
 * `update` publishes to the bus so live consumers can react; whether a setting
 * applies to already-running processes is each consumer's contract.
 */
export class SettingsUseCase {
  constructor(private readonly repo: SettingsRepository, private readonly bus: EventBus) {}

  async get(): Promise<AppSettings> {
    const raw = await this.repo.get(SETTINGS_KEY);
    if (raw === null) return structuredClone(DEFAULT_SETTINGS);
    try {
      return coerce(JSON.parse(raw));
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  async update(partial: Record<string, unknown>): Promise<AppSettings> {
    const current = await this.get();
    const next = coerce({ ...current, ...partial });
    await this.repo.set(SETTINGS_KEY, JSON.stringify(next));
    this.bus.publish("settings:changed", next);
    return next;
  }
}