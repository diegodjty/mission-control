/**
 * Folder-picker pure logic (issue 19) — the parts of "Browse… for a Project
 * folder" that do NOT need Electron and so can be unit-tested in isolation.
 *
 * The native directory chooser itself (`dialog.showOpenDialog`) can only run in
 * the main process and can't be driven headlessly, so the thin IPC handler
 * stays untested and delegates every decision to the two functions here:
 *
 *   1. `resolvePickedFolder` — turn the dialog's raw result into "the chosen
 *      path" or "nothing" (cancel). This is the cancel-is-a-no-op guarantee.
 *   2. `resolvePickerDefaultPath` — where the chooser should open: the last
 *      folder the user picked, else their home directory. Never empty.
 *
 * Pure (no electron, no fs, no node runtime) so both rules are unit-testable and
 * the handler is a trivial shell over them.
 */

/**
 * The shape Electron's `dialog.showOpenDialog` resolves to (the subset we use).
 * Mirrored here so this module stays free of an electron import.
 */
export interface OpenDialogResult {
  /** True when the user dismissed the dialog without choosing. */
  canceled: boolean;
  /** The chosen paths; empty when canceled. For `openDirectory` at most one. */
  filePaths: string[];
}

/**
 * Resolve the folder the user chose, or `null` when they cancelled / chose
 * nothing. Cancelling (or an empty/whitespace-only path) is always a clean
 * no-op — never an empty-path "open". A leading/trailing-whitespace path is
 * trimmed; a path that is only whitespace counts as no choice.
 */
export function resolvePickedFolder(result: OpenDialogResult): string | null {
  if (result.canceled) return null;
  const chosen = result.filePaths[0]?.trim();
  return chosen ? chosen : null;
}

/**
 * Where the native chooser should open: the last folder the user picked this
 * session, falling back to their home directory. A blank/whitespace last-used
 * value is ignored. The result is never empty, so the dialog always has a
 * sensible starting point.
 */
export function resolvePickerDefaultPath(
  lastUsed: string | null | undefined,
  homeDir: string,
): string {
  const last = lastUsed?.trim();
  return last ? last : homeDir;
}
