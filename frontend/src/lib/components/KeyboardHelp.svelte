<script lang="ts">
  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  const groups: { title: string; keys: { key: string; action: string }[] }[] = [
    {
      title: 'Playback',
      keys: [
        { key: 'Space', action: 'Play / pause current clip' },
        { key: 'J / K', action: 'Previous / next clip' },
        { key: '← / →', action: 'Seek ±5 seconds' },
        { key: ', / .', action: 'Frame step (±1 frame)' },
        { key: 'Shift+, / Shift+.', action: 'Step ±1 second' },
        { key: 'M', action: 'Mute / unmute video' },
        { key: 'F', action: 'Toggle fullscreen video' },
      ],
    },
    {
      title: 'Timeline',
      keys: [
        { key: 'Click', action: 'Seek to position (timeline is the scrub bar)' },
        { key: 'Drag', action: 'Scrub through video' },
        { key: 'Hover', action: 'Preview cursor + time tooltip' },
        { key: 'Click clip mark', action: 'Select clip (does not seek)' },
        { key: 'Drag handles', action: 'Adjust clip endpoints' },
        { key: 'C', action: 'Frame timeline to selected clip bounds' },
        { key: '+ / -', action: 'Zoom timeline in / out' },
        { key: 'Scroll', action: 'Zoom timeline at cursor' },
      ],
    },
    {
      title: 'Clips',
      keys: [
        { key: '1–6', action: 'Toggle axis filters (hype/humor/skill/awk/emot/tens)' },
        { key: 'E', action: 'Export current clip' },
        { key: 'Shift+E', action: 'Export all queued clips' },
        { key: 'D', action: 'Discard clip (marks rejected)' },
        { key: 'U', action: 'Undo discard' },
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
