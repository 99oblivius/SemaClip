/**
 * The one download query.
 *
 * Every surface that shows download state reads THIS query — one request for
 * all streams, one poll cadence, one source of truth. Per-component pollers
 * and per-component derivations were the cause of the reported
 * inconsistencies (a container that only appeared after a refresh, bars that
 * did not move, sizes landing on the wrong row).
 *
 * The cadence is driven by the PAYLOAD's own `active` flag: fast while
 * anything is downloading, slow when nothing is.
 */
import { createQuery } from '@tanstack/svelte-query';
import { apiClient } from '$lib/api/client';
import type { DownloadView } from '$lib/api/download';

export const DOWNLOADS_KEY = ['downloads'] as const;

/** Poll interval: fast while any download runs, idle otherwise. */
const ACTIVE_MS = 1000;
const IDLE_MS = 30_000;

export function downloadsQuery() {
  return createQuery(() => ({
    queryKey: DOWNLOADS_KEY as unknown as string[],
    queryFn: () => apiClient.listDownloads(),
    refetchInterval: (q: { state: { data?: { views?: DownloadView[] } } }) => {
      const views = q.state.data?.views;
      return views?.some((v) => v.active) ? ACTIVE_MS : IDLE_MS;
    },
  }));
}

/** The view for one stream, from the shared query's data. */
export function viewFor(views: DownloadView[] | undefined, streamId: string): DownloadView | undefined {
  return views?.find((v) => v.streamId === streamId);
}
