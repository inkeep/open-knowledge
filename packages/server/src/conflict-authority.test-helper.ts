import { ConflictAuthority } from './conflict-authority.ts';

export const RECONCILE_TEST_CONFLICTS: Pick<
  ConflictAuthority,
  'dissolveReconcile' | 'fileOf' | 'raise'
> = {
  dissolveReconcile: () => {},
  raise: () => {},
  fileOf: (docName: string) => `${docName}.md`,
};

export function createTestConflictAuthority(
  projectDir: string,
  contentDir: string = projectDir,
): ConflictAuthority {
  return new ConflictAuthority({
    projectDir,
    contentDir,
    io: {
      gitRaw: async () => '',
      writeProjectFileUntracked: () => {},
      unlinkProjectFileUndeclared: () => {},
      deleteResolvedContent: () => {},
      applyResolvedContent: async () => {},
    },
  });
}
