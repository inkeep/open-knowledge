import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertProjectPathSafe,
  EDITOR_TARGETS,
  ProjectPathSafetyError,
  writeProjectAiIntegrations,
} from '@inkeep/open-knowledge';
import {
  AGENTS_SKILLS_ROOT,
  ALL_EDITOR_IDS,
  type EditorId,
  RESERVED_PROJECT_SKILL_NAME,
} from '@inkeep/open-knowledge-core';
import { initContent } from '@inkeep/open-knowledge-server';
import { parse as parseYaml } from 'yaml';
import { getLogger } from './desktop-logger.ts';

const OK_MCP_MARKER_PREFIX = '# ok-mcp-';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function readRootContentDir(mainRoot: string): string | undefined {
  const configPath = `${mainRoot}/.ok/config.yml`;
  if (!existsSync(configPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(configPath, 'utf-8'));
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;
  const content = parsed.content;
  if (!isObject(content)) return undefined;
  const dir = content.dir;
  if (typeof dir !== 'string') return undefined;
  const trimmed = dir.trim();
  return trimmed.length > 0 && trimmed !== '.' ? dir : undefined;
}

function editorWiredForOk(configPath: string | undefined): boolean {
  if (!configPath) return false;
  try {
    if (!existsSync(configPath)) return false;
    const bytes = readFileSync(configPath, 'utf-8');
    return bytes.includes(OK_MCP_MARKER_PREFIX);
  } catch {
    return false;
  }
}

export function detectRootWiredEditors(mainRoot: string): EditorId[] {
  const wired: EditorId[] = [];
  for (const id of ALL_EDITOR_IDS) {
    const projectConfigPath = EDITOR_TARGETS[id]?.projectConfigPath?.(mainRoot);
    if (editorWiredForOk(projectConfigPath)) wired.push(id);
  }
  return wired;
}

export function seedWorktreeProjectSetup(
  worktreeProjectPath: string,
  sourceProjectPath: string,
): void {
  const logger = getLogger('worktree-setup');
  const editors = assertWorktreeProjectSetupSafe(worktreeProjectPath, sourceProjectPath);

  try {
    initContent(worktreeProjectPath, { contentDir: readRootContentDir(sourceProjectPath) });
  } catch (err) {
    logger.warn({ worktreeProjectPath, err }, 'failed to seed inherited .ok/ scaffold');
  }

  try {
    if (editors.length > 0) {
      const result = writeProjectAiIntegrations(worktreeProjectPath, editors);
      const failed = result.integrations.filter((o) => o.action === 'failed');
      if (failed.length > 0) {
        logger.warn(
          {
            worktreeProjectPath,
            editors,
            failed: failed.map((o) => `${o.editorId}:${o.integration}`),
          },
          'some inherited editor integrations failed to seed',
        );
      }
    }
  } catch (err) {
    logger.warn({ worktreeProjectPath, err }, 'failed to seed inherited editor integrations');
  }
}

export function assertWorktreeProjectSetupSafe(
  worktreeProjectPath: string,
  sourceProjectPath: string,
): EditorId[] {
  const editors = detectRootWiredEditors(sourceProjectPath);
  const writeTargets = [
    join(worktreeProjectPath, '.ok', 'config.yml'),
    join(worktreeProjectPath, '.ok', 'local', 'config.yml'),
    join(worktreeProjectPath, '.okignore'),
  ];
  if (editors.length > 0) {
    writeTargets.push(
      join(worktreeProjectPath, AGENTS_SKILLS_ROOT, RESERVED_PROJECT_SKILL_NAME, 'SKILL.md'),
    );
  }
  for (const editor of editors) {
    const target = EDITOR_TARGETS[editor];
    const configPath = target.projectConfigPath?.(worktreeProjectPath);
    const skillPath = target.projectSkillPath?.(worktreeProjectPath);
    if (configPath !== undefined) writeTargets.push(configPath);
    if (skillPath !== undefined) writeTargets.push(skillPath);
  }
  for (const target of writeTargets) {
    try {
      assertProjectPathSafe(target, worktreeProjectPath);
    } catch (error) {
      if (error instanceof ProjectPathSafetyError) {
        throw new WorktreeSetupPathSafetyError(error);
      }
      throw error;
    }
  }
  return editors;
}

export class WorktreeSetupPathSafetyError extends Error {
  override readonly name = 'WorktreeSetupPathSafetyError';
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super('A project setup path resolves outside the worktree');
    this.cause = cause;
  }
}
