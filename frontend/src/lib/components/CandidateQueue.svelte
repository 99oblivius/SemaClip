<script lang="ts">
  import Icon from './Icon.svelte';
  import type { Clip } from '$shared/types';

  interface Props {
    clips: Clip[];
    currentClipIndex: number;
    reviewed: Set<string>;
    onSelectClip: (index: number) => void;
  }

  let { clips, currentClipIndex, reviewed, onSelectClip }: Props = $props();

  // Review progress pinned at the queue top (P0-11 made visible).
  const reviewedCount = $derived(clips.filter((c) => reviewed.has(c.id)).length);
</script>

<div class="flex h-full flex-col overflow-hidden">
  <div class="flex items-center justify-between border-b border-border px-3 py-2">
    <span class="font-mono text-xs uppercase tracking-wider text-ash-dim">Candidates</span>
    <span class="font-mono text-xs {reviewedCount === clips.length && clips.length > 0 ? 'text-success' : 'text-ash-dim'}">
      ◉ {reviewedCount}/{clips.length}
    </span>
  </div>
  <div class="flex-1 overflow-y-auto">
    {#each clips as clip, i (clip.id)}
      <button
        class="flex w-full items-center gap-3 border-l-2 px-3 py-2 text-left transition-colors hover:bg-surface-2
        {i === currentClipIndex ? 'border-accent bg-surface-2' : 'border-transparent'}"
        onclick={() => onSelectClip(i)}
      >
        <span class="w-5 font-mono text-xs text-ash-dim">{i + 1}</span>
        <span class="flex-1 font-mono text-xs text-ash uppercase">{clip.axis}</span>
        {#if reviewed.has(clip.id)}
          <Icon name="check" size={12} class="text-success" />
        {/if}
        <span class="font-mono text-xs text-ink">{clip.score.toFixed(2)}</span>
      </button>
    {/each}
    {#if clips.length === 0}
      <div class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <Icon name="waveform" size={32} fill={false} />
        <p class="text-xs text-ash-dim">No clips found yet.<br />Process the stream to detect moments.</p>
      </div>
    {/if}
  </div>
</div>