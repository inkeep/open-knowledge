import type { ServerResponse } from 'node:http';
import type { SourceSpec } from '@inkeep/open-knowledge-core/skills-catalog';
import { errorResponse } from './http/error-response.ts';
import { isAllowedGitUrl } from './local-op-security.ts';

export function isDisallowedGitSpec(spec: SourceSpec): boolean {
  return spec.kind === 'git' && !isAllowedGitUrl(spec.url);
}

export function rejectDisallowedGitSpec(
  res: ServerResponse,
  spec: SourceSpec,
  handler: string,
): boolean {
  if (spec.kind === 'git' && isDisallowedGitSpec(spec)) {
    errorResponse(res, 400, 'urn:ok:error:url-not-allowed', 'Git URL protocol is not allowed.', {
      handler,
      cause: new Error(`url=${spec.url}`),
    });
    return true;
  }
  return false;
}
