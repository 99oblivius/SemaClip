import type {
  Stream,
  Job,
  Clip,
  ImportByFileInput,
  ImportByUrlInput,
  ImportResult,
  ExportClipInput,
  ExportResult,
  ExportPreset,
  QueueAction,
  AppSettings,
  Axis,
  StreamStatus,
  ToolStatus,
} from '$shared/types';
import type { DownloadState, DownloadView, QualityInfo } from '$lib/api/download';

export interface ChatMessage {
  t: number;       // content_offset_seconds
  user: string;    // commenter display_name
  body: string;    // message body
}

/** One transcript cue (parsed SRT entry, P0-8 caption editing). */
export interface TranscriptCue {
  index: number;
  start: number;   // seconds, VOD-relative
  end: number;
  text: string;
}

const API_BASE = '/api';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const apiClient = {
  // ── Streams ──
  listStreams: (status?: StreamStatus) =>
    api<Stream[]>(`/streams${status ? `?status=${status}` : ''}`),

  getStream: (id: string) =>
    api<Stream>(`/streams/${id}`),

  importByFile: (input: ImportByFileInput) =>
    api<ImportResult>('/streams/import-file', { method: 'POST', body: JSON.stringify(input) }),

  importByUrl: (input: ImportByUrlInput) =>
    api<ImportResult>('/streams/import-url', { method: 'POST', body: JSON.stringify(input) }),

  // ── Download pipeline ──
  listQualities: (url: string) =>
    api<{ qualities: { name: string; width: number; height: number; fps: number; bandwidth: number }[] }>(
      `/vod/qualities?url=${encodeURIComponent(url)}`,
    ),

  getDownloadState: (streamId: string) =>
    api<DownloadState>(`/streams/${streamId}/download`),

  /** Every stream's composed download view — the single UI source. */
  listDownloads: () =>
    api<{ views: DownloadView[] }>('/downloads'),

  deleteDownload: (streamId: string) =>
    api<{ ok: boolean }>(`/streams/${streamId}/download`, { method: 'DELETE' }),

  /** Cancel a single piece download: aborts it AND removes the files it wrote. */
  cancelPiece: (streamId: string, kind: 'proxy' | 'hq' | 'chat') =>
    api<{ ok: boolean }>(`/streams/${streamId}/download?piece=${kind}`, { method: 'DELETE' }),

  resumeDownload: (streamId: string) =>
    api<{ ok: boolean }>(`/streams/${streamId}/download/resume`, { method: 'POST' }),

  deleteVideo: (streamId: string) =>
    api<{ deleted: boolean }>(`/streams/${streamId}/video`, { method: 'DELETE' }),

  deleteProxy: (streamId: string) =>
    api<{ deleted: boolean }>(`/streams/${streamId}/proxy`, { method: 'DELETE' }),

  downloadPiece: (
    streamId: string,
    kind: 'proxy' | 'hq' | 'chat',
    opts?: { maxHeight?: number | null; proxyHeightCap?: number | null },
  ) =>
    api<{ started: boolean; quality: string | null; count?: number }>(`/streams/${streamId}/download-piece`, {
      method: 'POST',
      body: JSON.stringify({
        kind,
        maxHeight: opts?.maxHeight ?? null,
        proxyHeightCap: opts?.proxyHeightCap ?? null,
      }),
    }),

  deleteChat: (streamId: string) =>
    api<{ deleted: boolean }>(`/streams/${streamId}/chat`, { method: 'DELETE' }),



  /** Attach chat by local file path. */
  attachChat: (streamId: string, chatPath: string) =>
    api<Stream>(`/streams/${streamId}/attach-chat`, {
      method: 'POST',
      body: JSON.stringify({ chatPath }),
    }),

  deleteStream: (id: string) =>
    api<{ ok: boolean }>(`/streams/${id}`, { method: 'DELETE' }),

  updateStream: (id: string, patch: Partial<Pick<Stream, 'title' | 'streamer' | 'game' | 'vodPath' | 'chatPath' | 'sourceUrl'>>) =>
    api<Stream>(`/streams/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  // ── Jobs ──
  listJobs: () =>
    api<Job[]>('/jobs'),

  startJob: (streamId: string, config?: object) =>
    api<Job>(`/streams/${streamId}/jobs`, { method: 'POST', body: JSON.stringify({ config }) }),

  cancelJob: (jobId: string) =>
    api<Job>(`/jobs/${jobId}/cancel`, { method: 'POST' }),

  manageQueue: (action: QueueAction) =>
    api<Job[]>('/queue/manage', { method: 'POST', body: JSON.stringify(action) }),

  // ── Clips ──
  listClips: (streamId: string, filter?: { axis?: Axis; rejected?: boolean }) => {
    const params = new URLSearchParams();
    if (filter?.axis) params.set('axis', filter.axis);
    if (filter?.rejected !== undefined) params.set('rejected', String(filter.rejected));
    const qs = params.toString();
    return api<Clip[]>(`/streams/${streamId}/clips${qs ? `?${qs}` : ''}`);
  },

  getClip: (id: string) =>
    api<Clip>(`/clips/${id}`),

  rejectClip: (id: string) =>
    api<Clip>(`/clips/${id}/reject`, { method: 'POST' }),

  /** Persist endpoint/trim adjustments (review state, P0-11). */
  updateClip: (id: string, patch: { startTime?: number; endTime?: number }) =>
    api<Clip>(`/clips/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  exportClip: (input: ExportClipInput) =>
    api<ExportResult>(`/clips/${input.clipId}/export`, { method: 'POST', body: JSON.stringify(input) }),

  // ── Tool provisioning (ffmpeg) ──
  // ffmpeg resolves PATH -> previously-installed -> managed, so the UI asks
  // whether it is missing and offers a download rather than assuming.
  getToolStatus: () => api<ToolStatus>('/tools'),

  /** The provisioning endpoint is a POST that streams SSE progress. */
  toolProvisionUrl: () => `${API_BASE}/tools/ffmpeg`,

  // ── Settings ──
  getSettings: () =>
    api<AppSettings>('/settings'),

  updateSettings: (settings: Partial<AppSettings>) =>
    api<AppSettings>('/settings', { method: 'PUT', body: JSON.stringify(settings) }),

  // ── Export presets (P0-7) ──
  listPresets: () =>
    api<ExportPreset[]>('/presets'),

  savePreset: (preset: ExportPreset) =>
    api<{ ok: boolean }>(`/presets/${preset.id}`, { method: 'PUT', body: JSON.stringify(preset) }),

  deletePreset: (id: string) =>
    api<{ ok: boolean }>(`/presets/${id}`, { method: 'DELETE' }),

  // ── System ──
  listComputeDevices: () =>
    api<{ id: string; label: string; index: number | null; type: 'gpu' | 'cpu'; memoryMB: number }[]>('/system/devices'),

  // ── Video ──
  videoUrl: (streamId: string) =>
    `${API_BASE}/video/${streamId}`,

  hlsPlaylistUrl: (streamId: string, track: 'proxy' | 'hq' = 'proxy') =>
    `${API_BASE}/streams/${streamId}/hls.m3u8?track=${track}`,

  // ── Signal terrain data ──
  chatDensity: (streamId: string) =>
    api<{ duration: number; density: number[] }>(`/streams/${streamId}/chat-density`),

  listChat: (streamId: string, opts?: { offset?: number; limit?: number; around?: number }) => {
    const params = new URLSearchParams();
    if (opts?.offset !== undefined) params.set('offset', String(opts.offset));
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.around !== undefined) params.set('around', String(opts.around));
    const qs = params.toString();
    return api<{ messages: ChatMessage[]; total: number; offset: number }>(`/streams/${streamId}/chat${qs ? `?${qs}` : ''}`);
  },

  searchChat: (streamId: string, query: string) =>
    api<{ results: ChatMessage[] }>(`/streams/${streamId}/chat/search?q=${encodeURIComponent(query)}`),

  // ── Transcript (P0-8) ──
  getTranscript: (streamId: string) =>
    api<{ cues: TranscriptCue[]; srtPath: string }>(`/streams/${streamId}/transcript`),

  patchTranscript: (streamId: string, edits: { index: number; text: string }[]) =>
    api<{ ok: boolean }>(`/streams/${streamId}/transcript`, { method: 'PATCH', body: JSON.stringify({ edits }) }),

  // ── Markers (P0-6) ──
  getMarkers: (streamId: string) =>
    api<{ markers: { t: number; label: string; source: string }[] }>(`/streams/${streamId}/markers`),

  getRegimes: (streamId: string) =>
    api<{ regimes: { start: number; end: number; type: string }[] }>(`/streams/${streamId}/regimes`),
};

