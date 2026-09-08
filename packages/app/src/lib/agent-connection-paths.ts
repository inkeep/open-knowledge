import {
  AGENTS_SKILLS_ROOT,
  EDITOR_PROJECT_CONFIG_PATH,
  EDITOR_PROJECT_SKILL_ROOT,
  EDITOR_USER_SKILL_ROOT,
  parsePathId,
  RESERVED_PROJECT_SKILL_NAME,
} from '@inkeep/open-knowledge-core';

export function connectionPathDisplay(pathId: string | undefined): string | null {
  if (pathId === undefined) return null;
  const location = parsePathId(pathId);
  if (location === null) return null;

  if (location.kind === 'central-skill-store') return `~/${AGENTS_SKILLS_ROOT}/`;

  switch (location.kind) {
    case 'editor-project-config':
      return EDITOR_PROJECT_CONFIG_PATH[location.editor];
    case 'editor-project-skill-root': {
      const root = EDITOR_PROJECT_SKILL_ROOT[location.editor];
      return root === null ? null : `${root}/${RESERVED_PROJECT_SKILL_NAME}/`;
    }
    case 'editor-user-skill-root': {
      const root = EDITOR_USER_SKILL_ROOT[location.editor];
      return root === null ? null : `~/${root}/`;
    }
    case 'editor-user-config':
      return null;
  }
}

export function sharedPathDisplays(pathId: string | undefined, peers: readonly string[]): string[] {
  if (pathId === undefined || peers.length === 0) return [];
  const location = parsePathId(pathId);
  if (location === null || location.kind === 'central-skill-store') return [];
  return peers
    .map((peer) => connectionPathDisplay(`${location.kind}:${peer}`))
    .filter((path): path is string => path !== null);
}
