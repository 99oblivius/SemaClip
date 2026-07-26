<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import { playerStore, setZoom, pan } from '$lib/stores/player';
  import type { Clip } from '$shared/types';
  import { onMount, onDestroy } from 'svelte';

  interface Props {
    streamId: string;
    duration: number;
    clips: Clip[];
    currentClipId: string | null;
    onSelectClip: (clip: Clip) => void;
    onAdjustEndpoints?: (clip: Clip, start: number, end: number) => void;
  }

  let {
    streamId,
    duration,
    clips,
    currentClipId,
    onSelectClip,
    onAdjustEndpoints,
  }: Props = $props();

  let canvasEl = $state<HTMLCanvasElement | undefined>(undefined);
  let containerEl = $state<HTMLDivElement | undefined>(undefined);
  let rafId = 0;
  let hoveredClip = $state<Clip | null>(null);
  let tooltipX = $state(0);
  let tooltipY = $state(0);
  let isDraggingPlayhead = $state(false);
  let isDraggingEndpoint = $state(false);
  let draggingEndpoint: 'start' | 'end' | null = null;

  // Fetch waveform + chat density in parallel.
  const waveformQuery = createQuery(() => ({
    queryKey: ['waveform', streamId],
    queryFn: () => apiClient.waveform(streamId),
    staleTime: Infinity,
  }));
  const chatQuery = createQuery(() => ({
    queryKey: ['chat-density', streamId],
    queryFn: () => apiClient.chatDensity(streamId),
    staleTime: Infinity,
  }));

  const waveform = $derived(waveformQuery.data?.peaks ?? []);
  const chatDensity = $derived(chatQuery.data?.density ?? []);

  const player = $playerStore;

  // Visible window derived from player state.
  const viewStart = $derived(player.viewStart || 0);
  const viewEnd = $derived(player.viewEnd || duration);
  const viewSpan = $derived(Math.max(1, viewEnd - viewStart));

  function timeToX(t: number): number {
    if (!containerEl) return 0;
    const w = containerEl.clientWidth;
    return ((t - viewStart) / viewSpan) * w;
  }

  function xToTime(x: number): number {
    if (!containerEl) return 0;
    const w = containerEl.clientWidth;
    const t = viewStart + (x / w) * viewSpan;
    return Math.max(0, Math.min(duration, t));
  }

  function draw() {
    const canvas = canvasEl;
    const container = containerEl;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const midY = h / 2;

    // ── Layer 1a: Chat density (area chart below centerline) ──
    if (chatDensity.length > 0) {
      const chatStart = Math.floor(viewStart);
      const chatEnd = Math.ceil(viewEnd);
      const slice = chatDensity.slice(chatStart, chatEnd + 1);
      const maxDensity = Math.max(1, ...slice);
      ctx.fillStyle = 'rgba(46, 46, 58, 0.8)'; // surface-3
      ctx.beginPath();
      ctx.moveTo(0, h);
      slice.forEach((d, i) => {
        const x = (i / Math.max(1, slice.length - 1)) * w;
        const barH = (d / maxDensity) * (h * 0.35);
        ctx.lineTo(x, h - barH);
      });
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();
    }

    // ── Layer 1b: Audio waveform (mirrored vertical fill, centered) ──
    if (waveform.length > 0) {
      const peakStart = Math.floor((viewStart / duration) * waveform.length);
      const peakEnd = Math.ceil((viewEnd / duration) * waveform.length);
      const slice = waveform.slice(peakStart, peakEnd + 1);
      const samplesPerPixel = Math.max(1, Math.floor(slice.length / w));
      ctx.fillStyle = 'rgba(113, 113, 122, 0.6)'; // ash-dim
      const ampH = h * 0.4; // waveform half-height
      for (let x = 0; x < w; x++) {
        const idx = Math.floor((x / w) * slice.length);
        let peak = 0;
        for (let j = 0; j < samplesPerPixel; j++) {
          const v = slice[idx + j] ?? 0;
          if (v > peak) peak = v;
        }
        const barH = peak * ampH;
        ctx.fillRect(x, midY - barH, 1, barH * 2);
      }
    }

    // ── Layer 2: Regime boundaries (faint vertical hairlines) ──
    // Draw at regular intervals as placeholder regime markers.
    ctx.strokeStyle = 'rgba(45, 45, 58, 0.5)'; // border
    ctx.lineWidth = 1;
    const regimeInterval = 300; // every 5 min
    for (let t = Math.ceil(viewStart / regimeInterval) * regimeInterval; t < viewEnd; t += regimeInterval) {
      const x = timeToX(t);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      // Label
      ctx.fillStyle = 'rgba(113, 113, 122, 0.6)';
      ctx.font = '10px JetBrains Mono';
      ctx.fillText(fmtRegime(t), x + 4, 12);
    }

    // ── Layer 3: Clip marks (vertical ticks) ──
    const selectedClip = clips.find((c) => c.id === currentClipId);
    for (const clip of clips) {
      const x = timeToX(clip.peakTime);
      if (x < -10 || x > w + 10) continue;
      const isSelected = clip.id === currentClipId;
      if (isSelected) {
        // Glow behind selected clip
        const grad = ctx.createRadialGradient(x, h / 2, 0, x, h / 2, 40);
        grad.addColorStop(0, 'rgba(204, 0, 0, 0.2)');
        grad.addColorStop(1, 'rgba(204, 0, 0, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(x - 40, 0, 80, h);
        // Full-height tick
        ctx.strokeStyle = '#cc0000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        // Bracket: start/end hairlines
        const startX = timeToX(clip.startTime);
        const endX = timeToX(clip.endTime);
        ctx.strokeStyle = '#cc0000';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(startX, 0);
        ctx.lineTo(startX, h);
        ctx.moveTo(endX, 0);
        ctx.lineTo(endX, h);
        ctx.stroke();
        // Endpoint handles
        ctx.fillStyle = '#cc0000';
        ctx.fillRect(startX - 3, 0, 6, 8);
        ctx.fillRect(endX - 3, 0, 6, 8);
      } else {
        // Non-selected: zinc-400, height proportional to score
        const tickH = 4 + clip.score * (h * 0.4);
        ctx.strokeStyle = hoveredClip?.id === clip.id ? '#a1a1aa' : 'rgba(161, 161, 170, 0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, h - tickH);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }
  }

  function fmtRegime(t: number): string {
    const m = Math.floor(t / 60);
    const h = Math.floor(m / 60);
    return h > 0 ? `${h}h${m % 60}m` : `${m}m`;
  }

  function fmtTime(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function animate() {
    draw();
    rafId = requestAnimationFrame(animate);
  }

  onMount(() => {
    // Initialize view to full VOD.
    playerStore.update((s) => ({
      ...s,
      viewStart: 0,
      viewEnd: duration,
      zoomLevel: 1,
    }));
    animate();
  });

  onDestroy(() => cancelAnimationFrame(rafId));

  // Redraw when data arrives.
  $effect(() => {
    if (waveformQuery.data || chatQuery.data) draw();
  });

  function handleMouseMove(e: MouseEvent) {
    if (!containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    tooltipX = x;
    tooltipY = e.clientY - rect.top;

    if (isDraggingPlayhead) {
      const t = xToTime(x);
      playerStore.update((s) => ({ ...s, currentTime: t, isScrubbing: true }));
      return;
    }

    if (isDraggingEndpoint && selectedClip && onAdjustEndpoints) {
      const t = xToTime(x);
      if (draggingEndpoint === 'start') {
        onAdjustEndpoints(selectedClip, Math.min(t, selectedClip.endTime - 1), selectedClip.endTime);
      } else {
        onAdjustEndpoints(selectedClip, selectedClip.startTime, Math.max(t, selectedClip.startTime + 1));
      }
      return;
    }

    // Hover detection on clip marks.
    const t = xToTime(x);
    let found: Clip | null = null;
    for (const clip of clips) {
      if (Math.abs(clip.peakTime - t) < viewSpan / containerEl.clientWidth * 8) {
        found = clip;
        break;
      }
    }
    hoveredClip = found;
  }

  function handleMouseDown(e: MouseEvent) {
    if (!containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = xToTime(x);

    // Check if clicking on endpoint handle of selected clip.
    const sc = clips.find((c) => c.id === currentClipId);
    if (sc) {
      const startX = timeToX(sc.startTime);
      const endX = timeToX(sc.endTime);
      if (Math.abs(x - startX) < 6) {
        isDraggingEndpoint = true;
        draggingEndpoint = 'start';
        return;
      }
      if (Math.abs(x - endX) < 6) {
        isDraggingEndpoint = true;
        draggingEndpoint = 'end';
        return;
      }
    }

    // Check if clicking on a clip mark.
    for (const clip of clips) {
      if (Math.abs(clip.peakTime - t) < viewSpan / containerEl.clientWidth * 8) {
        onSelectClip(clip);
        return;
      }
    }

    // Otherwise, scrub playhead.
    isDraggingPlayhead = true;
    playerStore.update((s) => ({ ...s, currentTime: t, isScrubbing: true }));
  }

  function handleMouseUp() {
    isDraggingPlayhead = false;
    isDraggingEndpoint = false;
    draggingEndpoint = null;
    playerStore.update((s) => ({ ...s, isScrubbing: false }));
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    if (!containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const centerTime = xToTime(x);
    const factor = e.deltaY > 0 ? 0.8 : 1.25;
    const newZoom = (player.zoomLevel || 1) * factor;
    setZoom(newZoom, duration, centerTime);
  }

  let selectedClip = $derived(clips.find((c) => c.id === currentClipId));
</script>

<div
  bind:this={containerEl}
  class="relative h-full w-full cursor-text select-none"
  role="slider"
  aria-label="Timeline"
  aria-valuemin={0}
  aria-valuemax={duration}
  aria-valuenow={player.currentTime}
  tabindex={0}
  onmousemove={handleMouseMove}
  onmousedown={handleMouseDown}
  onmouseup={handleMouseUp}
  onmouseleave={handleMouseUp}
  onwheel={handleWheel}
>
  <canvas bind:this={canvasEl} class="absolute inset-0 h-full w-full"></canvas>

  <!-- Playhead: 1px red line + triangle cap -->
  <div
    class="pointer-events-none absolute top-0 bottom-0 w-px bg-accent"
    style="left: {timeToX(player.currentTime)}px"
  >
    <div class="absolute -top-0 -left-1.5" style="border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 6px solid #cc0000;"></div>
  </div>

  <!-- Hover tooltip -->
  {#if hoveredClip}
    <div
      class="pointer-events-none absolute z-10 rounded-md border border-border-strong bg-surface-2 px-2 py-1 font-mono text-xs text-ink shadow-lg"
      style="left: {Math.min(tooltipX + 12, (containerEl?.clientWidth ?? 0) - 120)}px; top: {tooltipY + 12}px"
    >
      <span class="text-accent">{hoveredClip.axis.toUpperCase()}</span>
      <span class="text-ash"> · {hoveredClip.score.toFixed(2)}</span>
      <span class="text-ash-dim"> · {fmtTime(hoveredClip.peakTime)}</span>
    </div>
  {/if}

  <!-- Zoom indicator -->
  <div class="pointer-events-none absolute bottom-1 right-2 font-mono text-xs text-ash-dim">
    {player.zoomLevel > 1 ? `${player.zoomLevel.toFixed(0)}×` : '1×'}
  </div>
</div>
