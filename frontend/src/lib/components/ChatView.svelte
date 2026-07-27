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
  // The chat shows messages in a time window ending at `viewTime`.
  // When follow is on, viewTime tracks playback. When off, the user
  // controls it by scrolling (wheel/drag).
  let viewTime = $state(0);
  let follow = $state(true);

  // How many messages to show in the viewport.
  const VISIBLE_COUNT = 40;

  // ── Load all messages once ──
  $effect(() => {
    if (streamId && !loaded) {
      loaded = true;
      loadAll();
    }
  });

  async function loadAll() {
    loading = true;
    try {
      // Load in chunks of 500 until we have everything.
      let offset = 0;
      let msgs: ChatMessage[] = [];
      while (true) {
        const res = await apiClient.listChat(streamId, { offset, limit: 500 });
        msgs = [...msgs, ...res.messages];
        if (res.messages.length < 500) break;
        offset += 500;
      }
      allMessages = msgs.sort((a, b) => a.t - b.t);
      hasChat = true;
    } catch {
      hasChat = false;
    }
    loading = false;
  }

  // ── Follow: sync viewTime to playback ──
  $effect(() => {
    if (follow) {
      viewTime = $playerStore.currentTime;
    }
  });

  // ── Visible messages: the last VISIBLE_COUNT messages with t <= viewTime ──
  // Binary search for the insertion point, then slice backward.
  const visibleMessages = $derived.by(() => {
    if (allMessages.length === 0) return [];
    // Binary search: find the last index where t <= viewTime.
    let lo = 0, hi = allMessages.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (allMessages[mid]!.t <= viewTime) lo = mid + 1;
      else hi = mid;
    }
    const end = lo;
    const start = Math.max(0, end - VISIBLE_COUNT);
    return allMessages.slice(start, end);
  });

  // ── Scroll handling: wheel adjusts viewTime ──
  // Each wheel tick moves viewTime by a proportional amount.
  // This seeks playback when follow is on, or just moves the chat window when off.
  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    // Sensitivity: ~3 seconds per wheel tick, scaled by delta.
    const delta = e.deltaY * 0.01;
    const newTime = Math.max(0, Math.min(duration ?? Infinity, viewTime + delta));
    viewTime = newTime;
    if (follow) {
      seek(newTime);
    }
  }

  // ── Drag to scrub: click and drag to move through chat ──
  let isDragging = false;
  let dragStartY = 0;
  let dragStartTime = 0;

  function handleMouseDown(e: MouseEvent) {
    isDragging = true;
    dragStartY = e.clientY;
    dragStartTime = viewTime;
    e.preventDefault();
  }

  function handleMouseMove(e: MouseEvent) {
    if (!isDragging) return;
    // 1px = ~0.1 seconds (adjustable).
    const dy = e.clientY - dragStartY;
    // Dragging down = earlier messages (time decreases).
    const newTime = Math.max(0, Math.min(duration ?? Infinity, dragStartTime - dy * 0.1));
    viewTime = newTime;
    if (follow) {
      seek(newTime);
    }
  }

  function handleMouseUp() {
    isDragging = false;
  }

  // ── Toggle follow ──
  function toggleFollow() {
    if (!follow) {
      // Re-enabling: seek to current viewTime so playback catches up.
      seek(viewTime);
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
    viewTime = msg.t;
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

  const currentTime = $derived($playerStore.currentTime);
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
        {#each visibleMessages as msg, i (msg.t + msg.user + i)}
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
        {#if visibleMessages.length === 0}
          <div class="flex items-center justify-center py-4">
            <span class="text-xs text-ash-dim">No messages at this time.</span>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
