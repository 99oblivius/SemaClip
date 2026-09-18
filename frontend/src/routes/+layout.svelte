<script lang="ts">
  import '../app.css';
  import Icon from '$lib/components/Icon.svelte';
  import UpdateBanner from '$lib/components/UpdateBanner.svelte';
  import ToolProvisionModal from '$lib/components/ToolProvisionModal.svelte';
  import { wsStore } from '$lib/stores/ws';
  import { fadeIn } from '$lib/actions/gsap';
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { type AppSettings } from '$shared/types';
  import { uiScale, seedUiScale, applyUiScale } from '$lib/stores/ui-scale';
  import { onMount, type Snippet } from 'svelte';
  import { page } from '$app/stores';
  import { browser } from '$app/environment';
  import type { PageData } from './$types';

  let { children, data }: { children: Snippet; data: PageData } = $props();

  onMount(() => wsStore.connect());

  // UI scale. Applied as the root font-size so every rem-based size and Tailwind
  // spacing utility scales together — the alternative (a CSS transform) blurs
  // text and breaks hit-testing.
  //
  // Two sources feed one store: the PERSISTED setting (read from the query cache,
  // seeded on load and whenever the server value changes) and an explicit user
  // choice on the settings page. The store is the only thing that touches the
  // DOM, so there is exactly one writer of the root font size — reading the
  // setting straight into the DOM here and also from the dropdown would be the
  // two-owners bug class.
  //
  // getQueryData is a NON-reactive read, so subscribing to the cache is what makes
  // the initial load and later server changes actually arrive. `data` is read
  // inside the closures (not captured at init) so the reference tracks the prop.
  const seedFromCache = () => {
    const cached = data.queryClient.getQueryData<AppSettings>(['settings']);
    if (cached?.uiScale) seedUiScale(cached.uiScale);
  };
  seedFromCache();

  $effect(() => {
    if (!browser) return;
    seedFromCache();
    const cache = data.queryClient.getQueryCache();
    return cache.subscribe(seedFromCache);
  });

  $effect(() => {
    if (!browser) return;
    applyUiScale($uiScale);
  });

  // Ctrl+wheel and Ctrl+plus/minus must NOT zoom. In a browser those are the
  // browser's own zoom; in the desktop webview they still fire, which would
  // double-scale the UI on top of the setting above and make the app feel like a
  // webpage. Swallow them so the Settings dropdown is the only thing that scales.
  function suppressZoom(event: WheelEvent | KeyboardEvent) {
    const zoomKeys = ['+', '=', '-', '_', '0'];
    const isZoomKey = event instanceof KeyboardEvent && zoomKeys.includes(event.key);
    const isZoomWheel = event instanceof WheelEvent && event.ctrlKey;
    if ((event.ctrlKey || event.metaKey) && (isZoomKey || isZoomWheel)) {
      event.preventDefault();
    }
  }
  // A browser chrome leaks into a desktop app in two ways: the URL of every link is
  // shown on hover, and right-click offers "Back", "Reload", "View source". Neither
  // belongs in a tool. Suppressing the context menu must NOT break text editing, so a
  // focused text field keeps the native menu (copy, paste, spellcheck).
  function suppressContextMenu(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    const editable = target?.closest('input, textarea, [contenteditable="true"]');
    if (editable) return;
    event.preventDefault();
  }

  onMount(() => {
    window.addEventListener('wheel', suppressZoom, { passive: false });
    window.addEventListener('keydown', suppressZoom);
    window.addEventListener('contextmenu', suppressContextMenu);
    // Ask once what chrome to draw. A failure keeps the defaults above, which is the
    // native-decoration case: better to draw no custom chrome than to draw a close
    // button for a window that already has one.
    fetch('/api/window')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) chrome = data as Chrome;
      })
      .catch(() => {});
    return () => {
      window.removeEventListener('wheel', suppressZoom);
      window.removeEventListener('keydown', suppressZoom);
      window.removeEventListener('contextmenu', suppressContextMenu);
    };
  });

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

  // The window title is the app's identity, never a document path or a port. The
  // webview would otherwise show the URL it navigated to (127.0.0.1:<port>) as the
  // window title, which is the most browser-like tell in the whole app.
  // What the window can actually do, asked of the server rather than assumed. A
  // frameless window has no OS titlebar, so the app must provide its own drag region
  // and close button. The capability report also says whether minimize and maximize
  // exist at all (measured: they do not, on this window class).
  type Chrome = {
    frameless: boolean;
    nativeDecorations: boolean;
    canMinimize: boolean;
    canMaximize: boolean;
  };
  let chrome = $state<Chrome>({
    frameless: false,
    nativeDecorations: true,
    canMinimize: false,
    canMaximize: false,
  });

  async function closeApp() {
    try {
      await fetch('/api/window/close', { method: 'POST' });
    } catch {
      // The process exits from the window's close handler, so a dropped response is
      // expected: the server can be gone before it manages to answer.
    }
  }

  const pageTitle = $derived(
    navItems.find((item) => item.active && item.id !== 'library')?.label ?? 'Library',
  );

  function reviewHref(): string {
    // SSR has no localStorage — dev-mode SSR crashed on undefined (500 on /).
    // The rail just falls back to Library during SSR; hydration replaces it.
    if (!browser) return '/';
    const last = localStorage.getItem('semaclip-last-stream');
    return last ? `/stream/${last}` : '/';
  }
