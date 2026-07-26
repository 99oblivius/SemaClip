<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import { gsap } from 'gsap';

  interface Props {
    volume: number;
    muted: boolean;
    onVolume: (v: number) => void;
    onToggleMute: () => void;
  }

  let { volume, muted, onVolume, onToggleMute }: Props = $props();

  let sliderEl = $state<HTMLDivElement | undefined>(undefined);
  let isHovering = $state(false);
  let isDragging = $state(false);

  $effect(() => {
    if (!sliderEl) return;
    if (isHovering || isDragging) {
      gsap.to(sliderEl, { width: 80, opacity: 1, duration: 0.2, ease: 'power2.out' });
    } else {
      gsap.to(sliderEl, { width: 0, opacity: 0, duration: 0.2, ease: 'power2.in' });
    }
  });

  function sliderPos(e: MouseEvent): number {
    if (!sliderEl) return 0;
    const rect = sliderEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  function handleMouseDown(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
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

<!-- Slider is absolutely positioned to the LEFT of the button.
     The button stays fixed — no layout shift on hover. -->
<div
  class="relative flex items-center"
  role="group"
  aria-label="Volume control"
  onmouseenter={() => (isHovering = true)}
  onmouseleave={() => (isHovering = false)}
>
  <div
    bind:this={sliderEl}
    class="absolute right-full mr-2 top-1/2 -translate-y-1/2 h-1 cursor-pointer overflow-hidden rounded-full bg-white/20"
    style="width: 0px; opacity: 0;"
    onmousedown={handleMouseDown}
    role="slider"
    tabindex={0}
    aria-label="Volume"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round((muted ? 0 : volume) * 100)}
  >
    <div
      class="absolute inset-y-0 left-0 rounded-full bg-white"
      style="width: {muted ? 0 : volume * 100}%"
    ></div>
  </div>

  <button
    onclick={onToggleMute}
    class="shrink-0 text-white/70 transition-colors hover:text-white"
    aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}
  >
    <Icon name={muted || volume === 0 ? 'volume-mute' : 'volume'} size={18} />
  </button>
</div>
