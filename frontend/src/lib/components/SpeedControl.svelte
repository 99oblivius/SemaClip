<script lang="ts">
  interface Props {
    rate: number;
    onRate: (r: number) => void;
  }

  let { rate, onRate }: Props = $props();

  const speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  let trackEl = $state<HTMLDivElement | undefined>(undefined);
  let isHovering = $state(false);
  let isDragging = $state(false);

  function rateFromPos(pos: number): number {
    const idx = Math.round(pos * (speeds.length - 1));
    return speeds[Math.max(0, Math.min(speeds.length - 1, idx))]!;
  }

  function posFromRate(r: number): number {
    const idx = speeds.indexOf(r);
    if (idx < 0) return speeds.indexOf(1)! / (speeds.length - 1);
    return idx / (speeds.length - 1);
  }

  function handleTrackDown(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    isDragging = true;
    if (!trackEl) return;
    const rect = trackEl.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onRate(rateFromPos(pos));
  }

  function handleMouseUp() {
    isDragging = false;
  }

  function handleMouseMove(e: MouseEvent) {
    if (!isDragging || !trackEl) return;
    const rect = trackEl.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onRate(rateFromPos(pos));
  }

  function cycleSpeed() {
    const common = [0.5, 1, 1.5, 2];
    const idx = common.indexOf(rate);
    const next = idx < 0 || idx >= common.length - 1 ? common[0]! : common[idx + 1]!;
    onRate(next);
  }
</script>

<svelte:window onmouseup={handleMouseUp} onmousemove={handleMouseMove} />

<div
  class="flex items-center"
  role="group"
  aria-label="Playback speed"
  onmouseenter={() => (isHovering = true)}
  onmouseleave={() => (isHovering = false)}
>
  <div class="w-20 h-7 shrink-0 flex items-center justify-end">
    <div
      bind:this={trackEl}
      class="relative h-1 rounded-full bg-white/20 cursor-pointer"
      style="width: {isHovering || isDragging ? '80px' : '0px'};
             opacity: {isHovering || isDragging ? 1 : 0};
             transition: width 0.2s ease-out, opacity 0.2s ease-out;"
      onmousedown={handleTrackDown}
      role="slider"
      tabindex={0}
      aria-label="Speed"
      aria-valuemin={0.5}
      aria-valuemax={2}
      aria-valuenow={rate}
    >
      <div
        class="absolute inset-y-0 left-0 rounded-full bg-white"
        style="width: {posFromRate(rate) * 100}%"
      ></div>
      <div
        class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-2.5 rounded-full bg-white shadow"
        style="left: {posFromRate(rate) * 100}%"
      ></div>
    </div>
  </div>

  <button
    onclick={cycleSpeed}
    class="shrink-0 w-9 text-center font-mono text-xs text-white/70 hover:text-white transition-colors"
    aria-label="Speed: {rate}&#215;"
  >
    {rate}&#215;
  </button>
</div>
