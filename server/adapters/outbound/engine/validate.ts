import type { Axis, ClipSignals, EngineEvent, EnginePhase } from "shared/types";
import { AXES } from "shared/types";

function isAxis(v: unknown): v is Axis {
  return typeof v === "string" && (AXES as readonly string[]).includes(v);
}

/**
 * Runtime validation of engine IPC payloads.
 *
 * The v1 adapter cast `JSON.parse(line) as EngineEvent` — the single gate on
 * the IPC boundary. Any engine/protocol drift propagated silently end-to-end.
 * Every inbound line now goes through parseEngineEvent; shapes that fail
 * validation are dropped with a counted protocol error instead of being
 * forwarded to the job pipeline with wrong-typed fields.
 *
 * Validation is structural (discriminator + required fields + numeric ranges),
 * not a schema-library dependency — the protocol is small and stable.
 */

export interface ProtocolError {
  line: string; // truncated
  reason: string;
}

const MAX_SIGNALS = 1e9;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function inRange01(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0 && v <= 1;
}

function hasString(v: unknown, key: string): boolean {
  return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>)[key] === "string";
}

function validateSignals(v: unknown): ClipSignals | null {
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  const keys: Array<keyof ClipSignals> = ["chatExcitement", "voicePitch", "emoteVelocity", "lurkerActivation"];
  for (const k of keys) {
    if (!inRange01(s[k])) return null;
  }
  return {
    chatExcitement: s.chatExcitement as number,
    voicePitch: s.voicePitch as number,
    emoteVelocity: s.emoteVelocity as number,
    lurkerActivation: s.lurkerActivation as number,
  };
}

function isEnginePhase(v: unknown): v is EnginePhase {
  return typeof v === "string";
}

function requireFields(
  o: Record<string, unknown>,
  fields: string[],
  types: Array<"string" | "number" | "object">,
): string | null {
  for (let i = 0; i < fields.length; i++) {
    const v = o[fields[i]!];
    const t = types[i]!;
    if (t === "number" && !isFiniteNumber(v)) return `missing/invalid ${fields[i]}`;
    if (t === "string" && typeof v !== "string") return `missing/invalid ${fields[i]}`;
    if (t === "object" && (typeof v !== "object" || v === null)) return `missing/invalid ${fields[i]}`;
  }
  return null;
}

/**
 * Parse and validate one NDJSON line as an EngineEvent.
 * Returns { ok: true, event } or { ok: false, reason }.
 * jobId presence is required on every variant (v1 protocol invariant).
 */
export function parseEngineEvent(line: string): { ok: true; event: EngineEvent } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "not an object" };
  const o = parsed as Record<string, unknown>;

  if (!hasString(o, "jobId")) return { ok: false, reason: "missing jobId" };
  if (typeof o.type !== "string") return { ok: false, reason: "missing type" };

  const jobId = o.jobId as string;

  switch (o.type) {
    case "progress": {
      const err = requireFields(o, ["phase", "percent"], ["string", "number"]);
      if (err) return { ok: false, reason: err };
      if (!isFiniteNumber(o.percent) || o.percent < 0 || o.percent > 1) {
        return { ok: false, reason: "percent out of [0,1]" };
      }
      if (!isEnginePhase(o.phase)) return { ok: false, reason: "invalid phase" };
      const event: EngineEvent = {
        type: "progress",
        jobId,
        phase: o.phase as EnginePhase,
        percent: o.percent as number,
        ...(typeof o.message === "string" ? { message: o.message } : {}),
      };
      return { ok: true, event };
    }
    case "segment": {
      const err = requireFields(o, ["start", "end", "regime"], ["number", "number", "string"]);
      if (err) return { ok: false, reason: err };
      return {
        ok: true,
        event: { type: "segment", jobId, start: o.start as number, end: o.end as number, regime: o.regime as string },
      };
    }
    case "candidate": {
      const err = requireFields(o, ["axis", "start", "end", "score"], ["string", "number", "number", "number"]);
      if (err) return { ok: false, reason: err };
      if (!isAxis(o.axis)) return { ok: false, reason: "invalid axis" };
      if (!inRange01(o.score)) return { ok: false, reason: "score out of [0,1]" };
      const signals = o.signals === undefined ? undefined : validateSignals(o.signals);
      if (o.signals !== undefined && !signals) return { ok: false, reason: "invalid signals" };
      return {
        ok: true,
        event: {
          type: "candidate",
          jobId,
          axis: o.axis,
          start: o.start as number,
          end: o.end as number,
          score: o.score as number,
          signals: signals!,
        },
      };
    }
    case "clip": {
      const err = requireFields(o, ["axis", "start", "end", "peak", "score"], ["string", "number", "number", "number", "number"]);
      if (err) return { ok: false, reason: err };
      if (!isAxis(o.axis)) return { ok: false, reason: "invalid axis" };
      if (!inRange01(o.score)) return { ok: false, reason: "score out of [0,1]" };
      const signals = o.signals === undefined ? undefined : validateSignals(o.signals);
      if (o.signals !== undefined && !signals) return { ok: false, reason: "invalid signals" };
      return {
        ok: true,
        event: {
          type: "clip",
          jobId,
          id: typeof o.id === "string" ? o.id : crypto.randomUUID(),
          axis: o.axis,
          start: o.start as number,
          end: o.end as number,
          peak: o.peak as number,
          score: o.score as number,
          justification: typeof o.justification === "string" ? o.justification : null,
          signals: signals!,
        },
      };
    }
    case "complete": {
      if (!isFiniteNumber(o.clipsFound) || (o.clipsFound as number) < 0 || (o.clipsFound as number) > MAX_SIGNALS) {
        return { ok: false, reason: "invalid clipsFound" };
      }
      return { ok: true, event: { type: "complete", jobId, clipsFound: o.clipsFound as number } };
    }
    case "error": {
      if (!hasString(o, "message")) return { ok: false, reason: "missing message" };
      const phase = isEnginePhase(o.phase) ? (o.phase as EnginePhase) : "audio_extraction";
      return { ok: true, event: { type: "error", jobId, phase, message: o.message as string } };
    }
    default:
      return { ok: false, reason: `unknown event type: ${String(o.type)}` };
  }
}

/**
 * Missing signals are not a protocol violation for engines that predate
 * signal emission — but fabricating zeros would lie in the UI. Callers decide:
 * JobUseCases persists a null-signal clip and the UI shows "no signal data".
 */