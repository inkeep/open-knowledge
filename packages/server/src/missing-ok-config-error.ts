import { currentCliCommandName } from '@inkeep/open-knowledge-core';

export type MissingOkConfigKind = 'okdir' | 'config';

export function missingOkConfigMessage(): string {
  return `OpenKnowledge config not found at .ok/config.yml. Run ${currentCliCommandName()} init to scaffold OK in this directory.`;
}

export class MissingOkConfigError extends Error {
  readonly kind: MissingOkConfigKind;
  readonly projectDir: string;
  constructor(kind: MissingOkConfigKind, projectDir: string, options?: { cause?: unknown }) {
    super(missingOkConfigMessage(), options);
    this.name = 'MissingOkConfigError';
    this.kind = kind;
    this.projectDir = projectDir;
  }
}
