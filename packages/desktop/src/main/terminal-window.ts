import { basename } from 'node:path';
import type { NoteWindowContext } from './note-window-registry.ts';
import type { ShowGateRegistry } from './show-gate.ts';
import { type TerminalReaper, wireWindowTerminalReap } from './terminal-lifecycle.ts';
import {
  registerTerminalWindow,
  type TerminalWindowContext,
  unregisterTerminalWindow,
} from './terminal-window-registry.ts';
import { type BrowserWindowLike, collabUrlFromApiOrigin } from './window-manager.ts';

export type TerminalBrowserWindow = BrowserWindowLike & { readonly id: number };

export interface TerminalWindowProject {
  readonly projectPath: string;
  readonly projectName: string;
  readonly collabUrl: string;
  readonly apiOrigin: string;
}

interface CreateTerminalWindowDeps {
  createWindow(opts: { additionalArguments: string[]; title: string }): TerminalBrowserWindow;
  rendererEntryPath: string;
  rendererDevUrl?: string | null;
  appVersion: string;
  showGate: ShowGateRegistry;
  terminalReaper: TerminalReaper;
  project: TerminalWindowProject | null;
}

const GENERIC_TITLE = 'Open Knowledge Terminal';

export function createTerminalWindow(deps: CreateTerminalWindowDeps): TerminalBrowserWindow {
  const { project } = deps;
  const title = project ? `${GENERIC_TITLE} — ${project.projectName}` : GENERIC_TITLE;
  const window = deps.createWindow({
    additionalArguments: [
      '--ok-mode=terminal',
      `--ok-app-version=${deps.appVersion}`,
      `--ok-collab-url=${project?.collabUrl ?? ''}`,
      `--ok-api-origin=${project?.apiOrigin ?? ''}`,
      `--ok-project-path=${project?.projectPath ?? ''}`,
      `--ok-project-name=${project?.projectName ?? GENERIC_TITLE}`,
    ],
    title,
  });

  registerTerminalWindow(window.id, {
    projectRoot: project?.projectPath ?? null,
    collabUrl: project?.collabUrl,
    apiOrigin: project?.apiOrigin,
  });

  wireWindowTerminalReap(window, deps.terminalReaper);
  const disposeShowGate = deps.showGate.register(window, { kind: 'terminal' });
  window.on('closed', () => {
    disposeShowGate();
    unregisterTerminalWindow(window.id);
  });

  const loadPromise = deps.rendererDevUrl
    ? window.loadURL(deps.rendererDevUrl)
    : window.loadFile(deps.rendererEntryPath);
  loadPromise.catch((err: unknown) => {
    console.warn(
      JSON.stringify({
        event: 'terminal-load-failed',
        windowId: window.id,
        target: deps.rendererDevUrl ?? deps.rendererEntryPath,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  });

  return window;
}

interface EditorProjectContext {
  readonly projectPath: string;
  readonly projectName: string;
  readonly port: number;
  readonly apiOrigin: string;
}

export function resolveTerminalWindowProject(args: {
  readonly editor: EditorProjectContext | null;
  readonly terminal: TerminalWindowContext | undefined;
  readonly note?: NoteWindowContext | undefined;
}): TerminalWindowProject | null {
  if (args.editor) {
    return {
      projectPath: args.editor.projectPath,
      projectName: args.editor.projectName,
      collabUrl: collabUrlFromApiOrigin(args.editor.apiOrigin),
      apiOrigin: args.editor.apiOrigin,
    };
  }
  if (args.terminal?.projectRoot) {
    return {
      projectPath: args.terminal.projectRoot,
      projectName: basename(args.terminal.projectRoot),
      collabUrl: args.terminal.collabUrl ?? '',
      apiOrigin: args.terminal.apiOrigin ?? '',
    };
  }
  if (args.note) {
    return {
      projectPath: args.note.projectRoot,
      projectName: basename(args.note.projectRoot),
      collabUrl: args.note.collabUrl,
      apiOrigin: args.note.apiOrigin,
    };
  }
  return null;
}
