import { buildConnectionsView, editorPathId } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { connectionPathDisplay } from './agent-connection-paths.ts';

describe('connectionPathDisplay', () => {
  test('names the project config file per editor', () => {
    expect(connectionPathDisplay(editorPathId('editor-project-config', 'claude'))).toBe(
      '.mcp.json',
    );
    expect(connectionPathDisplay(editorPathId('editor-project-config', 'codex'))).toBe(
      '.codex/config.toml',
    );
    expect(connectionPathDisplay(editorPathId('editor-project-config', 'opencode'))).toBe(
      'opencode.json',
    );
  });

  test('names the installed folder for a project skill, not just its root', () => {
    expect(connectionPathDisplay(editorPathId('editor-project-skill-root', 'codex'))).toBe(
      '.codex/skills/open-knowledge/',
    );
  });

  test('prefixes user scope with ~/', () => {
    expect(connectionPathDisplay(editorPathId('editor-user-skill-root', 'copilot'))).toBe(
      '~/.copilot/skills/',
    );
  });

  test('declines the user-config family rather than guessing', () => {
    expect(connectionPathDisplay(editorPathId('editor-user-config', 'codex'))).toBeNull();
  });

  test('returns null for absent and unparseable ids', () => {
    expect(connectionPathDisplay(undefined)).toBeNull();
    expect(connectionPathDisplay('not-a-path-id')).toBeNull();
    expect(connectionPathDisplay('editor-project-config:nope')).toBeNull();
  });

  test('a shared file is named by its owner, not by the agent reading it', () => {
    const row = buildConnectionsView({ agentIds: ['copilot'] }).rows[0];
    const cell = row?.scopes
      .flatMap((group) => group.cells)
      .find((candidate) => candidate.satisfierId === 'copilot/mcp/project/config-entry');
    expect(cell).toBeDefined();
    expect(connectionPathDisplay(cell?.pathId)).toBe('.mcp.json');
  });
});
