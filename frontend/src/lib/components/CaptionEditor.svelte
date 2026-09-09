<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import Icon from '$lib/components/Icon.svelte';
  import type { TranscriptCue } from '$lib/api/client';

  interface Props {
    streamId: string;
    clipStart: number;
    clipEnd: number;
  }

  let { streamId, clipStart, clipEnd }: Props = $props();

  const transcriptQuery = createQuery(() => ({
    queryKey: ['transcript', streamId],
    queryFn: () => apiClient.getTranscript(streamId),
    enabled: true,
    staleTime: 60_000,
  }));

  const queryClient = useQueryClient();

  // Cues overlapping the clip window, in timeline order.
  const clipCues = $derived(
    (transcriptQuery.data?.cues ?? []).filter(
      (c) => c.end > clipStart && c.start < clipEnd,
    ),
  );

  // Edit buffer: cue index → replacement text. Cleared on stream change.
  let edits = $state<Map<number, string>>(new Map());

  function cueText(cue: TranscriptCue): string {
    return edits.get(cue.index) ?? cue.text;
  }

  function editCue(cue: TranscriptCue, text: string) {
    const next = new Map(edits);
    if (text === cue.text) next.delete(cue.index);
    else next.set(cue.index, text);
    edits = next;
  }

  const editCount = $derived(edits.size);

  const saveMutation = createMutation(() => ({
    mutationFn: () => apiClient.patchTranscript(streamId, [...edits].map(([index, text]) => ({ index, text }))),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transcript', streamId] });
      edits = new Map();
    },
  }));

  function fmt(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function seekTo(sec: number) {
    // Jump the player to just before the cue starts via the component bridge.
    window.dispatchEvent(new CustomEvent('semaclip:seek', { detail: Math.max(0, sec - 0.2) }));
  }
</script>

<div class="flex flex-col gap-2">
  <div class="flex items-center justify-between">
    <span class="font-mono text-xs text-ash-dim uppercase">Captions · {clipCues.length} cues in clip</span>
    {#if editCount > 0}
      <button
        class="flex items-center gap-1 rounded-md border border-accent px-2 py-1 text-xs text-accent transition-colors hover:bg-accent/10 disabled:opacity-50"
        onclick={() => saveMutation.mutate()}
        disabled={saveMutation.isPending}
      >
        <Icon name="check" size={11} />
        {saveMutation.isPending ? 'Saving...' : `Save ${editCount} edit${editCount === 1 ? '' : 's'}`}
      </button>
    {/if}
  </div>

  {#if saveMutation.isError}
    <p class="font-mono text-xs text-error">{saveMutation.error?.message ?? 'Save failed'}</p>
  {:else if saveMutation.isSuccess && editCount === 0}
    <p class="font-mono text-xs text-success">✓ saved</p>
  {/if}

  {#if transcriptQuery.isLoading}
    <p class="text-xs text-ash-dim">Loading transcript...</p>
  {:else if transcriptQuery.isError}
    <p class="text-xs text-ash-dim italic">
      {(transcriptQuery.error as Error)?.message ?? 'No transcript'} — captions need a completed transcription pass.
    </p>
  {:else if clipCues.length === 0}
    <p class="text-xs text-ash-dim italic">No speech transcribed inside this clip's window.</p>
  {:else}
    <div class="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
      {#each clipCues as cue (cue.index)}
        <div class="group flex items-start gap-2 rounded px-1.5 py-1 transition-colors hover:bg-surface-2">
          <button
            class="mt-0.5 shrink-0 font-mono text-[10px] text-ash-dim transition-colors hover:text-accent"
            onclick={() => seekTo(cue.start)}
            title="Jump player here"
          >
            {fmt(cue.start)}
          </button>
          <input
            type="text"
            value={cueText(cue)}
            onchange={(e) => editCue(cue, e.currentTarget.value)}
            class="flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm text-ink transition-colors
            hover:border-border focus:border-accent focus:bg-surface-2 focus:outline-none
            {edits.has(cue.index) ? 'text-warning' : ''}"
            aria-label={`Cue at ${fmt(cue.start)}`}
          />
        </div>
      {/each}
    </div>
  {/if}
</div>