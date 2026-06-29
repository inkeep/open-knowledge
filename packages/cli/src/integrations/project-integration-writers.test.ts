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
import { EDITOR_TARGETS, type EditorId } from '../commands/editors.ts';
import {
  applyProjectIntegrations,
  DEFAULT_PROJECT_INTEGRATIONS,
  type IntegrationWriteOutcome,
  mcpConfigWriter,
  projectSkillWriter,
} from './project-integration-writers.ts';

let tmpRoot: string;
let projectDir: string;

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(resolve(tmpdir(), 'ok-project-integration-writers-')));
  projectDir = resolve(tmpRoot, 'proj');
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});


describe('mcpConfigWriter', () => {
  test('id is "mcp-config"', () => {
    expect(mcpConfigWriter.id).toBe('mcp-config');
  });

  test('writes a fresh project-scope MCP config and reports action "written"', () => {
    const outcome = mcpConfigWriter.write(EDITOR_TARGETS.cursor, projectDir, {});

    expect(outcome.integration).toBe('mcp-config');
    expect(outcome.editorId).toBe('cursor');
    expect(outcome.action).toBe('written');
    expect(outcome.path).toBe(join(projectDir, '.cursor', 'mcp.json'));
    expect(outcome.error).toBeUndefined();
    expect(existsSync(join(projectDir, '.cursor', 'mcp.json'))).toBe(true);
  });

  test('replaces an existing config and reports action "overwritten"', () => {
    const cursorMcp = join(projectDir, '.cursor', 'mcp.json');
    mkdirSync(join(projectDir, '.cursor'), { recursive: true });
    writeFileSync(
      cursorMcp,
      JSON.stringify({
        mcpServers: { 'open-knowledge': { command: 'old', args: ['mcp'] } },
      }),
    );

    const outcome = mcpConfigWriter.write(EDITOR_TARGETS.cursor, projectDir, {});

    expect(outcome.action).toBe('overwritten');
    expect(outcome.path).toBe(cursorMcp);
    const written = JSON.parse(readFileSync(cursorMcp, 'utf-8'));
    expect(written.mcpServers['open-knowledge'].command).toBe('/bin/sh');
    expect(written.mcpServers['open-knowledge'].args.slice(0, 2)).toEqual(['-l', '-c']);
    expect(written.mcpServers['open-knowledge'].args[2]).toContain('# ok-mcp-v1');
  });

  test('reports "skipped-unsupported" for an editor without projectConfigPath', () => {
    const outcome = mcpConfigWriter.write(EDITOR_TARGETS['claude-desktop'], projectDir, {});

    expect(outcome.integration).toBe('mcp-config');
    expect(outcome.editorId).toBe('claude-desktop');
    expect(outcome.action).toBe('skipped-unsupported');
    expect(outcome.path).toBeUndefined();
    expect(outcome.error).toBeUndefined();
  });

  test('reports "failed" with a non-empty error when the underlying write fails', () => {
    writeFileSync(join(projectDir, '.cursor'), 'not a directory');

    const outcome = mcpConfigWriter.write(EDITOR_TARGETS.cursor, projectDir, {});

    expect(outcome.action).toBe('failed');
    expect(outcome.error).toBeDefined();
    expect(outcome.error?.length ?? 0).toBeGreaterThan(0);
    expect(outcome.path).toBe(join(projectDir, '.cursor', 'mcp.json'));
  });

  test('never throws even when the target path environment is hostile', () => {
    writeFileSync(join(projectDir, '.mcp.json'), 'not-json');
    writeFileSync(join(projectDir, '.cursor'), 'block');
    writeFileSync(join(projectDir, '.codex'), 'block');

    const editorIds: EditorId[] = ['claude', 'cursor', 'codex', 'claude-desktop'];
    for (const id of editorIds) {
      expect(() => mcpConfigWriter.write(EDITOR_TARGETS[id], projectDir, {})).not.toThrow();
    }
  });
});


