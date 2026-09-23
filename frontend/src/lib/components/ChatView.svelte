<script lang="ts">
  import { apiClient, type ChatMessage } from '$lib/api/client';
  import Icon from './Icon.svelte';
  import { playerStore, seek } from '$lib/stores/player';
  import { downloadsQuery, viewFor } from '$lib/api/downloads';
  import {
    browseCrossing,
    cursorForTime,
    resumeCursor,
    shouldRefetchWindow,
  } from './chat-window';

  interface Props {
    streamId: string;
    duration: number | null;
  }

  let { streamId, duration }: Props = $props();

  // ── All messages (loaded once, sorted by time) ──
  let allMessages = $state<ChatMessage[]>([]);
  let totalCount = $state(0);
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

  // The chat file's presence comes from the SERVER view (its `chat` artifact
  // reports onDisk + bytes). Loading once on mount meant a chat file that
  // appeared later — or one that was deleted — never changed the panel: it
  // stayed "no chat file attached" through refreshes AND a backend restart,
  // because the decision was cached in this component's own `loaded` flag.
  const downloads = downloadsQuery();
  const dlView = $derived(viewFor(downloads.data?.views, streamId));
  /** Identity of the chat artifact: present, and its byte size. */
  const chatSig = $derived.by(() => {
    const art = dlView?.artifacts.find((a) => a.kind === 'chat');
    return art && art.onDisk ? `${art.path ?? 'chat'}:${art.bytes}` : 'absent';
  });

  let loadedSig = $state<string | null>(null);
  $effect(() => {
    const sig = chatSig;
    if (!streamId || sig === loadedSig) return;
    loadedSig = sig;
    if (sig === 'absent') {
      allMessages = [];
      totalCount = 0;
      hasChat = false;
      return;
    }
    void loadWindow(player.currentTime).then(() => {
      // Place the cursor at the playhead within the freshly loaded window. The follow effect does
      // this on every tick, but running it here too means the first paint is already correct rather
      // than showing the window's start for one frame.
      scrollIndex = allMessages.length;
    });
  });

  /**
   * The window of messages currently held, and the range it covers.
   *
   * The panel used to load `offset=0&limit=500` ONCE and treat that as the whole stream. Measured
   * against a 36,000-message / 2h chat: that window covers t=0..100, so opening a project at 1h30m
   * showed the chat from the first 100 SECONDS of the broadcast — and `follow` could only
   * binary-search inside it. The server has always supported `?around=<sec>`; the client never sent
   * it.
   *
   * So the loaded set is now a WINDOW rather than "all messages", refetched as the playhead moves
   * out of it. `windowStart` is the server's reported offset, which is what makes `scrollIndex`
   * convertible back into an absolute stream time.
   */
  let windowStart = $state(0);
  let windowEnd = $state(0);

  /**
   * Fetch the window around a time.
   *
   * It deliberately does NOT choose the cursor position. Three callers want three different places:
   * following playback wants the end of the window, a search jump wants the hit, and browsing off an
   * edge wants that edge. Choosing here made those fight each other — the first version set
   * `scrollIndex` to the end unconditionally, which undid a browse resume on every refetch.
   */
  async function loadWindow(aroundSec: number): Promise<void> {
    try {
      const res = await apiClient.listChat(streamId, { around: aroundSec, limit: 500 });
      allMessages = res.messages;
      totalCount = res.total;
      windowStart = res.offset;
      windowEnd = res.offset + res.messages.length;
      hasChat = true;
    } catch {
      hasChat = false;
    }
  }

  /**
   * Refetch when the playhead leaves the loaded window, and only then.
   *
   * One extra window either side is treated as "inside", so ordinary playback does not refetch on
   * every effect tick — the threshold is a quarter-window margin.
   */
  $effect(() => {
    if (!hasChat || allMessages.length === 0) return;
    const time = player.currentTime;
    const cursor = cursorForTime(
      allMessages.map((m) => m.t),
      time,
    );
    if (!shouldRefetchWindow({ follow, windowLength: allMessages.length, cursor })) return;
    void loadWindow(time);
  });
  // ── Follow: sync scrollIndex to playback ──
  // Suppressed while the user is scrolling (userScrolling guard) so the
  // follow effect doesn't fight the scroll position before the seek fires.
  let userScrolling = false;
  $effect(() => {
    if (!follow || allMessages.length === 0 || userScrolling) return;
    scrollIndex = cursorForTime(
      allMessages.map((m) => m.t),
      player.currentTime,
    );
  });

  // ── Visible messages: last VISIBLE_COUNT up to scrollIndex ──
  const visibleMessages = $derived(
    allMessages.slice(Math.max(0, scrollIndex - VISIBLE_COUNT), scrollIndex)
  );

  // ── Scroll: move one message, debounced seek ──
  // The seek is debounced so rapid scrolling doesn't spam the store.
  // userScrolling suppresses the follow effect until the seek fires,
  // keeping the chat position stable during the scroll gesture.
  let seekTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Move the browse position, refetching the window when it runs off either end.
   *
   * `allMessages` is a WINDOW of the stream now, and it used to be clamped to its bounds — so
   * dragging past either edge simply stopped, because there was nothing else loaded. Running off the
   * end means the window must move: the direction is recorded so the refetch lands on the right side
   * of the boundary rather than re-centring on the playhead.
   */
  let pendingResume = $state<'top' | 'bottom' | null>(null);

  function scrollToIndex(newIndex: number) {
    if (allMessages.length === 0) return;

    const crossing = browseCrossing({
      newIndex,
      windowLength: allMessages.length,
      windowStart,
      windowEnd,
      totalCount,
    });
    if (crossing === 'top') {
      // Ran off the TOP: fetch the preceding window and resume at its end.
      pendingResume = 'top';
      void loadWindow(allMessages[0]!.t - 1);
      return;
    }
    if (crossing === 'bottom') {
      // Ran off the BOTTOM: fetch the following window and resume at its start.
      pendingResume = 'bottom';
      void loadWindow(allMessages[allMessages.length - 1]!.t + 1);
      return;
    }

    const clamped = Math.max(0, Math.min(allMessages.length, newIndex));
    if (clamped === scrollIndex) return;
    // Browsing takes over from playback: without this the follow effect would overwrite scrollIndex
    // on the next tick and the browse would snap back to the playhead.
    follow = false;
    scrollIndex = clamped;
    userScrolling = true;
    if (seekTimer) clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      userScrolling = false;
      const msg = allMessages[clamped - 1];
      if (msg) seek(msg.t);
    }, 150);
  }

  /**
   * After a window refetch triggered by browsing, place the cursor at the edge the user came from.
   *
   * `loadWindow` centres the window on a time and points `scrollIndex` at the end; for a browse that
   * is wrong in the "top" case, where the user was moving backwards and expects to continue from the
   * window's last message. The seek is what keeps playback in step with the browse.
   */
  $effect(() => {
    if (pendingResume === null || allMessages.length === 0) return;
    const mode = pendingResume;
    pendingResume = null;
    const target = resumeCursor(mode, allMessages.length, VISIBLE_COUNT);
    if (target !== null) scrollIndex = target;
    const msg = allMessages[scrollIndex - 1];
    if (msg) seek(msg.t);
  });

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    if (allMessages.length === 0) return;
    const dir = e.deltaY > 0 ? 1 : -1;
    scrollToIndex(scrollIndex + dir);
  }

  // ── Drag to proxy: move by message proportional to drag distance ──
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

  /**
   * Jump to a search hit.
   *
   * The results come from a SERVER-side search across the whole stream, so a hit is usually OUTSIDE
   * the loaded window — `findIndex` on the window would return -1 and only the seek would happen,
   * leaving the list showing unrelated messages. The window is refetched around the hit instead, and
   * the seek makes `follow` place it correctly.
   */
  function jumpToMessage(msg: ChatMessage) {
    const idx = allMessages.findIndex((m) => m.t === msg.t && m.user === msg.user);
    if (idx >= 0) {
      scrollIndex = Math.min(allMessages.length, idx + 1);
    } else {
      void loadWindow(msg.t);
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
    <span class="font-mono text-xs text-ash-dim" title="Messages loaded: {windowStart + 1}–{windowEnd} of {totalCount}">
      {totalCount > 0
        ? `${windowStart + 1}–${windowEnd} of ${totalCount}`
        : ''}
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
              <span class="selectable text-xs text-ash truncate"><span class="text-ink">{msg.user}</span>: {msg.body}</span>
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
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="flex-1 overflow-hidden"
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
            <span class="selectable text-xs leading-relaxed break-words">
              <span class="font-medium text-ink">{msg.user}</span><span class="text-ash">: {msg.body}</span><span class="text-ash-dim text-[10px] ml-1.5">· {fmtTime(msg.t)}</span>
            </span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>
