<script lang="ts">
  import SignalBar from './SignalBar.svelte';
  import Icon from './Icon.svelte';
  import CaptionEditor from './CaptionEditor.svelte';
  import type { Clip } from '$shared/types';

  interface Props {
    clip: Clip;
    clipIndex: number;
    streamId: string;
    onPlay: () => void;
    onExport: () => void;
    onDiscard: () => void;
    onAccept: () => void;
  }

  let { clip, clipIndex, streamId, onPlay, onExport, onDiscard, onAccept }: Props = $props();

  function fmtTime(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
</script>

<div class="mb-3 flex items-center justify-between">
  <div class="flex items-center gap-3">
    <span class="font-mono text-xs text-ash-dim">{String(clipIndex + 1).padStart(2, '0')}</span>
    <span class="font-display text-sm font-medium text-accent uppercase">{clip.axis}</span>
    <span class="font-mono text-sm text-ink">{clip.score.toFixed(2)}</span>
  </div>
  <div class="flex items-center gap-2">
    <button
      class="flex items-center gap-1 rounded-md border border-success/50 px-2 py-1 text-xs text-success transition-colors hover:bg-success/10"
      onclick={onAccept}
      aria-label="Accept clip"
      title="Accept (A) — marks reviewed and advances"
    >
      <Icon name="check" size={12} /> Accept
    </button>
    <button
      class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-ash transition-colors hover:border-border-strong hover:text-ink"
      onclick={onExport}
      aria-label="Export this clip"
    >
      <Icon name="scissors" size={12} /> Export
    </button>
    <button
      class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-ash transition-colors hover:border-error hover:text-error"
      onclick={onDiscard}
      aria-label="Discard clip"
    >
      <Icon name="trash" size={12} /> Discard
    </button>
  </div>
</div>

{#if clip.justification}
  <p class="mb-3 text-sm text-ash leading-relaxed">{clip.justification}</p>
{:else}
  <p class="mb-3 text-sm text-ash-dim italic">No justification provided.</p>
{/if}

<div class="grid grid-cols-3 gap-4">
  <!-- Signals: real engine evidence, or an honest absence. -->
  <div class="col-span-1">
    <div class="mb-2 font-mono text-xs text-ash-dim uppercase">Signals</div>
    {#if clip.signals}
      <div class="flex flex-col gap-1.5">
        <SignalBar label="chat" value={clip.signals.chatExcitement} />
        <SignalBar label="emote" value={clip.signals.emoteVelocity} />
        <SignalBar label="audio" value={clip.signals.audioEnergy} />
        <SignalBar label="speech" value={clip.signals.speechCoverage} />
      </div>
    {:else}
      <div class="text-xs text-ash-dim italic">No signal data from engine.</div>
    {/if}
  </div>

  <!-- Endpoints -->
  <div class="col-span-1">
    <div class="mb-2 font-mono text-xs text-ash-dim uppercase">Endpoints</div>
    <div class="flex flex-col gap-1 font-mono text-xs">
      <div class="flex justify-between"><span class="text-ash-dim">Start</span><span class="text-ink">{fmtTime(clip.startTime)}</span></div>
      <div class="flex justify-between"><span class="text-ash-dim">Peak</span><span class="text-accent">{fmtTime(clip.peakTime)}</span></div>
      <div class="flex justify-between"><span class="text-ash-dim">End</span><span class="text-ink">{fmtTime(clip.endTime)}</span></div>
      <div class="flex justify-between border-t border-border pt-1"><span class="text-ash-dim">Dur</span><span class="text-ink">{(clip.endTime - clip.startTime).toFixed(0)}s</span></div>
    </div>
  </div>

  <!-- Actions -->
  <div class="col-span-1 flex flex-col gap-2">
    <div class="mb-2 font-mono text-xs text-ash-dim uppercase">Actions</div>
    <button
      class="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs text-ash transition-colors hover:border-accent hover:text-accent"
      onclick={onPlay}
    >
      <Icon name="play" size={12} fill /> Play from start
    </button>
    <button
      class="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs text-ash transition-colors hover:border-border-strong hover:text-ink"
      onclick={onExport}
    >
      <Icon name="scissors" size={12} /> Export clip
    </button>
  </div>
</div>

<!-- Captions (P0-8): line-level transcript editing for this clip's window -->
<div class="mt-4 border-t border-border pt-3">
  <CaptionEditor {streamId} clipStart={clip.startTime} clipEnd={clip.endTime} />
</div>