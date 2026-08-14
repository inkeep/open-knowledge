/**
 * Popped-out note window — a dedicated `--ok-mode=note` window showing exactly
 * one document full-window.
 *
 * Modeled on `terminal-window.ts`: same renderer bundle, a distinct window mode,
 * attach-mode argv, the dual-signal show gate, and a windowId-keyed registry
 * outside `windowsByPath` so N pop-outs coexist per project. It differs from the
 * terminal window in three ways:
 *   - It targets a document. `--ok-initial-doc` seeds the renderer hash before
 *     first render, so the window boots straight into its document.
 *   - It is never project-less. A document only exists inside a project, so the
 *     factory requires a project context rather than accepting null.
 *   - Its registry identity is content-keyed `(projectRoot, docName)`, so
 *     `openNoteWindow` focuses an existing window instead of creating a second.
 *
 * Dedup is race-free without the slides registry's in-flight-promise map:
 * `openNoteWindow` looks up and registers synchronously, before the async
 * renderer load starts, so two calls in the same tick cannot both miss.
 */

import { TERMINAL_CLIS } from '@inkeep/open-knowledge-core';
import type { OkNoteWindowMainAction } from '@inkeep/open-knowledge-core/desktop-bridge';
import type { NoteWindowContext, NoteWindowEntryPoint } from './note-window-registry.ts';
import {
  findNoteWindowForDoc,
  listNoteWindowsForProject,
  registerNoteWindow,
  touchNoteWindow,
  unregisterNoteWindow,
} from './note-window-registry.ts';
import { recordNoteWindowOpened } from './note-window-telemetry.ts';
import type { VibrancyMaterial } from './reduced-transparency-handler.ts';
import type { ShowGateRegistry } from './show-gate.ts';
import type { BrowserWindowLike } from './window-manager.ts';

/** A created window exposing the numeric `id` the registry wiring needs. */
export type NoteBrowserWindow = BrowserWindowLike & { readonly id: number };

/** Project context a note window inherits (attach-mode). Never null. */
export interface NoteWindowProject {
  readonly projectPath: string;
  readonly projectName: string;
  readonly collabUrl: string;
  readonly apiOrigin: string;
}

export interface CreateNoteWindowDeps {
  /** Creates the real BrowserWindow (with `show: false`); the show gate reveals it. */
  createWindow(opts: { additionalArguments: string[]; title: string }): NoteBrowserWindow;
  /** Path to the built renderer HTML (packaged/prod). */
  rendererEntryPath: string;
  /** electron-vite dev-server URL for HMR; when set, `loadURL` is used over `loadFile`. */
  rendererDevUrl?: string | null;
  /** App version, passed to the preload via additionalArguments. */
  appVersion: string;
  /** Dual-signal show coordinator — note windows get `kind: 'note'`. */
  showGate: ShowGateRegistry;
  /** Inherited project context (attach-mode). */
  project: NoteWindowProject;
  /** The document this window opens on. */
  docName: string;
  /** Applies cascade placement (and, later, the remembered per-project frame). */
  placeWindow?(window: NoteBrowserWindow): void;
  /**
   * Attaches the external-link navigation safety net, called before the renderer
   * loads. Injected because the net's openAsset/openExternal delegates are
   * Electron/shell-bound and belong in the composition root, not this pure
   * factory — the same reason `WindowManager` injects its own `safetyNet`. A
   * note window renders the same untrusted document content as an editor window
   * (raw `<a href>`, `target=_blank`, asset links), so without this a click that
   * escapes the renderer's own handler navigates the top frame to an external
   * origin, where the preload re-exposes the `okDesktop` bridge.
   */
  attachSafetyNet?(window: NoteBrowserWindow): void;
  /** Fired after the registry entry is dropped, for main-side per-window state
   *  that also has to forget this window (its active-target snapshot). */
  onClosed?(windowId: number): void;
}

export interface NoteWindowNativeChromeOptions {
  readonly vibrancy?: VibrancyMaterial;
  readonly trafficLightPosition?: { readonly x: number; readonly y: number };
}

/**
 * Native chrome policy for the compact note surface.
 *
 * Electron positions the macOS traffic-light frame by its top edge. The native
 * frame is 14px tall, so y=17 centers it in the renderer's 48px titlebar.
 * `window` vibrancy avoids electron/electron#27882's double-border artifact from
 * the `sidebar` material while retaining the translucent native treatment.
 */
