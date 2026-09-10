<script lang="ts">
  interface Props {
    title: string;
    body: string;
    confirmLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
  }

  let { title, body, confirmLabel = 'Confirm', onConfirm, onCancel }: Props = $props();
</script>

<!-- Shared destructive-action confirmation (user-directed: trash buttons in
     project settings must warn that the action cannot be undone). -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
  role="presentation"
  onclick={(e) => e.target === e.currentTarget && onCancel()}
>
  <div
    class="mx-4 flex w-80 flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-xl"
    role="alertdialog"
    aria-modal="true"
    aria-label={title}
  >
    <h3 class="font-display text-sm font-medium">{title}</h3>
    <p class="text-xs text-ash">{body}</p>
    <div class="flex justify-end gap-2">
      <button
        class="rounded-md border border-border px-3 py-1.5 text-xs text-ash transition-colors hover:text-ink"
        onclick={onCancel}
      >
        Cancel
      </button>
      <button
        class="rounded-md bg-error px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-error/80"
        onclick={onConfirm}
      >
        {confirmLabel}
      </button>
    </div>
  </div>
</div>