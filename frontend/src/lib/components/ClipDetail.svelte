<script lang="ts">
  import SignalBar from './SignalBar.svelte';
  import Icon from './Icon.svelte';
  import CaptionEditor from './CaptionEditor.svelte';
  import { untrack } from 'svelte';
  import type { Clip } from '$shared/types';

  interface Props {
    clip: Clip;
    clipIndex: number;
    streamId: string;
    onExport: () => void;
    onDiscard: () => void;
    /** Persist a new name for this clip. */
    onRename: (axis: string) => void;
  }

  let { clip, clipIndex, streamId, onExport, onDiscard, onRename }: Props = $props();

  /**
   * The clip's NAME, held locally while it is being typed.
   *
   * `title` is the user's own label and is null until someone names the clip — so the placeholder
   * shows for an unnamed clip instead of the word "manual". "manual" describes a KIND (no engine
   * behind it), not a name, and a field pre-filled with it would be saved as the clip's name. The
   * axis is deliberately NOT shown here: it is an engine enum, and putting it in an editable
   * free-text box invites someone to overwrite detection data with prose.
   */
  // `untrack` on the initial read only: the field takes the clip's current name as its starting
  // value, and the effect below is what keeps it in step when the selection changes. Reading it
  // tracked here would make every keystroke re-run against the same prop.
  let name = $state(untrack(() => clip.title ?? ''));

  // Follow the clip when selection changes: the field belongs to whichever clip is open.
  $effect(() => {
    name = clip.title ?? '';
  });

  function commitName() {
    onRename(name);
  }

  function fmtTime(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
</script>

<div class="mb-3 flex items-center justify-between">
  <div class="flex items-center gap-3">
    <span class="font-mono text-xs text-ash-dim">{String(clipIndex + 1).padStart(2, '0')}</span>
    <!-- The clip's name, editable in place: it is what identifies the clip in the library and in
         export filenames. Committed on blur and on Enter, never per keystroke — every character
         would otherwise be a PATCH. -->
    <input
      bind:value={name}
      onblur={commitName}
      onkeydown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') name = clip.title ?? '';
      }}
      class="w-40 rounded border border-transparent bg-transparent px-1 py-0.5 font-display text-sm font-medium text-accent transition-colors hover:border-border focus:border-border-strong focus:bg-surface-2 focus:outline-none"
      placeholder="unnamed clip"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      aria-label="Clip name"
      title="Clip name — Enter to save, Escape to cancel"
    />
    <!--
      No score for a clip with no engine behind it, and a DASH rather than "0.00": zero is a
      plausible engine score, so showing it would present a deliberate edit as a badly-ranked
      detection.
    -->
    <span class="font-mono text-sm text-ink">
      {clip.score === null ? '—' : clip.score.toFixed(2)}
    </span>
  </div>
  <div class="flex items-center gap-2">
    <!--
      One Export, not two. There was a second `Export` in the panel header beside this one, wired to
      the same `onExport` — the same verb twice on one screen, and the header copy carried no extra
      meaning (it did not even say which clip). The panel's own export button at the bottom is the
      one that stays, because that is where the clip's other actions live.

      No Accept button either. Accepting marked a clip reviewed and advanced; candidates stay visible
      until discarded, so there is nothing an Accept would record that the panel acts on — and two
      verbs that both mean "keep this" made the review flow say the same thing twice.
    -->
    <button
      class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-ash transition-colors hover:border-border-strong hover:text-ink"
      onclick={onExport}
      aria-label="Export this clip"
    >
      <Icon name="upload" size={12} /> Export
    </button>
    <button
      class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-ash transition-colors hover:border-error hover:text-error"
      onclick={onDiscard}
      aria-label="Discard clip"
    >
      <Icon name="trash" size={12} /> Discard
    </button>
  </div>
</div>

