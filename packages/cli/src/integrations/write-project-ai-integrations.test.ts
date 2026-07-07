import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ALL_EDITOR_IDS } from '../commands/editors.ts';
import { writeProjectAiIntegrations } from './write-project-ai-integrations.ts';

// `writeProjectAiIntegrations` is a thin wrapper over `applyProjectIntegrations`
// (the per-(editor × integration) matrix is exhaustively covered in
// project-integration-writers.test.ts). These tests pin the wrapper's own
// responsibilities: it installs BOTH integrations — MCP config AND the
// project-local runtime skill — for every selected editor (
// the desktop path previously installed MCP config only), and it scaffolds
// `.claude/launch.json` when `claude` is selected.

let tmpRoot: string;
let projectDir: string;

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(resolve(tmpdir(), 'ok-write-project-ai-')));
  projectDir = resolve(tmpRoot, 'proj');
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('writeProjectAiIntegrations — installs MCP config AND the project skill', () => {
  test('a selected editor gets both integrations (PRD-6733: the skill was previously missing)', () => {
    const result = writeProjectAiIntegrations(projectDir, ['claude']);

    const claudeOutcomes = result.integrations.filter((o) => o.editorId === 'claude');
    expect(claudeOutcomes.map((o) => o.integration).sort()).toEqual([
      'mcp-config',
      'project-skill',
    ]);
    for (const outcome of claudeOutcomes) expect(outcome.action).toBe('written');

    // Both artifacts on disk — the project skill is the regression this fixes.
    expect(existsSync(join(projectDir, '.mcp.json'))).toBe(true);
    expect(existsSync(join(projectDir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
      true,
    );
  });

  test('installs the project skill for cursor and codex too', () => {
    writeProjectAiIntegrations(projectDir, ['cursor', 'codex']);

    expect(existsSync(join(projectDir, '.cursor', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
      true,
    );
    expect(existsSync(join(projectDir, '.codex', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
      true,
    );
  });

  test('all editors: 2 outcomes per editor; claude-desktop skips both as unsupported', () => {
    const result = writeProjectAiIntegrations(projectDir, ALL_EDITOR_IDS);

    // mcp-config + project-skill for every selected editor.
    expect(result.integrations).toHaveLength(ALL_EDITOR_IDS.length * 2);

    const desktop = result.integrations.filter((o) => o.editorId === 'claude-desktop');
    expect(desktop).toHaveLength(2);
    for (const outcome of desktop) expect(outcome.action).toBe('skipped-unsupported');
  });

  test('empty selection returns no integrations and no launch.json', () => {
    const result = writeProjectAiIntegrations(projectDir, []);

    expect(result.integrations).toEqual([]);
    expect(result.claudeLaunchJson).toBeUndefined();
  });

  test('never throws — a hostile target surfaces as action "failed", not an exception', () => {
    // A regular file where cursor's `.cursor/` directory would live forces
    // the downstream mkdir to fail; the wrapper must still return cleanly.
    writeFileSync(join(projectDir, '.cursor'), 'block');

    let result: ReturnType<typeof writeProjectAiIntegrations> | undefined;
    expect(() => {
      result = writeProjectAiIntegrations(projectDir, ['claude', 'cursor', 'codex']);
    }).not.toThrow();

    const cursorFailed = result?.integrations.some(
      (o) => o.editorId === 'cursor' && o.action === 'failed',
    );
    expect(cursorFailed).toBe(true);
    // The other editors still completed.
    const claudeWritten = result?.integrations.every(
      (o) => o.editorId !== 'claude' || o.action === 'written',
    );
    expect(claudeWritten).toBe(true);
  });
});

describe('writeProjectAiIntegrations — Claude launch.json', () => {
  test('selecting "claude" scaffolds .claude/launch.json', () => {
    const result = writeProjectAiIntegrations(projectDir, ['claude']);

    expect(result.claudeLaunchJson?.action).toBe('created');
    expect(result.claudeLaunchJson?.configPath).toBe(join(projectDir, '.claude', 'launch.json'));
    expect(existsSync(join(projectDir, '.claude', 'launch.json'))).toBe(true);

    const launch = JSON.parse(readFileSync(join(projectDir, '.claude', 'launch.json'), 'utf-8'));
    expect(launch.configurations[0].name).toBe('open-knowledge-ui');
  });

  test('NOT selecting "claude" leaves launch.json absent and claudeLaunchJson undefined', () => {
    const result = writeProjectAiIntegrations(projectDir, ['cursor', 'codex']);

    expect(result.claudeLaunchJson).toBeUndefined();
    expect(existsSync(join(projectDir, '.claude', 'launch.json'))).toBe(false);
  });
});
