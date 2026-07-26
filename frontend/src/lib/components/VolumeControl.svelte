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

  /** Animate the slider open/closed on hover. Slider is to the LEFT of the icon. */
  $effect(() => {
    if (!sliderEl) return;
    if (isHovering || isDragging) {
      gsap.to(sliderEl, { width: 80, opacity: 1, duration: 0.2, ease: 'power2.out' });
    } else {
      gsap.to(sliderEl, { width: 0, opacity: 0, duration: 0.2, ease: 'power2.in' });
    }
  });

  function handleSliderClick(e: MouseEvent) {
    if (!sliderEl) return;
    const rect = sliderEl.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onVolume(pct);
  }

  function handleSliderMove(e: MouseEvent) {
    if (!isDragging || !sliderEl) return;
    const rect = sliderEl.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onVolume(pct);
  }

  function handleMouseDown(e: MouseEvent) {
    e.stopPropagation();
    isDragging = true;
    handleSliderClick(e);
  }

  function handleMouseUp() {
    isDragging = false;
  }
</script>

<svelte:window onmouseup={handleMouseUp} onmousemove={handleSliderMove} />

<!-- Slider is to the LEFT of the icon. The icon stays fixed; the slider
     expands leftward so clicking the icon always toggles mute. -->
<div
  class="flex items-center justify-end gap-2"
  role="group"
  aria-label="Volume control"
  onmouseenter={() => (isHovering = true)}
  onmouseleave={() => (isHovering = false)}
>
  <div
    bind:this={sliderEl}
    class="relative h-1 cursor-pointer overflow-hidden rounded-full bg-white/20"
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
