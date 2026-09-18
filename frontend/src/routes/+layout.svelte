<script lang="ts">
  import '../app.css';
  import Icon from '$lib/components/Icon.svelte';
  import UpdateBanner from '$lib/components/UpdateBanner.svelte';
  import ToolProvisionModal from '$lib/components/ToolProvisionModal.svelte';
  import { wsStore } from '$lib/stores/ws';
  import { fadeIn } from '$lib/actions/gsap';
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { type AppSettings, type WsEvent } from '$shared/types';
  import { uiScale, seedUiScale, applyUiScale } from '$lib/stores/ui-scale';
  import { onMount, type Snippet } from 'svelte';
  import { page } from '$app/stores';
  import { browser } from '$app/environment';
  import type { PageData } from './$types';

  let { children, data }: { children: Snippet; data: PageData } = $props();

  onMount(() => wsStore.connect());

  /**
   * Re-read what the server says changed, instead of waiting for a poll.
   *
   * Every artifact mutation (delete chat, delete video, attach a piece, finish a download)
   * changes the database and previously told the client nothing, so the UI learned about it
   * on its own schedule — up to 30 seconds when idle. Deleting chat from project settings was
   * the visible symptom: the panel and the settings row kept showing the file that had just
   * been deleted.
   *
   * The server now publishes `stream:changed` for those mutations, and this is the one place
   * that turns it into a refetch. Narrow on purpose: it invalidates the stream and the
   * downloads view rather than everything, so a chat delete does not refetch an unrelated
   * library listing.
   *
   * Scoped to the event's own stream when the route knows it, so an event for another stream
   * does not disturb this page's cache.
   */
  $effect(() => {
    const qc = data.queryClient;
    return wsStore.onEvent<WsEvent>((event) => {
      if (event.type === 'stream_changed') {
        // Narrow on the event's own stream so an event for another stream does not disturb
        // this page's cache.
        const id = event.streamId;
        if (id) {
          void qc.invalidateQueries({ queryKey: ['stream', id] });
        } else {
          void qc.invalidateQueries({ queryKey: ['stream'] });
        }
        void qc.invalidateQueries({ queryKey: ['streams'] });
        void qc.invalidateQueries({ queryKey: ['downloads'] });
        return;
      }
      if (event.type === 'job_status' || event.type === 'stream_status') {
        // The server already announces every job transition, so polling the job list every
        // three seconds is redundant work: this makes the transition itself the trigger.
        void qc.invalidateQueries({ queryKey: ['jobs'] });
        if (event.type === 'stream_status') {
          void qc.invalidateQueries({ queryKey: ['streams'] });
          void qc.invalidateQueries({ queryKey: ['stream', event.streamId] });
        }
        return;
      }
    });
  });

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
    /** The MEASURED window, so a claim can be traced (null when unmeasurable). */
    actual?: { frameless: boolean | null; width: number; height: number; source: string } | null;
  };
  /**
   * What the window can actually do, read from the server's MEASURED state.
   *
   * Defaults are the decorated case: drawing no custom chrome is the safe failure, because a
   * window that already has OS buttons must not get a second set. The server reports whether the
   * frame is really gone (`actual.frameless`), and the bar is drawn on that.
   */
  let chrome = $state<Chrome>({
    frameless: false,
    nativeDecorations: true,
    canMinimize: false,
    canMaximize: false,
    actual: null,
  });

  /**
   * Minimize and maximize via the server, which reaches user32.
   *
   * The window class exposes neither (re-verified: the only minimize/maximize strings in the
   * installed runtime belong to Intl.Locale), so with the native frame removed the app has to
   * provide the actions as well as the buttons. Each call reports what the OS did.
   */
  async function minimizeApp() {
    try {
      await fetch('/api/window/minimize', { method: 'POST' });
    } catch {
      // A hidden window has no way to report a failure; the button is best-effort.
    }
  }

  async function maximizeApp() {
    try {
      await fetch('/api/window/maximize', { method: 'POST' });
    } catch {
      // Best-effort: a refused maximize leaves the size unchanged, which is visible.
    }
  }

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
    <!-- Application chrome bar (36px).
         Thinner than a web header, with the window controls as a right-aligned CLUSTER in the
         order a Windows titlebar uses (minimize, maximize, close) — the arrangement is what makes
         a bar read as application chrome rather than a page header. It doubles as the drag region
         when there is no OS titlebar; interactive children opt back out.

         The buttons are drawn only when the app OWNS them (`chrome.canMinimize` etc.), which is
         derived from a MEASURED frame state — a decorated window keeps the OS buttons and this
         bar must not add a second set. -->
    <header
      class="relative flex h-9 shrink-0 items-center gap-3 border-b border-border bg-surface pl-4 pr-0"
      style={chrome.frameless ? '-webkit-app-region: drag;' : ''}
    >
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
      {#if chrome.canMinimize || chrome.canMaximize}
        <div class="ml-1 flex h-full items-stretch self-stretch" style="-webkit-app-region: no-drag;">
          {#if chrome.canMinimize}
            <button
              type="button"
              class="flex w-11 items-center justify-center text-ash-dim transition-colors hover:bg-surface-2 hover:text-ink"
              title="Minimize"
              aria-label="Minimize window"
              onclick={minimizeApp}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M0 5 H10" stroke="currentColor" stroke-width="1" />
              </svg>
            </button>
          {/if}
          {#if chrome.canMaximize}
            <button
              type="button"
              class="flex w-11 items-center justify-center text-ash-dim transition-colors hover:bg-surface-2 hover:text-ink"
              title="Maximize"
              aria-label="Maximize window"
              onclick={maximizeApp}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1" />
              </svg>
            </button>
          {/if}
          <!-- Close sits last and alone on the accent tint: the one destructive control should
               not look like its neighbours. -->
          <button
            type="button"
            class="flex w-12 items-center justify-center text-ash-dim transition-colors hover:bg-accent hover:text-white"
            title="Close SemaClip"
            aria-label="Close SemaClip"
            onclick={closeApp}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      {/if}
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