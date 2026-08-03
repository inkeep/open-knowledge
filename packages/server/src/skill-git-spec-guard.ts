import type { ServerResponse } from 'node:http';
import type { SourceSpec } from '@inkeep/open-knowledge-core/skills-catalog';
import { errorResponse } from './http/error-response.ts';
import { isAllowedGitUrl } from './local-op-security.ts';

/**
 * Defense-in-depth git-transport gate for the skill-acquisition routes
 * (preview / discover / import / reimport). Sends a 400 and returns true when
 * `spec` is a git source whose URL is not an allowlisted transport. `parseSource`
 * already rejects non-allowlisted transports (its ALLOWED_GIT_TRANSPORTS mirrors
 * `isAllowedGitUrl`), so in practice this never fires — it is a drift tripwire at
 * the trust boundary before `git clone`, re-closing the ext::/fd:: RCE class if
 * the two allowlists ever diverge.
 */
export function rejectDisallowedGitSpec(
  res: ServerResponse,
  spec: SourceSpec,
  handler: string,
): boolean {
  if (spec.kind === 'git' && !isAllowedGitUrl(spec.url)) {
    errorResponse(res, 400, 'urn:ok:error:url-not-allowed', 'Git URL protocol is not allowed.', {
      handler,
      cause: new Error(`url=${spec.url}`),
    });
    return true;
  }
  return false;
}
