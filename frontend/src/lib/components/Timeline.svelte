<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import { playerStore, setZoom } from '$lib/stores/player';
  import type { Clip } from '$shared/types';
  import { onMount, onDestroy } from 'svelte';

  interface Props {
    streamId: string;
    duration: number;
    clips: Clip[];
    currentClipId: string | null;
    onSelectClip: (clip: Clip) => void;
    onAdjustEndpoints?: (clip: Clip, start: number, end: number) => void;
    onSeek?: (time: number) => void;
  }

  let {
    streamId,
    duration,
    clips,
    currentClipId,
    onSelectClip,
    onAdjustEndpoints,
    onSeek,
  }: Props = $props();

  let canvasEl = $state<HTMLCanvasElement | undefined>(undefined);
  let containerEl = $state<HTMLDivElement | undefined>(undefined);
  let rafId = 0;
  let hoveredClip = $state<Clip | null>(null);
  let hoverX = $state(-1);           // -1 = not hovering
  let isScrubbing = $state(false);
  let isDraggingEndpoint = $state(false);
  let draggingEndpoint: 'start' | 'end' | null = null;

  // ── Streaming waveform via SSE, managed by $effect ──
  // Pre-allocate empty; resized when the server sends totalPeaks.
  let waveformPeaks = $state<number[]>([]);
  let waveformDuration = $state(0);
  let waveformTotalPeaks = $state(0);

  // Fetch waveform once on mount. The server caches the computed peaks,
  // so there's no need to reconnect on seek — all peaks arrive in one stream.
  let readerRef: ReadableStreamDefaultReader<Uint8Array> | null = null;

  $effect(() => {
    if (!streamId) return;
    const ctrl = new AbortController();

    (async () => {
      try {
        const res = await fetch(`/api/streams/${streamId}/waveform`, {
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) return;

        // If a new effect cleanup ran while fetch was in flight, abort.
        if (ctrl.signal.aborted) return;

        const reader = res.body.getReader();
        readerRef = reader;
        const decoder = new TextDecoder();
        let buffer = '';
        let duration = 0;
        let totalPeaks = 0;
        // Non-reactive accumulator — mutated in place, synced to $state per batch.
        let acc = waveformPeaks;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop()!;
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              try {
                const data = JSON.parse(line.slice(6));
                if (data.totalPeaks) {
                  totalPeaks = data.totalPeaks;
                  if (acc.length < totalPeaks) {
                    acc = new Array(totalPeaks).fill(-1);
                    // Push existing waveformPeaks into acc if sizes differ.
                    for (let i = 0; i < waveformPeaks.length && i < acc.length; i++) {
                      acc[i] = waveformPeaks[i] ?? -1;
                    }
                  }
                }
                if (data.firstIndex !== undefined && data.peaks) {
                  // Mutate the non-reactive accumulator directly — no copy.
                  for (let i = 0; i < data.peaks.length; i++) {
                    acc[data.firstIndex + i] = data.peaks[i];
                  }
                  // Sync to reactive state for rendering. Batching by BATCH_SIZE
                  // means one re-render per batch, not per peak.
                  waveformPeaks = [...acc];
                }
                if (data.done) continue;
                waveformDuration = duration;
                waveformTotalPeaks = totalPeaks;
              } catch { /* skip malformed */ }
            }
          }
        } finally {
          readerRef = null;
          try { reader.releaseLock(); } catch { /* ok */ }
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    })();

    return () => {
      ctrl.abort();                  // abort in-flight fetch
      readerRef?.cancel().catch(() => {}); // force-close established SSE reader
    };
  });

  const chatQuery = createQuery(() => ({
    queryKey: ['chat-density', streamId],
    queryFn: () => apiClient.chatDensity(streamId),
    staleTime: Infinity,
  }));

  const waveform = $derived(waveformPeaks);
  const chatDensity = $derived(chatQuery.data?.density ?? []);
  const player = $derived($playerStore);
  const viewStart = $derived(player.viewStart || 0);
  const viewEnd = $derived(player.viewEnd || duration);
  const viewSpan = $derived(Math.max(1, viewEnd - viewStart));
  function xToTime(x: number): number {
    if (!containerEl) return 0;
    const w = containerEl.clientWidth;
    const t = viewStart + (x / w) * viewSpan;
    return Math.max(0, Math.min(duration, t));
  }

  function timeToX(t: number): number {
    if (!containerEl) return 0;
    return ((t - viewStart) / viewSpan) * containerEl.clientWidth;
  }
  const selectedClip = $derived(clips.find((c) => c.id === currentClipId));

  /** Hit-test: is the cursor near an endpoint handle of the selected clip? */
  function endpointAt(x: number): 'start' | 'end' | null {
    if (!selectedClip) return null;
    const startX = timeToX(selectedClip.startTime);
    const endX = timeToX(selectedClip.endTime);
    if (Math.abs(x - startX) < 7) return 'start';
    if (Math.abs(x - endX) < 7) return 'end';
    return null;
  }

  /** Hit-test: is the cursor near a clip mark? */
  function clipAt(t: number): Clip | null {
    const threshold = viewSpan / (containerEl?.clientWidth ?? 1) * 8;
    for (const clip of clips) {
      if (Math.abs(clip.peakTime - t) < threshold) return clip;
    }
    return null;
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

    // ── Chat density (area chart) ──
    // Aggregate per-second density to pixel resolution so detail survives
    // at any zoom level. When zoomed out, many seconds per pixel → sum.
    // When zoomed in, one second per pixel or finer → exact.
    if (chatDensity.length > 0) {
      const barWidth = 2;
      const numBars = Math.max(1, Math.floor(w / barWidth));
      const secPerBar = viewSpan / numBars;
      const maxDensity = Math.max(1, ...chatDensity.slice(
        Math.max(0, Math.floor(viewStart)),
        Math.min(chatDensity.length, Math.ceil(viewEnd) + 1),
      ));
      ctx.fillStyle = 'rgba(46, 46, 58, 0.8)';
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let b = 0; b <= numBars; b++) {
        const tStart = viewStart + b * secPerBar;
        const tEnd = tStart + secPerBar;
        // Sum messages in this time window.
        const sIdx = Math.max(0, Math.floor(tStart));
        const eIdx = Math.min(chatDensity.length - 1, Math.floor(tEnd));
        let sum = 0;
        for (let i = sIdx; i <= eIdx; i++) sum += chatDensity[i] ?? 0;
        const x = b * barWidth;
        const barH = (sum / maxDensity) * (h * 0.3);
        ctx.lineTo(x, h - barH);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();
    }

    if (waveform.some((v) => v >= 0)) {
      const totalPeaks = waveformTotalPeaks || waveform.length;
      // Peak i holds max amplitude of second [i, i+1). Drawn at bucket END
      // (time i+1) so the bar appears after the audio it represents.
      const peakDur = duration / totalPeaks;
      const barWidth = 2;
      const numBars = Math.max(1, Math.floor(w / barWidth));
      const secPerBar = viewSpan / numBars;

      ctx.fillStyle = 'rgba(113, 113, 122, 0.55)';
      const ampH = h * 0.35;
      for (let b = 0; b < numBars; b++) {
        const barTime = viewStart + b * secPerBar;
        // Peak whose bucket ENDS at barTime: index = barTime/peakDur - 1.
        // Range of peaks whose end-time falls in [barTime, barTime+secPerBar).
        const s = Math.max(0, Math.floor(barTime / peakDur) - 1);
        const e = Math.min(waveform.length - 1, Math.ceil((barTime + secPerBar) / peakDur) - 1);
        let peak = 0;
        for (let i = s; i <= e; i++) {
          const v = waveform[i] ?? -1;
          if (v >= 0 && v > peak) peak = v;
        }
        const barH = peak * ampH;
        ctx.fillRect(b * barWidth, midY - barH, barWidth, barH * 2);
      }
    }

    // ── Time axis (adaptive tick spacing) ──
    ctx.strokeStyle = 'rgba(45, 45, 58, 0.4)';
    ctx.lineWidth = 1;
    ctx.font = '10px JetBrains Mono';
  ctx.fillStyle = 'rgba(161, 161, 170, 0.7)';
    ctx.textBaseline = 'top';

    // Pick a "nice" interval so labels never overlap. Target ~80px between labels.
    const minLabelPx = 80;
    const targetTicks = Math.max(2, Math.floor(w / minLabelPx));
    const rawStep = viewSpan / targetTicks;
    // Snap to a nice value: 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600…
    const niceSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];
    let step = niceSteps[niceSteps.length - 1] ?? 3600;
    for (const s of niceSteps) {
      if (s >= rawStep) { step = s; break; }
    }

    // Draw ticks + labels
    const firstTick = Math.ceil(viewStart / step) * step;
    let lastLabelEnd = -Infinity;
    for (let t = firstTick; t <= viewEnd; t += step) {
      const x = timeToX(t);
      // Hairline
      ctx.strokeStyle = 'rgba(45, 45, 58, 0.4)';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();

      // Label — only if it doesn't overlap the previous one
      const label = fmtTick(t, step);
      const labelW = ctx.measureText(label).width;
      const labelX = Math.max(2, Math.min(x + 4, w - labelW - 2));
      if (labelX < lastLabelEnd + 4) continue; // skip overlapping label
      ctx.fillText(label, labelX, 2);
      lastLabelEnd = labelX + labelW;
    }

    // ── Clip marks ──
    for (const clip of clips) {
      const x = timeToX(clip.peakTime);
      if (x < -10 || x > w + 10) continue;
      const isSelected = clip.id === currentClipId;
      if (isSelected) {
        // Selected clip bracket + glow
        const grad = ctx.createRadialGradient(x, h / 2, 0, x, h / 2, 40);
        grad.addColorStop(0, 'rgba(204, 0, 0, 0.15)');
        grad.addColorStop(1, 'rgba(204, 0, 0, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(x - 40, 0, 80, h);
        // Peak tick
        ctx.strokeStyle = '#cc0000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        // Start/end bracket
        const startX = timeToX(clip.startTime);
        const endX = timeToX(clip.endTime);
        ctx.strokeStyle = 'rgba(204, 0, 0, 0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(startX, 0);
        ctx.lineTo(startX, h);
        ctx.moveTo(endX, 0);
        ctx.lineTo(endX, h);
        ctx.stroke();
        // Endpoint handles (drawn in HTML for better hit targets)
      } else {
        // Non-selected: zinc tick, height ∝ score
        const tickH = 4 + clip.score * (h * 0.35);
        const isHovered = hoveredClip?.id === clip.id;
        ctx.strokeStyle = isHovered ? '#a1a1aa' : 'rgba(161, 161, 170, 0.5)';
        ctx.lineWidth = isHovered ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(x, h - tickH);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }

    // ── Hover cursor line (seek preview) ──
    if (hoverX >= 0 && !isDraggingEndpoint) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hoverX, 0);
      ctx.lineTo(hoverX, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── Playhead (2px line + triangle cap, pixel-snapped on canvas) ──
    const px = Math.round(timeToX(player.currentTime)); // integer, left edge of 2px line
    ctx.fillStyle = '#cc0000';
    ctx.fillRect(px, 0, 2, h);           // line at px..px+2, centre px+1
    ctx.beginPath();                       // 8px triangle centred on px+1
    ctx.moveTo(px - 3, 0);
    ctx.lineTo(px + 5, 0);
    ctx.lineTo(px + 1, 6);
    ctx.closePath();
    ctx.fill();
  }

  /** Format a tick label. Uses the step to pick the right precision:
   *  - step < 60s: show seconds (e.g. "2:14" or "0:45")
   *  - step < 3600s: show minutes (e.g. "5:00" or "42:00")
   *  - step >= 3600s: show hours+minutes (e.g. "1:30:00" or "2:00:00")
   *  All zero-padded for alignment. */
  function fmtTick(t: number, step: number): string {
    const totalSec = Math.round(t);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const hh = String(h).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    if (step >= 3600) return `${hh}:${mm}:00`;
    if (step >= 60) return `${hh}:${mm}`;
    return `${mm}:${ss}`;
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
    playerStore.update((s) => ({
      ...s,
      viewStart: 0,
      viewEnd: duration,
      zoomLevel: 1,
    }));
    animate();
  });

  onDestroy(() => cancelAnimationFrame(rafId));

  $effect(() => {
    waveformPeaks; chatQuery.data;
    draw();
  });

  // ── Unified mouse handling ──
  // Default: seek/scrub. Click clip mark: select. Hover endpoint handle: drag.

  function getMouseX(e: MouseEvent): number {
    if (!containerEl) return 0;
    return e.clientX - containerEl.getBoundingClientRect().left;
  }

  function handleMouseMove(e: MouseEvent) {
    const x = getMouseX(e);
    hoverX = x;
    const t = xToTime(x);

    if (isScrubbing) {
      // Live-seek while dragging — immediate feedback.
      if (onSeek) onSeek(t);
      playerStore.update((s) => ({ ...s, currentTime: t, isScrubbing: true }));
      return;
    }

    if (isDraggingEndpoint && selectedClip && onAdjustEndpoints) {
      if (draggingEndpoint === 'start') {
        onAdjustEndpoints(selectedClip, Math.min(t, selectedClip.endTime - 1), selectedClip.endTime);
      } else {
        onAdjustEndpoints(selectedClip, selectedClip.startTime, Math.max(t, selectedClip.startTime + 1));
      }
      return;
    }

    // Hover detection: endpoints first, then clip marks.
    const ep = endpointAt(x);
    if (ep && containerEl) {
      containerEl.style.cursor = 'ew-resize';
      hoveredClip = null;
      return;
    }
    const clip = clipAt(t);
    if (containerEl) {
      containerEl.style.cursor = clip ? 'pointer' : 'text';
    }
    hoveredClip = clip;
  }

  function handleMouseDown(e: MouseEvent) {
    const x = getMouseX(e);
    const t = xToTime(x);

    // 1. Endpoint drag?
    const ep = endpointAt(x);
    if (ep) {
      isDraggingEndpoint = true;
      draggingEndpoint = ep;
      return;
    }

    // 2. Clip mark click? Select it (don't seek).
    const clip = clipAt(t);
    if (clip) {
      onSelectClip(clip);
      return;
    }

    // 3. Otherwise: seek immediately + begin scrub.
    isScrubbing = true;
    if (onSeek) onSeek(t);
    playerStore.update((s) => ({ ...s, currentTime: t, isScrubbing: true }));
  }

  function handleMouseUp() {
    isScrubbing = false;
    isDraggingEndpoint = false;
    draggingEndpoint = null;
    playerStore.update((s) => ({ ...s, isScrubbing: false }));
  }

  function handleMouseLeave() {
    hoverX = -1;
    hoveredClip = null;
    handleMouseUp();
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    if (!containerEl) return;
    const x = getMouseX(e);
    const centerTime = xToTime(x);
    const factor = e.deltaY > 0 ? 0.8 : 1.25;
    const newZoom = (player.zoomLevel || 1) * factor;
    setZoom(newZoom, duration, centerTime);
  }

  // Endpoint handle positions for HTML overlay
  const selectedStartX = $derived(selectedClip ? timeToX(selectedClip.startTime) : -1);
  const selectedEndX = $derived(selectedClip ? timeToX(selectedClip.endTime) : -1);
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
  onmouseleave={handleMouseLeave}
  onwheel={handleWheel}