describe('projectSkillWriter', () => {
  test('id is "project-skill"', () => {
    expect(projectSkillWriter.id).toBe('project-skill');
  });

  test('writes a fresh project-local skill and reports action "written"', () => {
    const outcome = projectSkillWriter.write(EDITOR_TARGETS.claude, projectDir, {});

    expect(outcome.integration).toBe('project-skill');
    expect(outcome.editorId).toBe('claude');
    expect(outcome.action).toBe('written');
    expect(outcome.path).toBe(join(projectDir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'));
    expect(outcome.error).toBeUndefined();
    expect(existsSync(outcome.path ?? '')).toBe(true);
  });

  test('writes for cursor (.cursor/skills/open-knowledge/SKILL.md)', () => {
    const outcome = projectSkillWriter.write(EDITOR_TARGETS.cursor, projectDir, {});

    expect(outcome.action).toBe('written');
    expect(outcome.path).toBe(join(projectDir, '.cursor', 'skills', 'open-knowledge', 'SKILL.md'));
    expect(existsSync(outcome.path ?? '')).toBe(true);
  });

  test('writes for codex (.codex/skills/open-knowledge/SKILL.md)', () => {
    const outcome = projectSkillWriter.write(EDITOR_TARGETS.codex, projectDir, {});

    expect(outcome.action).toBe('written');
    expect(outcome.path).toBe(join(projectDir, '.codex', 'skills', 'open-knowledge', 'SKILL.md'));
    expect(existsSync(outcome.path ?? '')).toBe(true);
  });

  test('replaces an existing skill and reports action "overwritten"', () => {
    const first = projectSkillWriter.write(EDITOR_TARGETS.claude, projectDir, {});
    expect(first.action).toBe('written');

    const second = projectSkillWriter.write(EDITOR_TARGETS.claude, projectDir, {});

    expect(second.action).toBe('overwritten');
    expect(second.path).toBe(first.path);
    expect(existsSync(second.path ?? '')).toBe(true);
  });

  test('reports "skipped-unsupported" for an editor without projectSkillPath', () => {
    const outcome = projectSkillWriter.write(EDITOR_TARGETS['claude-desktop'], projectDir, {});

    expect(outcome.integration).toBe('project-skill');
    expect(outcome.editorId).toBe('claude-desktop');
    expect(outcome.action).toBe('skipped-unsupported');
    expect(outcome.path).toBeUndefined();
    expect(outcome.error).toBeUndefined();
  });

  test('reports "failed" with a non-empty error when the destination is blocked', () => {
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    writeFileSync(join(projectDir, '.claude', 'skills'), 'block');

    const outcome = projectSkillWriter.write(EDITOR_TARGETS.claude, projectDir, {});

    expect(outcome.action).toBe('failed');
    expect(outcome.error).toBeDefined();
    expect(outcome.error?.length ?? 0).toBeGreaterThan(0);
    expect(outcome.path).toBe(join(projectDir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'));
  });

  test('never throws even when the target path environment is hostile', () => {
    writeFileSync(join(projectDir, '.cursor'), 'block');

    const editorIds: EditorId[] = ['claude', 'cursor', 'codex', 'claude-desktop'];
    for (const id of editorIds) {
      expect(() => projectSkillWriter.write(EDITOR_TARGETS[id], projectDir, {})).not.toThrow();
    }
  });
});


const outcomesFor = (
  outcomes: readonly IntegrationWriteOutcome[],
  editorId: EditorId,
): IntegrationWriteOutcome[] => outcomes.filter((o) => o.editorId === editorId);

describe('DEFAULT_PROJECT_INTEGRATIONS', () => {
  test('contains exactly [mcp-config, project-skill] in apply order', () => {
    expect(DEFAULT_PROJECT_INTEGRATIONS.map((w) => w.id)).toEqual(['mcp-config', 'project-skill']);
  });

  test('the writers in the default set are the exported singletons', () => {
    expect(DEFAULT_PROJECT_INTEGRATIONS[0]).toBe(mcpConfigWriter);
    expect(DEFAULT_PROJECT_INTEGRATIONS[1]).toBe(projectSkillWriter);
  });
});

describe('applyProjectIntegrations', () => {
  test('runs every default writer for every selected editor (editor × writer)', () => {
    const outcomes = applyProjectIntegrations(projectDir, ['claude', 'cursor', 'codex']);

    expect(outcomes).toHaveLength(6);

    expect(outcomesFor(outcomes, 'claude').map((o) => o.integration)).toEqual([
      'mcp-config',
      'project-skill',
    ]);
    expect(outcomesFor(outcomes, 'cursor').map((o) => o.integration)).toEqual([
      'mcp-config',
      'project-skill',
    ]);
    expect(outcomesFor(outcomes, 'codex').map((o) => o.integration)).toEqual([
      'mcp-config',
      'project-skill',
    ]);

    expect(outcomes.map((o) => o.editorId)).toEqual([
      'claude',
      'claude',
      'cursor',
      'cursor',
      'codex',
      'codex',
    ]);

    expect(existsSync(join(projectDir, '.mcp.json'))).toBe(true);
    expect(existsSync(join(projectDir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
      true,
    );
    expect(existsSync(join(projectDir, '.cursor', 'mcp.json'))).toBe(true);
    expect(existsSync(join(projectDir, '.cursor', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
      true,
    );
    expect(existsSync(join(projectDir, '.codex', 'config.toml'))).toBe(true);
    expect(existsSync(join(projectDir, '.codex', 'skills', 'open-knowledge', 'SKILL.md'))).toBe(
      true,
    );
  });

  test('returns an empty array for an empty editorIds selection', () => {
    expect(applyProjectIntegrations(projectDir, [])).toEqual([]);
  });

  test('one editor failing one integration never aborts the rest of the batch', () => {
    mkdirSync(join(projectDir, '.cursor'), { recursive: true });
    writeFileSync(join(projectDir, '.cursor', 'skills'), 'block');

    const outcomes = applyProjectIntegrations(projectDir, ['claude', 'cursor', 'codex']);

    const cursorSkill = outcomesFor(outcomes, 'cursor').find(
      (o) => o.integration === 'project-skill',
    );
    expect(cursorSkill?.action).toBe('failed');
    expect(cursorSkill?.error).toBeDefined();

    const cursorMcp = outcomesFor(outcomes, 'cursor').find((o) => o.integration === 'mcp-config');
    expect(cursorMcp?.action).toBe('written');

    for (const editorId of ['claude', 'codex'] as const) {
      for (const integrationId of ['mcp-config', 'project-skill'] as const) {
        const found = outcomes.find(
          (o) => o.editorId === editorId && o.integration === integrationId,
        );
        expect(found?.action).toBe('written');
      }
    }
  });

  test('claude-desktop yields skipped-unsupported for both default writers', () => {
    const outcomes = applyProjectIntegrations(projectDir, ['claude-desktop']);

    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.action).toBe('skipped-unsupported');
      expect(outcome.error).toBeUndefined();
    }
  });

  test('respects a custom writers parameter (extension point)', () => {
    const outcomes = applyProjectIntegrations(projectDir, ['claude', 'cursor'], {}, [
      mcpConfigWriter,
    ]);

    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((o) => o.integration)).toEqual(['mcp-config', 'mcp-config']);
    expect(existsSync(join(projectDir, '.claude', 'skills'))).toBe(false);
    expect(existsSync(join(projectDir, '.cursor', 'skills'))).toBe(false);
  });

  test('passes install options through to mcpConfigWriter (dev mode)', () => {
    const outcomes = applyProjectIntegrations(projectDir, ['claude'], { mode: 'dev' });

    const mcpOutcome = outcomes.find((o) => o.integration === 'mcp-config');
    expect(mcpOutcome?.action).toBe('written');
    const written = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf-8'));
    expect(written.mcpServers['open-knowledge'].command).toBe('node');
  });
});
