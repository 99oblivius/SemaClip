<script lang="ts">
  /**
   * The staged-update prompt.
   *
   * WHY A BANNER AND NOT A MODAL. An update here cannot be "applied" in place: the
   * runtime stages it next to the runtime dylib and swaps it in on the NEXT LAUNCH
   * (`autoUpdate` exposes only onUpdateReady/onRollback — there is no apply-now call, and
   * the running dylib is deliberately untouched). So the honest affordances are "restart
   * into it" and "not now". A modal that could not be dismissed would trap the user in a
   * state where the only button restarts their session mid-task, and on Windows it would
   * have to sit there permanently, because the runtime cannot swap a loaded DLL at all —
   * exactly the dead-end the project's no-gating rule forbids.
   *
   * What it IS: unmissable. It appears the instant the runtime reports the stage (pushed
   * over /api/events, not discovered on a poll), it is in-theme, and it stays until the
   * user acts. Dismissing is explicit and leaves Settings reporting the staged version, so
   * nothing is lost or hidden.
   */
  import Icon from '$lib/components/Icon.svelte';
  import { getUpdateStatus, restartApp } from '$lib/api/client';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';

  let staged = $state<string | null>(null);
  let canRestart = $state(true);
  let restarting = $state(false);
  let error = $state<string | null>(null);
  let dismissed = $state<string | null>(null);

  // A staged version already waiting when the page loads (the check runs at boot, so this
  // is the common case on a cold start — the event fired before the webview connected).
  onMount(() => {
    if (!browser) return;
    getUpdateStatus()
      .then((s) => {
        if (s.pendingVersion) {
          staged = s.pendingVersion;
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
    const onStaged = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { version: string; canApplyByRestart: boolean };
        if (!data.version) return;
        staged = data.version;
        canRestart = data.canApplyByRestart;
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
    es.addEventListener('update-staged', onStaged);
    es.addEventListener('update-rollback', onRollback);
    return () => {
      es.removeEventListener('update-staged', onStaged);
      es.removeEventListener('update-rollback', onRollback);
      es.close();
    };
  });

  async function restartNow() {
    restarting = true;
    error = null;
    try {
      await restartApp();
      // The process is going away; the page will not receive a reply worth rendering.
    } catch (err) {
      restarting = false;
      error = err instanceof Error ? err.message : 'Restart failed';
    }
  }

  function askNotify() {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  }
</script>

{#if staged && dismissed !== staged}
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
        {#if canRestart}
          Updates apply on launch, so this restarts SemaClip to install it.
        {:else}
          Windows applies updates while the app is closed and cannot swap a running
          program — use the update launcher in the app's folder.
        {/if}
      </span>
    </div>
    {#if canRestart}
      <button
        class="shrink-0 rounded bg-accent px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        onclick={restartNow}
        disabled={restarting}
        title="Close and reopen SemaClip; the staged update installs on the way up"
      >
        {restarting ? 'Restarting…' : 'Restart now'}
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
