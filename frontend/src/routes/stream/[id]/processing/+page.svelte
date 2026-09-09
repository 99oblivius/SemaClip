<script lang="ts">
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import { wsStore } from '$lib/stores/ws';
  import Icon from '$lib/components/Icon.svelte';
  import { fadeIn, staggerIn } from '$lib/actions/gsap';
  import { ENGINE_PHASES, PHASE_LABELS, type EngineEvent, type EnginePhase } from '$shared/types';
  import { onMount, onDestroy } from 'svelte';

  let { params } = $props();
  const streamId = $derived(params.id);
  const queryClient = useQueryClient();

  const streamQuery = createQuery(() => ({
    queryKey: ['stream', streamId],
    queryFn: () => apiClient.getStream(streamId),
  }));

  let phaseStatus = $state<Record<EnginePhase, { done: boolean; percent: number; active: boolean }>>(
    Object.fromEntries(
      ENGINE_PHASES.map((p) => [p, { done: false, percent: 0, active: false }])
    ) as Record<EnginePhase, { done: boolean; percent: number; active: boolean }>
  );

  let candidates = $state<{ axis: string; score: number; time: number; summary: string }[]>([]);
  let cancelling = $state(false);
  let cancelError = $state<string | null>(null);

  /** Cancel the running job — NOT the stream. v1 deleted the whole project here. */
  async function cancelJob() {
    if (cancelling) return;
    const jobs = await apiClient.listJobs().catch(() => []);
    const running = jobs.find((j) => j.streamId === streamId && j.status === 'running');
    if (!running) {
      window.location.href = `/stream/${streamId}`;
      return;
    }
    cancelling = true;
    cancelError = null;
    try {
      await apiClient.cancelJob(running.id);
      window.location.href = `/stream/${streamId}`;
    } catch (err) {
      cancelError = err instanceof Error ? err.message : String(err);
      cancelling = false;
    }
  }

  let unsub: (() => void) | null = null;

  onMount(() => {
    unsub = wsStore.onEvent<EngineEvent>((event) => {
      if ('jobId' in event && event.type === 'progress') {
        phaseStatus[event.phase] = { done: false, percent: event.percent, active: true };
        phaseStatus = { ...phaseStatus };
      } else if (event.type === 'candidate') {
        candidates = [...candidates, {
          axis: event.axis,
          score: event.score,
          time: event.start,
          summary: `${event.axis} ${event.score.toFixed(2)}`,
        }];
      } else if (event.type === 'complete') {
        queryClient.invalidateQueries({ queryKey: ['streams'] });
        queryClient.invalidateQueries({ queryKey: ['clips', streamId] });
      }
    });
  });

  onDestroy(() => unsub?.());

  const stream = $derived(streamQuery.data);
</script>

<div class="flex h-full flex-col gap-4 p-6" use:fadeIn>
  <div class="flex items-center justify-between">
    <div class="flex flex-col gap-1">
      <span class="font-display text-base font-medium">{stream?.title ?? 'Processing...'}</span>
      <span class="font-mono text-xs text-ash">
        {stream?.streamer ?? 'unknown'} · started processing
      </span>
    </div>
    <div class="flex items-center gap-3">
      {#if cancelError}
        <span class="text-xs text-error">{cancelError}</span>
      {/if}
      <button
        class="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm text-ash transition-colors hover:text-ink disabled:opacity-50"
        onclick={cancelJob}
        disabled={cancelling}
      >
        <Icon name="close" size={16} />
        {cancelling ? 'Cancelling…' : 'Cancel'}
      </button>
    </div>
  </div>

  <div class="grid grid-cols-2 gap-4">
    <!-- Pipeline -->
    <div class="rounded-lg border border-border bg-surface p-4">
      <h2 class="mb-3 font-display text-sm font-medium text-ash uppercase tracking-wider">Pipeline</h2>
      <div class="flex flex-col gap-2">
        {#each ENGINE_PHASES as phase}
          {@const status = phaseStatus[phase]}
          <div class="flex items-center gap-3 text-sm">
            <span class="w-4 text-center">
              {#if status.done}
                <span class="text-success"><Icon name="check" size={14} fill /></span>
              {:else if status.active}
                <span class="text-accent"><Icon name="cpu" size={14} fill /></span>
              {:else}
                <span class="text-ash-dim">·</span>
              {/if}
            </span>
            <span class="w-40 {status.active ? 'text-ink' : status.done ? 'text-ash' : 'text-ash-dim'}">
              {PHASE_LABELS[phase]}
            </span>
            {#if status.active}
              <div class="flex-1">
                <div class="h-1 overflow-hidden rounded-full bg-surface-3">
                  <div class="h-full bg-accent transition-all" style="width: {status.percent * 100}%"></div>
                </div>
              </div>
              <span class="font-mono text-xs text-ash">{Math.round(status.percent * 100)}%</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>

    <!-- Live findings -->
    <div class="rounded-lg border border-border bg-surface p-4">
      <h2 class="mb-3 font-display text-sm font-medium text-ash uppercase tracking-wider">Live Findings</h2>
      {#if candidates.length === 0}
        <div class="flex h-32 items-center justify-center text-sm text-ash-dim">
          Waiting for candidates...
        </div>
      {:else}
        <div class="flex flex-col gap-1" use:staggerIn>
          {#each candidates as candidate, i}
            <div class="flex items-center gap-3 rounded px-2 py-1.5 font-mono text-xs">
              <span class="w-12 text-ash-dim">{Math.floor(candidate.time / 60)}:{String(Math.floor(candidate.time % 60)).padStart(2, '0')}</span>
              <span class="w-16 uppercase text-ash">{candidate.axis}</span>
              <span class="flex-1 text-ink">{candidate.score.toFixed(2)}</span>
              <div class="h-1 w-20 overflow-hidden rounded-full bg-surface-3">
                <div class="h-full bg-accent" style="width: {candidate.score * 100}%"></div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>
