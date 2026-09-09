<script lang="ts">
  import { createMutation, useQueryClient, createQuery } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import Icon from './Icon.svelte';
  import DeleteConfirmModal from './DeleteConfirmModal.svelte';
  import type { Stream } from '$shared/types';
  import type { DownloadState } from '$lib/api/download';

  interface Props {
    stream: Stream;
  }

  let { stream }: Props = $props();
  const queryClient = useQueryClient();

  let open = $state(false);
  let showDeleteModal = $state(false);

  // Editable local copies — synced via $effect when stream prop changes.
  let title = $state('');
  let streamer = $state('');
  let game = $state('');
  let vodPath = $state('');
  let chatPath = $state('');
  let loaded = $state(false);
  let prevId = $state('');

  $effect(() => {
    // Re-sync when the stream prop changes (e.g. after refetch or first load).
    if (!loaded || stream.id !== prevId) {
      title = stream.title ?? '';
      streamer = stream.streamer ?? '';
      game = stream.game ?? '';
      vodPath = stream.vodPath ?? '';
      chatPath = stream.chatPath ?? '';
      prevId = stream.id;
      loaded = true;
    }
  });

  const updateMutation = createMutation(() => ({
    mutationFn: (patch: Parameters<typeof apiClient.updateStream>[1]) =>
      apiClient.updateStream(stream.id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stream', stream.id] });
      queryClient.invalidateQueries({ queryKey: ['streams'] });
      saved = true;
      setTimeout(() => (saved = false), 2000);
    },
  }));

  const deleteMutation = createMutation(() => ({
    mutationFn: () => apiClient.deleteStream(stream.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['streams'] });
      window.location.href = '/';
    },
  }));

  let saved = $state(false);

  // ── Media section: download state + piece actions ──
  const downloadQuery = createQuery(() => ({
    queryKey: ['download', stream.id],
    queryFn: () => apiClient.getDownloadState(stream.id),
    refetchInterval: 1000,
    enabled: Boolean(stream.sourceUrl),
  }));
  const dlState = $derived(downloadQuery.data as DownloadState | undefined);
  const hasScrub = $derived(Boolean(dlState?.scrubPath));
  const hasHq = $derived(Boolean(dlState?.hqPath));
  const mediaBusy = $derived(dlState?.phase === 'running');

  const deleteScrubMutation = createMutation(() => ({
    mutationFn: () => apiClient.deleteScrub(stream.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['download', stream.id] });
      queryClient.invalidateQueries({ queryKey: ['stream', stream.id] });
    },
  }));

  const pieceMutation = createMutation(() => ({
    mutationFn: (kind: 'scrub' | 'hq') => apiClient.downloadPiece(stream.id, kind),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['download', stream.id] }),
  }));

  const dirty = $derived(
    loaded && (
      title !== (stream.title ?? '') ||
      streamer !== (stream.streamer ?? '') ||
      game !== (stream.game ?? '') ||
      vodPath !== (stream.vodPath ?? '') ||
      chatPath !== (stream.chatPath ?? '')
    )
  );

  function save() {
    updateMutation.mutate({
      title: title.trim() || null,
      streamer: streamer.trim() || null,
      game: game.trim() || null,
      vodPath: vodPath.trim(),
      chatPath: chatPath.trim() || null,
    });
  }

  function confirmDelete() {
    deleteMutation.mutate();
  }

  function toggle() {
    open = !open;
  }

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (open && target && !target.closest('[data-project-settings]')) {
      open = false;
    }
  }
</script>

<svelte:window onclick={handleClickOutside} />

