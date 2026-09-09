<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import Icon from '$lib/components/Icon.svelte';
  import { PART_LABELS, fmtEta, type DownloadPart } from '$lib/api/download';

  interface Props {
    streamId: string;
  }

  let { streamId }: Props = $props();
  const queryClient = useQueryClient();

  const stateQuery = createQuery(() => ({
    queryKey: ['download', streamId],
    queryFn: () => apiClient.getDownloadState(streamId),
    refetchInterval: (q) => (q.state.data?.phase === 'running' ? 1000 : 5000),
  }));

  const dlState = $derived(stateQuery.data);
  let detailOpen = $state(false);

  // Delete download: abort in-flight + remove artifacts + clear state.
  const deleteMutation = createMutation(() => ({
    mutationFn: () => apiClient.deleteDownload(streamId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['download', streamId] });
      queryClient.invalidateQueries({ queryKey: ['streams'] });
    },
  }));

  // Resume: picks up from the on-disk chunk prefix; only the tail re-fetches.
  const resumeMutation = createMutation(() => ({
    mutationFn: () => apiClient.resumeDownload(streamId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['download', streamId] }),
  }));

  function fmtTime(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  const phaseText = $derived.by(() => {
    if (!dlState) return '';
    switch (dlState.phase) {
      case 'running': {
        const scrub = dlState.parts.find((p) => p.kind === 'scrub');
        const hq = dlState.parts.find((p) => p.kind === 'hq');
        if (scrub?.status === 'running') return `scrub · ${fmtTime(dlState.scrubFrontierSec)} downloaded`;
        if (hq?.status === 'running') return 'full quality downloading';
        return 'downloading';
      }
      case 'done': return 'download complete';
      case 'failed': {
        const failed = dlState.parts.filter((p) => p.status === 'failed');
        return `download interrupted: ${failed.map((f) => PART_LABELS[f.kind]).join(', ')}`;
      }
      default: return '';
    }
  });

  // A download that finished honestly (video bytes complete) leaves the
  // list — the stream itself is already in the library rows. A "done" phase
  // with no playable twin is NOT complete (aborted scrub); it stays with
  // resume/delete actions.
  const satisfied = $derived(Boolean(
    dlState?.phase === 'done' && (dlState.scrubMp4 || dlState.hqMp4) && dlState.scrubFrontierSec > 0,
  ));
</script>

{#if dlState && dlState.phase !== 'idle' && !satisfied}
  <div class="rounded-md border border-border bg-surface px-3 py-2" role="status">
    <!-- Single unified bar: click for the itemized popover -->
    <button
      class="flex w-full items-center gap-2.5 text-left"
      onclick={() => (detailOpen = !detailOpen)}
      aria-expanded={detailOpen}
      aria-controls="download-detail"
    >
      <Icon
        name={dlState.phase === 'failed' ? 'alert' : 'download'}
        size={14}
        class={dlState.phase === 'failed' ? 'text-error' : 'text-accent'}
      />
      <div class="min-w-0 flex-1">
        <div class="flex items-center justify-between gap-2 font-mono text-[10px]">
          <span class="truncate {dlState.phase === 'failed' ? 'text-error' : 'text-ash'}">{phaseText}</span>
          <span class="flex items-center gap-2 text-ash-dim">
            {#if dlState.overall.etaSec !== null && dlState.phase === 'running'}
              <span>ETA {fmtEta(dlState.overall.etaSec)}</span>
            {/if}
            <span>{Math.round(dlState.overall.percent * 100)}%</span>
            <Icon name={detailOpen ? 'chevron-left' : 'chevron-right'} size={10} class={detailOpen ? 'rotate-90' : '-rotate-90'} />
          </span>
        </div>
        <div class="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
          <div
            class="h-full transition-all {dlState.phase === 'failed' ? 'bg-error' : 'bg-accent'}"
            style="width: {dlState.overall.percent * 100}%"
          ></div>
        </div>
      </div>
    </button>

    {#if detailOpen}
      <div id="download-detail" class="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
        {#each dlState.parts as part (part.kind)}
          <div class="flex items-center gap-2">
            <span class="w-24 shrink-0 font-mono text-[10px] text-ash">{PART_LABELS[part.kind]}</span>
            <div class="h-0.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3">
              <div
                class="h-full transition-all
                {part.status === 'failed' ? 'bg-error' : part.status === 'done' ? 'bg-success' : part.status === 'running' ? 'bg-accent' : 'bg-surface-3'}"
                style="width: {part.percent * 100}%"
              ></div>
            </div>
            <span class="w-16 shrink-0 text-right font-mono text-[10px] text-ash-dim">
              {#if part.status === 'running' && part.etaSec !== null}
                {fmtEta(part.etaSec)}
              {:else if part.status === 'done'}
                ✓
              {:else if part.status === 'failed'}
                <span class="text-error" title={part.error}>failed</span>
              {:else if part.status === 'skipped'}
                skipped
              {:else}
                pending
              {/if}
            </span>
          </div>
          {#if part.error && part.status === 'failed'}
            <p class="pl-28 font-mono text-[10px] text-error/80">{part.error}</p>
          {/if}
        {/each}
        <div class="mt-1 flex items-center justify-end gap-2">
          {#if dlState.phase === 'failed'}
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