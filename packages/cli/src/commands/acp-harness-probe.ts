import {
  EDITOR_TARGETS,
  type EditorId,
  entryRunsOwnManagedServer,
  openCodeEntryRunsOwnManagedServer,
} from './editors.ts';
import { readExistingMcpEntry } from './init.ts';

export interface OwnManagedMcpEntryHit {
  editorId: EditorId;
  scope: 'project' | 'user';
  configPath: string;
}

function ownServerMatcherFor(editorId: EditorId): (entry: unknown) => boolean {
  if (editorId === 'opencode') return openCodeEntryRunsOwnManagedServer;
  return entryRunsOwnManagedServer;
}

export function probeOwnManagedEditorMcpEntry(
  editorId: EditorId,
  cwd: string,
  home?: string,
): OwnManagedMcpEntryHit | null {
  const target = EDITOR_TARGETS[editorId];
  const runsOwnServer = ownServerMatcherFor(editorId);
  const surfaces: Array<{ scope: 'project' | 'user'; configPath: string }> = [];
  const projectPath = target.projectConfigPath?.(cwd);
  if (projectPath !== undefined) surfaces.push({ scope: 'project', configPath: projectPath });
  try {
    surfaces.push({ scope: 'user', configPath: target.configPath(cwd, home) });
  } catch {}
  for (const surface of surfaces) {
    const entry = readExistingMcpEntry(target, cwd, home, surface.configPath);
    if (entry !== null && runsOwnServer(entry)) {
      return { editorId, scope: surface.scope, configPath: surface.configPath };
    }
  }
  return null;
}