</script>

<svelte:head>
  <title>SemaClip {__APP_VERSION__} — {pageTitle}</title>
</svelte:head>

<QueryClientProvider client={data.queryClient}>
<div class="flex h-screen w-screen flex-col overflow-hidden bg-foundation text-ink">
    <!-- Top bar (44px): wordmark + local-first badge + connection state. It doubles
         as the window's drag region when there is no OS titlebar; interactive
         children opt back out so links and buttons still work. -->
    <header
      class="relative flex h-11 shrink-0 items-center gap-3 border-b border-border bg-surface px-4"
      style={chrome.frameless ? '-webkit-app-region: drag;' : ''}
    >
      <!-- Close button, only when the window has no decoration: without it there is
           no way to close the app at all. Minimize and maximize are deliberately
           absent because the window class does not expose them (verified against the
           runtime's own prototype, not assumed from the docs). -->
      {#if chrome.frameless}
        <button
          type="button"
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ash transition-colors hover:bg-accent/20 hover:text-accent"
          style="-webkit-app-region: no-drag;"
          title="Close SemaClip"
          aria-label="Close SemaClip"
          onclick={closeApp}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M1 1 L11 11 M11 1 L1 11" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" />
          </svg>
        </button>
      {/if}
      <a href="/" class="flex items-baseline gap-2" style="-webkit-app-region: no-drag;" aria-label="SemaClip home">
        <span class="font-display text-base font-bold tracking-tight">Sema<span class="text-accent">Clip</span></span>
      </a>
      <span class="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-ash-dim" title="All processing happens on this machine">
        <Icon name="cpu" size={10} /> local
      </span>
      <div class="flex-1"></div>
      <!-- Pre-alpha notice: dead-centre of the bar so it is unmissable on every
           navigation. Uses the theme's blood-red accent (scarce by design). There is
           one continuous line of releases, so no channel chip accompanies it: the
           version alone identifies the build. -->
      <span class="pointer-events-none absolute left-1/2 flex -translate-x-1/2 items-center gap-1.5">
        <span
          class="rounded border border-accent/60 bg-accent/10 px-2 py-0.5 font-mono text-[10px] font-bold tracking-wide text-accent"
          title="This software is pre-alpha: features are missing and things will break."
        >
          pre-alpha v{__APP_VERSION__} — missing features, will break
        </span>
      </span>
      <span
        class="flex items-center gap-1.5 font-mono text-[10px] {$wsStore.connected ? 'text-success' : 'text-warning'}"
        title={$wsStore.connected ? 'Engine events connected' : 'Reconnecting to engine events...'}
      >
        <span class="h-1.5 w-1.5 rounded-full {$wsStore.connected ? 'bg-success' : 'animate-pulse bg-warning'}"></span>
        {$wsStore.connected ? 'ready' : 'connecting'}
      </span>
    </header>

    <!-- Staged-update prompt: below the header, above every page, so it cannot be missed
         on any navigation. It appears when the runtime reports a stage (pushed over
         /api/events) and stays until acted on. -->
    <UpdateBanner />

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

    <!-- App-wide, not per-screen: a missing ffmpeg blocks downloads and exports
         wherever they are started, so the offer belongs above the routing. It
         renders nothing unless the binary is actually absent. -->
    <ToolProvisionModal />
  </div>
</QueryClientProvider>