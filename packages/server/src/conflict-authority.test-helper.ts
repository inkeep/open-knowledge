import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      unlinkProjectFile: () => {},
      applyResolvedContent: async () => {},
    },
  });
}

export function createTestConflictAuthorityInTmpDir(prefix: string): ConflictAuthority {
  return createTestConflictAuthority(mkdtempSync(join(tmpdir(), prefix)));
}
