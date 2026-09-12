import {
  classifyExistingMcpEntry,
  EDITOR_TARGETS,
  isEntryUpToDate,
  isOwnManagedEntry,
} from '@inkeep/open-knowledge';

import type { McpEntryKind } from './claude-readiness.ts';

export interface ClaudeMcpScopes {
  readonly projectWired: boolean;
  readonly projectOwn: boolean;
  readonly projectEntryPresent: boolean;
  readonly globalOwn: boolean;
  readonly globalKind: McpEntryKind;
}

const NO_PROJECT_SCOPE = {
  projectWired: false,
  projectOwn: false,
  projectEntryPresent: false,
} as const;

export function classifyClaudeMcpScopes(
  projectRoot: string | undefined,
  home: string,
): ClaudeMcpScopes {
  const target = EDITOR_TARGETS.claude;
  const global = classifyExistingMcpEntry(target, '', home);
  const globalOwn = global.kind === 'present' && isOwnManagedEntry(global.entry);
  const globalScope = { globalOwn, globalKind: global.kind };

  const projectPath =
    projectRoot === undefined ? undefined : target.projectConfigPath?.(projectRoot);
  if (projectRoot === undefined || projectPath === undefined) {
    return { ...NO_PROJECT_SCOPE, ...globalScope };
  }

  const project = classifyExistingMcpEntry(target, projectRoot, undefined, projectPath);
  return {
    projectWired:
      project.kind === 'present' &&
      (isEntryUpToDate(project.entry) || isOwnManagedEntry(project.entry)),
    projectOwn: project.kind === 'present' && isOwnManagedEntry(project.entry),
    projectEntryPresent: project.kind === 'present' || project.kind === 'decline',
    ...globalScope,
  };
}
