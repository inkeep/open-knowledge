import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = join(tmpdir(), `ok-test-authority-${randomUUID()}`);
export const testAuthorityRegistryPath = join(directory, 'authority.sqlite');

const releaseTestAuthorityRegistry = (): void => {
  rmSync(directory, { recursive: true, force: true });
  process.off('exit', releaseTestAuthorityRegistry);
};

export { releaseTestAuthorityRegistry };

process.once('exit', releaseTestAuthorityRegistry);
