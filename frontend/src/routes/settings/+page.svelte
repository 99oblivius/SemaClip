<script lang="ts">
  import { createQuery, createMutation } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import Icon from '$lib/components/Icon.svelte';
  import { fadeIn } from '$lib/actions/gsap';
  import type { AppSettings, AspectRatio, CaptionStyle } from '$shared/types';

  const settingsQuery = createQuery(() => ({
    queryKey: ['settings'],
    queryFn: () => apiClient.getSettings(),
  }));

  const updateMutation = createMutation(() => ({
    mutationFn: (settings: Partial<AppSettings>) => apiClient.updateSettings(settings),
    onSuccess: () => settingsQuery.refetch(),
  }));

  // Local editable copies — synced when data loads.
  let gpuDevice = $state<string>('auto');
  let exportDir = $state('');
  let defaultAspectRatio = $state<AspectRatio>('16:9');
  let captionsEnabled = $state(false);
  let captionPreset = $state<CaptionStyle['preset']>('bold-white');
  let captionPosition = $state<CaptionStyle['position']>('bottom');
  let captionFontSize = $state(48);
  let captionBgOpacity = $state(0.8);
  let engineBinaryPath = $state('');
  let loaded = $state(false);

  $effect(() => {
    const s = settingsQuery.data;
    if (s && !loaded) {
      gpuDevice = s.gpuDevice === null ? 'auto' : String(s.gpuDevice);
      exportDir = s.exportDir;
      defaultAspectRatio = s.defaultAspectRatio;
      captionsEnabled = s.defaultCaptions.enabled;
      captionPreset = s.defaultCaptions.preset;
      captionPosition = s.defaultCaptions.position;
      captionFontSize = s.defaultCaptions.fontSize;
      captionBgOpacity = s.defaultCaptions.backgroundOpacity;
      engineBinaryPath = s.engineBinaryPath ?? '';
      loaded = true;
    }
  });

  function save() {
    updateMutation.mutate({
      gpuDevice: gpuDevice === 'auto' ? null : parseInt(gpuDevice, 10),
      exportDir,
      defaultAspectRatio,
      defaultCaptions: {
        enabled: captionsEnabled,
        preset: captionPreset,
        position: captionPosition,
        fontSize: captionFontSize,
        backgroundOpacity: captionBgOpacity,
      },
      engineBinaryPath: engineBinaryPath.trim() || null,
    });
  }

  const dirty = $derived(
    loaded && (
      updateMutation.isPending ||
      (gpuDevice === 'auto' ? null : parseInt(gpuDevice, 10)) !== settingsQuery.data?.gpuDevice ||
      exportDir !== settingsQuery.data?.exportDir ||
      defaultAspectRatio !== settingsQuery.data?.defaultAspectRatio ||
      captionsEnabled !== settingsQuery.data?.defaultCaptions.enabled ||
      captionPreset !== settingsQuery.data?.defaultCaptions.preset ||
      captionPosition !== settingsQuery.data?.defaultCaptions.position ||
      captionFontSize !== settingsQuery.data?.defaultCaptions.fontSize ||
      captionBgOpacity !== settingsQuery.data?.defaultCaptions.backgroundOpacity ||
      (engineBinaryPath.trim() || null) !== settingsQuery.data?.engineBinaryPath
    )
  );

  const ratios: { value: AspectRatio; label: string }[] = [
    { value: '16:9', label: '16:9' },
    { value: '9:16', label: '9:16' },
    { value: '1:1', label: '1:1' },
  ];
</script>

<div class="flex h-full flex-col overflow-y-auto p-6" use:fadeIn role="region" aria-label="Settings">
  <div class="mx-auto flex w-full max-w-2xl flex-col gap-6">
    <h1 class="font-display text-xl font-medium">Settings</h1>

    {#if settingsQuery.isLoading}
      <div class="text-sm text-ash">Loading...</div>
    {:else if settingsQuery.isError}
      <div class="rounded-md border border-error bg-surface px-3 py-2 text-xs text-error">
        {settingsQuery.error?.message ?? 'Failed to load settings'}
      </div>
    {:else}
      <!-- Engine -->
      <section class="flex flex-col gap-3">
        <h2 class="font-display text-sm font-medium text-ash uppercase tracking-wider">Engine</h2>
        <div class="rounded-md border border-border bg-surface p-4 flex flex-col gap-4">
          <label class="flex flex-col gap-1">
            <span class="font-mono text-xs text-ash">GPU Device</span>
            <select bind:value={gpuDevice} class="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none">
              <option value="auto">Auto (default)</option>
              <option value="0">GPU 0</option>
              <option value="1">GPU 1</option>
              <option value="2">GPU 2</option>
              <option value="3">GPU 3</option>
            </select>
            <span class="font-mono text-xs text-ash-dim">CUDA device index for ML inference. Auto uses the first available GPU.</span>
          </label>

          <label class="flex flex-col gap-1">
            <span class="font-mono text-xs text-ash">Engine Binary Path</span>
            <input
              type="text"
              bind:value={engineBinaryPath}
              placeholder="Auto-detect (leave empty)"
              class="rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-ink placeholder:text-ash-dim focus:border-accent focus:outline-none"
            />
            <span class="font-mono text-xs text-ash-dim">Path to the semaclip-engine binary. Leave empty for auto-detection.</span>
          </label>
        </div>
      </section>

      <!-- Export defaults -->
      <section class="flex flex-col gap-3">
        <h2 class="font-display text-sm font-medium text-ash uppercase tracking-wider">Export Defaults</h2>
        <div class="rounded-md border border-border bg-surface p-4 flex flex-col gap-4">
          <label class="flex flex-col gap-1">
            <span class="font-mono text-xs text-ash">Export Directory</span>
            <input
              type="text"
              bind:value={exportDir}
              placeholder="~/Videos/SemaClip"
              class="rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-ink placeholder:text-ash-dim focus:border-accent focus:outline-none"
            />
            <span class="font-mono text-xs text-ash-dim">Where exported clips are saved by default.</span>
          </label>

          <div>
            <span class="mb-1 block font-mono text-xs text-ash">Default Aspect Ratio</span>
            <div class="flex gap-2">
              {#each ratios as r}
                <button
                  class="rounded-md border px-3 py-1.5 text-sm transition-colors
                  {defaultAspectRatio === r.value ? 'border-accent text-accent' : 'border-border text-ash hover:text-ink'}"
                  onclick={() => defaultAspectRatio = r.value}
                >
                  {r.label}
                </button>
              {/each}
            </div>
          </div>

          <div>
            <span class="mb-1 flex items-center gap-2 font-mono text-xs text-ash uppercase">
              <input type="checkbox" bind:checked={captionsEnabled} class="accent-accent" />
              Burn in captions by default
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
        </div>
      </section>

      <!-- Save bar -->
      <div class="flex items-center justify-between gap-3">
        {#if updateMutation.isError}
          <span class="font-mono text-xs text-error">{updateMutation.error?.message ?? 'Save failed'}</span>
        {:else if updateMutation.isSuccess && !dirty}
          <span class="font-mono text-xs text-success">✓ Saved</span>
        {/if}
        <button
          class="ml-auto flex items-center gap-1 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          onclick={save}
          disabled={!dirty}
        >
          <Icon name="check" size={16} />
          {updateMutation.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>
    {/if}
  </div>
</div>
