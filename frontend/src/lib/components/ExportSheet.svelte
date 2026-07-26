<script lang="ts">
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import Icon from '$lib/components/Icon.svelte';
  import { slideUp } from '$lib/actions/gsap';
  import type { Clip, ExportFormat, AspectRatio, CropPosition, CaptionStyle, ExportClipInput } from '$shared/types';

  interface Props {
    clip: Clip;
    onClose: () => void;
  }

  let { clip, onClose }: Props = $props();
  const queryClient = useQueryClient();

  let format = $state<ExportFormat>('mp4_h264');
  let aspectRatio = $state<AspectRatio>('16:9');
  let cropPosition = $state<CropPosition>('center');
  let captionsEnabled = $state(false);
  let captionPreset = $state<CaptionStyle['preset']>('bold-white');
  let captionPosition = $state<CaptionStyle['position']>('bottom');
  let captionFontSize = $state(48);
  let captionBgOpacity = $state(0.8);
  let outputPath = $state<string | null>(null);

  const exportMutation = createMutation(() => ({
    mutationFn: (input: ExportClipInput) => apiClient.exportClip(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clips', clip.streamId] });
      onClose();
    },
  }));

  function handleExport() {
    exportMutation.mutate({
      clipId: clip.id,
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
      outputPath,
    });
  }

  const formats: { value: ExportFormat; label: string }[] = [
    { value: 'mp4_h264', label: 'MP4 (H.264)' },
    { value: 'mp4_h265', label: 'MP4 (H.265)' },
    { value: 'webm', label: 'WebM' },
  ];

  const ratios: { value: AspectRatio; label: string }[] = [
    { value: '16:9', label: '16:9' },
    { value: '9:16', label: '9:16' },
    { value: '1:1', label: '1:1' },
  ];
</script>

<div class="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onclick={onClose} onkeydown={(e) => e.key === 'Escape' && onClose()} role="button" tabindex="-1">
  <div
    class="w-full max-w-2xl rounded-t-lg border border-border bg-surface p-6"
    use:slideUp
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
    role="dialog"
    aria-label="Export clip"
    tabindex="-1"
  >
    <div class="mb-4 flex items-center justify-between">
      <h2 class="font-display text-base font-medium">
        Export · <span class="text-accent uppercase">{clip.axis}</span>
      </h2>
      <button onclick={onClose} class="text-ash hover:text-ink" aria-label="Close">
        <Icon name="close" size={20} />
      </button>
    </div>

    <div class="flex flex-col gap-4">
      <!-- Format -->
      <div>
        <span class="mb-1 block font-mono text-xs text-ash uppercase">Format</span>
        <div class="flex gap-2">
          {#each formats as f}
            <button
              class="rounded-md border px-3 py-1.5 text-sm transition-colors
              {format === f.value ? 'border-accent text-accent' : 'border-border text-ash hover:text-ink'}"
              onclick={() => format = f.value}
            >
              {f.label}
            </button>
          {/each}
        </div>
      </div>

      <!-- Aspect ratio -->
      <div>
        <span class="mb-1 block font-mono text-xs text-ash uppercase">Aspect Ratio</span>
        <div class="flex gap-2">
          {#each ratios as r}
            <button
              class="rounded-md border px-3 py-1.5 text-sm transition-colors
              {aspectRatio === r.value ? 'border-accent text-accent' : 'border-border text-ash hover:text-ink'}"
              onclick={() => aspectRatio = r.value}
            >
              {r.label}
            </button>
          {/each}
        </div>
        {#if aspectRatio !== '16:9'}
          <div class="mt-2 flex items-center gap-3">
            <span class="font-mono text-xs text-ash-dim">Crop:</span>
            {#each ['center', 'top', 'bottom'] as pos}
              <button
                class="rounded px-2 py-1 font-mono text-xs transition-colors
                {cropPosition === pos ? 'text-accent' : 'text-ash-dim hover:text-ash'}"
                onclick={() => cropPosition = pos as CropPosition}
              >
                {pos}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Captions -->
      <div>
        <span class="mb-1 flex items-center gap-2 font-mono text-xs text-ash uppercase">
          <input type="checkbox" bind:checked={captionsEnabled} class="accent-accent" />
          Burn in captions
        </span>
        {#if captionsEnabled}
          <div class="ml-6 flex flex-col gap-2">
            <div class="flex items-center gap-3">
              <span class="font-mono text-xs text-ash-dim">Style:</span>
              {#each ['bold-white', 'yellow', 'custom'] as style}
                <button
                  class="rounded px-2 py-1 font-mono text-xs transition-colors
                  {captionPreset === style ? 'text-accent' : 'text-ash-dim hover:text-ash'}"
                  onclick={() => captionPreset = style as CaptionStyle['preset']}
                >
                  {style}
                </button>
              {/each}
            </div>
            <div class="flex items-center gap-3">
              <span class="font-mono text-xs text-ash-dim">Position:</span>
              {#each ['bottom', 'top'] as pos}
                <button
                  class="rounded px-2 py-1 font-mono text-xs transition-colors
                  {captionPosition === pos ? 'text-accent' : 'text-ash-dim hover:text-ash'}"
                  onclick={() => captionPosition = pos as CaptionStyle['position']}
                >
                  {pos}
                </button>
              {/each}
            </div>
            <div class="flex items-center gap-3">
              <span class="font-mono text-xs text-ash-dim">Font size:</span>
              <input type="range" min="24" max="96" bind:value={captionFontSize} class="accent-accent" />
              <span class="font-mono text-xs text-ash">{captionFontSize}px</span>
            </div>
            <div class="flex items-center gap-3">
              <span class="font-mono text-xs text-ash-dim">BG opacity:</span>
              <input type="range" min="0" max="1" step="0.1" bind:value={captionBgOpacity} class="accent-accent" />
              <span class="font-mono text-xs text-ash">{Math.round(captionBgOpacity * 100)}%</span>
            </div>
          </div>
        {/if}
      </div>

      <!-- Actions -->
      <div class="flex justify-end gap-2 pt-2">
        <button
          class="rounded-md border border-border px-4 py-2 text-sm text-ash transition-colors hover:text-ink"
          onclick={onClose}
        >
          Cancel
        </button>
        <button
          class="flex items-center gap-1 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          onclick={handleExport}
          disabled={exportMutation.isPending}
        >
          <Icon name="scissors" size={16} />
          {exportMutation.isPending ? 'Exporting...' : 'Export'}
        </button>
      </div>
    </div>
  </div>
</div>
