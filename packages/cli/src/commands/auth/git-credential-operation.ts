import type { Readable } from 'node:stream';

export const GIT_CREDENTIAL_OPERATIONS = ['get', 'store', 'erase'] as const;

export type GitCredentialOperation = (typeof GIT_CREDENTIAL_OPERATIONS)[number];

function isGitCredentialOperation(value: string | undefined): value is GitCredentialOperation {
  return GIT_CREDENTIAL_OPERATIONS.some((operation) => operation === value);
}

export function gitCredentialHelperOperation(
  args: readonly string[],
): GitCredentialOperation | null {
  if (args.length !== 3 || args[0] !== 'auth' || args[1] !== 'git-credential') return null;
  const operation = args[2];
  return isGitCredentialOperation(operation) ? operation : null;
}

export function handleCredentialUpdate(
  operation: Exclude<GitCredentialOperation, 'get'>,
  input: Readable,
): Promise<number> {
  switch (operation) {
    case 'store':
    case 'erase':
      return drainInput(input);
  }
}

function drainInput(input: Readable): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  input.once('end', () => resolve(0));
  input.once('error', () => resolve(0));
  input.resume();
  return promise;
}
