<script lang="ts">
  import '../app.css';
  import Icon from '$lib/components/Icon.svelte';
  import { wsStore } from '$lib/stores/ws';
  import { fadeIn } from '$lib/actions/gsap';
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { onMount, type Snippet } from 'svelte';
  import { page } from '$app/stores';
  import type { PageData } from './$types';

  let { children, data }: { children: Snippet; data: PageData } = $props();

  onMount(() => wsStore.connect());

  // Active route derived from the current URL path.
  const currentPath = $derived($page.url.pathname);
  const activeNav = $derived(
    currentPath === '/' || currentPath.startsWith('/stream') ? 'library'
    : currentPath.startsWith('/queue') ? 'queue'
    : currentPath.startsWith('/settings') ? 'settings'
    : 'library'
  );

  const navItems = [
    { id: 'library', icon: 'grid' as const, label: 'Library', href: '/' },
    { id: 'queue', icon: 'queue' as const, label: 'Queue', href: '/queue' },
    { id: 'settings', icon: 'settings' as const, label: 'Settings', href: '/settings' },
  ];
</script>

<QueryClientProvider client={data.queryClient}>
  <div class="flex h-screen w-screen overflow-hidden bg-foundation text-ink">
    <nav class="flex w-14 flex-col items-center gap-1 border-r border-border bg-surface pt-3">
      <a href="/" class="mb-4 font-display text-lg font-bold text-accent" aria-label="SemaClip home">S</a>
      {#each navItems as item}
        <a
          href={item.href}
          class="flex h-10 w-10 items-center justify-center rounded-md transition-colors hover:text-ink
          {activeNav === item.id ? 'text-accent' : 'text-ash'}"
          title={item.label}
          aria-label={item.label}
          aria-current={activeNav === item.id ? 'page' : undefined}
        >
          <Icon name={item.icon} size={20} />
        </a>
      {/each}
    </nav>

    <main class="flex-1 overflow-hidden" use:fadeIn>
      {@render children()}
    </main>
  </div>
</QueryClientProvider>
