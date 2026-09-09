<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import { playerStore } from '$lib/stores/player';
  import Icon from '$lib/components/Icon.svelte';
  import { fadeIn } from '$lib/actions/gsap';
  import type { Clip, ExportFormat, AspectRatio, CropPosition, CaptionStyle, ExportClipInput, ExportPreset } from '$shared/types';

  const queryClient = useQueryClient();

  // Selected clip: ?clip=<id> query param, else the first un-rejected clip.
  const urlParams = new URLSearchParams(window.location.search);
  let selectedClipId = $state(urlParams.get('clip'));

  const streamsQuery = createQuery(() => ({
    queryKey: ['streams'],
    queryFn: () => apiClient.listStreams(),
  }));

  const presetsQuery = createQuery(() => ({
    queryKey: ['presets'],
    queryFn: () => apiClient.listPresets(),
  }));

  // All clips across all streams (export is a top-level workflow surface).
  const clipsByStream = $derived(
    (streamsQuery.data ?? []).map((s) => ({
      stream: s,
      clips: [] as Clip[], // loaded per stream below
    })),
  );

  // Load clips for every completed stream into the query cache so the
  // accepted-clip list can read them synchronously.
  $effect(() => {
    for (const s of streamsQuery.data ?? []) {
      if (s.status !== 'completed') continue;
      void queryClient.ensureQueryData({
        queryKey: ['clips', s.id],
        queryFn: () => apiClient.listClips(s.id),
      });
    }
  });

  let acceptedClips = $derived.by(() => {
    const out: { streamId: string; streamTitle: string; clip: Clip }[] = [];
    for (const s of streamsQuery.data ?? []) {
      if (s.status !== 'completed') continue;
      const cached = queryClient.getQueryData<Clip[]>(['clips', s.id]) ?? [];
      for (const c of cached) {
        if (!c.rejected) out.push({ streamId: s.id, streamTitle: s.title ?? 'Untitled', clip: c });
      }
    }
    return out.sort((a, b) => b.clip.score - a.clip.score);
  });

  const selected = $derived(
    acceptedClips.find((x) => x.clip.id === selectedClipId) ?? acceptedClips[0] ?? null,
  );

  // ── Export config state (initialized from the selected preset) ──
  let activePresetId = $state<string | null>(null);
  let format = $state<ExportFormat>('mp4_h264');
  let aspectRatio = $state<AspectRatio>('16:9');
  let cropPosition = $state<CropPosition>('center');
  let captionsEnabled = $state(false);
  let captionPreset = $state<CaptionStyle['preset']>('bold-white');
  let captionPosition = $state<CaptionStyle['position']>('bottom');
  let captionFontSize = $state(48);
  let captionBgOpacity = $state(0.8);
  let nameTemplate = $state('{date}-{channel}-{axis}-{ts}');
  let presetTouched = $state(false);

  const presets = $derived(presetsQuery.data ?? []);

  // Applying a preset fills every control (P0-7: one applied by default).
  $effect(() => {
    if (presets.length === 0 || presetTouched) return;
    const target = presets.find((p) => p.id === activePresetId) ?? presets[0];
    if (!target) return;
    applyPreset(target);
  });

  function applyPreset(p: ExportPreset) {
    activePresetId = p.id;
    format = p.format;
    aspectRatio = p.aspectRatio;
    cropPosition = p.cropPosition;
    captionsEnabled = p.captions.enabled;
    captionPreset = p.captions.preset;
    captionPosition = p.captions.position;
    captionFontSize = p.captions.fontSize;
    captionBgOpacity = p.captions.backgroundOpacity;
    nameTemplate = p.nameTemplate;
  }

  // ── Naming template preview (P1-2) ──
  const sampleName = $derived.by(() => {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const ts = selected?.clip
      ? `${String(Math.floor(selected.clip.startTime / 60)).padStart(2, '0')}${String(Math.floor(selected.clip.startTime % 60)).padStart(2, '0')}`
      : '0000';
    return nameTemplate
      .replace('{date}', date)
      .replace('{channel}', 'channel')
      .replace('{axis}', selected?.clip.axis ?? 'axis')
      .replace('{ts}', ts)
      .replace('{title}', selected?.streamTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) ?? 'title')
      .replace('{platform}', presets.find((p) => p.id === activePresetId)?.name.toLowerCase().split(' ')[0] ?? 'export');
  });

  const exportMutation = createMutation(() => ({
    mutationFn: (input: ExportClipInput) => apiClient.exportClip(input),
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ['clips'] });
    },
  }));

  function handleExport() {
    if (!selected) return;
    exportMutation.mutate({
      clipId: selected.clip.id,
      format,
      aspectRatio,
      cropPosition,
      captions: {
        enabled: captionsEnabled,
        preset: captionPreset,
        position: captionPosition,
        fontSize: captionFontSize,
        backgroundOpacity: captionBgOpacity,
      },
      outputPath: null,
      filename: sampleName || null,
    });
  }

  const formats: { value: ExportFormat; label: string }[] = [
    { value: 'mp4_h264', label: 'MP4 H.264' },
    { value: 'mp4_h265', label: 'MP4 H.265' },
    { value: 'webm', label: 'WebM VP9' },
  ];

  const ratios: { value: AspectRatio; label: string }[] = [
    { value: '16:9', label: '16:9' },
    { value: '9:16', label: '9:16' },
    { value: '1:1', label: '1:1' },
  ];

  function fmtTime(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
</script>

<div class="flex h-full" use:fadeIn role="region" aria-label="Export">
  <!-- Left: clip selection (all decided clips across channels) -->
  <aside class="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface" aria-label="Clips ready for export">
    <h2 class="sticky top-0 z-10 border-b border-border bg-surface px-4 py-3 font-display text-sm font-medium text-ash uppercase tracking-wider">
      Clips · {acceptedClips.length}
    </h2>
    {#if acceptedClips.length === 0}
      <div class="flex flex-1 items-center justify-center p-6 text-center text-xs text-ash-dim">
        No clips yet. Review a stream first.
      </div>
    {:else}
      <div class="flex flex-col p-2">
        {#each acceptedClips as item (item.clip.id)}
          <button
            class="relative flex flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors
            {selected?.clip.id === item.clip.id ? 'bg-surface-2' : 'hover:bg-surface-2/50'}"
            onclick={() => (selectedClipId = item.clip.id)}
          >
            {#if selected?.clip.id === item.clip.id}
              <span class="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-accent"></span>
            {/if}
            <div class="flex items-center gap-2">
              <span class="font-mono text-[10px] uppercase text-accent">{item.clip.axis}</span>
              <span class="font-mono text-[10px] text-ash-dim">{item.clip.score.toFixed(2)}</span>
            </div>
            <span class="truncate font-mono text-xs text-ash">{item.streamTitle}</span>
            <span class="font-mono text-[10px] text-ash-dim">{fmtTime(item.clip.startTime)} → {fmtTime(item.clip.endTime)}</span>
          </button>
        {/each}
      </div>
    {/if}
  </aside>

  <!-- Center: export configuration -->
  <div class="flex flex-1 flex-col overflow-y-auto p-6">
    <div class="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div class="flex items-center justify-between">
        <h1 class="font-display text-xl font-medium">Export</h1>
        {#if selected}
          <span class="font-mono text-xs text-ash">
            {selected.clip.axis} · {fmtTime(selected.clip.startTime)} · {(selected.clip.endTime - selected.clip.startTime).toFixed(0)}s
          </span>
        {/if}
      </div>

      {#if !selected}
        <div class="flex flex-1 flex-col items-center justify-center gap-2 py-20 text-center">
          <Icon name="scissors" size={32} class="text-ash-dim" />
          <p class="text-sm text-ash-dim">Select a clip on the left, or review a stream first.</p>
        </div>
      {:else}
        <!-- Presets (P0-7): first control, one applied by default -->
        <section class="flex flex-col gap-2">
          <h2 class="font-mono text-xs uppercase tracking-wider text-ash">Preset</h2>
          <div class="flex flex-wrap gap-2">
            {#each presets as p (p.id)}
              <button
                class="rounded-md border px-3 py-1.5 text-sm transition-colors
                {activePresetId === p.id ? 'border-accent text-accent' : 'border-border text-ash hover:text-ink'}"
                onclick={() => { presetTouched = false; applyPreset(p); }}
              >
                {p.name}
              </button>
            {/each}
            <span class="flex items-center px-1 font-mono text-[10px] text-ash-dim">
              {#if presetTouched}customized{/if}
            </span>
          </div>
        </section>

        <div class="grid grid-cols-2 gap-6">
          <!-- Format & aspect -->
          <section class="flex flex-col gap-2">
            <h2 class="font-mono text-xs uppercase tracking-wider text-ash">Format</h2>
            <div class="flex gap-2">
              {#each formats as f}
                <button
                  class="rounded-md border px-2.5 py-1.5 text-xs transition-colors
                  {format === f.value ? 'border-accent text-accent' : 'border-border text-ash hover:text-ink'}"
                  onclick={() => { format = f.value; presetTouched = true; }}
                >
                  {f.label}
                </button>
              {/each}
            </div>
            <div class="mt-2 flex gap-2">
              {#each ratios as r}
                <button
                  class="rounded-md border px-2.5 py-1.5 text-xs transition-colors
                  {aspectRatio === r.value ? 'border-accent text-accent' : 'border-border text-ash hover:text-ink'}"
                  onclick={() => { aspectRatio = r.value; presetTouched = true; }}
                >
                  {r.label}
                </button>
              {/each}
            </div>
            {#if aspectRatio !== '16:9'}
              <div class="mt-1 flex items-center gap-2">
                <span class="font-mono text-xs text-ash-dim">Crop:</span>
                {#each ['center', 'top', 'bottom'] as pos}
                  <button
                    class="rounded px-2 py-1 font-mono text-xs transition-colors
                    {cropPosition === pos ? 'text-accent' : 'text-ash-dim hover:text-ash'}"
                    onclick={() => { cropPosition = pos as CropPosition; presetTouched = true; }}
                  >
                    {pos}
                  </button>
                {/each}
              </div>
            {/if}
          </section>

          <!-- Crop preview (P0-9) -->
          <section class="flex flex-col gap-2">
            <h2 class="font-mono text-xs uppercase tracking-wider text-ash">Preview</h2>
            <div class="flex items-center justify-center rounded-md border border-border bg-foundation p-3">
              <div
                class="relative overflow-hidden rounded bg-surface-2"
                style="aspect-ratio: {aspectRatio.replace(':', '/')}; {aspectRatio === '16:9' ? 'width: 100%;' : 'height: 160px;'}"
              >
                <div class="absolute inset-0 flex items-center justify-center">
                  <Icon name="film" size={20} class="text-ash-dim" />
                </div>
                {#if captionsEnabled}
                  <div
                    class="absolute inset-x-2 rounded-sm bg-black px-1 py-0.5 text-center font-mono text-[9px] text-white"
                    style="{captionPosition === 'bottom' ? 'bottom: 8%' : 'top: 8%'}; opacity: {0.4 + captionBgOpacity * 0.6}; font-size: {Math.max(8, captionFontSize / 6)}px"
                  >
                    caption preview
                  </div>
                {/if}
              </div>
            </div>
          </section>
        </div>

        <!-- Captions -->
        <section class="flex flex-col gap-2">
          <h2 class="font-mono text-xs uppercase tracking-wider text-ash">Captions</h2>
          <div class="flex flex-col gap-2 rounded-md border border-border bg-surface p-3">
            <span class="flex items-center gap-2 font-mono text-xs text-ash">
              <input
                type="checkbox"
                checked={captionsEnabled}
                onchange={(e) => { captionsEnabled = e.currentTarget.checked; presetTouched = true; }}
                class="accent-accent"
              />
              Burn in captions
            </span>
            {#if captionsEnabled}
              <div class="ml-6 flex flex-wrap items-center gap-3">
                {#each ['bold-white', 'yellow', 'custom'] as style}
                  <button
                    class="rounded px-2 py-1 font-mono text-xs transition-colors
                    {captionPreset === style ? 'text-accent' : 'text-ash-dim hover:text-ash'}"
                    onclick={() => { captionPreset = style as CaptionStyle['preset']; presetTouched = true; }}
                  >
                    {style}
                  </button>
                {/each}
                <span class="text-ash-dim">·</span>
                {#each ['bottom', 'top'] as pos}
                  <button
                    class="rounded px-2 py-1 font-mono text-xs transition-colors
                    {captionPosition === pos ? 'text-accent' : 'text-ash-dim hover:text-ash'}"
                    onclick={() => { captionPosition = pos as CaptionStyle['position']; presetTouched = true; }}
                  >
                    {pos}
                  </button>
                {/each}
                <span class="text-ash-dim">·</span>
                <input type="range" min="24" max="96" bind:value={captionFontSize} class="w-24 accent-accent" oninput={() => presetTouched = true} />
                <span class="font-mono text-xs text-ash">{captionFontSize}px</span>
              </div>
            {/if}
          </div>
        </section>

        <!-- Output naming (P1-2): template with live preview -->
        <section class="flex flex-col gap-2">
          <h2 class="font-mono text-xs uppercase tracking-wider text-ash">Filename</h2>
          <input
            type="text"
            bind:value={nameTemplate}
            oninput={() => presetTouched = true}
            class="rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-ink focus:border-accent focus:outline-none"
            aria-label="Filename template"
          />
          <div class="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-ash-dim">
            {#each ['{date}', '{channel}', '{axis}', '{ts}', '{title}', '{platform}'] as token}
              <span>{token}</span>
            {/each}
          </div>
          <p class="font-mono text-xs text-success">{sampleName}.mp4</p>
        </section>

        <!-- Export action -->
        <div class="flex items-center justify-between border-t border-border pt-4">
          <div>
            {#if exportMutation.isError}
              <span class="font-mono text-xs text-error">{exportMutation.error?.message ?? 'Export failed'}</span>
            {:else if exportMutation.isSuccess}
              <span class="font-mono text-xs text-success">✓ {exportMutation.data?.exportPath ?? 'Exported'}</span>
            {/if}
          </div>
          <button
            class="flex items-center gap-1.5 rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            onclick={handleExport}
            disabled={exportMutation.isPending}
          >
            <Icon name="scissors" size={15} />
            {exportMutation.isPending ? 'Exporting...' : 'Export clip'}
          </button>
        </div>
      {/if}
    </div>
  </div>
</div>