import type {
  Stream,
  Job,
  Clip,
  ImportByFileInput,
  ImportByUrlInput,
  ImportResult,
  ExportClipInput,
  ExportResult,
  QueueAction,
  AppSettings,
  Axis,
  StreamStatus,
} from '$shared/types';

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

  /** Upload VOD file via multipart form (for small/medium videos). */
  uploadVod: (file: File, opts?: { title?: string; streamer?: string }) => {
    const form = new FormData();
    form.append('vod', file);
    if (opts?.title) form.append('title', opts.title);
    if (opts?.streamer) form.append('streamer', opts.streamer);
    return api<ImportResult>('/streams/upload-vod', { method: 'POST', body: form });
  },

  /** Upload chat file and attach to existing stream. */
  uploadChat: (streamId: string, file: File) => {
    const form = new FormData();
    form.append('chat', file);
    return api<Stream>(`/streams/${streamId}/upload-chat`, { method: 'POST', body: form });
  },

  /** Attach chat by local file path. */
  attachChat: (streamId: string, chatPath: string) =>
    api<Stream>(`/streams/${streamId}/attach-chat`, {
      method: 'POST',
      body: JSON.stringify({ chatPath }),
    }),

  deleteStream: (id: string) =>
    api<{ ok: boolean }>(`/streams/${id}`, { method: 'DELETE' }),

  updateStream: (id: string, patch: Partial<Pick<Stream, 'title' | 'streamer' | 'game' | 'vodPath' | 'chatPath'>>) =>
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

  exportClip: (input: ExportClipInput) =>
    api<ExportResult>(`/clips/${input.clipId}/export`, { method: 'POST', body: JSON.stringify(input) }),

  // ── Settings ──
  getSettings: () =>
    api<AppSettings>('/settings'),

  updateSettings: (settings: Partial<AppSettings>) =>
    api<AppSettings>('/settings', { method: 'PUT', body: JSON.stringify(settings) }),

  // ── System ──
  listComputeDevices: () =>
    api<{ id: string; label: string; index: number | null; type: 'gpu' | 'cpu'; memoryMB: number }[]>('/system/devices'),

  // ── Video ──
  videoUrl: (streamId: string) =>
    `${API_BASE}/video/${streamId}`,

  // ── Signal terrain data ──
  chatDensity: (streamId: string) =>
    api<{ duration: number; density: number[] }>(`/streams/${streamId}/chat-density`),

  waveform: (streamId: string) =>
    api<{ duration: number; peaks: number[]; resolution?: string }>(`/streams/${streamId}/waveform`),
};
