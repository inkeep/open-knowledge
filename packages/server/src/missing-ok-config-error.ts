export type MissingOkConfigKind = 'okdir' | 'config';

export const MISSING_OK_CONFIG_MESSAGE =
  'OpenKnowledge config not found at .ok/config.yml. Run ok init to scaffold OK in this directory.';

export class MissingOkConfigError extends Error {
  readonly kind: MissingOkConfigKind;
  readonly projectDir: string;
  constructor(kind: MissingOkConfigKind, projectDir: string, options?: { cause?: unknown }) {
    super(MISSING_OK_CONFIG_MESSAGE, options);
    this.name = 'MissingOkConfigError';
    this.kind = kind;
    this.projectDir = projectDir;
  }
}
