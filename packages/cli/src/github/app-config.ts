import { DEFAULT_GITHUB_OAUTH_CLIENT_ID } from '@inkeep/open-knowledge-core';

/**
 * Resolve the OAuth App client ID. Precedence:
 *   1. `OPEN_KNOWLEDGE_GITHUB_CLIENT_ID` environment variable
 *   2. `DEFAULT_GITHUB_OAUTH_CLIENT_ID` built-in constant
 */
export function getOAuthClientId(): string {
  return process.env.OPEN_KNOWLEDGE_GITHUB_CLIENT_ID ?? DEFAULT_GITHUB_OAUTH_CLIENT_ID;
}
