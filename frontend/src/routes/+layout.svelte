<script lang="ts">
  import '../app.css';
  import Icon from '$lib/components/Icon.svelte';
  import { wsStore } from '$lib/stores/ws';
  import { fadeIn } from '$lib/actions/gsap';
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { onMount, type Snippet } from 'svelte';
  import type { PageData } from './$types';

  let { children, data }: { children: Snippet; data: PageData } = $props();
  let route = $state('library');

  onMount(() => wsStore.connect());

  const navItems = [
    { id: 'library', icon: 'grid' as const, label: 'Library' },
    { id: 'queue', icon: 'queue' as const, label: 'Queue' },
    { id: 'settings', icon: 'settings' as const, label: 'Settings' },
  ];
</script>

<QueryClientProvider client={data.queryClient}>
  <div class="flex h-screen w-screen overflow-hidden bg-foundation text-ink">
    <nav class="flex w-14 flex-col items-center gap-1 border-r border-border bg-surface pt-3">
      <div class="mb-4 font-display text-lg font-bold text-accent">S</div>
      {#each navItems as item}
        <button
          class="flex h-10 w-10 items-center justify-center rounded-md transition-colors hover:text-ink
          {route === item.id ? 'text-accent' : 'text-ash'}"
          onclick={() => (route = item.id)}
          title={item.label}
          aria-label={item.label}
        >
          <Icon name={item.icon} size={20} />
        </button>
      {/each}
    </nav>

    <main class="flex-1 overflow-hidden" use:fadeIn>
      {@render children()}
    </main>
  </div>
</QueryClientProvider>
