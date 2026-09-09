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

  const currentPath = $derived($page.url.pathname);

  // Rail order = workflow order (spec §4.0). Review/Processing/Compose/Export
  // are contextual: they route into the most recent stream context when one
  // exists, otherwise land on the nearest meaningful surface.
  const navItems = $derived([
    { id: 'library', icon: 'grid' as const, label: 'Library', href: '/', active: currentPath === '/' || currentPath.startsWith('/stream') },
    { id: 'review', icon: 'film' as const, label: 'Review', href: reviewHref(), active: currentPath.startsWith('/stream') && !currentPath.includes('/processing') },
    { id: 'processing', icon: 'queue' as const, label: 'Processing', href: '/queue', active: currentPath.startsWith('/queue') || currentPath.includes('/processing') },
    { id: 'compose', icon: 'layers' as const, label: 'Compose', href: '/compose', active: currentPath.startsWith('/compose') },
    { id: 'export', icon: 'scissors' as const, label: 'Export', href: '/export', active: currentPath.startsWith('/export') },
    { id: 'settings', icon: 'settings' as const, label: 'Settings', href: '/settings', active: currentPath.startsWith('/settings') },
  ]);

  function reviewHref(): string {
    const last = localStorage.getItem('semaclip-last-stream');
    return last ? `/stream/${last}` : '/';
  }
</script>

<QueryClientProvider client={data.queryClient}>
  <div class="flex h-screen w-screen flex-col overflow-hidden bg-foundation text-ink">
    <!-- Top bar (44px): wordmark + local-first badge + connection state -->
    <header class="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
      <a href="/" class="flex items-baseline gap-2" aria-label="SemaClip home">
        <span class="font-display text-base font-bold tracking-tight">Sema<span class="text-accent">Clip</span></span>
      </a>
      <span class="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-ash-dim" title="All processing happens on this machine">
        <Icon name="cpu" size={10} /> local
      </span>
      <div class="flex-1"></div>
      <span
        class="flex items-center gap-1.5 font-mono text-[10px] {$wsStore.connected ? 'text-success' : 'text-warning'}"
        title={$wsStore.connected ? 'Engine events connected' : 'Reconnecting to engine events...'}
      >
        <span class="h-1.5 w-1.5 rounded-full {$wsStore.connected ? 'bg-success' : 'animate-pulse bg-warning'}"></span>
        {$wsStore.connected ? 'ready' : 'connecting'}
      </span>
    </header>

    <div class="flex min-h-0 flex-1">
      <!-- Rail (56px): 2px accent left border marks active -->
      <nav class="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-3" aria-label="Primary">
        {#each navItems as item (item.id)}
          <a
            href={item.href}
            class="relative flex h-10 w-10 items-center justify-center rounded-md transition-colors
            {item.active ? 'text-ink' : 'text-ash hover:text-ink'}"
            title={item.label}
            aria-label={item.label}
            aria-current={item.active ? 'page' : undefined}
          >
            {#if item.active}
              <span class="absolute -left-3 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-accent"></span>
            {/if}
            <Icon name={item.icon} size={19} />
          </a>
        {/each}
      </nav>

      <main class="min-w-0 flex-1 overflow-hidden" use:fadeIn>
        {@render children()}
      </main>
    </div>
  </div>
</QueryClientProvider>