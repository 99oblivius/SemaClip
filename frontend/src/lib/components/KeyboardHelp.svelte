<script lang="ts">
  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  /**
   * Every row here must correspond to something the code actually does.
   *
   * This overlay had drifted from `handleKey` (and from the mouse handling in Timeline.svelte) in
   * both directions, and both are user-visible lies:
   *
   *  - `A` (accept) was documented and is handled NOWHERE — the branch went with the Accept button.
   *  - `Enter (on marker)` never existed: Timeline.svelte has no keydown handler at all, and marker
   *    jump is a mouse CLICK (markerClick is called only from handleMouseDown).
   *  - `[` / `]` and `N` are real and were not listed.
   *
   * The mouse rows are kept, because a reader looking for "how do I jump to a marker" needs the
   * answer to be here — but they are their own group, labelled as mouse, rather than sitting among
   * keys under a "Timeline" heading that implied every row was a shortcut.
   *
   * `Q` was documented as "Hide / show snoozed clips" and is REMOVED (owner's request). It was dead
   * twice over in the code: `handleKey` has no `q` branch at all, and the state it drove,
   * `unreviewedOnly`, is initialised `false` and NEVER assigned anywhere else in the page — so the
   * key could not hide anything even if the branch came back. Snoozing still works and is still
   * visible: snoozed clips sort to the END of the queue (`visibleClips`), so the row says "Snooze
   * clip to queue end" rather than promising a filter that does not exist.
   */
  const groups: { title: string; keys: { key: string; action: string }[] }[] = [
    {
      title: 'Playback',
      keys: [
        { key: 'Space', action: 'Play / pause current clip' },
        { key: 'J / K', action: 'Previous / next clip' },
        { key: '← / →', action: 'Seek ±5 seconds' },
        { key: 'Shift+← / →', action: 'Seek ±1 second' },
        { key: ', / .', action: 'Frame step (±1 frame)' },
        { key: 'Shift+, / Shift+.', action: 'Step ±1 second' },
        { key: 'M', action: 'Mute / unmute video' },
        { key: 'F', action: 'Toggle fullscreen video' },
      ],
    },
    {
      title: 'Clips',
      keys: [
        { key: 'N', action: 'New clip at the playhead' },
        { key: 'I / O', action: 'Set clip in / out at playhead' },
        { key: '[ / ]', action: 'Same as I / O — the clip-editor keys' },
        { key: 'D', action: 'Discard clip (marks rejected)' },
        { key: 'U', action: 'Undo discard' },
        { key: 'S', action: 'Snooze clip to queue end' },
        { key: 'Ctrl+Z', action: 'Undo endpoint edit' },
        { key: 'Ctrl+Shift+Z', action: 'Redo endpoint edit' },
        { key: 'E', action: 'Send current clip to the export list' },
        { key: 'Shift+E', action: 'Send every clip to the export list' },
      ],
    },
    {
      title: 'Filters & zoom',
      keys: [
        { key: '1–7', action: 'Toggle axis filters (hype/humor/skill/awkward/emotional/tension/reaction)' },
        { key: '+ / -', action: 'Zoom timeline in / out' },
      ],
    },
    {
      title: 'Timeline (mouse)',
      keys: [
        { key: 'Left click', action: 'Seek to position' },
        { key: 'Left drag', action: 'Drag the playhead (continues past the edge)' },
        { key: 'Middle drag', action: 'Pan the timeline, without moving the playhead' },
        { key: 'Click clip mark', action: 'Select clip (does not seek)' },
        { key: 'Drag handles', action: 'Adjust clip endpoints' },
        { key: 'Click a flag', action: 'Jump to an external marker' },
        { key: 'Scroll', action: 'Zoom the timeline at the cursor' },
      ],
    },
    {
      title: 'Navigation',
      keys: [
        { key: '?', action: 'Show this overlay' },
        { key: 'Esc', action: 'Close overlay / back to library' },
      ],
    },
  ];
</script>

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
  onclick={onClose}
  onkeydown={(e) => e.key === 'Escape' && onClose()}
  role="button"
  tabindex="-1"
>
  <div
    class="w-full max-w-2xl rounded-lg border border-border bg-surface p-6"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
    role="dialog"
    aria-label="Keyboard shortcuts"
    tabindex="-1"
  >
    <div class="mb-4 flex items-center justify-between">
      <h2 class="font-display text-lg font-medium">Keyboard Shortcuts</h2>
      <button onclick={onClose} class="text-ash hover:text-ink" aria-label="Close">
        ✕
      </button>
    </div>
    <div class="grid grid-cols-2 gap-x-8 gap-y-6">
      {#each groups as group}
        <div>
          <h3 class="mb-2 font-mono text-xs text-accent uppercase tracking-wider">{group.title}</h3>
          <div class="flex flex-col gap-1">
            {#each group.keys as entry}
              <div class="flex items-center justify-between gap-3">
                <kbd class="rounded border border-border-strong bg-surface-2 px-2 py-0.5 font-mono text-xs text-ink">{entry.key}</kbd>
                <span class="text-right text-xs text-ash">{entry.action}</span>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </div>
</div>