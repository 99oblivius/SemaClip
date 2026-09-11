/**
 * The one download query.
 *
 * Every surface that shows download state reads THIS query — one request for
 * all streams, one poll cadence, one source of truth. Per-component pollers
 * and per-component derivations were the cause of the reported
 * inconsistencies (a container that only appeared after a refresh, bars that
 * did not move, sizes landing on the wrong row).
 *
 * Cadence is adaptive and change-aware, so the app feels live rather than
 * polled:
 * - a download is running anywhere → 1 s (progress must look continuous);
 * - nothing running but something changed recently → 2 s (a completion or
 *   delete settles immediately instead of waiting out an idle timer);
 * - settled → a slow heartbeat, plus an immediate refetch on window focus,
 *   so returning to the app is always fresh.
 */
import { createQuery } from '@tanstack/svelte-query';
import { apiClient } from '$lib/api/client';
import type { DownloadView } from '$lib/api/download';

export const DOWNLOADS_KEY = ['downloads'] as const;

const ACTIVE_MS = 1000;
/** After activity stops, keep watching briefly so the final state lands. */
const SETTLING_MS = 2000;
const SETTLING_WINDOW_MS = 15_000;
const IDLE_MS = 30_000;

interface DownloadsPayload {
  views?: DownloadView[];
  revision?: number;
}

/** When the payload last changed, observed client-side. */
let lastChangeAt = 0;
let lastRevision: number | undefined;

function noteRevision(revision: number | undefined): void {
  if (revision === undefined) return;
  if (revision !== lastRevision) {
    lastRevision = revision;
    lastChangeAt = Date.now();
  }
}

export function downloadsQuery() {
  return createQuery(() => ({
    queryKey: DOWNLOADS_KEY as unknown as string[],
    queryFn: async () => {
      const data = await apiClient.listDownloads();
      noteRevision((data as DownloadsPayload).revision);
      return data;
    },
    refetchInterval: (q: { state: { data?: DownloadsPayload } }) => {
      const views = q.state.data?.views;
      if (views?.some((v) => v.active)) return ACTIVE_MS;
      // Just-changed: keep watching so a completion/delete is reflected
      // promptly rather than at the idle heartbeat.
      if (Date.now() - lastChangeAt < SETTLING_WINDOW_MS) return SETTLING_MS;
      return IDLE_MS;
    },
    refetchOnWindowFocus: true,
    staleTime: 0,
  }));
}

/** The view for one stream, from the shared query's data. */
export function viewFor(views: DownloadView[] | undefined, streamId: string): DownloadView | undefined {
  return views?.find((v) => v.streamId === streamId);
}

/** Force the next poll to be treated as "just changed" (post-mutation). */
export function markDownloadsChanged(): void {
  lastChangeAt = Date.now();
}
