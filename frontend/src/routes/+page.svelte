<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import Icon from '$lib/components/Icon.svelte';
  import { fadeIn, staggerIn, hoverLift } from '$lib/actions/gsap';
  import type { Stream, ImportByUrlInput, ImportByFileInput } from '$shared/types';

  const queryClient = useQueryClient();

  const streamsQuery = createQuery(() => ({
    queryKey: ['streams'],
    queryFn: () => apiClient.listStreams(),
  }));

  const importUrlMutation = createMutation(() => ({
    mutationFn: (input: ImportByUrlInput) => apiClient.importByUrl(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['streams'] }),
  }));

  const importFileMutation = createMutation(() => ({
    mutationFn: (input: ImportByFileInput) => apiClient.importByFile(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['streams'] }),
  }));

  let urlInput = $state('');
  let streams = $derived(streamsQuery.data ?? []);
  let showEmpty = $derived(streams.length === 0);

  function fmtDuration(sec: number | null): string {
    if (!sec) return '--';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h > 0 ? `${h}h${m}m` : `${m}m`;
  }

  function fmtDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function handleImport() {
    if (!urlInput.trim()) return;
    importUrlMutation.mutate({ url: urlInput.trim() });
    urlInput = '';
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    for (const file of files) {
      importFileMutation.mutate({ vodPath: file.name, title: file.name.replace(/\.[^.]+$/, '') });
    }
  }
</script>

<div class="flex h-full flex-col overflow-y-auto p-6" use:fadeIn role="region" aria-label="Library">
  <section class="mb-6">
    <div
      class="flex items-center gap-3 rounded-lg border border-border bg-surface p-4 transition-colors focus-within:border-accent"
      ondrop={handleDrop}
      ondragover={(e) => e.preventDefault()}
      role="button"
      tabindex="0"
      aria-label="Drop files or paste URL"
    >
      <Icon name="download" size={20} fill={false} />
      <span class="text-sm text-ash">Drop VOD + chat files here</span>
      <span class="text-ash-dim">or paste Twitch VOD URL:</span>
      <input
        type="text"
        bind:value={urlInput}
        onkeydown={(e) => e.key === 'Enter' && handleImport()}
        placeholder="https://www.twitch.tv/videos/..."
        class="flex-1 bg-transparent text-sm text-ink placeholder:text-ash-dim focus:outline-none"
        aria-label="Twitch VOD URL"
      />
      <button
        class="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        onclick={handleImport}
        disabled={importUrlMutation.isPending || !urlInput.trim()}
        use:hoverLift
      >
        <Icon name="link" size={16} />
        Import
      </button>
    </div>
  </section>

  {#if showEmpty}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <Icon name="waveform" size={48} fill={false} />
      <p class="font-display text-lg text-ash">Drop a Twitch VOD to begin</p>
      <p class="text-sm text-ash-dim">or paste a VOD URL above</p>
    </div>
  {:else}
    <section>
      <h2 class="mb-3 font-display text-sm font-medium text-ash uppercase tracking-wider">Recent</h2>
      <div class="flex flex-col gap-1" use:staggerIn>
        {#each streams as stream (stream.id)}
          <a
            href="/stream/{stream.id}"
            class="flex items-center gap-4 rounded-md border border-transparent bg-surface px-4 py-3 transition-colors hover:border-border-strong hover:bg-surface-2"
            use:hoverLift
          >
            <div class="flex flex-1 flex-col gap-0.5">
              <span class="text-sm font-medium text-ink">{stream.title ?? 'Untitled Stream'}</span>
              <span class="font-mono text-xs text-ash">
                {stream.streamer ?? 'unknown'} · {fmtDuration(stream.duration)} · {fmtDate(stream.createdAt)}
              </span>
            </div>
            <div class="flex items-center gap-2">
              {#if stream.status === 'processing'}
                <span class="flex items-center gap-1 font-mono text-xs text-warning">
                  <Icon name="cpu" size={14} /> processing
                </span>
              {:else if stream.status === 'completed'}
                <span class="font-mono text-xs text-success">✓ done</span>
              {/if}
            </div>
          </a>
        {/each}
      </div>
    </section>
  {/if}
</div>
