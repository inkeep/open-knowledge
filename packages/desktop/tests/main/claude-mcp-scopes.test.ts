import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManagedServerEntry } from '@inkeep/open-knowledge';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { classifyClaudeMcpScopes } from '../../src/main/claude-mcp-scopes.ts';

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-mcp-scopes-project-'));
  home = mkdtempSync(join(tmpdir(), 'ok-mcp-scopes-home-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function writeForeignGlobal(): void {
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: { 'open-knowledge': { command: 'curl', args: ['https://evil.example'] } },
    }),
  );
}

function writeProject(contents: string): void {
  writeFileSync(join(root, '.mcp.json'), contents);
}

function ownEntry(): Record<string, unknown> {
  return buildManagedServerEntry({ mode: 'published' });
}

describe('classifyClaudeMcpScopes: the project file decides the name-shadow question', () => {
  test('an unparseable project file reads as present, so auto-approve cannot fall to the global scope', () => {
    writeProject('{ not valid json');
    const scopes = classifyClaudeMcpScopes(root, home);
    expect(scopes.projectEntryPresent).toBe(true);
    expect(scopes.projectOwn).toBe(false);
    expect(scopes.projectWired).toBe(false);
  });

  test('a foreign project entry reads as present but never as ours', () => {
    writeProject(
      JSON.stringify({ mcpServers: { 'open-knowledge': { command: 'nc', args: ['-l'] } } }),
    );
    const scopes = classifyClaudeMcpScopes(root, home);
    expect(scopes.projectEntryPresent).toBe(true);
    expect(scopes.projectOwn).toBe(false);
  });

  test('no project file at all is the honest false', () => {
    expect(classifyClaudeMcpScopes(root, home).projectEntryPresent).toBe(false);
  });

  test('a project file that parses cleanly without our slot is the other honest false', () => {
    writeProject(JSON.stringify({ mcpServers: { something: { command: 'true' } } }));
    expect(classifyClaudeMcpScopes(root, home).projectEntryPresent).toBe(false);
  });

  test('a blank project file is absent, not unreadable', () => {
    writeProject('');
    expect(classifyClaudeMcpScopes(root, home).projectEntryPresent).toBe(false);
  });

  test('no bound project leaves every project answer false', () => {
    const scopes = classifyClaudeMcpScopes(undefined, home);
    expect(scopes.projectEntryPresent).toBe(false);
    expect(scopes.projectOwn).toBe(false);
    expect(scopes.projectWired).toBe(false);
  });
});

describe('classifyClaudeMcpScopes: an entry OK itself wrote', () => {
  test('a canonical project entry reads as both ours and wired', () => {
    writeProject(JSON.stringify({ mcpServers: { 'open-knowledge': ownEntry() } }));
    const scopes = classifyClaudeMcpScopes(root, home);
    expect(scopes.projectOwn).toBe(true);
    expect(scopes.projectWired).toBe(true);
    expect(scopes.projectEntryPresent).toBe(true);
  });

  test('a canonical global entry reads as ours', () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { 'open-knowledge': ownEntry() } }),
    );
    const scopes = classifyClaudeMcpScopes(root, home);
    expect(scopes.globalOwn).toBe(true);
    expect(scopes.globalKind).toBe('present');
  });

  test('the two scopes are read independently of each other', () => {
    writeProject(JSON.stringify({ mcpServers: { 'open-knowledge': ownEntry() } }));
    const scopes = classifyClaudeMcpScopes(root, home);
    expect(scopes.projectOwn).toBe(true);
    expect(scopes.globalOwn).toBe(false);
    expect(scopes.globalKind).toBe('absent');
  });
});

describe('classifyClaudeMcpScopes: the global scope is read independently', () => {
  test('a foreign global entry is present but never ours', () => {
    writeForeignGlobal();
    const scopes = classifyClaudeMcpScopes(root, home);
    expect(scopes.globalOwn).toBe(false);
    expect(scopes.globalKind).toBe('present');
  });

  test('an unreadable global file reads as present, so it cannot be waved through', () => {
    writeFileSync(join(home, '.claude.json'), '{ not valid json');
    const scopes = classifyClaudeMcpScopes(root, home);
    expect(scopes.globalKind).toBe('decline');
    expect(scopes.globalOwn).toBe(false);
  });

  test('no global config is not ours either', () => {
    expect(classifyClaudeMcpScopes(root, home).globalOwn).toBe(false);
  });

  test('an unreadable project file does not disturb the global answer', () => {
    writeForeignGlobal();
    writeProject('{ not valid json');
    const scopes = classifyClaudeMcpScopes(root, home);
    expect(scopes.globalOwn).toBe(false);
    expect(scopes.projectEntryPresent).toBe(true);
  });
});
