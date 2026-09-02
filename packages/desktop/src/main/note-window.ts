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

export type NoteBrowserWindow = BrowserWindowLike & { readonly id: number };

export interface NoteWindowProject {
  readonly projectPath: string;
  readonly projectName: string;
  readonly collabUrl: string;
  readonly apiOrigin: string;
}

export interface CreateNoteWindowDeps {
  createWindow(opts: { additionalArguments: string[]; title: string }): NoteBrowserWindow;
  rendererEntryPath: string;
  rendererDevUrl?: string | null;
  appVersion: string;
  showGate: ShowGateRegistry;
  project: NoteWindowProject;
  docName: string;
  placeWindow?(window: NoteBrowserWindow): void;
  attachSafetyNet?(window: NoteBrowserWindow): void;
  onClosed?(windowId: number): void;
}

export interface NoteWindowNativeChromeOptions {
  readonly vibrancy?: VibrancyMaterial;
  readonly trafficLightPosition?: { readonly x: number; readonly y: number };
}

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
  readonly focusProjectWindow: (projectRoot: string) => TTarget | null;
  readonly send: (target: TTarget, action: OkNoteWindowMainAction) => void;
}

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

export function noteWindowTitle(docName: string): string {
  return docName;
}

export function createNoteWindow(deps: CreateNoteWindowDeps): NoteBrowserWindow {
  const { project, docName } = deps;
  const window = deps.createWindow({
    additionalArguments: [
      '--ok-mode=note',
      `--ok-app-version=${deps.appVersion}`,
      `--ok-collab-url=${project.collabUrl}`,
      `--ok-api-origin=${project.apiOrigin}`,
      `--ok-project-path=${project.projectPath}`,
      `--ok-project-name=${project.projectName}`,
      `--ok-initial-doc=${docName}`,
    ],
    title: noteWindowTitle(docName),
  });

  deps.attachSafetyNet?.(window);

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

interface EditorProjectContext {
  readonly projectPath: string;
  readonly projectName: string;
  readonly apiOrigin: string;
}

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
  readonly outcome: 'created' | 'focused';
  readonly windowId: number;
}

export function openNoteWindow(
  deps: CreateNoteWindowDeps & {
    readonly entryPoint?: NoteWindowEntryPoint;
    focusWindowById(windowId: number): boolean;
  },
): OpenNoteWindowResult {
  const existingId = findNoteWindowForDoc(deps.project.projectPath, deps.docName);
  if (existingId !== undefined && deps.focusWindowById(existingId)) {
    touchNoteWindow(existingId);
    return { outcome: 'focused', windowId: existingId };
  }
  if (existingId !== undefined) unregisterNoteWindow(existingId);

  const window = createNoteWindow(deps);
  if (deps.entryPoint !== undefined) recordNoteWindowOpened({ entryPoint: deps.entryPoint });
  return { outcome: 'created', windowId: window.id };
}

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
    unregisterNoteWindow(windowId);
  }
  return windowIds;
}
