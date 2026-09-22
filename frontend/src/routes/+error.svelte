<script lang="ts">
  /**
   * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
   * Reported: "only the content of the selected page shows 500 Internal error. The page menu and
   * header still work."
   *
   * That is exactly what SvelteKit's DEFAULT error page looks like: a load or render throw inside a
   * route replaces the route's content in the page slot while the app shell — nav, header — stays
   * up. The server was never able to reproduce it (every endpoint answered 200 through a full export
   * batch), which is itself the problem: a bare "Internal Error" says nothing about what broke, so
   * the report cannot be acted on.
   *
   * This page does not fix anything. It makes the next occurrence SELF-REPORTING: the message, the
   * status and the error's own stack are shown, so whatever it is can be identified from the screen
   * instead of guessed at. It deliberately renders the raw error rather than a friendly sentence —
   * a friendly sentence here would hide precisely the information that is missing.
   */
  import { page } from '$app/state';

  let { error } = $props<{ error?: { message?: string; stack?: string } }>();

  // SvelteKit's own fallback when the thrown value was not an Error.
  const message = $derived(error?.message || 'The page could not be loaded.');
  const status = $derived(page.status);
  // Only in the log the user pastes back — never a substitute for the message.
  const detail = $derived(error?.stack ?? '');
</script>

<div class="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
  <p class="font-mono text-[11px] uppercase tracking-wider text-ash-dim">Error {status}</p>
  <p class="max-w-xl font-display text-base text-ink">{message}</p>
  <p class="max-w-xl font-mono text-[11px] text-ash-dim">
    This page failed to render. The rest of the app is unaffected — the message above is the
    underlying error, shown instead of the usual "Internal Error" so it can be reported as-is.
  </p>
  {#if detail}
    <details class="w-full max-w-2xl text-left">
      <summary class="cursor-pointer font-mono text-[11px] text-ash-dim hover:text-ink">Details</summary>
      <pre class="mt-2 max-h-72 overflow-auto rounded-md border border-border bg-surface-2/40 p-3 font-mono text-[10px] text-ash">{detail}</pre>
    </details>
  {/if}
  <a
    href="/export"
    class="rounded-md border border-border px-3 py-1.5 font-mono text-[11px] text-ash transition-colors hover:border-accent hover:text-ink"
  >
    Reload
  </a>
</div>
