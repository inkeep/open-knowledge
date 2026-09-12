import type { FmEditError } from '@inkeep/open-knowledge-core';

export function describeFmEditError(error: FmEditError): string {
  switch (error.kind) {
    case 'invalid_value':
      return `${error.kind} (${error.key}: ${error.reason})`;
    case 'reserved_key':
      return `${error.kind} ('${error.key}' is reserved)`;
    case 'unknown_key':
      return `${error.kind} ('${error.key}' is not a recognized key)`;
    case 'duplicate_target':
      return `${error.kind} ('${error.key}' appears more than once)`;
    case 'reorder_mismatch':
      return `${error.kind} (expected: ${error.expected.join(', ')}; got: ${error.got.join(', ')})`;
    case 'region_too_large':
      return `${error.kind} (frontmatter region too large: ${error.bytes} > ${error.limit} bytes)`;
    case 'parse_failed':
      return `${error.kind} (frontmatter region unparseable: ${error.reason})`;
    case 'invalid_path':
      return `${error.kind} (${error.path.map(String).join('.') || '__path__'}: ${error.reason})`;
    default: {
      const _exhaustive: never = error;
      return `unhandled frontmatter edit error (${String(_exhaustive)})`;
    }
  }
}
