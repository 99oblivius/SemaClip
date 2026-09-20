import type { AppSettings, AspectRatio, CaptionStyle, UiScale } from '$shared/types';

/**
 * The settings form's own shape, and whether it differs from what the server holds.
 *
 * ── WHY THIS IS A PURE MODULE ────────────────────────────────────────────────────────────────
 * The editable settings live in a component's `bind:value` state, so "have these been changed?"
 * was an inline comparison inside a `.svelte` file — and it could not be tested, which is how a
 * whole class of it went unnoticed.
 *
 * A PATH FIELD CANNOT BE COMPARED AS TYPED. The server RESOLVES a user-entered path before
 * storing it: `~` is expanded, separators are unified, a trailing separator is dropped, and a
 * relative path is refused outright (`application/use-cases/paths.ts`). The client cannot
 * reproduce that — `~` expansion needs the home directory, which is the server's to know — so
 * the string the user typed and the string the server holds are DIFFERENT STRINGS FOR THE SAME
 * VALUE. Comparing them made the form permanently dirty the moment a path was saved: the save
 * succeeded, the toast never appeared, and Save stayed armed for ever.
 *
 * So a form is only ever compared against a value the SERVER produced, and a save's own response
 * is adopted into the form (see the page). `sameForm`/`isDirty` are the testable half of that
 * rule: they take a server snapshot as the truth and say whether the form has left it.
 */

/** The editable fields, as one comparable unit. */
export interface SettingsForm {
  /** `'auto'` or a device index as a string, because a `<select>` binds strings. */
  gpuDevice: string;
  cpuUsage: AppSettings['cpuUsage'];
  defaultMaxQualityHeight: number | null;
  uiScale: UiScale;
  exportDir: string;
  vodDir: string;
  defaultAspectRatio: AspectRatio;
  captionsEnabled: boolean;
  captionPreset: CaptionStyle['preset'];
  captionPosition: CaptionStyle['position'];
  captionFontSize: number;
  captionBgOpacity: number;
  engineBinaryPath: string;
}

/** A form with every value at its default — what the page holds before the query answers. */
export const DEFAULT_FORM: SettingsForm = {
  gpuDevice: 'auto',
  cpuUsage: 'medium',
  defaultMaxQualityHeight: 1080,
  uiScale: 'medium',
  exportDir: '',
  vodDir: '',
  defaultAspectRatio: '16:9',
  captionsEnabled: false,
  captionPreset: 'bold-white',
  captionPosition: 'bottom',
  captionFontSize: 48,
  captionBgOpacity: 0.8,
  engineBinaryPath: '',
};

/**
 * The form for a server value.
 *
 * The ONE way a form is ever built from settings, so the initial load, the post-save adoption
 * and the dirty comparison cannot drift apart — three builders would be three chances to
 * normalize one field differently and reintroduce exactly this bug for that field alone.
 */
export function formFromSettings(s: AppSettings): SettingsForm {
  return {
    gpuDevice: s.gpuDevice === null ? 'auto' : String(s.gpuDevice),
    cpuUsage: s.cpuUsage ?? 'medium',
    defaultMaxQualityHeight: s.defaultMaxQualityHeight ?? null,
    uiScale: s.uiScale ?? 'medium',
    exportDir: s.exportDir,
    vodDir: s.vodDir ?? '',
    defaultAspectRatio: s.defaultAspectRatio,
    captionsEnabled: s.defaultCaptions.enabled,
    captionPreset: s.defaultCaptions.preset,
    captionPosition: s.defaultCaptions.position,
    captionFontSize: s.defaultCaptions.fontSize,
    captionBgOpacity: s.defaultCaptions.backgroundOpacity,
    engineBinaryPath: s.engineBinaryPath ?? '',
  };
}

/**
 * The form's values as the API expects them.
 *
 * `gpuDevice` is the one field whose wire shape differs from its form shape: an index or `null`
 * for auto, never the string `'auto'`.
 */
export function formToSettings(form: SettingsForm): Partial<AppSettings> {
  return {
    gpuDevice: form.gpuDevice === 'auto' ? null : parseInt(form.gpuDevice, 10),
    cpuUsage: form.cpuUsage,
    defaultMaxQualityHeight: form.defaultMaxQualityHeight,
    uiScale: form.uiScale,
    exportDir: form.exportDir,
    vodDir: form.vodDir,
    defaultAspectRatio: form.defaultAspectRatio,
    defaultCaptions: {
      enabled: form.captionsEnabled,
      preset: form.captionPreset,
      position: form.captionPosition,
      fontSize: form.captionFontSize,
      backgroundOpacity: form.captionBgOpacity,
    },
    engineBinaryPath: form.engineBinaryPath.trim() || null,
  };
}

/**
 * Does the form differ from what the server holds?
 *
 * `server` undefined means the query has not answered yet, and an unanswered query is not a
 * difference — reporting one would arm Save against a page that has nothing loaded.
 *
 * Path fields compare verbatim against the SERVER's value, including `vodDir` when it is empty:
 * empty means "use the app's default", the server substitutes a concrete path for it, and the
 * adopt-on-load has already put that path in the form — so an empty field IS a difference from a
 * resolved server value, and saving it legitimately resets the location to the default.
 */
export function isDirty(form: SettingsForm, server: AppSettings | undefined): boolean {
  if (!server) return false;
  return (
    (form.gpuDevice === 'auto' ? null : parseInt(form.gpuDevice, 10)) !== server.gpuDevice ||
    form.cpuUsage !== (server.cpuUsage ?? 'medium') ||
    form.defaultMaxQualityHeight !== (server.defaultMaxQualityHeight ?? null) ||
    form.uiScale !== (server.uiScale ?? 'medium') ||
    form.exportDir !== server.exportDir ||
    form.vodDir !== (server.vodDir ?? '') ||
    form.defaultAspectRatio !== server.defaultAspectRatio ||
    form.captionsEnabled !== server.defaultCaptions.enabled ||
    form.captionPreset !== server.defaultCaptions.preset ||
    form.captionPosition !== server.defaultCaptions.position ||
    form.captionFontSize !== server.defaultCaptions.fontSize ||
    form.captionBgOpacity !== server.defaultCaptions.backgroundOpacity ||
    (form.engineBinaryPath.trim() || null) !== server.engineBinaryPath
  );
}