<div class="relative" data-project-settings>
  <button
    class="flex h-8 w-8 items-center justify-center rounded-md text-ash transition-colors hover:bg-surface-2 hover:text-ink {open ? 'bg-surface-2 text-ink' : ''}"
    onclick={toggle}
    aria-label="Project settings"
    aria-expanded={open}
  >
    <Icon name="settings" size={16} />
  </button>

  {#if open}
    <div
      class="absolute right-0 top-full z-40 mt-1 w-96 rounded-lg border border-border bg-surface shadow-xl"
      role="dialog"
      aria-label="Project settings"
    >
      <div class="flex flex-col gap-4 p-4">
        <div class="flex items-center justify-between">
          <h3 class="font-display text-sm font-medium">Project Settings</h3>
          {#if saved}
            <span class="font-mono text-xs text-success">✓ Saved</span>
          {/if}
        </div>

        <!-- Metadata -->
        <div class="flex flex-col gap-3">
          <label class="flex flex-col gap-1">
            <span class="font-mono text-xs text-ash">Title</span>
            <input
              type="text"
              bind:value={title}
              class="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </label>
          <div class="flex gap-3">
            <label class="flex flex-1 flex-col gap-1">
              <span class="font-mono text-xs text-ash">Streamer</span>
              <input
                type="text"
                bind:value={streamer}
                class="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
              />
            </label>
            <label class="flex flex-1 flex-col gap-1">
              <span class="font-mono text-xs text-ash">Game</span>
              <input
                type="text"
                bind:value={game}
                class="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
              />
            </label>
          </div>
        </div>

        <!-- File paths -->
        <div class="flex flex-col gap-3 border-t border-border pt-3">
          <span class="font-mono text-xs text-ash uppercase tracking-wider">File Paths</span>
          <label class="flex flex-col gap-1">
            <span class="font-mono text-xs text-ash">Video Path</span>
            <input
              type="text"
              bind:value={vodPath}
              class="rounded-md border border-border bg-surface-2 px-3 py-1.5 font-mono text-xs text-ink focus:border-accent focus:outline-none"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="font-mono text-xs text-ash">Chat Path</span>
            <input
              type="text"
              bind:value={chatPath}
              placeholder="No chat file"
              class="rounded-md border border-border bg-surface-2 px-3 py-1.5 font-mono text-xs text-ink placeholder:text-ash-dim focus:border-accent focus:outline-none"
            />
          </label>
        </div>

        <!-- Media (progressive downloads) -->
        {#if stream.sourceUrl && dlState}
          <div class="flex flex-col gap-2 border-t border-border pt-3">
            <span class="font-mono text-xs text-ash uppercase tracking-wider">Media</span>
            {#if dlState.qualities.length > 0}
              <div class="flex flex-wrap gap-1.5">
                {#each dlState.qualities as q (q.name)}
                  <span class="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] {hasHq && q.height <= 540 ? 'text-ash-dim' : 'text-ash'}">
                    {q.name}
                  </span>
                {/each}
              </div>
            {/if}
            <div class="flex flex-wrap items-center gap-2">
              {#if hasScrub}
                <button
                  class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-ash transition-colors hover:border-error hover:text-error disabled:opacity-50"
                  onclick={() => deleteScrubMutation.mutate()}
                  disabled={mediaBusy || deleteScrubMutation.isPending}
                  title="Delete the 540p scrub file — review then scrubs the full-quality file"
                >
                  <Icon name="trash" size={12} /> Delete LQ scrub
                </button>
              {:else}
                <button
                  class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-ash transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                  onclick={() => pieceMutation.mutate('scrub')}
                  disabled={mediaBusy || pieceMutation.isPending}
                  title="Download a 540p scrub file for fast review"
                >
                  <Icon name="download" size={12} /> Download scrub
                </button>
              {/if}
              {#if !hasHq}
                <button
                  class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-ash transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                  onclick={() => pieceMutation.mutate('hq')}
                  disabled={mediaBusy || pieceMutation.isPending}
                  title="Download the full-quality file (capped by settings)"
                >
                  <Icon name="download" size={12} /> Download HQ
                </button>
              {:else}
                <span class="flex items-center gap-1 font-mono text-[10px] text-success">
                  <Icon name="check" size={11} /> HQ on disk
                </span>
              {/if}
            </div>
            {#if mediaBusy}
              <div class="h-0.5 overflow-hidden rounded-full bg-surface-3">
                <div class="h-full bg-accent transition-all" style="width: {dlState.overall.percent * 100}%"></div>
              </div>
            {/if}
            {#if deleteScrubMutation.isError}
              <p class="font-mono text-[10px] text-error">{deleteScrubMutation.error?.message}</p>
            {:else if pieceMutation.isError}
              <p class="font-mono text-[10px] text-error">{pieceMutation.error?.message}</p>
            {/if}
          </div>
        {/if}

        <!-- Actions -->
        <div class="flex items-center justify-between gap-2 border-t border-border pt-3">
          <button
            class="flex items-center gap-1 rounded-md border border-error/30 px-3 py-1.5 text-xs text-error transition-colors hover:bg-error/10"
            onclick={() => (showDeleteModal = true)}
          >
            <Icon name="trash" size={14} />
            Delete Project
          </button>
          <button
            class="flex items-center gap-1 rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            onclick={save}
            disabled={!dirty || updateMutation.isPending}
          >
            <Icon name="check" size={14} />
            {updateMutation.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>

        {#if updateMutation.isError}
          <div class="rounded-md border border-error bg-surface-2 px-3 py-2 text-xs text-error">
            {updateMutation.error?.message ?? 'Save failed'}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

{#if showDeleteModal}
  <DeleteConfirmModal
    {stream}
    onConfirm={confirmDelete}
    onCancel={() => (showDeleteModal = false)}
  />
{/if}