>
  <canvas bind:this={canvasEl} class="absolute inset-0 h-full w-full"></canvas>


  <!-- Endpoint handles for selected clip (HTML for better hit targets) -->
  {#if selectedClip && selectedStartX >= 0}
    <div
      class="absolute top-0 h-full w-2 -translate-x-1/2 cursor-ew-resize"
      style="left: {selectedStartX}px"
      role="button"
      aria-label="Drag clip start"
      tabindex={0}
    ></div>
    <div
      class="absolute top-0 h-full w-2 -translate-x-1/2 cursor-ew-resize"
      style="left: {selectedEndX}px"
      role="button"
      aria-label="Drag clip end"
      tabindex={0}
    ></div>
  {/if}

  <!-- Hover tooltip: time preview + clip info -->
  {#if hoverX >= 0}
    <div
      class="pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border border-border-strong bg-surface-2 px-2 py-1 font-mono text-xs text-ink shadow-lg"
      style="left: {Math.min(Math.max(hoverX, 60), (containerEl?.clientWidth ?? 0) - 60)}px; top: 2px;"
    >
      {#if hoveredClip}
        <span class="text-accent">{hoveredClip.axis.toUpperCase()}</span>
        <span class="text-ash"> · {hoveredClip.score.toFixed(2)} · </span>
        <span class="text-ash-dim">{fmtTime(hoveredClip.peakTime)}</span>
      {:else}
        <span class="text-ash">{fmtTime(xToTime(hoverX))}</span>
      {/if}
    </div>
  {/if}

  <!-- Zoom indicator -->
  <div class="pointer-events-none absolute bottom-0.5 right-1.5 font-mono text-xs text-ash-dim/60">
    {player.zoomLevel > 1 ? `${player.zoomLevel.toFixed(0)}×` : ''}
  </div>
</div>