export function noteWindowNativeChromeOptions(
  platform: NodeJS.Platform,
): NoteWindowNativeChromeOptions {
  if (platform !== 'darwin') return {};
  return {
    vibrancy: 'window',
    trafficLightPosition: { x: 22, y: 17 },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

type NoteWindowMainActionKind = OkNoteWindowMainAction['kind'];
const NOTE_WINDOW_MAIN_ACTION_KINDS = {
  'active-input': true,
  'agent-thread': true,
  'terminal-launch': true,
  'reveal-comments': true,
} satisfies Record<NoteWindowMainActionKind, true>;

function isNoteWindowMainActionKind(value: unknown): value is NoteWindowMainActionKind {
  return typeof value === 'string' && Object.hasOwn(NOTE_WINDOW_MAIN_ACTION_KINDS, value);
}

/** Runtime validation for the renderer-originated cross-window intent. */
export function parseNoteWindowMainAction(value: unknown): OkNoteWindowMainAction | null {
  if (!isRecord(value) || !isNoteWindowMainActionKind(value.kind)) return null;

  if (value.kind === 'active-input') {
    if (
      typeof value.text !== 'string' ||
      typeof value.newTab !== 'boolean' ||
      typeof value.submit !== 'boolean' ||
      (value.target !== undefined && value.target !== 'agents')
    )
      return null;
    return {
      kind: 'active-input',
      text: value.text,
      newTab: value.newTab,
      submit: value.submit,
      ...(value.target === 'agents' ? { target: 'agents' as const } : {}),
    };
  }

  if (value.kind === 'agent-thread') {
    if (
      (value.agentSource !== 'registry' && value.agentSource !== 'custom') ||
      typeof value.agentId !== 'string' ||
      !isNullableString(value.prompt) ||
      !isNullableString(value.docName) ||
      !isNullableString(value.titleHint)
    )
      return null;
    return {
      kind: 'agent-thread',
      agentSource: value.agentSource,
      agentId: value.agentId,
      prompt: value.prompt,
      docName: value.docName,
      titleHint: value.titleHint,
    };
  }

  if (value.kind === 'terminal-launch') {
    if (
      typeof value.prompt !== 'string' ||
      typeof value.cli !== 'string' ||
      !Object.hasOwn(TERMINAL_CLIS, value.cli) ||
      typeof value.stage !== 'boolean'
    )
      return null;
    const cli = value.cli as keyof typeof TERMINAL_CLIS;
    return {
      kind: 'terminal-launch',
      prompt: value.prompt,
      cli,
      stage: value.stage,
    };
  }

  if (value.kind === 'reveal-comments') {
    if (
      typeof value.docName !== 'string' ||
      value.docName.trim() === '' ||
      (value.scope !== 'doc' && value.scope !== 'queue')
    )
      return null;
    return { kind: 'reveal-comments', docName: value.docName, scope: value.scope };
  }

  const exhaustiveKind: never = value.kind;
  return exhaustiveKind;
}

export interface DispatchNoteWindowMainActionDeps<TTarget> {
  readonly originWindowId: number | null;
  readonly action: unknown;
  readonly getContext: (windowId: number) => NoteWindowContext | undefined;
  /** Focuses the owning project window and returns the live delivery target. */
  readonly focusProjectWindow: (projectRoot: string) => TTarget | null;
  readonly send: (target: TTarget, action: OkNoteWindowMainAction) => void;
}

/**
 * Authorize, validate, focus, then deliver a note-window action.
 *
 * Kept outside the Electron composition root so the load-bearing order is
 * executable in the unit tier; the live Electron smoke separately proves the
 * renderer/preload/main/renderer wiring that this pure decision cannot see.
 */
export function dispatchNoteWindowMainActionToProject<TTarget>(
  deps: DispatchNoteWindowMainActionDeps<TTarget>,
):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'invalid-action' | 'not-note-window' | 'project-not-open';
    } {
  if (deps.originWindowId === null) return { ok: false, reason: 'not-note-window' };
  const context = deps.getContext(deps.originWindowId);
  if (!context) return { ok: false, reason: 'not-note-window' };
  const action = parseNoteWindowMainAction(deps.action);
  if (!action) return { ok: false, reason: 'invalid-action' };
  const target = deps.focusProjectWindow(context.projectRoot);
  if (!target) return { ok: false, reason: 'project-not-open' };
  deps.send(target, action);
  return { ok: true };
}

/**
 * Window titles are main-owned and set at construction. The title tracks the
 * displayed document from here on via the active-target push, not via the
 * renderer's `page-title-updated` (which every creation site preventDefaults).
 */
export function noteWindowTitle(docName: string): string {
  return docName;
}

export function createNoteWindow(deps: CreateNoteWindowDeps): NoteBrowserWindow {
  const { project, docName } = deps;
  const window = deps.createWindow({
    additionalArguments: [
      '--ok-mode=note',
      `--ok-app-version=${deps.appVersion}`,
      // Attach-mode: inherit the launching project's collab + api server. The
      // note window never spawns a server, so its edits land on the same Y.Doc
      // the main window is editing — that is the whole live-sync story.
      `--ok-collab-url=${project.collabUrl}`,
      `--ok-api-origin=${project.apiOrigin}`,
      `--ok-project-path=${project.projectPath}`,
      `--ok-project-name=${project.projectName}`,
      // Seeds location.hash pre-render, so the window boots on its document
      // rather than flashing the home surface first.
      `--ok-initial-doc=${docName}`,
    ],
    title: noteWindowTitle(docName),
  });

  // Guard the window's navigation BEFORE it loads: `setWindowOpenHandler` /
  // `will-navigate` must be registered before `loadFile`/`loadURL` to catch the
  // first navigation.
  deps.attachSafetyNet?.(window);

  // Register BEFORE the renderer loads: this is the window's only project
  // source for main-side resolution, and registering synchronously is what
  // makes same-tick dedup race-free.
  registerNoteWindow(window.id, {
    projectRoot: project.projectPath,
    collabUrl: project.collabUrl,
    apiOrigin: project.apiOrigin,
    currentDocName: docName,
  });

  const disposeShowGate = deps.showGate.register(window, { kind: 'note' });
  window.on('closed', () => {
    disposeShowGate();
    unregisterNoteWindow(window.id);
    deps.onClosed?.(window.id);
  });

  deps.placeWindow?.(window);

  // Surface load failures with a grep-able structured warn rather than
  // discarding the rejection — the show gate's 5 s safety timeout still reveals
  // the (blank) window so the failure is visible instead of silent.
  const loadPromise = deps.rendererDevUrl
    ? window.loadURL(deps.rendererDevUrl)
    : window.loadFile(deps.rendererEntryPath);
  loadPromise.catch((err: unknown) => {
    console.warn(
      JSON.stringify({
        event: 'note-window-load-failed',
        windowId: window.id,
        target: deps.rendererDevUrl ?? deps.rendererEntryPath,
        message: err instanceof Error ? (err.stack ?? err.message) : String(err),
      }),
    );
  });

  return window;
}

/** The editor-window project fields the resolver reads. The full `ProjectContext`
 *  (window-manager.ts) is structurally assignable to this. */
interface EditorProjectContext {
  readonly projectPath: string;
  readonly projectName: string;
  readonly apiOrigin: string;
}

/**
 * Resolve the project a new note window inherits from the invoking window.
 *
 * An editor window's `windowsByPath` context wins, with its collab URL derived
 * from `apiOrigin` through the same helper the editor's own dials use.
 * Otherwise an invoking NOTE window's registry context carries the project, so
 * popping out from inside a pop-out works.
 *
 * Returns null when neither resolves. Unlike a terminal window there is no
 * project-less fallback: a document only exists inside a project, so no project
 * means no window rather than a home-directory one.
 */
export function resolveNoteWindowProject(args: {
  readonly editor: EditorProjectContext | null;
  readonly note: NoteWindowContext | undefined;
  readonly collabUrlFromApiOrigin: (apiOrigin: string) => string;
  readonly projectNameFromPath: (projectPath: string) => string;
}): NoteWindowProject | null {
  if (args.editor) {
    return {
      projectPath: args.editor.projectPath,
      projectName: args.editor.projectName,
      collabUrl: args.collabUrlFromApiOrigin(args.editor.apiOrigin),
      apiOrigin: args.editor.apiOrigin,
    };
  }
  if (args.note) {
    return {
      projectPath: args.note.projectRoot,
      projectName: args.projectNameFromPath(args.note.projectRoot),
      collabUrl: args.note.collabUrl,
      apiOrigin: args.note.apiOrigin,
    };
  }
  return null;
}

/**
 * The project scope a window's main-side actions operate against.
 *
 * Editor windows resolve through `windowsByPath`. Note windows are deliberately
 * absent from that map — it is one-per-project focus-existing, which would block
 * N pop-outs — so `getContextForBrowserWindow` returns nothing for them. Without
 * this fallback, every containment-gated handler would treat a focused pop-out
 * as having no project at all: asset clicks and copy-image refuse outright;
 * reveal, trash, and show-item-in-folder fall back to their no-project arms; and
 * spawn-cursor takes its deliberately PERMISSIVE no-scope path (a containment
 * gap). Resolving the note window's project here closes all of those for a
 * focused pop-out.
 *
 * Resolved per field rather than per source, so an editor context that carries
 * a path but no origin behaves exactly as an editor-only context does.
 */
export function resolveWindowProjectScope(args: {
  readonly editor:
    | { readonly projectPath?: string; readonly apiOrigin?: string }
    | null
    | undefined;
  readonly note: NoteWindowContext | undefined;
}): { projectPath: string | undefined; apiOrigin: string | undefined } {
  return {
    projectPath: args.editor?.projectPath ?? args.note?.projectRoot,
    apiOrigin: args.editor?.apiOrigin ?? args.note?.apiOrigin,
  };
}

export interface OpenNoteWindowResult {
  /** 'created' when a new window was made, 'focused' on a dedup hit. */
  readonly outcome: 'created' | 'focused';
  readonly windowId: number;
}

/**
 * The single entry point every surface (tab menu, palette, Window menu) calls.
 * Focuses the existing window for this `(project, document)` identity when one
 * exists, otherwise creates it. Only a real creation emits the adoption span.
 */
export function openNoteWindow(
  deps: CreateNoteWindowDeps & {
    /**
     * Which surface the user opened this from, or undefined when nothing did —
     * a server-restart recreate, say. Undefined emits NO adoption span: those
     * windows are the app putting back what was already there, and counting
     * them would inflate the one number this feature reports.
     */
    readonly entryPoint?: NoteWindowEntryPoint;
    /** Resolves a live window object from its id, for the focus-existing path. */
    focusWindowById(windowId: number): boolean;
  },
): OpenNoteWindowResult {
  const existingId = findNoteWindowForDoc(deps.project.projectPath, deps.docName);
  if (existingId !== undefined && deps.focusWindowById(existingId)) {
    touchNoteWindow(existingId);
    return { outcome: 'focused', windowId: existingId };
  }
  // A registry entry whose window could not be focused is stale (the window
  // died without firing 'closed'); drop it so it cannot shadow the new window.
  if (existingId !== undefined) unregisterNoteWindow(existingId);

  const window = createNoteWindow(deps);
  if (deps.entryPoint !== undefined) recordNoteWindowOpened({ entryPoint: deps.entryPoint });
  return { outcome: 'created', windowId: window.id };
}

/**
 * Owner-close cascade: a project's note windows close with its main window and
 * do not survive as independents.
 *
 * `reason` is load-bearing rather than cosmetic. On `quit` the restore snapshot
 * must already have been captured before this runs, so the windows are recorded
 * for the next launch; on `project-close` they are gone for good and must NOT be
 * recorded. Keeping the distinction in the signature stops a caller from
 * cascading without having decided which case it is in.
 */
export function closeNoteWindowsForProject(args: {
  readonly projectRoot: string;
  readonly reason: 'project-close' | 'quit';
  readonly closingProjectWindow?: BrowserWindowLike;
  readonly activeProjectWindow?: BrowserWindowLike;
  closeWindowById(windowId: number): void;
}): number[] {
  if (
    args.activeProjectWindow !== undefined &&
    args.activeProjectWindow !== args.closingProjectWindow &&
    args.activeProjectWindow.isDestroyed?.() !== true
  ) {
    return [];
  }

  const windowIds = listNoteWindowsForProject(args.projectRoot);
  for (const windowId of windowIds) {
    args.closeWindowById(windowId);
    // Drop the entry eagerly. The 'closed' handler also unregisters, but a
    // destroyed-window close() can skip it, and an orphaned entry would keep
    // shadowing later dedup lookups for a window that no longer exists.
    unregisterNoteWindow(windowId);
  }
  return windowIds;
}
