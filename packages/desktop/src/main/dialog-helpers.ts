/**
 * Shared native-dialog helpers for main-process surfaces.
 *
 * The File → Open Folder menu item and the `ok:dialog:open-folder` IPC
 * handler both need to show a native folder-picker scoped to an existing
 * directory. Colocating the dialog options here gives us exactly one
 * definition of "what does Open Folder do" — future tweaks (e.g., adding
 * `treatPackagesAsDirectories: true` for macOS behavior) land in one
 * place, not two.
 *
 * `Electron.Dialog` is injected so this module is unit-testable without a
 * real Electron runtime — the shape we consume is a single method.
 */

interface DialogLike {
  showOpenDialog(opts: {
    properties: (
      | 'openDirectory'
      | 'createDirectory'
      | 'openFile'
      | 'multiSelections'
      | 'showHiddenFiles'
    )[];
    defaultPath?: string;
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

interface PromptForFolderOpts {
  /** Initial directory shown in the picker. Pass the project root so the user
   *  doesn't have to navigate to it. */
  defaultPath?: string;
}

/**
 * Resolve which target a zero-based Browse index maps to from a raw
 * picked-path spec. A single path (the common case) is returned for every
 * index. A `\x1f`-separated spec is a sequence: index N yields entry N;
 * once the sequence is exhausted the last entry sticks, so Browsing more
 * times than enumerated targets stays stable rather than falling through
 * to the real picker. `\x1f` (ASCII Unit Separator) can never appear in a
 * filesystem path, so it is an unambiguous delimiter that needs no
 * escaping; empty segments are dropped (a single space is a valid path and
 * is preserved — the filter is length-based, not trim-based). Returns null
 * when the spec yields no usable entries.
 *
 * **For test authors:** the multi-entry
 * spec is INDEX-ORDERED, NOT "primary-then-fallback". Picker call counter
 * advances monotonically per `readTestPickedPath()` call and clamps to the
 * last entry — there is no fallthrough, no "use entry 2 if entry 1 was
 * invalid". The dialog hydration / cascade-probe paths inside Electron may
 * trigger picker calls BEFORE the test's intended `Browse` click, so a
 * two-entry spec like `${PRIMARY}\x1f${FALLBACK}` will hand entry 0 to the
 * hydration call and leave entry 1 sticking for every subsequent call —
 * which means your intended path lands at the FALLBACK slot, not PRIMARY.
 *
 * Examples:
 *   - One call expected, one path wanted:
 *     `OK_DESKTOP_TEST_PICKED_PATH=/Users/x/proj` → every picker call
 *     returns `/Users/x/proj`. (The common case; preferred unless you have
 *     a precise multi-call invariant in mind.)
 *   - Two distinct picker calls expected, two different paths wanted:
 *     `OK_DESKTOP_TEST_PICKED_PATH=/Users/x/a\x1f/Users/x/b` → call 0 gets
 *     `/Users/x/a`, call 1+ gets `/Users/x/b`. Verify the call sequence
 *     empirically (write a tolerant `dom-extract` after the picker click
 *     to capture which dir actually opened) before relying on this shape.
 *
 * Pure (no env or counter access) so the sequence semantics are
 * unit-testable without driving the module-global counter through Electron.
 */
export function resolvePickedPathForIndex(raw: string, callIndex: number): string | null {
  const sequence = raw.split('\x1f').filter((s) => s.length > 0);
  if (sequence.length === 0) return null;
  const idx = Math.min(callIndex, sequence.length - 1);
  return sequence[idx] ?? null;
}

/**
 * E2E test seam: the macOS native folder picker can't be driven from
 * Playwright. When the smoke harness runs (`OK_DESKTOP_E2E_SMOKE=1`) and a
 * `OK_DESKTOP_TEST_PICKED_PATH` env var is set, return that path — or the
 * Nth entry of a `\x1f`-separated sequence per `resolvePickedPathForIndex`
 * — instead of showing the OS dialog. The double gate prevents accidental
 * firing in production: `OK_DESKTOP_E2E_SMOKE` is itself only ever set by
 * the smoke launcher, so a stray `OK_DESKTOP_TEST_PICKED_PATH` in the
 * user's shell environment cannot bypass the real picker.
 */
let testPickedPathCallIndex = 0;

function readTestPickedPath(): string | null {
  if (process.env.OK_DESKTOP_E2E_SMOKE !== '1') return null;
  const raw = process.env.OK_DESKTOP_TEST_PICKED_PATH;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const resolved = resolvePickedPathForIndex(raw, testPickedPathCallIndex);
  if (resolved === null) return null;
  testPickedPathCallIndex += 1;
  return resolved;
}

/**
 * Prompt for a folder. `createDirectory` is included so macOS shows the
 * "New Folder" button — under the name-first model the Create-New-Project
 * → Browse flow picks the **parent** directory and the project basename
 * comes from the Name <Input>, but users may still want to mint a fresh
 * parent via the native New Folder affordance, and Pick Existing / File
 * → Open Folder may want to mint a host directory. Used by the
 * Create-New-Project Browse flow (picks the project parent), the Pick
 * Existing path in the Navigator (picks an existing project root), and
 * the File → Open Folder menu (also picks an existing project root).
 * `showHiddenFiles` flips the picker's initial dot-file/dir visibility on
 * — necessary so users can navigate into folders like
 * `.claude/worktrees/<name>` and pick a linked worktree as its own
 * project. macOS users can still toggle visibility with Cmd+Shift+. (this
 * property only changes the initial state). Routes through the E2E test
 * seam so smoke tests can drive the path without an OS picker.
 */
export async function promptForExistingFolder(
  dialogModule: DialogLike,
  opts: PromptForFolderOpts = {},
): Promise<string | null> {
  const testSeam = readTestPickedPath();
  if (testSeam !== null) return testSeam;
  const result = await dialogModule.showOpenDialog({
    properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
    ...(opts.defaultPath !== undefined ? { defaultPath: opts.defaultPath } : {}),
  });
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
}
