<script lang="ts">
  /**
   * The update banner: download progress, then a restart that SemaClip performs itself.
   *
   * ── THE THREE FACES ─────────────────────────────────────────────────────────────────────────
   * 1. DOWNLOADING. The payload is fetched while the app is fully usable, with a progress bar and
   *    an explicit "keep this window open". It is downloaded on open, so by the time the user
   *    notices this banner the transfer is usually already done.
   * 2. READY. Downloaded and verified. SemaClip restarts itself to install it — the user is not
   *    asked to do anything, and the copy says so rather than presenting a button they would have
   *    to guess at.
   * 3. WORKING. A restart is held back while a job is queued or running, and the copy names what it
   *    is waiting for. Closing the window on its own mid-download is the least intuitive thing an
   *    auto-update can do, so it waits and restarts the moment nothing is running.
   *
   * WHY A BANNER AND NOT A MODAL. The no-gating rule: the user keeps working, and nothing blocks the
   * UI while an update is fetched. Dismissing is explicit, and the next launch still installs what
   * was downloaded.
   *
   * WHY IT IS PUSHED, NOT POLLED. Every state arrives over /api/events — including each progress
   * frame — because a bar that depends on a query refresh looks stalled exactly when the user is
   * watching it. The server replays the last few frames to a late subscriber, so a cold start cannot
   * miss a stage that already happened.
   */
  import Icon from '$lib/components/Icon.svelte';
  import { apiClient, getUpdateStatus, restartApp } from '$lib/api/client';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';

  let staged = $state<string | null>(null);
  let canRestart = $state(true);
  let restarting = $state(false);
  let error = $state<string | null>(null);
  let dismissed = $state<string | null>(null);
  /**
   * The in-flight download, when one is running.
   *
   * `fraction` is null until the server declares a content-length, so the bar renders as
   * INDETERMINATE rather than as a made-up percentage — a progress bar that lies about how far
   * along it is worse than one that admits it does not know.
   */
  let progress = $state<{ version: string; received: number; total: number; fraction: number | null } | null>(null);
  /** True once the payload is downloaded and verified, which is when a restart installs it. */
  let readyToInstall = $state(false);
  /**
   * Jobs that are still working, and therefore the reason a restart is being held back.
   *
   * ── WHY A RESTART WAITS FOR THEM ────────────────────────────────────────────────────────────
   * "it will automatically restart" has to mean SAFELY. A job that is downloading, transcribing or
   * detecting is killed by a restart, and the user would watch the app close because they clicked
   * something unrelated. So while any job is queued or running the banner SAYS it is waiting
   * instead of taking the window away, and it restarts on its own the moment the queue drains.
   * A job status is read the same way the rest of the app reads it: queued/running are live.
   */
  let activeJobs = $state(0);
  /** Set when a restart was deferred, so the copy can explain the wait rather than look stuck. */
  let waitingForJobs = $state(false);

  async function refreshActiveJobs() {
    try {
      const jobs = await apiClient.listJobs();
      activeJobs = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
    } catch {
      // An unreachable jobs endpoint must not block an update forever; treat it as "nothing running"
      // only because the alternative is never restarting at all.
      activeJobs = 0;
    }
  }

  /**
   * Restart into the update now that it is safe to.
   *
   * Called both by the button and by the automatic path, so there is exactly ONE place that decides
   * "is it safe" and one place that restarts. A second copy on the auto path is how the two drift
   * and the automatic one starts killing work the button would have waited for.
   */
  async function restartNowChecked(opts: { byHand: boolean }) {
    if (restarting) return;
    await refreshActiveJobs();
    if (activeJobs > 0) {
      // DEFERRED, deliberately. The user is told rather than interrupted: closing the window on its
      // own while work is running is the least intuitive thing an auto-update can do. `byHand` is
      // carried so the button can say "waiting for the running job" instead of appearing to fail.
      waitingForJobs = true;
      void opts;
      return;
    }
    waitingForJobs = false;
    restarting = true;
    error = null;
    try {
      await restartApp();
      // The process is going away; the page will not receive a reply worth rendering.
    } catch (err) {
      restarting = false;
      error = err instanceof Error ? err.message : 'Restart failed';
      void opts;
    }
  }

  /**
   * Once downloaded, apply it without being asked — but only when nothing is running.
   *
   * The delay keeps the app from closing the instant the last byte lands, which would feel like a
   * crash. Re-checking every few seconds is what makes the restart happen on its OWN once the queue
   * drains, rather than waiting for the user to press the button that they were told they would not
   * need.
   */
  $effect(() => {
    if (!browser) return;
    if (!readyToInstall || !canRestart || dismissed !== null) return;
    const tick = setInterval(() => {
      if (restarting) return;
      void refreshActiveJobs().then(() => {
        if (activeJobs === 0) void restartNowChecked({ byHand: false });
      });
    }, 5000);
    return () => clearInterval(tick);
  });

  /** Bytes as MB, for the label under the bar. */
  function mb(bytes: number): string {
    return `${(bytes / 1e6).toFixed(bytes > 1e9 ? 0 : 1)}MB`;
  }

  // A download already in flight when the page loads (the check runs at boot, so the first progress
  // frames can fire before the webview connects).
  onMount(() => {
    if (!browser) return;
    getUpdateStatus()
      .then((s) => {
        if (s.pendingVersion) {
          staged = s.pendingVersion;
          canRestart = s.canApply;
          readyToInstall = true;
        } else if (s.phase === 'downloading' && s.download) {
          // The download is running but nothing is ready yet: show progress and say so, WITHOUT
          // offering a restart that would install nothing.
          progress = s.download;
          canRestart = s.canApply;
        }
      })
      .catch(() => {
        // A dev run has no update surface; silence is correct here.
      });
  });

  // PUSHED events. EventSource reconnects on its own, and the server replays what a late
  // subscriber missed, so a cold start cannot miss a stage that already happened.
  $effect(() => {
    if (!browser) return;
    const es = new EventSource('/api/events');
    const onProgress = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as {
          version: string;
          received?: number;
          total?: number;
          fraction?: number | null;
        };
        if (!data.version) return;
        progress = {
          version: data.version,
          received: data.received ?? 0,
          total: data.total ?? 0,
          fraction: data.fraction ?? null,
        };
        // A download in progress means the update is NOT ready: clear any earlier readiness so a
        // restart is never offered for a payload that is still arriving.
        readyToInstall = false;
        staged = null;
      } catch {
        // A malformed frame must not break the surface.
      }
    };
    const onStaged = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { version: string; canApplyByRestart: boolean };
        if (!data.version) return;
        staged = data.version;
        canRestart = data.canApplyByRestart;
        readyToInstall = true;
        progress = null;
        // Native OS notification as well: the banner is inside the window, and the user
        // may be looking at something else. requireInteraction keeps it up rather than
        // letting it auto-expire unread.
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification('SemaClip update ready', {
            body: `${data.version} will install on restart.`,
            requireInteraction: true,
          });
        }
      } catch {
        // A malformed frame must not break the surface.
      }
    };
    const onRollback = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { version: string };
        error = `The last update failed and was rolled back: ${data.version}`;
      } catch {
        // as above
      }
    };
    es.addEventListener('update-progress', onProgress);
    es.addEventListener('update-staged', onStaged);
    es.addEventListener('update-rollback', onRollback);
    return () => {
      es.removeEventListener('update-progress', onProgress);
      es.removeEventListener('update-staged', onStaged);
      es.removeEventListener('update-rollback', onRollback);
      es.close();
    };
  });

  async function restartNow() {
    await restartNowChecked({ byHand: true });
  }

  function askNotify() {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  }
