import type { SemanticIndexStatus } from '@inkeep/open-knowledge-core/schemas/api';

type EmbeddingsSecretStoreErrorCode = NonNullable<SemanticIndexStatus['keyStoreError']>;

export type EmbeddingsSecretStorePhase =
  | 'load'
  | 'initialize'
  | 'native_get'
  | 'native_set'
  | 'native_clear'
  | 'verify'
  | 'index_read'
  | 'index_write'
  | 'file_read'
  | 'file_write'
  | 'lock'
  | 'timeout'
  | 'operation';

export interface EmbeddingsSecretStoreDiagnostic {
  readonly phase: EmbeddingsSecretStorePhase;
  readonly name: string;
  readonly code: string;
}

const SAFE_NAMES = new Set(['Error', 'TypeError', 'SyntaxError', 'YAMLParseError', 'AbortError']);
const SAFE_CODES = new Set([
  'GenericFailure',
  'ERR_MODULE_NOT_FOUND',
  'ERR_DLOPEN_FAILED',
  'ERR_SQLITE_ERROR',
  'EACCES',
  'EPERM',
  'ENOENT',
  'EIO',
  'EBUSY',
]);

function diagnostic(
  phase: EmbeddingsSecretStorePhase,
  error: unknown,
): EmbeddingsSecretStoreDiagnostic {
  let name: unknown;
  let code: unknown;
  try {
    if (typeof error === 'object' && error !== null) {
      name = Reflect.get(error, 'name');
      code = Reflect.get(error, 'code');
    }
  } catch {}
  return Object.freeze({
    phase,
    name: typeof name === 'string' && SAFE_NAMES.has(name) ? name : 'unknown',
    code: typeof code === 'string' && SAFE_CODES.has(code) ? code : 'unknown',
  });
}

export class EmbeddingsSecretStoreError extends Error {
  readonly code: EmbeddingsSecretStoreErrorCode;
  declare readonly cause?: EmbeddingsSecretStoreDiagnostic;
  constructor(
    code: EmbeddingsSecretStoreErrorCode,
    phase?: EmbeddingsSecretStorePhase,
    error?: unknown,
  ) {
    const messages: Record<EmbeddingsSecretStoreErrorCode, string> = {
      index_invalid:
        'Embeddings credential inventory is missing or invalid. Restore its backup first. If that is impossible, preserve any needed keys, remove this channel’s native embedding entries, then delete secrets.yml.embeddings-index and secrets.yml.embeddings-index.required from its home folder. Removing native entries deletes this channel’s saved embedding keys.',
      migration_conflict:
        'Saved embeddings keys conflict. Set a project-specific key to override the conflict without changing other projects.',
      native_access:
        'Embeddings credential store is unavailable or inaccessible. Unlock the OS credential store and try again.',
      lock_timeout:
        'Embeddings credential store is busy. Wait for the other operation to finish and try again.',
      file_access:
        'Embeddings credential files could not be read or written. Check their contents and permissions, then try again.',
      timeout:
        'Embeddings credential store timed out. Wait for any system prompt or other operation to finish and try again.',
    };
    super(
      code === 'native_access' && phase === 'load'
        ? 'The OS credential-store backend could not load. Reinstall OpenKnowledge and try again.'
        : messages[code],
      phase === undefined ? undefined : { cause: diagnostic(phase, error) },
    );
    this.name = 'EmbeddingsSecretStoreError';
    this.code = code;
    Object.defineProperty(this, 'code', { writable: false, configurable: false });
    Object.defineProperty(this, 'cause', {
      value: this.cause,
      writable: false,
      configurable: false,
    });
  }
}
