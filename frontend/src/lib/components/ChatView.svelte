<script lang="ts">
  import { apiClient, type ChatMessage } from '$lib/api/client';
  import Icon from './Icon.svelte';
  import { playerStore, seek } from '$lib/stores/player';

  interface Props {
    streamId: string;
    duration: number | null;
  }

  let { streamId, duration }: Props = $props();

  // ── All messages (loaded once, sorted by time) ──
  let allMessages = $state<ChatMessage[]>([]);
  let loading = $state(false);
  let hasChat = $state(true);
  let loaded = $state(false);

  // ── View state ──
  // scrollIndex: index of the bottom-most visible message.
  // The view shows the last VISIBLE_COUNT messages up to scrollIndex,
  // rendered bottom-aligned via flex justify-end (no scrollbar, no DOM scroll).
  //
  // When following, an effect syncs scrollIndex to player.currentTime.
  // When the user scrolls, scrollIndex moves by 1 message and seeks to
  // that message's time. This works even while playing — the seek jumps
  // playback and the follow effect picks up the new position.
  let follow = $state(true);
  let scrollIndex = $state(0);
  const player = $derived($playerStore);
  const VISIBLE_COUNT = 40;

  $effect(() => {
    if (streamId && !loaded) {
      loaded = true;
      loadAll();
    }
  });

  async function loadAll() {
    loading = true;
    try {
      // Single request — server caches the parsed chat file in memory.
      const res = await apiClient.listChat(streamId, { offset: 0, limit: 100000 });
      allMessages = res.messages;
      hasChat = true;
    } catch {
      hasChat = false;
    } finally {
      loading = false;
    }
    scrollIndex = 0;
  }
  // ── Follow: sync scrollIndex to playback ──
  // Uses a guard so user-initiated scrolls don't get overridden while
  // the debounced seek is in flight.
  let userScrolling = false;
  $effect(() => {
    if (!follow || allMessages.length === 0 || userScrolling) return;
    const time = player.currentTime;
    // Binary search: last index where t <= time.
    let lo = 0, hi = allMessages.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (allMessages[mid]!.t <= time) lo = mid + 1;
      else hi = mid;
    }
    scrollIndex = lo;
  });

  // ── Visible messages: last VISIBLE_COUNT up to scrollIndex ──
  const visibleMessages = $derived(
    allMessages.slice(Math.max(0, scrollIndex - VISIBLE_COUNT), scrollIndex)
  );

  // ── Scroll: move one message, debounced seek to bottom message's time ──
  let seekTimer: ReturnType<typeof setTimeout> | null = null;
  function scrollToIndex(newIndex: number) {
    const clamped = Math.max(0, Math.min(allMessages.length, newIndex));
    if (clamped === scrollIndex) return;
    scrollIndex = clamped;
    userScrolling = true;
    // Debounce seek so rapid scroll doesn't spam the store / fight playback.
    if (seekTimer) clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      userScrolling = false;
      const msg = allMessages[clamped - 1];
      if (msg) seek(msg.t);
    }, 120);
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    if (allMessages.length === 0) return;
    const dir = e.deltaY > 0 ? 1 : -1;
    scrollToIndex(scrollIndex + dir);
  }

  // ── Drag to scrub: move by message proportional to drag distance ──
  let isDragging = false;
  let dragStartY = 0;
  let dragStartIndex = 0;

  function handleMouseDown(e: MouseEvent) {
    isDragging = true;
    dragStartY = e.clientY;
    dragStartIndex = scrollIndex;
    e.preventDefault();
  }

  function handleMouseMove(e: MouseEvent) {
    if (!isDragging || allMessages.length === 0) return;
    const dy = e.clientY - dragStartY;
    // Dragging up = forward through messages. ~3px per message.
    const delta = -Math.round(dy / 3);
    scrollToIndex(dragStartIndex + delta);
  }

  function handleMouseUp() {
    isDragging = false;
  }
  // ── Toggle follow ──
  function toggleFollow() {
    if (!follow) {
      // Re-enabling: seek to current bottom message.
      const msg = allMessages[scrollIndex - 1];
      if (msg) seek(msg.t);
    }
    follow = !follow;
  }

  // ── Search ──
  let showSearch = $state(false);
  let searchQuery = $state('');
  let searchResults = $state<ChatMessage[]>([]);
  let searching = $state(false);
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

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
    const idx = allMessages.findIndex((m) => m.t === msg.t && m.user === msg.user);
    if (idx >= 0) {
      scrollIndex = Math.min(allMessages.length, idx + 1);
    }
    seek(msg.t);
    showSearch = false;
    searchQuery = '';
    searchResults = [];
    follow = true;
  }

  // ── Formatting ──
  function fmtTime(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
</script>

<svelte:window onmousemove={handleMouseMove} onmouseup={handleMouseUp} />

<div class="flex h-full flex-col overflow-hidden">
  <!-- Header -->
  <div class="flex items-center justify-between border-b border-border px-3 py-2">
    <span class="font-mono text-xs text-ash-dim">
      {allMessages.length > 0 ? allMessages.length : ''}
    </span>
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
        {follow ? 'text-accent' : 'text-ash-dim hover:text-ink'}"
        onclick={toggleFollow}
        aria-label="Toggle follow playback"
        title={follow ? 'Following playback — click to browse manually' : 'Browsing manually — click to follow playback'}
      >
        <Icon name="eye" size={14} fill={follow} />
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

  <!-- Messages: time-windowed view, no scrollbar -->
  {#if !hasChat}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
      <Icon name="alert" size={24} fill={false} class="text-ash-dim" />
      <p class="text-xs text-ash-dim">No chat file attached to this stream.</p>
    </div>
  {:else if loading}
    <div class="flex flex-1 items-center justify-center">
      <span class="text-xs text-ash-dim">Loading chat...</span>
    </div>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="flex-1 overflow-hidden select-none"
      onwheel={handleWheel}
      onmousedown={handleMouseDown}
      role="log"
      tabindex="-1"
      aria-label="Chat messages — scroll or drag to browse"
    >
      <div class="flex h-full flex-col justify-end">
        {#if visibleMessages.length === 0}
          <div class="flex items-center justify-center py-4">
            <span class="text-xs text-ash-dim">Scroll down to browse messages</span>
          </div>
        {/if}
        {#each visibleMessages as msg, i (msg.t + msg.user + i)}
          {@const isLive = Math.abs(msg.t - player.currentTime) < 1}
          <div
            class="px-3 py-0.5 transition-colors {isLive ? 'bg-accent/10' : ''}"
          >
            <span class="text-xs leading-relaxed break-words">
              <span class="font-medium text-ink">{msg.user}</span><span class="text-ash">: {msg.body}</span><span class="text-ash-dim text-[10px] ml-1.5">· {fmtTime(msg.t)}</span>
            </span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>