/** Window chrome capability, as reported by the runtime-backed server. */
export interface WindowChrome {
  frameless: boolean;
  nativeDecorations: boolean;
  canMinimize: boolean;
  canMaximize: boolean;
}

/**
 * Real update state from the runtime, not a description of the mechanism.
 *
 * `current` is the version baked into the binary (null under `deno run`);
 * `pendingVersion` is set once a patch is staged; on Windows `sidecarPath` /
 * `sidecarPath` names the updater that applies it, and `sidecarError` explains
 * why they are missing when they are.
 */
export interface UpdateStatus {
  current: string | null;
  pendingVersion: string | null;
  lastRollback: string | null;
  canApply: boolean;
  /** "downloading" means a payload is being fetched right now — keep the window open. */
  phase: 'idle' | 'downloading' | 'ready';
  downloading: boolean;
  download: { version: string; received: number; total: number; fraction: number | null } | null;
  /**
   * The last thing that went wrong CHECKING FOR OR FETCHING an update, or null.
   *
   * Separate from `sidecarError`, which means "this install cannot update itself". A transient HTTP
   * failure or a dropped download says nothing about that, and conflating them made the app report a
   * permanent limitation for a passing network problem.
   */
  updateError: string | null;
  sidecarPath: string | null;
  sidecarError: string | null;
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
  const r = await fetch('/api/update');
  if (!r.ok) throw new Error(`update status: ${r.status}`);
  return await r.json();
}

