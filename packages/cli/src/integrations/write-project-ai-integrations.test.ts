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
    expect(existsSync(join(projectDir, '.agents', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
      true,
    );
  });

  test('all editors: 2 outcomes per editor; global-only editors skip the MCP config', () => {
    const result = writeProjectAiIntegrations(projectDir, ALL_EDITOR_IDS);

    expect(result.integrations).toHaveLength(ALL_EDITOR_IDS.length * 2);

    // claude-desktop is fully global-only (no project MCP config and no project
    // skill), so both its project integrations report skipped-unsupported.
    const claudeDesktop = result.integrations.filter((o) => o.editorId === 'claude-desktop');
    expect(claudeDesktop).toHaveLength(2);
    for (const outcome of claudeDesktop) expect(outcome.action).toBe('skipped-unsupported');

    // Copilot CLI has no repo-local MCP config (global-only), but it DOES read a
    // project skill from .github/skills — so the skill is written and only the
    // MCP config is skipped.
    const copilot = result.integrations.filter((o) => o.editorId === 'copilot');
    expect(copilot.find((o) => o.integration === 'mcp-config')?.action).toBe('skipped-unsupported');
    expect(copilot.find((o) => o.integration === 'project-skill')?.action).toBe('written');
    expect(existsSync(join(projectDir, '.github', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
      true,
    );
  });

  test('empty selection returns no integrations and no launch.json', () => {
    const result = writeProjectAiIntegrations(projectDir, []);

    expect(result.integrations).toEqual([]);
    expect(result.claudeLaunchJson).toBeUndefined();
  });

  test('never throws — a hostile target surfaces as action "failed", not an exception', () => {
    writeFileSync(join(projectDir, '.cursor'), 'block');

    let result: ReturnType<typeof writeProjectAiIntegrations> | undefined;
    expect(() => {
      result = writeProjectAiIntegrations(projectDir, ['claude', 'cursor', 'codex']);
    }).not.toThrow();

    const cursorFailed = result?.integrations.some(
      (o) => o.editorId === 'cursor' && o.action === 'failed',
    );
    expect(cursorFailed).toBe(true);
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
