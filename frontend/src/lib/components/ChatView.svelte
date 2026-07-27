<script lang="ts">
  import { apiClient, type ChatMessage } from '$lib/api/client';
  import Icon from './Icon.svelte';
  import { playerStore, seek } from '$lib/stores/player';

  interface Props {
    streamId: string;
    duration: number | null;
  }

  let { streamId, duration }: Props = $props();

  // ── State ──
  let messages = $state<ChatMessage[]>([]);
  let total = $state(0);
  let loading = $state(false);
  let hasChat = $state(true);
  let scrollEl = $state<HTMLDivElement | undefined>(undefined);
  let showSearch = $state(false);

  // Auto-follow: when true, the chat scrolls to match playback.
  // Disabled when the user manually scrolls. Re-enabled by clicking the
  // follow button or by the playback time jumping far from the current view.
  let autoFollow = $state(true);

  // Guard: prevents the playback-follow effect from reacting to a scroll
  // that IT triggered. Set true before programmatic scroll, cleared after.
  let programmaticScroll = false;

  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  let loaded = $state(false);

  // ── Load messages centered on a timestamp ──
  async function loadAround(time: number) {
    loading = true;
    try {
      const res = await apiClient.listChat(streamId, { around: time, limit: 200 });
      messages = res.messages;
      total = res.total;
      hasChat = true;
    } catch {
      hasChat = false;
    }
    loading = false;
  }

  // ── Load more messages (infinite scroll) ──
  async function loadMore(direction: 'up' | 'down') {
    if (loading || messages.length === 0) return;

    loading = true;
    try {
      if (direction === 'up') {
        const firstT = messages[0]!.t;
        const res = await apiClient.listChat(streamId, { around: firstT, limit: 200 });
        const newMsgs = res.messages.filter((m) => m.t < firstT);
        if (newMsgs.length > 0) {
          const prevScrollHeight = scrollEl?.scrollHeight ?? 0;
          messages = [...newMsgs, ...messages];
          // Maintain scroll position after prepending.
          requestAnimationFrame(() => {
            if (scrollEl) {
              const newScrollHeight = scrollEl.scrollHeight;
              programmaticScroll = true;
              scrollEl.scrollTop += newScrollHeight - prevScrollHeight;
              setTimeout(() => { programmaticScroll = false; }, 50);
            }
          });
        }
      } else {
        const lastT = messages.at(-1)!.t;
        const res = await apiClient.listChat(streamId, { around: lastT, limit: 200 });
        const newMsgs = res.messages.filter((m) => m.t > lastT);
        if (newMsgs.length > 0) {
          messages = [...messages, ...newMsgs];
        }
      }
    } catch { /* ignore */ }
    loading = false;
  }

  // ── Initial load ──
  $effect(() => {
    if (streamId && !loaded) {
      loadAround(0);
      loaded = true;
    }
  });

  // ── Playback follow ──
  // Scrolls the chat so the message closest to currentTime is at the bottom
  // of the viewport (like a live chat feed). Uses programmaticScroll guard
  // to prevent the scroll handler from seeking back.
  let lastFollowTime = -1;
  $effect(() => {
    const time = $playerStore.currentTime;
    if (!autoFollow || !scrollEl || messages.length === 0) return;

    // Throttle: only follow every 0.5s.
    if (Math.abs(time - lastFollowTime) < 0.5) return;
    lastFollowTime = time;

    const firstT = messages[0]!.t;
    const lastT = messages.at(-1)!.t;

    // If playhead is outside loaded range, reload centered on it.
    if (time < firstT - 5 || time > lastT + 5) {
      loadAround(time);
      return;
    }

    // Find the last message with t <= currentTime.
    let idx = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.t <= time) { idx = i; break; }
    }

    // Scroll so this message sits at the bottom of the viewport.
    const targetEl = scrollEl.children[idx] as HTMLElement | undefined;
    if (targetEl) {
      const targetBottom = targetEl.offsetTop + targetEl.offsetHeight;
      const scrollTop = targetBottom - scrollEl.clientHeight;
      if (scrollTop >= 0) {
        programmaticScroll = true;
        scrollEl.scrollTop = scrollTop;
        // Clear guard after the browser processes the scroll event.
        requestAnimationFrame(() => { programmaticScroll = false; });
      }
    }
  });

  // ── Manual scroll handling ──
  // When the user scrolls manually (not from programmatic follow):
  // 1. Disable auto-follow.
  // 2. Load more messages near edges (infinite scroll).
  // 3. Do NOT seek — the user is browsing, not controlling playback.
  // Seeking only happens when autoFollow is re-enabled via the button.
  function handleScroll() {
    if (!scrollEl) return;

    // Ignore scrolls triggered by the follow effect.
    if (programmaticScroll) return;

    // User scrolled manually — disable follow.
    if (autoFollow) autoFollow = false;

    // Infinite scroll: load more when near top or bottom.
    if (scrollEl.scrollTop < 50) {
      loadMore('up');
    }
    if (scrollEl.scrollTop + scrollEl.clientHeight > scrollEl.scrollHeight - 50) {
      loadMore('down');
    }
  }

  // ── Re-enable follow: seek to the bottom-most visible message ──
  function toggleFollow() {
    if (autoFollow) {
      // Turning off — just disable.
      autoFollow = false;
    } else {
      // Turning on — seek to the bottom-most visible message first,
      // so playback syncs to where the user is looking.
      if (scrollEl) {
        const viewportBottom = scrollEl.scrollTop + scrollEl.clientHeight;
        let bottomMsg: ChatMessage | undefined;
        for (let i = 0; i < scrollEl.children.length; i++) {
          const child = scrollEl.children[i] as HTMLElement;
          if (child.offsetTop + child.offsetHeight > viewportBottom - 20) {
            bottomMsg = messages[i];
            break;
          }
        }
        if (bottomMsg) seek(bottomMsg.t);
      }
      autoFollow = true;
    }
  }

  // ── Search ──
  let searchQuery = $state('');
  let searchResults = $state<ChatMessage[]>([]);
  let searching = $state(false);

  async function doSearch() {
    if (!searchQuery.trim()) {
      searchResults = [];
      return;
    }
    searching = true;
    try {
      const res = await apiClient.searchChat(streamId, searchQuery.trim());
      searchResults = res.results;
    } catch {
      searchResults = [];
    }
    searching = false;
  }

  function jumpToMessage(msg: ChatMessage) {
    seek(msg.t);
    loadAround(msg.t);
    showSearch = false;
    searchQuery = '';
    searchResults = [];
    autoFollow = true;
  }

  // ── Formatting ──
  function fmtTime(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  const currentTime = $derived($playerStore.currentTime);
</script>

<div class="flex h-full flex-col overflow-hidden">
  <!-- Header -->
  <div class="flex items-center justify-between border-b border-border px-3 py-2">
    <div class="flex items-center gap-2">
      <span class="font-mono text-xs text-ash-dim">{total > 0 ? total : ''}</span>
    </div>
    <div class="flex items-center gap-1">
      <button
        class="flex h-6 w-6 items-center justify-center rounded text-ash-dim transition-colors hover:text-ink"
        onclick={() => (showSearch = !showSearch)}
        aria-label="Search chat"
      >
        <Icon name="search" size={14} />
      </button>
      <button
        class="flex h-6 w-6 items-center justify-center rounded transition-colors
        {autoFollow ? 'text-accent' : 'text-ash-dim hover:text-ink'}"
        onclick={toggleFollow}
        aria-label="Toggle auto-follow"
        title={autoFollow ? 'Following playback — click to browse manually' : 'Browsing manually — click to follow playback'}
      >
        <Icon name="eye" size={14} fill={autoFollow} />
      </button>
    </div>
  </div>

  <!-- Search overlay -->
  {#if showSearch}
    <div class="border-b border-border bg-surface-2 p-2">
      <div class="flex items-center gap-2">
        <Icon name="search" size={14} class="text-ash-dim" />
        <input
          type="text"
          bind:value={searchQuery}
          oninput={() => { if (searchDebounce) clearTimeout(searchDebounce); searchDebounce = setTimeout(doSearch, 300); }}
          onkeydown={(e) => e.key === 'Enter' && doSearch()}
          placeholder="Search messages..."
          class="flex-1 bg-transparent text-xs text-ink placeholder:text-ash-dim focus:outline-none"
          autocomplete="off"
        />
        <button class="text-ash-dim hover:text-ink" onclick={() => (showSearch = false)} aria-label="Close search">
          <Icon name="close" size={14} />
        </button>
      </div>
      {#if searchResults.length > 0}
        <div class="mt-2 max-h-48 overflow-y-auto">
          {#each searchResults as msg (msg.t + msg.user)}
            <button
              class="flex w-full items-start gap-2 rounded px-2 py-1 text-left transition-colors hover:bg-surface-3"
              onclick={() => jumpToMessage(msg)}
            >
              <span class="font-mono text-xs text-ash-dim shrink-0">{fmtTime(msg.t)}</span>
              <span class="text-xs text-ash truncate"><span class="text-ink">{msg.user}</span>: {msg.body}</span>
            </button>
          {/each}
        </div>
      {:else if searching}
        <div class="py-2 text-center text-xs text-ash-dim">Searching...</div>
      {:else if searchQuery.trim()}
        <div class="py-2 text-center text-xs text-ash-dim">No results</div>
      {/if}
    </div>
  {/if}

  <!-- Messages -->
  {#if !hasChat}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
      <Icon name="alert" size={24} fill={false} class="text-ash-dim" />
      <p class="text-xs text-ash-dim">No chat file attached to this stream.</p>
    </div>
  {:else if messages.length === 0 && loading}
    <div class="flex flex-1 items-center justify-center">
      <span class="text-xs text-ash-dim">Loading chat...</span>
    </div>
  {:else}
    <div
      bind:this={scrollEl}
      class="flex-1 overflow-y-auto"
      onscroll={handleScroll}
    >
      {#if loading && messages.length > 0}
        <div class="py-1 text-center text-xs text-ash-dim">Loading...</div>
      {/if}
      {#each messages as msg, i (msg.t + msg.user + i)}
        <div
          class="flex items-start gap-2 px-3 py-0.5 transition-colors
          {Math.abs(msg.t - currentTime) < 1 ? 'bg-accent/10' : ''}"
        >
          <span class="font-mono text-xs text-ash-dim shrink-0 w-16">{fmtTime(msg.t)}</span>
          <span class="text-xs leading-relaxed break-words">
            <span class="font-medium text-ink">{msg.user}</span>
            <span class="text-ash">: {msg.body}</span>
          </span>
        </div>
      {/each}
      {#if loading && messages.length > 0}
        <div class="py-1 text-center text-xs text-ash-dim">Loading...</div>
      {/if}
    </div>
  {/if}
</div>
