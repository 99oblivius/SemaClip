/** Client-side mirror of the server's download state (download-orchestrator.ts). */

export type DownloadPartKind = 'chat' | 'markers' | 'proxy' | 'hq';
export type DownloadPartStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface DownloadPart {
  kind: DownloadPartKind;
  status: DownloadPartStatus;
  percent: number;
  downloadedSec: number;
  totalSec: number;
  /** Bytes of the artifact on disk so far (chat: comments fetched). */
  downloadedBytes: number;
  etaSec: number | null;
  error?: string;
}

export interface Artifact {
  onDisk: boolean;
  bytes: number;
  path: string | null;
}

export interface DownloadState {
  phase: 'idle' | 'running' | 'done' | 'failed';
  parts: DownloadPart[];
  overall: { percent: number; etaSec: number | null };
  proxyFrontierSec: number;
  proxyPath: string | null;
  hqPath: string | null;
  /** Playable mp4 twins of the .ts files (Chromium can't demux raw TS). */
  proxyMp4: string | null;
  hqMp4: string | null;
  qualities: { name: string; width: number; height: number }[];
  startedAt: string | null;
  /** Disk truth per artifact — computed fresh on every read server-side. */
  presence?: Partial<Record<'proxy' | 'hq' | 'chat', Artifact>>;
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
  proxy: 'Proxy',
  hq: 'High quality',
};
// ── Server-composed view model ──────────────────────────────────────────
// The server composes these (application/view/download-view.ts). Components
// render them verbatim — deriving "is a download happening", "is it on
// disk", or "which file is shared" locally is what produced the reported
// inconsistencies, so nothing here is re-computed in the UI.

export type ArtifactKind = 'chat' | 'proxy' | 'video';

export interface ArtifactView {
  kind: ArtifactKind;
  label: string;
  status: DownloadPartStatus;
  percent: number;
  etaSec: number | null;
  bytes: number;
  frontierSec: number | null;
  totalSec: number | null;
  /** A COMPLETE artifact exists — never true while it is still running. */
  onDisk: boolean;
  path: string | null;
  /** Other artifacts whose file IS this one (trash must respect it). */
  sharedWith: ArtifactKind[];
  error: string | null;
  downloadable: boolean;
  removable: boolean;
}

export interface DownloadView {
  streamId: string;
  phase: 'idle' | 'running' | 'done' | 'failed';
  /** ANY download happening — the single flag the UI keys off. */
  active: boolean;
  /** Server-composed status line ("video · 42%", "download complete"). */
  label: string;
  overall: { percent: number; etaSec: number | null };
  artifacts: ArtifactView[];
  media: {
    playablePath: string | null;
    /** True when only the proxy remains — exports are impossible. */
    previewOnly: boolean;
    frontierSec: number;
    durationSec: number | null;
  };
  metadata: {
    markers: { t: number; label: string; source: string }[] | null;
    chatCount: number;
  };
  revision: number;
  updatedAt: string;
}

/** Bytes as a short human string. */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/** True when a download should be shown as progress (not satisfied). */
export function isLive(view: DownloadView): boolean {
  return view.active || view.phase === 'failed';
}

/**
 * True when the Library should show a progress container for this project.
 *
 * ONLY work in flight or a failure belongs here. A project that simply has
 * nothing downloaded yet is not "in progress" — showing it produced a latent
 * 0%-everything container for an untouched project, and pressing its Delete
 * could not dismiss it (delete resets to idle, which is exactly that state).
 *
 * Re-downloading a missing artifact is NOT offered here by design: that is
 * project settings' job, where the per-artifact rows live.
 */
export function needsAttention(view: DownloadView): boolean {
  return view.active || view.phase === 'failed';
}

/** A download finished with a playable file — the Library row can drop it. */
export function isSatisfied(view: DownloadView): boolean {
  return view.phase === 'done' && Boolean(view.media.playablePath) && !view.active;
}
