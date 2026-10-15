import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

declare module 'vitest' {
  interface TaskMeta {
    authorityRegistryDirectories?: string[];
  }
}

afterEach(({ task }) => {
  const temp = tmpdir();
  task.meta.authorityRegistryDirectories = readdirSync(temp)
    .filter((entry) => entry.startsWith('ok-test-authority-'))
    .map((entry) => join(temp, entry));
});
