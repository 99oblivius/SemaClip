<script lang="ts">
/**
 * ffmpeg is looked up on PATH first, and only offered as a download when missing.
 *
 * WHY NOT BUNDLE IT: shipping a static ffmpeg pair costs ~330MB in every installer
 * and every patch, and it is the outlier — every comparable tool (or a package
 * manager) expects the binary to be present. The app therefore resolves
 * PATH -> previously-installed -> managed, and this modal is the last step: it
 * asks before downloading, because a 65-82MB transfer is an action the user should
 * choose, not something that happens silently on first launch.
 *
 * It shows itself ONLY when ffmpeg is genuinely absent. A machine that already has
 * it never sees this.
 */
import { createQuery } from '@tanstack/svelte-query';
import { onMount } from 'svelte';
import { apiClient } from '$lib/api/client';
import Icon from '$lib/components/Icon.svelte';

const toolsQuery = createQuery(() => ({
  queryKey: ['tools'],
  queryFn: () => apiClient.getToolStatus(),
  // The answer changes only when a download finishes, and the download owns its
  // own progress state — polling here would fight the stream.
  refetchOnWindowFocus: true,
}));

type Phase = 'idle' | 'downloading' | 'done' | 'error';

let phase = $state<Phase>('idle');
/**
 * Set when the user declines. ffmpeg is a hard dependency — nothing can download or
 * export without it — so declining is a decision to quit, not to hide a prompt. The
 * button says Exit and this closes the window, which the desktop runtime treats as
 * ending the app (see window-lifecycle.ts).
 */
let exiting = $state(false);
let percent = $state(0);
/**
 * Which phase the server is in. "extracting" and "verifying" have NO measurable
 * percentage — the server sends percent: 1 for them as a "not zero" marker — so
 * showing a number there is a lie. Extract dominates the wall-clock time of a
 * 65-82MB archive, which is why a real download read as "stuck at 1%".
 */
let phaseName = $state<'downloading' | 'extracting' | 'verifying'>('downloading');
let receivedMB = $state(0);
let totalMB = $state(0);
let error = $state('');

const missing = $derived(
  toolsQuery.data ? !toolsQuery.data.available : false,
);
const shown = $derived(missing && !exiting && phase !== 'done');

/**
 * Ends the app. The window is the app: closing it exits the process, which is the
 * behaviour the desktop runtime gives us. Under `deno run` there is no window, so
 * this falls back to a closed state rather than a silent no-op.
 */
function exitApp() {
  exiting = true;
  try {
    window.close();
  } catch {
    // No window (dev run) — the modal simply closes.
  }
}

/**
 * Streams progress from the provisioning endpoint.
 *
 * EventSource cannot POST, and this endpoint is a POST (it has a side effect), so
 * the stream is read from the fetch body directly.
 */
