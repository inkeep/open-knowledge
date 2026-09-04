import { existsSync, readFileSync } from 'node:fs';
import { EDITOR_TARGETS, writeProjectAiIntegrations } from '@inkeep/open-knowledge';
import { ALL_EDITOR_IDS, type EditorId } from '@inkeep/open-knowledge-core';
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

export function seedWorktreeProjectSetup(worktreePath: string, mainRoot: string): void {
  const logger = getLogger('worktree-setup');

  try {
    initContent(worktreePath, { contentDir: readRootContentDir(mainRoot) });
  } catch (err) {
    logger.warn({ worktreePath, err }, 'failed to seed inherited .ok/ scaffold');
  }

  try {
    const editors = detectRootWiredEditors(mainRoot);
    if (editors.length > 0) {
      const result = writeProjectAiIntegrations(worktreePath, editors);
      const failed = result.integrations.filter((o) => o.action === 'failed');
      if (failed.length > 0) {
        logger.warn(
          { worktreePath, editors, failed: failed.map((o) => `${o.editorId}:${o.integration}`) },
          'some inherited editor integrations failed to seed',
        );
      }
    }
  } catch (err) {
    logger.warn({ worktreePath, err }, 'failed to seed inherited editor integrations');
  }
}
