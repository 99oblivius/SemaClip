<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import { fadeIn } from '$lib/actions/gsap';
</script>

<div class="flex h-full flex-col items-center justify-center gap-3 p-6" use:fadeIn role="region" aria-label="Compose">
  <Icon name="layers" size={40} class="text-ash-dim" />
  <p class="font-display text-base text-ash">Compose / Reel</p>
  <p class="max-w-sm text-center text-sm text-ash-dim">
    Multi-clip stitched reels (reorder segments, per-clip trim, single render) are the next
    Phase 2 batch. Accepted clips are already exportable individually on the Export screen.
  </p>
</div>