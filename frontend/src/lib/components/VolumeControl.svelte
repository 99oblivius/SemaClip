<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';

  interface Props {
    volume: number;
    muted: boolean;
    onVolume: (v: number) => void;
    onToggleMute: () => void;
  }

  let { volume, muted, onVolume, onToggleMute }: Props = $props();

  let trackEl = $state<HTMLDivElement | undefined>(undefined);
  let isHovering = $state(false);
  let isDragging = $state(false);

  function sliderPos(e: MouseEvent): number {
    if (!trackEl) return 0;
    const rect = trackEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  function handleTrackDown(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    isDragging = true;
    onVolume(sliderPos(e));
  }

  function handleMouseUp() {
    isDragging = false;
  }

  function handleMouseMove(e: MouseEvent) {
    if (!isDragging) return;
    onVolume(sliderPos(e));
  }
</script>

<svelte:window onmouseup={handleMouseUp} onmousemove={handleMouseMove} />

<div
  class="flex items-center"
  role="group"
  aria-label="Volume control"
  onmouseenter={() => (isHovering = true)}
  onmouseleave={() => (isHovering = false)}
>
  <div class="w-20 h-7 shrink-0 flex items-center justify-end">
    <div
      bind:this={trackEl}
      class="h-1 rounded-full bg-white/20 cursor-pointer"
      style="width: {isHovering || isDragging ? '80px' : '0px'};
             opacity: {isHovering || isDragging ? 1 : 0};
             transition: width 0.2s ease-out, opacity 0.2s ease-out;"
      onmousedown={handleTrackDown}
      role="slider"
      tabindex={0}
      aria-label="Volume"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round((muted ? 0 : volume) * 100)}
    >
      <div
        class="h-full rounded-full bg-white"
        style="width: {muted ? 0 : volume * 100}%"
      ></div>
    </div>
  </div>

  <button
    onclick={onToggleMute}
    class="shrink-0 -ml-1 text-white/70 transition-colors hover:text-white"
    aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}
  >
    <Icon name={muted || volume === 0 ? 'volume-mute' : 'volume'} size={18} />
  </button>
</div>
