import { afterEach, describe, expect, test } from 'bun:test';
import {
  getTerminalWindowContext,
  registerTerminalWindow,
  resolvePtyProjectRoot,
  unregisterTerminalWindow,
} from './terminal-window-registry.ts';

// Unique windowIds per test + explicit cleanup so the module-global Map does not
// leak across cases.
const WIN_A = 90_001;
const WIN_B = 90_002;

afterEach(() => {
  unregisterTerminalWindow(WIN_A);
  unregisterTerminalWindow(WIN_B);
});

describe('terminal-window registry', () => {
  test('round-trips a registered window context by windowId', () => {
    registerTerminalWindow(WIN_A, {
      projectRoot: '/Users/me/project',
      collabUrl: 'ws://localhost:5200/collab',
      apiOrigin: 'http://localhost:5200',
    });
    expect(getTerminalWindowContext(WIN_A)).toEqual({
      projectRoot: '/Users/me/project',
      collabUrl: 'ws://localhost:5200/collab',
      apiOrigin: 'http://localhost:5200',
    });
  });

  test('returns undefined for an unregistered window', () => {
    expect(getTerminalWindowContext(WIN_B)).toBeUndefined();
  });

  test('unregister removes the entry', () => {
    registerTerminalWindow(WIN_A, { projectRoot: '/Users/me/project' });
    unregisterTerminalWindow(WIN_A);
    expect(getTerminalWindowContext(WIN_A)).toBeUndefined();
  });
});

describe('resolvePtyProjectRoot', () => {
  test('an editor window keeps its windowsByPath-resolved project path', () => {
    const root = resolvePtyProjectRoot({
      editorProjectPath: '/Users/me/editor-project',
      terminalWindow: { projectRoot: '/Users/me/other' },
      homedir: '/Users/me',
    });
    expect(root).toBe('/Users/me/editor-project');
  });

  test('a project-bound terminal window resolves to its registered project root', () => {
    const root = resolvePtyProjectRoot({
      editorProjectPath: null,
      terminalWindow: { projectRoot: '/Users/me/project' },
      homedir: '/Users/me',
    });
    expect(root).toBe('/Users/me/project');
  });

  test('a project-less terminal window resolves to the home directory (never null)', () => {
    const root = resolvePtyProjectRoot({
      editorProjectPath: null,
      terminalWindow: { projectRoot: null },
      homedir: '/Users/me',
    });
    expect(root).toBe('/Users/me');
  });

  test('a window in neither map (e.g. the Navigator) resolves to null so the handler refuses', () => {
    const root = resolvePtyProjectRoot({
      editorProjectPath: null,
      terminalWindow: undefined,
      homedir: '/Users/me',
    });
    expect(root).toBeNull();
  });
});
