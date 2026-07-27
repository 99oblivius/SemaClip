<script lang="ts">
  import Icon from './Icon.svelte';
  import { slideUp } from '$lib/actions/gsap';
  import type { Stream } from '$shared/types';

  interface Props {
    stream: Stream;
    onConfirm: () => void;
    onCancel: () => void;
  }

  let { stream, onConfirm, onCancel }: Props = $props();

  // The user must type the stream's title exactly to enable deletion.
  // Falls back to the stream ID prefix if no title is set.
  const confirmText = $derived(stream.title ?? stream.id.slice(0, 8));
  let typed = $state('');
  const canDelete = $derived(typed === confirmText);
</script>

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
  onclick={onCancel}
  onkeydown={(e) => e.key === 'Escape' && onCancel()}
  role="button"
  tabindex="-1"
>
  <div
    class="w-full max-w-md rounded-lg border border-border bg-surface p-6"
    use:slideUp
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
    role="dialog"
    aria-label="Delete project"
    tabindex="-1"
  >
    <div class="mb-4 flex items-center gap-2">
      <Icon name="trash" size={20} class="text-error" />
      <h2 class="font-display text-base font-medium text-error">Delete Project</h2>
    </div>

    <p class="mb-4 text-sm text-ash">
      This will permanently delete the stream, all its jobs, and all detected clips.
      The original video and chat files on disk will not be deleted.
    </p>

    <div class="mb-4 rounded-md border border-border bg-surface-2 px-3 py-2">
      <div class="font-mono text-xs text-ash-dim mb-1">Project</div>
      <div class="text-sm text-ink">{stream.title ?? 'Untitled Stream'}</div>
      {#if stream.streamer}
        <div class="font-mono text-xs text-ash-dim mt-0.5">{stream.streamer}</div>
      {/if}
    </div>

    <label class="mb-4 block">
      <span class="mb-1 block font-mono text-xs text-ash uppercase">
        Type the project name to confirm
      </span>
      <input
        type="text"
        bind:value={typed}
        class="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-ink focus:border-error focus:outline-none"
        placeholder={confirmText}
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
      />
    </label>

    <div class="flex justify-end gap-2">
      <button
        class="rounded-md border border-border px-4 py-2 text-sm text-ash transition-colors hover:text-ink"
        onclick={onCancel}
      >
        Cancel
      </button>
      <button
        class="flex items-center gap-1 rounded-md bg-error px-4 py-2 text-sm font-medium text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        onclick={onConfirm}
        disabled={!canDelete}
      >
        <Icon name="trash" size={16} />
        Delete
      </button>
    </div>
  </div>
</div>
