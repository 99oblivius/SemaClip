<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import { downloadsQuery, viewFor } from '$lib/api/downloads';
  import { pan as panStore, playerStore, setZoom } from '$lib/stores/player';
  import type { Clip } from '$shared/types';
  import { onMount, onDestroy } from 'svelte';

  interface Props {
    streamId: string;
    duration: number;
    clips: Clip[];
    currentClipId: string | null;
    onSelectClip: (clip: Clip) => void;
    /**
     * Live endpoint changes while a drag is in progress. `commit` is false for every
     * frame of the drag and the caller must NOT push an undo entry for it.
     */
    onAdjustEndpoints?: (clip: Clip, start: number, end: number, commit?: boolean) => void;
    /**
     * The drag ENDED: push ONE undo entry spanning it, from the range captured when the
     * drag began. Separate from `onAdjustEndpoints` because the pre-drag range only
     * exists at press time — by release the live updates have overwritten it.
     */
    onCommitEndpoints?: (clipId: string, before: { startTime: number; endTime: number }) => void;
    onSeek?: (time: number) => void;
  }

  let {
    streamId,
    duration,
    clips,
    currentClipId,
    onSelectClip,
    onAdjustEndpoints,
    onCommitEndpoints,
    onSeek,
  }: Props = $props();

  // ── Markers layer (P0-6): external shortlist evidence (Twitch chapters /
  // user markers). Fetched once; rendered as hairline flags with tooltips.
  const markersQuery = createQuery(() => ({
    queryKey: ['markers', streamId],
    queryFn: () => apiClient.getMarkers(streamId),
    staleTime: Infinity, // markers are static per VOD
  }));
  let markers = $derived(markersQuery.data?.markers ?? [] as { t: number; label: string; source: string }[]);
  type Marker = { t: number; label: string; source: string };
  let hoveredMarker = $state<Marker | null>(null);

  // ── Regimes layer: persisted segmentation boundaries (lull/gameplay/
  // chatting/hype). Static per job run; drawn as a top-edge tint band. ──
  const regimesQuery = createQuery(() => ({
    queryKey: ['regimes', streamId],
    queryFn: () => apiClient.getRegimes(streamId),
    staleTime: Infinity,
  }));
  type Regime = { start: number; end: number; type: string };
  let regimes = $derived(regimesQuery.data?.regimes ?? [] as Regime[]);
  const REGIME_COLORS: Record<string, string> = {
    lull: 'rgba(100, 116, 139, 0.25)',
    gameplay: 'rgba(100, 116, 139, 0.08)',
    chatting: 'rgba(56, 189, 248, 0.15)',
    hype: 'rgba(204, 0, 0, 0.12)',
  };

  function markerClick(m: Marker) {
    onSeek?.(m.t);
    playerStore.update((s) => ({ ...s, pendingSeek: m.t }));
  }

  // ── Playback frontier: time beyond the downloaded extent renders as void —
  // the media genuinely does not exist there yet. Read from the SHARED
  // downloads query (no second poller). ──
  const downloads = downloadsQuery();
  const dlView = $derived(viewFor(downloads.data?.views, streamId));
  /**
   * How far the media exists, for the void band and the moving red cursor.
   *
   * Read from the artifact that is actually GROWING, not from `media.frontierSec`. The media
   * value is composed server-side and was reporting the idle, empty PROXY at the start of a
   * no-proxy download, so the whole timeline looked complete and neither the not-downloaded
   * band nor the frontier cursor was drawn. Selecting a proxy resolution hid it, because then
   * the proxy genuinely IS the growing artifact.
   *
   * Preferring the growing artifact here makes the indicator depend on what is on disk rather
   * than on which mode the project happens to be in.
   */
  const proxyFrontier = $derived.by(() => {
    const v = dlView;
    if (!v || v.phase === 'idle') return Infinity;
    // Complete: the media exists in full, whatever its artifact status says.
    if (!v.media.playableIsGrowing) return Infinity;
    const growing = v.artifacts.find((a) => a.status === 'running' && a.frontierSec && a.frontierSec > 0);
    if (growing?.frontierSec) return growing.frontierSec;
    // No running artifact with a frontier yet: fall back to the media value, which is at least
    // 0 when nothing has landed (drawing the void across the whole timeline, correctly).
    return v.media.frontierSec;
  });

  /**
   * The seek ceiling: how far into the timeline the media can actually be scrubbed.
   *
   * The timeline keeps showing the ABSOLUTE duration (a 5.8 h VOD looks 5.8 h long from
   * the first second), while the scrubbable portion is this extent — the frontier of the
   * file review plays, grown live as chunks land, and the full duration once that file is
   * complete. Same mechanism as the waveform's `extentSec`, which draws only the media
   * that exists.
   */
  const playableExtent = $derived.by(() => {
    const v = dlView;
    if (!v) return Infinity;
    if (!v.media.playableIsGrowing) return Infinity;
    const proxy = v.artifacts.find((a) => a.kind === 'proxy');
    const video = v.artifacts.find((a) => a.kind === 'video');
    // A RUNNING artifact wins over a complete one: during a re-download the old completed
    // artifact still reports its full duration, which would claim the whole timeline is
    // scrubbable while the new file is being written.
    const running = v.artifacts.find((a) => a.status === 'running' && a.frontierSec && a.frontierSec > 0);
    const fallback = proxy && proxy.bytes > 0 ? proxy : video;
    const growing = (running ?? fallback)?.frontierSec ?? 0;
    return growing > 0 ? growing : Infinity;
  });

  let canvasEl = $state<HTMLCanvasElement | undefined>(undefined);
  let containerEl = $state<HTMLDivElement | undefined>(undefined);
  let rafId = 0;
  let hoveredClip = $state<Clip | null>(null);
  let hoverX = $state(-1);           // -1 = not hovering
  let isProxybing = $state(false);
  let isDraggingEndpoint = $state(false);
  let draggingEndpoint: 'start' | 'end' | null = null;
  let isPanning = $state(false);
  /** View start + pointer x at press: the pan is computed against these, never accumulated. */
  let panStartOffset = 0;
  let panStartClientX = 0;
  /** The clip an endpoint drag is editing, and its range BEFORE the drag — the undo entry. */
  let draggingClip: string | null = null;
  let draggingAnchorClip: Clip | null = null;
  let dragStartRange: { startTime: number; endTime: number } | null = null;
  let dragEndTime: number | null = null;

  // ── Streaming waveform via SSE, managed by $effect ──
  // Pre-allocate empty; resized when the server sends totalPeaks.
  let waveformPeaks = $state<number[]>([]);
  let waveformDuration = $state(0);
  let waveformTotalPeaks = $state(0);
  /** Media seconds the waveform actually covers (the download frontier while
   *  a download runs, the full duration once complete). */
  let waveformExtent = $state(0);
  let waveformDownloading = $state(false);

  // Fetch waveform once on mount. The server caches the computed peaks,
  // so there's no need to reconnect on seek — all peaks arrive in one stream.
  let readerRef: ReadableStreamDefaultReader<Uint8Array> | null = null;

  // Re-run the waveform fetch when the download's frontier advances (so the
  // waveform GROWS as fragments land) and once more when it completes (so a
  // partial waveform is replaced by the full one).
  let waveformGen = $state(0);
  let lastFrontierSec = -1;
  let lastPhase = '';
  $effect(() => {
    const v = dlView;
    if (!v) return;
    const frontier = Math.floor(v.media.frontierSec ?? 0);
    const phase = v.phase;
    const grew = frontier > lastFrontierSec + 30;   // every ~30s of new media
    const finished = phase === 'done' && lastPhase !== 'done';
    if ((v.active && grew) || finished) {
      lastFrontierSec = frontier;
      lastPhase = phase;
      waveformGen++;
    } else if (!v.active) {
      lastPhase = phase;
    }
  });

  $effect(() => {
    if (!streamId) return;
    waveformGen;   // dependency: re-fetch when the generation changes
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
                if (data.extentSec !== undefined) waveformExtent = data.extentSec;
                if (data.downloading !== undefined) waveformDownloading = data.downloading;
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
  /**
   * Pixel → time, in absolute VOD seconds.
   *
   * The timeline is ABSOLUTE (the full VOD duration always), but only the downloaded
   * prefix is scrubbable: past `playableExtent` the media genuinely does not exist, so
   * seeking there lands the player on nothing. Clamping here — the single place a pixel
   * becomes a time — covers dragging, clicking and marker jumps at once, and the void
   * band drawn past the extent is then exactly what the cursor cannot enter.
   *
   * `playableExtent` is Infinity once the file being played is complete, so a finished
   * project scrubs its whole timeline.
   */
  function xToTime(x: number): number {
    if (!containerEl) return 0;
    const w = containerEl.clientWidth;
    const t = viewStart + (x / w) * viewSpan;
    return Math.max(0, Math.min(duration, t, playableExtent));
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

  /**
   * Hit-test: is the cursor over a clip?
   *
   * Tests the clip's RANGE, not its peak. The range is what is drawn (fill plus two boundaries), so
   * the whole highlighted band is hoverable; testing the peak alone meant a clip could only be
   * hovered within ~8px of a tick, and for a clip whose peak has gone stale that point is not even
   * inside the clip any more.
   */
  function clipAt(t: number): Clip | null {
    const pad = (viewSpan / (containerEl?.clientWidth ?? 1)) * 8;
    for (const clip of clips) {
      if (t >= clip.startTime - pad && t <= clip.endTime + pad) return clip;
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

    // ── Proxy frontier void (progressive download): everything past the
    // downloaded extent is not-yet-media — black it out under everything
    // else so the void is unambiguous at any zoom. ──
    if (Number.isFinite(proxyFrontier) && viewEnd > proxyFrontier) {
      const fx = timeToX(proxyFrontier);
      if (fx < w) {
        ctx.fillStyle = 'rgba(11, 11, 16, 0.85)'; // foundation color, near-opaque
        ctx.fillRect(Math.max(0, fx), 0, w - Math.max(0, fx), h);
        // Frontier edge hairline — moving right as chunks land.
        ctx.strokeStyle = 'rgba(204, 0, 0, 0.5)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(fx, 0);
        ctx.lineTo(fx, h);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

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
      // While a download is running, the waveform only covers the downloaded extent —
      // drawing past it would stretch partial data across the whole timeline (the
      // reported bug).
      const coveredSec = waveformExtent > 0 ? Math.min(waveformExtent, duration) : duration;
      // Seconds PER PEAK, derived from the extent the peaks actually cover — NOT from the
      // project's total duration. Peaks are emitted at one per second of decoded media, so
      // dividing the FULL duration by the peak count made each peak stand for more time than it
      // holds, and every bar landed further right than the audio it represents: the waveform
      // stretched as the download grew. Measured on a live download, the two differ while the
      // file is partial (extent 1418s of a 3300s project), and match once it completes.
      const peakDur = totalPeaks > 0 ? coveredSec / totalPeaks : 1;
      const barWidth = 2;
      const numBars = Math.max(1, Math.floor(w / barWidth));
      const secPerBar = viewSpan / numBars;

      ctx.fillStyle = 'rgba(113, 113, 122, 0.55)';
      const ampH = h * 0.35;
      for (let b = 0; b < numBars; b++) {
        const barTime = viewStart + b * secPerBar;
        if (barTime >= coveredSec) continue;   // not downloaded yet
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

    // ── Regime band: bottom-edge tint per regime; boundaries as faint
    // verticals. Drawn first so markers/clip marks stay on top. ──
    if (regimes.length > 0) {
      for (const r of regimes) {
        const x0 = timeToX(r.start);
        const x1 = timeToX(r.end);
        if (x1 < 0 || x0 > w) continue;
        ctx.fillStyle = REGIME_COLORS[r.type] ?? 'rgba(100, 116, 139, 0.08)';
        const cx0 = Math.max(0, x0);
        const cx1 = Math.min(w, x1);
        ctx.fillRect(cx0, h - 6, cx1 - cx0, 6);
        // Boundary hairline between regimes.
        if (x0 > 0 && x0 < w) {
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(Math.round(x0) + 0.5, 0);
          ctx.lineTo(Math.round(x0) + 0.5, h);
          ctx.stroke();
        }
      }
    }

    // ── Marker flags (P0-6): hairline with a notch at the top, drawn under
    // clip marks so machine candidates stay visually primary. ──
    if (markers.length > 0) {
      ctx.lineWidth = 1;
      for (const m of markers) {
        const x = Math.round(timeToX(m.t));
        if (x < -1 || x > w + 1) continue;
        ctx.strokeStyle = 'rgba(234, 179, 8, 0.45)'; // muted warning-gold
        ctx.beginPath();
        ctx.moveTo(x, 8);
        ctx.lineTo(x, h);
        ctx.stroke();
        // Notch at the flag head for click affordance.
        ctx.fillStyle = 'rgba(234, 179, 8, 0.7)';
        ctx.fillRect(x - 2, 4, 5, 5);
      }
    }

    // ── Clip marks ──
    //
    // THREE separate marks used to be drawn for one clip: the PEAK tick, a START line and an END
    // line. The peak tick is the one that failed to follow the clip, because it was positioned at
    // `clip.peakTime`, which is a RECORDED fact that goes stale the moment the clip is trimmed —
    // so it sat at the old creation point while the start line moved. Two timestamps is what a clip
    // has; a third mark derived from a stale field is the bug. The start line IS the start, and the
    // end line is drawn thicker so the pair reads as one range.
    //
    // EVERY clip's range is drawn (filled + both boundaries), selected or not: the ranges are the
    // overview of the cut, and hiding them until selection made the timeline unreadable.
    const drawRange = (clip: Clip, selected: boolean) => {
      const startX = timeToX(clip.startTime);
      const endX = timeToX(clip.endTime);
      if (endX < 0 || startX > w) return;
      const x0 = Math.max(0, startX);
      const x1 = Math.min(w, endX);

      // Highlight fill between the endpoints: this is what shows the clip's DURATION. A clip with
      // no highlight is a bare tick, which is why a freshly created clip looked like it had no
      // length at all.
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      if (selected) {
        grad.addColorStop(0, 'rgba(204, 0, 0, 0.22)');
        grad.addColorStop(1, 'rgba(204, 0, 0, 0.10)');
      } else {
        grad.addColorStop(0, 'rgba(161, 161, 170, 0.16)');
        grad.addColorStop(1, 'rgba(161, 161, 170, 0.07)');
      }
      ctx.fillStyle = grad;
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);

      // The two boundaries. The END is the thicker line so a glance separates them; both are
      // solid, and neither is derived from `peakTime`.
      ctx.strokeStyle = selected ? '#cc0000' : 'rgba(161, 161, 170, 0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(Math.round(startX) + 0.5, 0);
      ctx.lineTo(Math.round(startX) + 0.5, h);
      ctx.stroke();
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(Math.round(endX) + 0.5, 0);
      ctx.lineTo(Math.round(endX) + 0.5, h);
      ctx.stroke();

      if (selected) {
        // Subtle glow so the selected range is findable without adding a third mark.
        const glow = ctx.createRadialGradient((x0 + x1) / 2, h / 2, 0, (x0 + x1) / 2, h / 2, 40);
        glow.addColorStop(0, 'rgba(204, 0, 0, 0.12)');
        glow.addColorStop(1, 'rgba(204, 0, 0, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect((x0 + x1) / 2 - 40, 0, 80, h);
      }
    };

    for (const clip of clips) {
      const isSelected = clip.id === currentClipId;
      drawRange(clip, isSelected);
      // NO peak/confidence tick. `peakTime` is where the clip was CREATED (the engine's detection
      // point), which is a THIRD timestamp beside the start and the end: for a hand-made clip it is
      // literally the same value as the start, so it drew a second thin line under the start line
      // and looked like the start line had failed to follow the clip. Only two positions exist —
      // the boundaries — and the confidence number lives in the inspector, where it can be read.
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

  /**
   * A drag is owned by the WINDOW, not the element.
   *
   * Listening on the timeline alone meant a pointer that left the element mid-drag
   * simply stopped moving the endpoint (and `onmouseleave` cancelled the gesture), so a
   * drag past the edge died instead of continuing. These listeners are armed only while
   * a gesture is active, so the page pays nothing for them at rest.
   */
  $effect(() => {
    const active = isPanning || isDraggingEndpoint || isProxybing;
    if (!active) return;
    const move = (e: MouseEvent) => handleWindowMove(e);
    const up = () => handleMouseUp();
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  });

  $effect(() => {
    waveformPeaks; chatQuery.data;
    draw();
  });

  // ── Unified mouse handling ──
  // Default: seek/proxy. Click clip mark: select. Hover endpoint handle: drag.

  function getMouseX(e: MouseEvent): number {
    if (!containerEl) return 0;
    return e.clientX - containerEl.getBoundingClientRect().left;
  }

  /**
   * Pointer coordinates → a time, in ANY coordinate system.
   *
   * Used by the window-level listeners below, where `e.clientX` is no longer relative to
   * the container (the pointer may be outside it entirely). Clamped to the timeline so a
   * drag past the edge parks at 0 or the end rather than producing an impossible time.
   */
  function clientXToTime(clientX: number): number {
    if (!containerEl) return 0;
    const r = containerEl.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - r.left, 0), r.width);
    return xToTime(x);
  }

  // ── Panning (middle mouse) ──
  // Middle-drag pans the VIEW; it must not move the playhead, which is what makes the
  // two gestures distinguishable. The pan moves the same view window that zoom sets
  // (`viewStart`/`viewEnd` in the player store) rather than a second, parallel offset —
  // two owners of "what time is at x=0" is how a timeline ends up disagreeing with itself
  // about where a clip is.
  function handlePanMove(e: MouseEvent) {
    if (!containerEl) return;
    const r = containerEl.getBoundingClientRect();
    if (r.width <= 0) return;
    const secPerPx = viewSpan / r.width;
    // Dragging right moves the content right, i.e. reveals EARLIER time. The delta is
    // applied against the offset captured at press, not accumulated per event, so the
    // view cannot drift away from the pointer over a long drag.
    const wanted = panStartOffset + (panStartClientX - e.clientX) * secPerPx;
    panStore(wanted - viewStart, duration);
  }

  function handleMouseMove(e: MouseEvent) {
    // A gesture in flight belongs to the window listener below — it must keep working when the
    // pointer leaves the element, so it is the single owner of drag motion. Handling it here as
    // well fired every drag frame twice (two seeks, two endpoint updates per pixel).
    if (isPanning || isDraggingEndpoint || isProxybing) return;

    const x = getMouseX(e);
    hoverX = x;
    const t = xToTime(x);

    // Hover detection: endpoints first, then clip marks, then marker flags.
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
    if (!clip) {
      const MARKER_HIT_PX = 5;
      const hit = markers.find((m) => Math.abs(timeToX(m.t) - x) <= MARKER_HIT_PX);
      hoveredMarker = hit ?? null;
      if (hit && containerEl) containerEl.style.cursor = 'pointer';
    } else {
      hoveredMarker = null;
    }
  }

  /**
   * Window-level move handler: the drag continues while the button is held, even if the
   * pointer leaves the timeline. Without this, dragging off the element silently ended the
   * gesture (and a re-entry restarted it from wherever the pointer happened to be).
   */
  function handleWindowMove(e: MouseEvent) {
    if (isPanning) { handlePanMove(e); return; }
    if (isDraggingEndpoint) {
      const t = clientXToTime(e.clientX);
      dragEndTime = t;
      if (draggingClip) {
        const anchor = draggingAnchorClip;
        if (anchor && onAdjustEndpoints) {
          if (draggingEndpoint === 'start') {
            onAdjustEndpoints(anchor, Math.min(t, anchor.endTime - 1), anchor.endTime, false);
          } else {
            onAdjustEndpoints(anchor, anchor.startTime, Math.max(t, anchor.startTime + 1), false);
          }
        }
      }
      return;
    }
    if (isProxybing) {
      const t = clientXToTime(e.clientX);
      if (onSeek) onSeek(t);
      playerStore.update((s) => ({ ...s, currentTime: t, isProxybing: true }));
    }
  }

  function handleMouseDown(e: MouseEvent) {
    // Middle button pans, and ONLY middle: it must never move the playhead.
    if (e.button === 1) {
      e.preventDefault();
      if (!containerEl) return;
      isPanning = true;
      panStartClientX = e.clientX;
      panStartOffset = viewStart;
      containerEl.style.cursor = 'grabbing';
      return;
    }
    // Left button only from here on: a right-click must not start a seek or a drag.
    if (e.button !== 0) return;

    const x = getMouseX(e);
    const t = xToTime(x);

    // 1. Endpoint drag?
    const ep = endpointAt(x);
    if (ep) {
      isDraggingEndpoint = true;
      draggingEndpoint = ep;
      // The clip being edited is PINNED at press time: the undo entry (pushed on
      // release) needs the range as it was before the drag, and reading it later
      // would capture a range the drag already changed.
      draggingClip = selectedClip?.id ?? null;
      draggingAnchorClip = selectedClip ? { ...selectedClip } : null;
      dragStartRange = selectedClip
        ? { startTime: selectedClip.startTime, endTime: selectedClip.endTime }
        : null;
      dragEndTime = null;
      return;
    }

    // 2. Marker flag click? Jump to it (flags sit under clip marks).
    const MARKER_HIT_PX = 5;
    const marker = markers.find((m) => Math.abs(timeToX(m.t) - x) <= MARKER_HIT_PX);
    if (marker) {
      markerClick(marker);
      return;
    }

    // 3. Clip mark click? Select it (don't seek).
    const clip = clipAt(t);
    if (clip) {
      onSelectClip(clip);
      return;
    }

    // 4. Otherwise: seek immediately + begin proxy.
    isProxybing = true;
    if (onSeek) onSeek(t);
    playerStore.update((s) => ({ ...s, currentTime: t, isProxybing: true }));
  }

  function handleMouseUp() {
    // Endpoint drags have moved the range live (many times). The UNDO ENTRY is pushed
    // here, once, with the range as it was when the drag started — one history event per
    // gesture instead of one per frame.
    if (isDraggingEndpoint && draggingClip && dragStartRange && dragEndTime !== null && onCommitEndpoints) {
      onCommitEndpoints(draggingClip, dragStartRange);
    }
    isPanning = false;
    isProxybing = false;
    isDraggingEndpoint = false;
    draggingEndpoint = null;
    draggingClip = null;
    draggingAnchorClip = null;
    dragStartRange = null;
    dragEndTime = null;
    if (containerEl) containerEl.style.cursor = 'text';
    playerStore.update((s) => ({ ...s, isProxybing: false }));
  }

  function handleMouseLeave() {
    hoverX = -1;
    hoveredClip = null;
    // A hover state ends at the edge, but a DRAG does not: the window listeners
    // (armed while a gesture is active) keep it alive, so a pointer that leaves the
    // timeline mid-drag comes back to the same gesture rather than a dead one.
    if (isPanning || isDraggingEndpoint || isProxybing) return;
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
        <span class="text-accent">{hoveredClip.title ?? (hoveredClip.axis ?? 'manual').toUpperCase()}</span>
        <span class="text-ash"> · {hoveredClip.score === null ? 'unranked' : hoveredClip.score.toFixed(2)} · </span>
        <!-- The clip's RANGE, not a third timestamp: start and end are the only two positions a clip
             has, and showing `peakTime` here restated the creation point as if it were a third one. -->
        <span class="text-ash-dim">{fmtTime(hoveredClip.startTime)} → {fmtTime(hoveredClip.endTime)}</span>
      {:else if hoveredMarker}
        <span class="text-warning">⚑</span>
        <span class="text-ash">{hoveredMarker.label || 'chapter'} · </span>
        <span class="text-ash-dim">{fmtTime(hoveredMarker.t)}</span>
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
