<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import Icon from '$lib/components/Icon.svelte';
  import { fadeIn, staggerIn } from '$lib/actions/gsap';
  import type { Job, QueueAction } from '$shared/types';

  const queryClient = useQueryClient();

  const jobsQuery = createQuery(() => ({
    queryKey: ['jobs'],
    queryFn: () => apiClient.listJobs(),
    refetchInterval: 3000, // poll for updates
  }));

  const queueMutation = createMutation(() => ({
    mutationFn: (action: QueueAction) => apiClient.manageQueue(action),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  }));

  const cancelMutation = createMutation(() => ({
    mutationFn: (jobId: string) => apiClient.cancelJob(jobId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  }));

  const jobs = $derived(jobsQuery.data ?? []);
  const running = $derived(jobs.filter((j) => j.status === 'running'));
  const queued = $derived(jobs.filter((j) => j.status === 'queued').sort((a, b) => a.position - b.position));

  function fmtElapsed(startedAt: string | null): string {
    if (!startedAt) return '--';
    const sec = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function moveUp(job: Job) {
    queueMutation.mutate({ type: 'reorder', jobId: job.id, newPosition: Math.max(0, job.position - 1) });
  }
  function moveDown(job: Job) {
    queueMutation.mutate({ type: 'reorder', jobId: job.id, newPosition: job.position + 1 });
  }
  function cancelQueued(job: Job) {
    queueMutation.mutate({ type: 'cancel', jobId: job.id });
  }
  function cancelRunning(job: Job) {
    cancelMutation.mutate(job.id);
  }
</script>

<div class="flex h-full flex-col overflow-y-auto p-6" use:fadeIn role="region" aria-label="Queue">
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-6">
    <h1 class="font-display text-xl font-medium">Queue</h1>

    {#if jobsQuery.isLoading}
      <div class="text-sm text-ash">Loading...</div>
    {:else if jobs.length === 0}
      <div class="flex flex-col items-center justify-center gap-2 py-20 text-center">
        <Icon name="queue" size={32} class="text-ash-dim" />
        <p class="text-sm text-ash-dim">No active jobs. Start processing from the Library.</p>
      </div>
    {:else}
      <!-- Running -->
      {#if running.length > 0}
        <section class="flex flex-col gap-2">
          <h2 class="font-display text-sm font-medium text-ash uppercase tracking-wider">Running</h2>
          <div class="flex flex-col gap-1" use:staggerIn>
            {#each running as job (job.id)}
              <div class="flex items-center gap-3 rounded-md border border-border bg-surface px-4 py-3">
                <Icon name="cpu" size={16} class="text-warning animate-pulse" />
                <div class="flex flex-1 flex-col gap-0.5">
                  <a href="/stream/{job.streamId}" class="text-sm font-medium text-ink hover:text-accent">
                    {job.streamId.slice(0, 8)}
                  </a>
                  <span class="font-mono text-xs text-ash-dim">{fmtElapsed(job.startedAt)} elapsed</span>
                </div>
                <button
                  class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-ash transition-colors hover:border-error hover:text-error"
                  onclick={() => cancelRunning(job)}
                >
                  <Icon name="close" size={12} />
                  Cancel
                </button>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <!-- Queued -->
      {#if queued.length > 0}
        <section class="flex flex-col gap-2">
          <h2 class="font-display text-sm font-medium text-ash uppercase tracking-wider">
            Queued ({queued.length})
          </h2>
          <div class="flex flex-col gap-1" use:staggerIn>
            {#each queued as job, i (job.id)}
              <div class="flex items-center gap-3 rounded-md border border-border bg-surface px-4 py-3">
                <span class="font-mono text-sm text-ash-dim w-6 text-right">{i + 1}</span>
                <div class="flex flex-1 flex-col gap-0.5">
                  <a href="/stream/{job.streamId}" class="text-sm font-medium text-ink hover:text-accent">
                    {job.streamId.slice(0, 8)}
                  </a>
                  <span class="font-mono text-xs text-ash-dim">waiting</span>
                </div>
                <div class="flex items-center gap-1">
                  <button
                    class="flex h-7 w-7 items-center justify-center rounded text-ash-dim transition-colors hover:text-ink disabled:opacity-30"
                    onclick={() => moveUp(job)}
                    disabled={i === 0}
                    aria-label="Move up"
                  >
                    <Icon name="chevron-left" size={14} class="rotate-90" />
                  </button>
                  <button
                    class="flex h-7 w-7 items-center justify-center rounded text-ash-dim transition-colors hover:text-ink disabled:opacity-30"
                    onclick={() => moveDown(job)}
                    disabled={i === queued.length - 1}
                    aria-label="Move down"
                  >
                    <Icon name="chevron-left" size={14} class="-rotate-90" />
                  </button>
                  <button
                    class="flex h-7 w-7 items-center justify-center rounded text-ash-dim transition-colors hover:text-error"
                    onclick={() => cancelQueued(job)}
                    aria-label="Remove from queue"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/if}
    {/if}
  </div>
</div>