{#if clip.justification}
  <p class="mb-3 text-sm text-ash leading-relaxed">{clip.justification}</p>
{/if}

<!--
  The grid used to be three equal columns: Signals, Endpoints, Actions. With the Actions column
  removed (its two buttons were both redundant — see above) a `grid-cols-3` would leave Endpoints in
  a third of the panel with two thirds empty, so the column template now adapts: Endpoints takes the
  whole width when there is no Signals column beside it.
-->
<div class="grid gap-4 {clip.signals ? 'grid-cols-2' : 'grid-cols-1'}">
  <!--
    Signals: real engine evidence, or NOTHING AT ALL. A clip with no signals gets no column — the
    heading plus an apology was four fifths empty space claiming a metric that does not exist.
    (The engine's own "justification says evidence but no signal fired" case is caught by the
    honesty tests in the server, not by an empty panel.)
  -->
  {#if clip.signals}
    <div class="col-span-1">
      <div class="mb-2 font-mono text-xs text-ash-dim uppercase">Signals</div>
      <div class="flex flex-col gap-1.5">
        <SignalBar label="chat" value={clip.signals.chatExcitement} />
        <SignalBar label="emote" value={clip.signals.emoteVelocity} />
        <SignalBar label="audio" value={clip.signals.audioEnergy} />
        <SignalBar label="speech" value={clip.signals.speechCoverage} />
      </div>
    </div>
  {/if}

  <!--
    Endpoints: ONE ROW, not a stack of rows.

    Start / End / Dur are three facts about the same span, so giving each its own row claimed three
    times the vertical space for one idea — and what that space is FOR is engine data that does not
    exist yet. Laying them inline leaves the column's height available for the engine's own fields
    (a new row here, or a new column beside it) instead of pre-spending it on labels.

    `Peak` is GONE from the panel. It was the engine's argmax — the hottest second inside the
    detected window — and it earned its place when selecting a clip jumped the playhead there and
    the timeline drew a tick for it. Both of those were removed (selecting now seeks to the clip's
    START, and the tick went because it restated the start line), which left a number nothing acted
    on. It was also misleading for a manual clip, where it is set to `startTime`, and it went stale
    on any trim: it is a RECORDED fact about where the clip was created, not about the clip as it
    now stands. The field stays on the wire and in the DB — it is engine evidence, and the engine is
    going to need somewhere to put the rest of it.
  -->
  <div class="col-span-1">
    <div class="mb-2 font-mono text-xs text-ash-dim uppercase">Endpoints</div>
    <div class="flex flex-wrap items-baseline gap-x-6 gap-y-1 font-mono text-xs">
      <span><span class="text-ash-dim">Start</span> <span class="text-ink">{fmtTime(clip.startTime)}</span></span>
      <span><span class="text-ash-dim">End</span> <span class="text-ink">{fmtTime(clip.endTime)}</span></span>
      <span><span class="text-ash-dim">Dur</span> <span class="text-ink">{(clip.endTime - clip.startTime).toFixed(0)}s</span></span>
    </div>
  </div>

  <!--
    The Actions column is GONE, and its two buttons with it.

    `Play from start` and `Export clip` both duplicated something the panel already offers: the
    export button in the header (same `onExport`), and playback, which the player's own controls and
    Space already drive. The column also held nothing else, so the owner's request to let Endpoints
    take the whole width is the same change.

    Worth recording what `Play from start` actually did, because its label undersold it and it is the
    one deliberate loss here: it seeked to the clip's start, PLAYED, and auto-paused at the clip's end
    — then advanced to the next clip (`onClipEnd` -> `nextClip`). No other control does that chain:
    Space plays from wherever the playhead is and does not stop at the boundary. It is one keystroke
    to reproduce (J/K to select, then Space), and the chain can come back in ClipDetail's header
    without restoring the duplicate Export beside it, if the owner wants it.
  -->
</div>

<!-- Captions (P0-8): line-level transcript editing for this clip's window -->
<div class="mt-4 border-t border-border pt-3">
  <CaptionEditor {streamId} clipStart={clip.startTime} clipEnd={clip.endTime} />
</div>