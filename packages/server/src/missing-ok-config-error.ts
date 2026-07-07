/**
 * `MissingOkConfigError` — thrown by `bootServer`'s pre-listen check when
 * `<projectDir>/.ok/config.yml` cannot be located. Covers two on-disk shapes:
 *
 *   - `'okdir'`: `<projectDir>/.ok/` is absent entirely.
 *   - `'config'`: `<projectDir>/.ok/` exists but `config.yml` is missing.
 *
 * The discriminator lets log consumers branch without parsing the message
 * string. Both states surface the same canonical user-facing message because
 * the recovery is identical: run `ok init`.
 *
 * Note: prior to the projectDir fix this carried `contentDir`. The field was
 * renamed because config lives at `<projectDir>/.ok/`, not `<contentDir>/.ok/`,
 * and a misnamed field led downstream consumers to reach for the wrong path
 * when surfacing the error.
 */

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
