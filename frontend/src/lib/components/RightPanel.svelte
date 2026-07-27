<script lang="ts">
  import Icon from './Icon.svelte';
  import ChatView from './ChatView.svelte';
  import type { Clip, Stream } from '$shared/types';

  interface Props {
    streamId: string;
    stream: Stream | undefined;
    clips: Clip[];
    currentClipIndex: number;
    onSelectClip: (index: number) => void;
  }

  let { streamId, stream, clips, currentClipIndex, onSelectClip }: Props = $props();

  let activeTab = $state<'clips' | 'chat'>('clips');
</script>

<div class="flex w-72 flex-col overflow-hidden rounded-md border border-border bg-surface">
  <!-- Tab header -->
  <div class="flex border-b border-border">
    <button
      class="flex flex-1 items-center justify-center gap-2 px-3 py-2 text-xs font-medium uppercase transition-colors
      {activeTab === 'clips' ? 'text-ink border-b-2 border-accent' : 'text-ash-dim hover:text-ash'}"
      onclick={() => (activeTab = 'clips')}
    >
      Clips
      {#if clips.length > 0}
        <span class="font-mono text-xs text-ash-dim">{clips.length}</span>
      {/if}
    </button>
    <button
      class="flex flex-1 items-center justify-center gap-2 px-3 py-2 text-xs font-medium uppercase transition-colors
      {activeTab === 'chat' ? 'text-ink border-b-2 border-accent' : 'text-ash-dim hover:text-ash'}"
      onclick={() => (activeTab = 'chat')}
    >
      Chat
    </button>
  </div>

  <!-- Tab content -->
  <div class="flex-1 min-h-0 overflow-hidden">
    {#if activeTab === 'clips'}
      <div class="flex h-full flex-col overflow-hidden">
        <div class="flex-1 overflow-y-auto">
          {#each clips as clip, i (clip.id)}
            <button
              class="flex w-full items-center gap-3 border-l-2 px-3 py-2 text-left transition-colors hover:bg-surface-2
              {i === currentClipIndex ? 'border-accent bg-surface-2' : 'border-transparent'}"
              onclick={() => onSelectClip(i)}
            >
              <span class="w-5 font-mono text-xs text-ash-dim">{i + 1}</span>
              <span class="flex-1 font-mono text-xs text-ash uppercase">{clip.axis}</span>
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
    {:else}
      <ChatView {streamId} duration={stream?.duration ?? null} />
    {/if}
  </div>
</div>