async function download() {
  phase = 'downloading';
  percent = 0;
  error = '';
  try {
    const res = await fetch(apiClient.toolProvisionUrl(), { method: 'POST' });
    if (!res.ok || !res.body) {
      throw new Error(`server returned ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; keep the trailing partial.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === 'progress') {
          if (event.phase) phaseName = event.phase;
          // The server's field names are bytesDownloaded/totalBytes; reading
          // `receivedBytes` here meant both stayed 0, so the bar had nothing real
          // to show even during the download.
          receivedMB = Math.round((event.bytesDownloaded ?? 0) / 1048576);
          totalMB = Math.round((event.totalBytes ?? 0) / 1048576);
          percent = event.phase === 'downloading'
            ? (totalMB ? Math.round((receivedMB / totalMB) * 100) : 0)
            : 100;
        } else if (event.type === 'done') {
          phase = 'done';
          await toolsQuery.refetch();
        } else if (event.type === 'error') {
          phase = 'error';
          error = event.message ?? 'download failed';
        }
      }
    }
    // The stream ended without a terminal event only if the server died mid-way.
    if (phase === 'downloading') {
      phase = 'error';
      error = 'the download ended unexpectedly';
    }
  } catch (err) {
    phase = 'error';
    error = err instanceof Error ? err.message : String(err);
  }
}

onMount(() => {
  // A machine without ffmpeg should learn it here rather than through a failed
  // job three screens later.
  void toolsQuery.refetch();
});
</script>

{#if shown}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-foundation/80"
    role="dialog"
    aria-modal="true"
    aria-label="ffmpeg required"
  >
    <div class="w-[32rem] max-w-[90vw] rounded-md border border-border bg-surface p-5 shadow-lg">
      <div class="mb-3 flex items-start gap-3">
        <span class="mt-0.5 text-warning"><Icon name="alert" size={18} /></span>
        <div class="flex flex-col gap-1">
          <h2 class="font-display text-base font-medium text-ink">ffmpeg not found</h2>
          <p class="text-sm text-ash">
            SemaClip needs <span class="font-mono text-ink">ffmpeg</span> to download and
            cut video, and it was not found on your PATH or in SemaClip's data folder.
            It can be downloaded now — about 80MB, kept alongside SemaClip's own data
            and removable from there at any time.
          </p>
        </div>
      </div>

      {#if phase === 'downloading'}
        <div class="mt-4 flex flex-col gap-2">
          {#if phaseName === 'downloading'}
            <div class="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
              <div
                class="h-full rounded-full bg-accent transition-[width] duration-200"
                style="width: {percent}%"
              ></div>
            </div>
            <div class="flex justify-between font-mono text-xs text-ash-dim">
              <span>Downloading</span>
              <span>{percent}%{#if totalMB} · {receivedMB} of {totalMB}MB{/if}</span>
            </div>
          {:else}
            <!-- No measurable percentage exists for these phases: a pulse, not a
                 frozen bar, is the honest rendering. -->
            <div class="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
              <div class="h-full w-1/3 animate-pulse rounded-full bg-accent"></div>
            </div>
            <div class="flex justify-between font-mono text-xs text-ash-dim">
              <span>{phaseName === 'extracting' ? 'Extracting' : 'Verifying'}</span>
              <span>{phaseName === 'extracting' ? 'a few seconds' : 'almost done'}</span>
            </div>
          {/if}
        </div>
      {:else if phase === 'error'}
        <p class="mt-4 rounded border border-error/40 bg-error/10 p-2 font-mono text-xs text-error">
          {error}
        </p>
      {/if}

      <div class="mt-5 flex items-center justify-end gap-2">
        {#if phase === 'error'}
          <button
            class="rounded border border-border px-3 py-1.5 text-sm text-ash hover:bg-surface-2"
            onclick={exitApp}
          >
            Exit
          </button>
          <button
            class="rounded border border-accent bg-accent/10 px-3 py-1.5 text-sm text-accent hover:bg-accent/20"
            onclick={download}
          >
            Retry
          </button>
        {:else if phase === 'downloading'}
          <span class="font-mono text-xs text-ash-dim">Downloading…</span>
        {:else}
          <button
            class="rounded border border-border px-3 py-1.5 text-sm text-ash hover:bg-surface-2"
            onclick={exitApp}
            title="SemaClip needs ffmpeg for every download and export — without it there is nothing to do"
          >
            Exit
          </button>
          <button
            class="rounded border border-accent bg-accent/10 px-3 py-1.5 text-sm text-accent hover:bg-accent/20"
            onclick={download}
          >
            Download ffmpeg
          </button>
        {/if}
      </div>

      <p class="mt-3 border-t border-border pt-3 text-xs text-ash-dim">
        Prefer to manage it yourself? Install ffmpeg from your package manager, or point
        SemaClip at an existing binary in Settings — both avoid this download. Otherwise
        SemaClip cannot download or cut video, which is why declining exits the app.
      </p>
    </div>
  </div>
{/if}
