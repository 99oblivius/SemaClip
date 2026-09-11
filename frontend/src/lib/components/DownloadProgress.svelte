<script lang="ts">
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import Icon from '$lib/components/Icon.svelte';
  import { fmtEta, fmtBytes, isLive, isSatisfied, type DownloadView } from '$lib/api/download';
  import { DOWNLOADS_KEY, downloadsQuery, viewFor, markDownloadsChanged } from '$lib/api/downloads';

  interface Props {
    streamId: string;
    /** Project title for the container label. */
    title?: string;
  }

  let { streamId, title = '' }: Props = $props();
  const queryClient = useQueryClient();

  // The ONE download query — no per-component poller.
  const downloads = downloadsQuery();
  const view = $derived(viewFor(downloads.data?.views, streamId));

  let detailOpen = $state(false);
  // Auto-expand once on the transition into a live download, so "what am I
  // resuming?" surfaces itself without a click — but the user can collapse
  // it and it stays collapsed (a naive effect re-opened it on every poll).
  let wasLive = $state(false);
  $effect(() => {
    const live = view ? isLive(view) : false;
    if (live && !wasLive) detailOpen = true;
    wasLive = live;
  });

  const deleteMutation = createMutation(() => ({
    mutationFn: () => apiClient.deleteDownload(streamId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: DOWNLOADS_KEY as unknown as string[] }),
  }));

  const resumeMutation = createMutation(() => ({
    mutationFn: () => apiClient.resumeDownload(streamId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: DOWNLOADS_KEY as unknown as string[] }),
  }));

  function fmtTime(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // A satisfied download leaves the list: the stream is in the library rows.
  const show = $derived(Boolean(view && isLive(view) && !isSatisfied(view)));
</script>

{#if show && view}
  <div class="rounded-md border border-border bg-surface px-3 py-2" role="status">
    <button
      class="flex w-full items-center gap-2.5 text-left"
      onclick={() => (detailOpen = !detailOpen)}
      aria-expanded={detailOpen}
      aria-controls="download-detail"
    >
      <Icon
        name={view.phase === 'failed' ? 'alert' : 'download'}
        size={14}
        class={view.phase === 'failed' ? 'text-error' : 'text-accent'}
      />
      {#if title}
        <span class="max-w-40 shrink-0 truncate font-mono text-[10px] text-ash-dim" title={title}>{title}</span>
      {/if}
      <div class="min-w-0 flex-1">
        <div class="flex items-center justify-between gap-2 font-mono text-[10px]">
          <span class="truncate {view.phase === 'failed' ? 'text-error' : 'text-ash'}">{view.label}</span>
          <span class="flex items-center gap-2 text-ash-dim">
            {#if view.overall.etaSec !== null && view.active}
              <span>ETA {fmtEta(view.overall.etaSec)}</span>
            {/if}
            <span>{Math.round(view.overall.percent * 100)}%</span>
            <Icon name={detailOpen ? 'chevron-left' : 'chevron-right'} size={10} class={detailOpen ? 'rotate-90' : '-rotate-90'} />
          </span>
        </div>
        <div class="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
          <div
            class="h-full transition-all {view.phase === 'failed' ? 'bg-error' : 'bg-accent'}"
            style="width: {view.overall.percent * 100}%"
          ></div>
        </div>
      </div>
    </button>

    {#if detailOpen}
      <div id="download-detail" class="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
        {#each view.artifacts as art (art.kind)}
          <div class="flex items-center gap-2">
            <span class="w-24 shrink-0 font-mono text-[10px] text-ash">{art.label}</span>
            <div class="h-0.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3">
              <div
                class="h-full transition-all
                {art.status === 'failed' ? 'bg-error' : art.onDisk ? 'bg-success' : art.status === 'running' ? 'bg-accent' : 'bg-surface-3'}"
                style="width: {art.percent * 100}%"
              ></div>
            </div>
            <span class="w-24 shrink-0 text-right font-mono text-[10px] text-ash-dim">
              {#if art.status === 'running' && art.etaSec !== null}
                {fmtEta(art.etaSec)}
              {:else if art.status === 'running'}
                {fmtBytes(art.bytes)}
              {:else if art.onDisk}
                ✓ {fmtBytes(art.bytes)}
              {:else if art.status === 'failed'}
                <span class="text-error" title={art.error ?? ''}>failed</span>
              {:else if art.status === 'skipped'}
                skipped
              {:else}
                pending
              {/if}
            </span>
          </div>
          {#if art.frontierSec !== null && art.status === 'running'}
            <p class="pl-28 font-mono text-[10px] text-ash-dim">
              {fmtTime(art.frontierSec)} downloaded{art.sharedWith.length > 0 ? ` · shared with ${art.sharedWith.join(', ')}` : ''}
            </p>
          {/if}
          {#if art.error && art.status === 'failed'}
            <p class="pl-28 font-mono text-[10px] text-error/80">{art.error}</p>
          {/if}
        {/each}
        {#if view.media.previewOnly}
          <p class="pl-1 font-mono text-[10px] text-warning">preview only — the video file is missing, exports are not possible</p>
        {/if}
        <div class="mt-1 flex items-center justify-end gap-2">
          {#if view.phase === 'failed'}
            <button
              class="rounded border border-border px-2 py-0.5 text-[10px] text-ash transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
              onclick={() => resumeMutation.mutate()}
              disabled={resumeMutation.isPending}
              title="Keep the already-downloaded prefix; fetch only what's missing"
            >
              Resume download
            </button>
          {/if}
          <button
            class="rounded border border-border px-2 py-0.5 text-[10px] text-ash transition-colors hover:border-error hover:text-error"
            onclick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
            title="Abort the download and delete its files"
          >
            Delete download
          </button>
        </div>
      </div>
    {/if}
  </div>
{/if}
