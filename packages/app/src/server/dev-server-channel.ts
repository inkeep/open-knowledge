import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultToDevChannel, isDevChannel } from '@inkeep/open-knowledge-core/constants/product';

export function applyDevServerChannel(env: Record<string, string | undefined>): void {
  if (env.OK_TEST_CONTENT_DIR) return;
  defaultToDevChannel(env);
}

export function workspaceCliEntry(projectRoot: string): string {
  return join(projectRoot, 'packages', 'cli', 'dist', 'cli.mjs');
}

export function devServerCliArgs(
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>>,
  deps: { nodePath?: string; entryExists?: (path: string) => boolean } = {},
): string[] | undefined {
  if (!isDevChannel(env)) return undefined;
  const entry = workspaceCliEntry(projectRoot);
  if (!(deps.entryExists ?? existsSync)(entry)) return undefined;
  return [deps.nodePath ?? process.execPath, entry];
}
