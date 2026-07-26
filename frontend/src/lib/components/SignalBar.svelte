<script lang="ts">
  interface Props {
    label: string;
    value: number; // 0-1
  }
  let { label, value }: Props = $props();
  let pct = $derived(Math.round(value * 100));
</script>

<div class="flex items-center gap-2">
  <span class="w-12 font-mono text-xs text-ash-dim">{label}</span>
  <div class="relative h-2 flex-1 overflow-hidden rounded-sm bg-surface-3">
    <div
      class="absolute inset-y-0 left-0 bg-ash transition-[width] duration-300 ease-out"
      style="width: {pct}%"
    ></div>
  </div>
</div>
