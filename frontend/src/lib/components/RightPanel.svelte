<script lang="ts">
  import ChatView from './ChatView.svelte';
  import CandidateQueue from './CandidateQueue.svelte';
  import type { Clip, Stream } from '$shared/types';

  interface Props {
    streamId: string;
    stream: Stream | undefined;
    clips: Clip[];
    currentClipIndex: number;
    snoozed: Set<string>;
    onSelectClip: (index: number) => void;
  }

  let { streamId, stream, clips, currentClipIndex, snoozed, onSelectClip }: Props = $props();

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
  <div class="min-h-0 flex-1 overflow-hidden">
    {#if activeTab === 'clips'}
      <CandidateQueue {clips} {currentClipIndex} {snoozed} {onSelectClip} {streamId} />
    {:else}
      <ChatView {streamId} duration={stream?.duration ?? null} />
    {/if}
  </div>
</div>