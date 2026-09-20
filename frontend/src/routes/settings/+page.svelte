<script lang="ts">
  import { createQuery, createMutation } from '@tanstack/svelte-query';
  import { onDestroy } from 'svelte';
  import { apiClient, getUpdateStatus } from '$lib/api/client';
  import Icon from '$lib/components/Icon.svelte';
  import { fadeIn } from '$lib/actions/gsap';
  import { selectUiScale, confirmUiScaleSaved, revertUiScaleIfPending } from '$lib/stores/ui-scale';
  import {
    DEFAULT_FORM,
    formFromSettings,
    formToSettings,
    isDirty,
    type SettingsForm,
  } from '$lib/components/settings-form';
  import { UI_SCALE_FACTOR, type AppSettings, type AspectRatio, type CaptionStyle, type UiScale } from '$shared/types';

  const settingsQuery = createQuery(() => ({
    queryKey: ['settings'],
    queryFn: () => apiClient.getSettings(),
  }));

  // Hand the choice to the shared store, which the layout turns into the root
  // font size — the dropdown must not touch documentElement itself, and it must
  // NOT write the query cache either: `dirty` below compares against that cache,
  // so an optimistic cache write makes the page believe the server already has
  // the value and Save stays disabled (measured: clicking the dropdown left
  // saveDisabled true and the value never persisted).
  function selectScale(next: UiScale) {
    uiScale = next;
    selectUiScale(next);
  }

  /**
   * Leaving without saving must UNDO a previewed change.
   *
   * The scale previews live by design, but the preview lives in a store the layout
   * reads on every page, so navigating away with an unsaved choice kept it applied over
   * the whole app while the settings page no longer showed it — the page and the UI
   * disagreed about the scale. Reverting on destroy is what makes the preview honest.
   * A no-op when the pending choice was saved (confirmUiScaleSaved clears the flag).
   */
  onDestroy(() => {
    revertUiScaleIfPending();
  });

  // Real update state from the runtime (nulls in a dev run, where updates are inert).
  
  const devicesQuery = createQuery(() => ({
    queryKey: ['system', 'devices'],
    queryFn: () => apiClient.listComputeDevices(),
  }));

  const updateMutation = createMutation(() => ({
    mutationFn: (settings: Partial<AppSettings>) => apiClient.updateSettings(settings),
    onSuccess: (saved: AppSettings) => {
      // The pending choice is the persisted one now; let server values win again.
      confirmUiScaleSaved();
      // ADOPT THE RESPONSE into the form. This is the fix for "saving the VOD directory did
      // not make the page accept the save": a refetch alone writes the resolved path into the
      // QUERY CACHE while the form keeps the text the user typed, and `~`-vs-expanded can never
      // compare equal — so the form stayed dirty for ever (Save armed, no saved mark, no
      // toast). The response is the one value guaranteed to be in the same spelling the dirty
      // rule compares against.
      adoptForm(saved);
      settingsQuery.refetch();
    },
  }));

  /**
   * The editable settings, as one object.
   *
   * The fields keep their own names because the template binds them directly (`bind:value={f
   * .vodDir}`); what is new is that they move together. `dirty` and the revert both need the
   * WHOLE form, and a `let` per field would mean building that unit in two more places — which
   * is exactly the drift that produced the bug being fixed here.
   */
  let form = $state<SettingsForm>({ ...DEFAULT_FORM });
  let loaded = $state(false);

  // Destructured so the script and the template share ONE owner: `vodDir` below IS
  // `form.vodDir`, not a copy of it.
  let {
    gpuDevice, cpuUsage, defaultMaxQualityHeight, uiScale, exportDir, vodDir,
    defaultAspectRatio, captionsEnabled, captionPreset, captionPosition,
    captionFontSize, captionBgOpacity, engineBinaryPath,
  } = $derived(form);

  /**
   * Take server values as the form's own.
   *
   * The single writer of every field: the initial load, the adopt-on-save, and the revert all
   * come through here, so none of them can normalize a field differently from the dirty rule
   * that judges it.
   */
  function adoptForm(s: AppSettings) {
    form = formFromSettings(s);
    loaded = true;
  }

  // Seed once. Re-seeding on every cache event would clobber edits in progress — the cache also
  // fires for unrelated queries (the 1 Hz download poller among them).
  $effect(() => {
    const s = settingsQuery.data;
    if (s && !loaded) adoptForm(s);
  });

  function save() {
    updateMutation.mutate(formToSettings(form));
  }

  /**
   * Discard every edit, restoring the last saved settings.
   *
   * Backed by the SERVER's value (via the query cache), never by a snapshot taken locally: the
   * server resolves paths and may refuse a value outright, so a local snapshot can describe a
   * state the server never held. Same rule the UI-scale store follows — an unsaved change must
   * not survive, and what it reverts TO must be something the server actually confirmed.
   */
  function revert() {
    const server = settingsQuery.data;
    if (server) adoptForm(server);
    // The scale preview lives in a shared store the layout reads on every route, so undoing it
    // is not optional: reverting the form must also take back the previewed zoom.
    revertUiScaleIfPending();
  }

  const dirty = $derived(isDirty(form, settingsQuery.data));

  /**
   * Whether the save confirmation should be showing.
   *
   * Its own flag rather than `updateMutation.isSuccess`, because that stays true for the rest of
   * the page's life: edit anything after a save and the "✓ Saved" mark would still be sitting
   * there claiming the current values were saved. This is the same 2s confirmation the project
   * settings panel uses.
   */
  let justSaved = $state(false);
  $effect(() => {
    if (!updateMutation.isSuccess) return;
    justSaved = true;
    const t = setTimeout(() => (justSaved = false), 2000);
    return () => clearTimeout(t);
  });

  const ratios: { value: AspectRatio; label: string }[] = [
    { value: '16:9', label: '16:9' },
    { value: '9:16', label: '9:16' },
    { value: '1:1', label: '1:1' },
  ];

  const uiScales: { value: UiScale; label: string; hint: string }[] = [
    { value: 'small', label: 'Small', hint: `${UI_SCALE_FACTOR.small * 100}% — original density, most content on screen` },
    { value: 'medium', label: 'Medium', hint: `${UI_SCALE_FACTOR.medium * 100}% — default` },
    { value: 'large', label: 'Large', hint: `${UI_SCALE_FACTOR.large * 100}% — easiest to read` },
  ];

  const cpuTiers: { value: AppSettings['cpuUsage']; label: string; hint: string }[] = [
    { value: 'slow', label: 'Slow', hint: '25% of cores — machine stays fully usable' },
    { value: 'medium', label: 'Medium', hint: '50% of cores — balanced' },
    { value: 'fast', label: 'Fast', hint: '100% of cores — fastest, machine busy' },
  ];
