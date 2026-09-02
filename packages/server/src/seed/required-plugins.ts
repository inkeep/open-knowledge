import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LintPluginId } from '@inkeep/open-knowledge-core';
import { parseDocument } from 'yaml';
import { tracedWriteFileSync } from '../fs-traced.ts';
import { CONFIG_FILENAME } from '../init-project.ts';

function configPath(projectDir: string): string {
  return join(projectDir, '.ok', CONFIG_FILENAME);
}

export function isPluginEnabled(projectDir: string, id: LintPluginId): boolean {
  let raw: string;
  try {
    raw = readFileSync(configPath(projectDir), 'utf8');
  } catch {
    return false;
  }
  try {
    const parsed = parseDocument(raw).toJSON() as
      | { contentRules?: Record<string, { enabled?: unknown }> }
      | null
      | undefined;
    return parsed?.contentRules?.[id]?.enabled === true;
  } catch {
    return false;
  }
}

export function enableRequiredPlugins(
  projectDir: string,
  ids: readonly LintPluginId[],
): LintPluginId[] {
  const pending = ids.filter((id) => !isPluginEnabled(projectDir, id));
  if (pending.length === 0) return [];

  const path = configPath(projectDir);
  const doc = parseDocument(readFileSync(path, 'utf8'));
  for (const id of pending) {
    doc.setIn(['contentRules', id, 'enabled'], true);
  }
  tracedWriteFileSync(path, doc.toString(), 'utf8');
  return pending;
}