/**
 * Closes and reopens the app so a staged update installs.
 *
 * The reply says a restart was STARTED — the process exits immediately afterwards, so the
 * caller cannot observe success any other way and must not treat a missing response as a
 * failure.
 */
export async function restartApp(): Promise<{ restarting: boolean; error: string | null }> {
  const r = await fetch('/api/window/restart', { method: 'POST' });
  return await r.json();
}

/**
 * Ask the server to check for an update again.
 *
 * The automatic check runs once per launch, so this is the only way to recover from a failure — or
 * from a download interrupted by closing the app — without restarting. A 409 means a check is
 * already running, which is not an error worth showing.
 */
export async function retryUpdateCheck(): Promise<{ started: boolean; error: string | null }> {
  const r = await fetch('/api/update/check', { method: 'POST' });
  return await r.json();
}

/**
 * The updater's own log, as text.
 *
 * The updater is a SEPARATE process started detached with its output discarded, so this file is the
 * only account of what it did. It returns plain text rather than JSON because that is what the file
 * is, and the point is to show it verbatim.
 */
export async function getUpdateLog(): Promise<string> {
  const r = await fetch('/api/update/log');
  if (!r.ok) throw new Error(`update log: ${r.status}`);
  return await r.text();
}

export async function getWindowChrome(): Promise<WindowChrome> {
  const r = await fetch('/api/window');
  if (!r.ok) throw new Error(`window chrome: ${r.status}`);
  return await r.json();
}

/**
 * Closes the app window.
 *
 * The response is frequently lost, because the process exits from the window's close
 * handler while this request is still in flight. Callers should not treat a rejected
 * promise here as a failure.
 */
export async function closeAppWindow(): Promise<void> {
  await fetch('/api/window/close', { method: 'POST' });
}
