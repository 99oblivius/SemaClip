/** Client-side mirror of the server's download state (download-orchestrator.ts). */

export type DownloadPartKind = 'chat' | 'markers' | 'scrub' | 'hq';
export type DownloadPartStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface DownloadPart {
  kind: DownloadPartKind;
  status: DownloadPartStatus;
  percent: number;
  downloadedSec: number;
  totalSec: number;
  etaSec: number | null;
  error?: string;
}

export interface DownloadState {
  phase: 'idle' | 'running' | 'done' | 'failed';
  parts: DownloadPart[];
  overall: { percent: number; etaSec: number | null };
  scrubFrontierSec: number;
  scrubPath: string | null;
  hqPath: string | null;
  qualities: { name: string; width: number; height: number }[];
  startedAt: string | null;
}

export interface QualityInfo {
  name: string;
  width: number;
  height: number;
  fps: number;
  bandwidth: number;
}

/** "4:51" from seconds; null-safe. */
export function fmtEta(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m >= 60) return `${Math.floor(m / 60)}h${m % 60}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const PART_LABELS: Record<DownloadPartKind, string> = {
  chat: 'Chat',
  markers: 'Markers',
  scrub: 'Scrub (540p)',
  hq: 'High quality',
};