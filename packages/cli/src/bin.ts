#!/usr/bin/env node

import { excludeWorkingDirectoryFromProgramLookup } from '@inkeep/open-knowledge-core/util/windows-program-lookup';
import { recordCliEntryPath } from './cli-entry-path.ts';
import {
  gitCredentialHelperOperation,
  handleCredentialUpdate,
} from './commands/auth/git-credential-operation.ts';

excludeWorkingDirectoryFromProgramLookup();
recordCliEntryPath(import.meta.url);

const helperOperation = gitCredentialHelperOperation(process.argv.slice(2));
if (helperOperation === 'get') {
  const { runGitCredentialGet } = await import('./commands/auth/git-credential-helper.ts');
  process.exit(await runGitCredentialGet());
}
if (helperOperation !== null) {
  process.exit(await handleCredentialUpdate(helperOperation, process.stdin));
}

await import('zod/compile');
await import('./cli.ts');
