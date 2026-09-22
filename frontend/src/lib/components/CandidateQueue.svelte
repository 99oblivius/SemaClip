<script lang="ts">
  import Icon from './Icon.svelte';
  import type { Clip } from '$shared/types';

  interface Props {
    clips: Clip[];
    currentClipIndex: number;
    /** Clips set aside this session (S, or the rail's snooze button). */
    snoozed: Set<string>;
    onSelectClip: (index: number) => void;
    /** Base URL for clip thumbnails; defaults to the server route. */
    streamId: string;
  }

  let { clips, currentClipIndex, snoozed, onSelectClip, streamId }: Props = $props();

  // ── Key-light (P2 exit gate): the active candidate is the lit row; the gsap
  // keyLight action dims siblings. Applied per-row via class here
  // (CSS dimming) because gsap DOM mutation fights Svelte's keyed each. ──
  // The clip is chosen from a THUMBNAIL of its start: the image shows the clip's first frame, so
  // the playhead must land on that frame and not somewhere inside the clip.
  const activeId = $derived(clips[currentClipIndex]?.id ?? null);

  /**
   * Thumbnail URL for a clip, busted by its start time.
   *
   * The SERVER's cache key already includes the start time, so the correct frame is always what
   * gets read; this query string only stops the browser reusing its own copy of the old image.
   */
  function thumbUrl(clip: Clip): string {
    return `/api/clips/${clip.id}/thumbnail?at=${clip.startTime}`;
  }
</script>

<div class="flex h-full flex-col overflow-hidden">
  <div class="flex items-center justify-between border-b border-border px-3 py-2">
    <span class="font-mono text-xs uppercase tracking-wider text-ash-dim">Candidates</span>
    <!-- A plain count. There was a "reviewed/total" progress readout here, which counted accepts —
         and accepting is gone, so it would have sat permanently at 0 out of N. -->
    <span class="font-mono text-xs text-ash-dim">{clips.length}</span>
  </div>
  <div class="flex-1 overflow-y-auto">
    {#each clips as clip, i (clip.id)}
      <button
        class="flex w-full items-center gap-3 border-l-2 px-3 py-2 text-left transition-all duration-200
        {i === currentClipIndex ? 'border-accent bg-surface-2' : 'border-transparent'}
        {activeId && clip.id !== activeId ? 'opacity-45' : ''}"
        onclick={() => onSelectClip(i)}
      >
        <span class="w-5 font-mono text-xs text-ash-dim">{i + 1}</span>
        <!--
          The frame at the clip's start. A 404 (nothing on disk yet, or the media vanished) is a
          real answer, so the element hides itself rather than showing a broken-image icon or a
          placeholder that implies a frame exists.
        -->
        <img
          src={thumbUrl(clip)}
          alt=""
          class="h-8 w-14 shrink-0 rounded-sm border border-border object-cover"
          loading="lazy"
          onerror={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')}
        />
        <span class="flex-1 truncate font-mono text-xs text-ash">
          <!--
            The clip's NAME if it has one, else its axis, else "manual".
            NOT upper-cased: the name is whatever the user typed, and a CSS `uppercase` here would
            display a differently-cased string than the one that was saved. The axis and the
            fallback are lower-case in the data, so they are upper-cased deliberately to keep
            engine values visually distinct from a user's own name.
          -->
          {clip.title ?? (clip.axis ?? 'manual').toUpperCase()}
        </span>
        {#if snoozed.has(clip.id)}
          <!-- Set aside this session (S). Not an "accepted" mark — accepting does not exist. -->
          <Icon name="clock" size={12} class="text-ash-dim" />
        {/if}
        <!-- Unranked: show a dash, never "0.00" — that reads as a badly-scored detection. -->
        <span class="font-mono text-xs text-ink">
          {clip.score === null ? '—' : clip.score.toFixed(2)}
        </span>
      </button>
    {/each}
    {#if clips.length === 0}
      <div class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <Icon name="waveform" size={32} fill={false} />
        <p class="text-xs text-ash-dim">No clips yet.<br />Process the stream to detect moments, or create one at the playhead.</p>
      </div>
    {/if}
  </div>
</div>