</script>

{#if progress && dismissed !== `downloading-${progress.version}`}
  <!-- THE DOWNLOAD IS HAPPENING WHILE THE APP IS OPEN, which is the whole point: the user can keep
       working, and is told not to close the window until it finishes. The bar animates while the
       length is unknown rather than showing a percentage that would be invented. -->
  <div
    class="flex flex-col gap-1.5 border-b border-accent/40 bg-accent/10 px-3 py-2"
    role="status"
    aria-live="polite"
  >
    <div class="flex items-center gap-3">
      <Icon name="download" size={14} class="shrink-0 animate-pulse text-accent" />
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="font-mono text-xs text-ink">
          Downloading SemaClip {progress.version}
          {#if progress.fraction !== null}
            — {Math.round(progress.fraction * 100)}%
          {/if}
        </span>
        <span class="font-mono text-[10px] text-ash-dim">
          Keep this window open. Once the download finishes, SemaClip restarts itself and installs
          the update — you can keep working until then.
          {#if progress.total > 0}
            <span class="text-ash">{mb(progress.received)} of {mb(progress.total)}</span>
          {/if}
        </span>
      </div>
    </div>
    <div class="h-1 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
      {#if progress.fraction === null}
        <!-- No content-length: an indeterminate bar, not a fabricated percentage. -->
        <div class="h-full w-1/3 animate-pulse rounded-full bg-accent"></div>
      {:else}
        <div
          class="h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
          style="width: {Math.round(progress.fraction * 100)}%"
        ></div>
      {/if}
    </div>
  </div>
{/if}

{#if staged && readyToInstall && dismissed !== staged}
  <div
    class="flex items-center gap-3 border-b border-accent/40 bg-accent/10 px-3 py-2"
    role="status"
    aria-live="polite"
  >
    <Icon name="download" size={14} class="shrink-0 text-accent" />
    <div class="flex min-w-0 flex-1 flex-col">
      <span class="font-mono text-xs text-ink">
        {staged} is ready to install
      </span>
      <span class="font-mono text-[10px] text-ash-dim">
        {#if waitingForJobs}
          Waiting for {activeJobs === 1 ? 'a download or job' : `${activeJobs} downloads or jobs`} to
          finish. SemaClip restarts by itself the moment nothing is running.
        {:else if canRestart}
          Downloaded and verified. SemaClip restarts by itself to install it, as soon as nothing is
          running. You can keep working until then.
        {:else}
          This build cannot restart itself to install the update. Re-download SemaClip
          when convenient — the update is already available.
        {/if}
      </span>
    </div>
    {#if canRestart}
      <button
        class="shrink-0 rounded bg-accent px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        onclick={restartNow}
        disabled={restarting}
        title="Close and reopen SemaClip; the downloaded update installs on the way up"
      >
        {#if restarting}
          Restarting…
        {:else if waitingForJobs}
          Restart when idle
        {:else}
          Restart now
        {/if}
      </button>
    {/if}
    <button
      class="shrink-0 rounded border border-border px-2 py-1 text-xs text-ash transition-colors hover:border-accent hover:text-accent"
      onclick={() => (dismissed = staged)}
      title="Keep working; SemaClip reports it in Settings until you restart"
    >
      Later
    </button>
  </div>
{/if}

{#if error}
  <div class="flex items-center gap-2 border-b border-error/40 bg-error/10 px-3 py-2" role="alert">
    <Icon name="alert" size={13} class="shrink-0 text-error" />
    <span class="font-mono text-[10px] text-error">{error}</span>
    <button class="ml-auto font-mono text-[10px] text-ash-dim hover:text-ash" onclick={() => (error = null)}>
      dismiss
    </button>
  </div>
{/if}