</script>

<div class="flex h-full flex-col overflow-y-auto p-6" use:fadeIn role="region" aria-label="Settings">
  <div class="mx-auto flex w-full max-w-2xl flex-col gap-6">
    <div class="flex items-center justify-between">
      <h1 class="font-display text-xl font-medium">Settings</h1>
      <button
        class="flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        onclick={save}
        disabled={!dirty}
      >
        <Icon name="check" size={15} />
        {updateMutation.isPending ? 'Saving...' : 'Save'}
      </button>
    </div>

    {#if settingsQuery.isLoading}
      <div class="text-sm text-ash">Loading...</div>
    {:else if settingsQuery.isError}
      <div class="rounded-md border border-error bg-surface px-3 py-2 text-xs text-error">
        {settingsQuery.error?.message ?? 'Failed to load settings'}
      </div>
    {:else}
      <!-- Processing -->
      <section class="flex flex-col gap-3">
        <h2 class="font-display text-sm font-medium text-ash uppercase tracking-wider">Processing</h2>
        <div class="flex flex-col gap-4 rounded-md border border-border bg-surface p-4">
          <label class="flex flex-col gap-1">
            <span class="font-mono text-xs text-ash">Compute Device</span>
            <select bind:value={form.gpuDevice} class="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none">
              <option value="auto">Auto (first available GPU)</option>
              {#each devicesQuery.data ?? [] as device}
                <option value={String(device.index)}>
                  {device.label}{#if device.type === 'gpu' && device.memoryMB > 0} · {Math.round(device.memoryMB / 1024 * 10) / 10} GB{/if}
                </option>
              {/each}
            </select>
            <span class="font-mono text-xs text-ash-dim">
              {#if devicesQuery.isLoading}
                Detecting devices...
              {:else if (devicesQuery.data ?? []).filter(d => d.type === 'gpu').length === 0}
                No NVIDIA GPUs detected. CPU will be used.
              {:else}
                Device for ML inference. Auto uses the first available GPU.
              {/if}
            </span>
          </label>

          <div>
            <span class="mb-1 block font-mono text-xs text-ash">CPU Usage Tier</span>
            <div class="flex gap-2">
              {#each cpuTiers as tier}
                <button
                  class="rounded-md border px-3 py-1.5 text-sm transition-colors
                  {cpuUsage === tier.value ? 'border-accent text-accent' : 'border-border text-ash hover:text-ink'}"
                  onclick={() => form.cpuUsage = tier.value}
                  title={tier.hint}
                >
                  {tier.label}
                </button>
              {/each}
            </div>
            <span class="mt-1 block font-mono text-xs text-ash-dim">
              {cpuTiers.find((t) => t.value === cpuUsage)?.hint} — applies to transcription workers.
            </span>
          </div>

          <label class="flex flex-col gap-1">
            <span class="font-mono text-xs text-ash">Default Max Download Quality</span>
            <select
              bind:value={form.defaultMaxQualityHeight}
              class="self-start rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
              aria-label="Default max download quality"
            >
              <option value={2160}>2160p (4K, source capped)</option>
              <option value={1440}>1440p</option>
              <option value={1080}>1080p</option>
              <option value={720}>720p</option>
              <option value={480}>480p</option>
              <option value={null}>No cap (source quality)</option>
            </select>
            <span class="font-mono text-xs text-ash-dim">
              Highest resolution downloaded for new imports (the import modal can override per download). Applies to the vertical dimension for both horizontal and vertical content.
            </span>
          </label>

          <label class="flex flex-col gap-1">
            <span class="font-mono text-xs text-ash">Engine Binary Path</span>
            <input
              type="text"
              bind:value={form.engineBinaryPath}
              placeholder="Auto-detect (leave empty)"
              class="rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-ink placeholder:text-ash-dim focus:border-accent focus:outline-none"
            />
            <span class="font-mono text-xs text-ash-dim">Path to the semaclip-engine binary. Leave empty for auto-detection.</span>
          </label>
        </div>
      </section>

      <!-- Download locations -->
      <section class="flex flex-col gap-3">
        <h2 class="font-display text-sm font-medium text-ash uppercase tracking-wider">VOD Downloads</h2>
        <div class="flex flex-col gap-4 rounded-md border border-border bg-surface p-4">
          <label class="flex flex-col gap-1">
            <span class="font-mono text-xs text-ash">VOD Directory</span>
            <input
              type="text"
              bind:value={form.vodDir}
              placeholder="/path/to/VODs"
              class="rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-ink placeholder:text-ash-dim focus:border-accent focus:outline-none"
            />
            <span class="font-mono text-xs text-ash-dim">
              Where new downloads create their project folder, as
              <span class="text-ash">streamer-game-date</span>. Each project records its own path, so
              changing this only affects downloads started from now on — and any project can be
              pointed elsewhere on its own with <span class="text-ash">Change Location</span>.
            </span>
          </label>
        </div>
      </section>

      <!-- Export defaults -->
      <section class="flex flex-col gap-3">
        <h2 class="font-display text-sm font-medium text-ash uppercase tracking-wider">Export Defaults</h2>
        <div class="flex flex-col gap-4 rounded-md border border-border bg-surface p-4">
          <label class="flex flex-col gap-1">
            <span class="font-mono text-xs text-ash">Export Directory</span>
            <input
              type="text"
              bind:value={form.exportDir}
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
                  onclick={() => form.defaultAspectRatio = r.value}
                >
                  {r.label}
                </button>
              {/each}
            </div>
          </div>

          <p class="font-mono text-xs text-ash-dim">
            Platform presets (TikTok / Shorts / Archive) are managed on the Export screen — they live where they're used.
          </p>
        </div>
      </section>

      <!-- Captions -->
      <section class="flex flex-col gap-3">
        <h2 class="font-display text-sm font-medium text-ash uppercase tracking-wider">Captions</h2>
        <div class="flex flex-col gap-4 rounded-md border border-border bg-surface p-4">
          <span class="flex items-center gap-2 font-mono text-xs text-ash uppercase">
            <input type="checkbox" bind:checked={form.captionsEnabled} class="accent-accent" />
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
                    onclick={() => form.captionPreset = style as CaptionStyle['preset']}
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
                    onclick={() => form.captionPosition = pos as CaptionStyle['position']}
                  >
                    {pos}
                  </button>
                {/each}
              </div>
              <div class="flex items-center gap-3">
                <span class="font-mono text-xs text-ash-dim">Font size:</span>
                <input type="range" min="24" max="96" bind:value={form.captionFontSize} class="accent-accent" />
                <span class="font-mono text-xs text-ash">{captionFontSize}px</span>
              </div>
              <div class="flex items-center gap-3">
                <span class="font-mono text-xs text-ash-dim">BG opacity:</span>
                <input type="range" min="0" max="1" step="0.1" bind:value={form.captionBgOpacity} class="accent-accent" />
                <span class="font-mono text-xs text-ash">{Math.round(captionBgOpacity * 100)}%</span>
              </div>
            </div>
          {/if}
        </div>
      </section>

      <!-- Appearance -->
      <section class="flex flex-col gap-3">
        <h2 class="font-display text-sm font-medium text-ash uppercase tracking-wider">Appearance</h2>
        <div class="rounded-md border border-border bg-surface p-4">
          <div class="flex items-start justify-between gap-6">
            <div class="flex flex-col gap-0.5">
              <label for="ui-scale" class="text-sm text-ink">Interface scale</label>
              <span class="text-xs text-ash-dim">
                {uiScales.find((s) => s.value === uiScale)?.hint ?? ''}
              </span>
            </div>
            <select
              id="ui-scale"
              class="rounded border border-border bg-surface-2 px-2 py-1 text-sm text-ink"
              value={uiScale}
              onchange={(e) => selectScale(e.currentTarget.value as UiScale)}
            >
              {#each uiScales as scale (scale.value)}
                <option value={scale.value}>{scale.label}</option>
              {/each}
            </select>
          </div>
          <p class="mt-3 border-t border-border pt-3 text-xs text-ash-dim">
            Ctrl+scroll and Ctrl+± are disabled — the scale here is the only way the interface changes size.
          </p>
        </div>
      </section>

      <!-- Keyboard -->
      <section class="flex flex-col gap-3">
        <h2 class="font-display text-sm font-medium text-ash uppercase tracking-wider">Keyboard</h2>
        <div class="rounded-md border border-border bg-surface p-4">
          <p class="mb-2 text-sm text-ash">
            The full map is available on any screen via <kbd class="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-xs">?</kbd>.
          </p>
          <div class="grid grid-cols-2 gap-x-8 gap-y-1.5 font-mono text-xs">
            <div class="flex justify-between"><span class="text-ash-dim">Play / pause</span><span class="text-ink">Space</span></div>
            <div class="flex justify-between"><span class="text-ash-dim">Prev / next clip</span><span class="text-ink">J / K</span></div>
            <div class="flex justify-between"><span class="text-ash-dim">Seek ±5s</span><span class="text-ink">← / →</span></div>
            <div class="flex justify-between"><span class="text-ash-dim">Frame step</span><span class="text-ink">, / .</span></div>
            <div class="flex justify-between"><span class="text-ash-dim">Set in / out</span><span class="text-ink">I / O</span></div>
            <div class="flex justify-between"><span class="text-ash-dim">Timeline zoom</span><span class="text-ink">+ / −</span></div>
            <div class="flex justify-between"><span class="text-ash-dim">Accept / discard</span><span class="text-ink">A / D</span></div>
            <div class="flex justify-between"><span class="text-ash-dim">Snooze / undo</span><span class="text-ink">S / U</span></div>
            <div class="flex justify-between"><span class="text-ash-dim">Axis filters</span><span class="text-ink">1–7</span></div>
            <div class="flex justify-between"><span class="text-ash-dim">Export clip / batch</span><span class="text-ink">E / Shift+E</span></div>
          </div>
          <p class="mt-2 font-mono text-xs text-ash-dim">Remapping is not implemented yet — the defaults above are fixed.</p>
        </div>
      </section>


      <!-- Save status. Gated on having SAVED, not on !dirty: the two agreed by accident
           before, and when they disagreed (a resolved path never equalling the typed one)
           the confirmation could never appear at all. -->
      <div class="flex items-center justify-end gap-3 pb-4">
        {#if updateMutation.isError}
          <span class="font-mono text-xs text-error">{updateMutation.error?.message ?? 'Save failed'}</span>
        {:else if justSaved}
          <span class="font-mono text-xs text-success">✓ Saved</span>
        {/if}
      </div>
    {/if}
  </div>

  <!-- ── UNSAVED-CHANGES FOOTER ────────────────────────────────────────────────
       Floating, so it is reachable from anywhere in a long settings page rather than
       only at the top where the header's Save lives. It states the consequence of
       leaving (the previewed scale reverts) and carries BOTH ways out of it: Save,
       and a Revert that discards the edits back to the last saved settings — so the
       reminder and the two fixes are the same control. -->
  {#if dirty}
    <div
      class="sticky bottom-0 z-10 mx-auto mt-2 flex w-full max-w-2xl items-center justify-between gap-4 rounded-md border border-warning/50 bg-surface-2 px-4 py-2.5 shadow-lg"
      role="status"
      aria-live="polite"
    >
      <span class="flex items-center gap-2 text-xs text-ash">
        <Icon name="alert" size={13} />
        {updateMutation.isPending
          ? 'Saving your changes...'
          : 'You have unsaved changes. Leaving this page reverts them.'}
      </span>
      <div class="flex shrink-0 items-center gap-2">
        <button
          class="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ash transition-colors hover:border-ink hover:text-ink disabled:opacity-50"
          onclick={revert}
          disabled={updateMutation.isPending}
        >
          <Icon name="back" size={13} />
          Revert
        </button>
        <button
          class="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          onclick={save}
          disabled={updateMutation.isPending}
        >
          <Icon name="check" size={13} />
          {updateMutation.isPending ? 'Saving...' : 'Save changes'}
        </button>
      </div>
    </div>
  {/if}
</div>