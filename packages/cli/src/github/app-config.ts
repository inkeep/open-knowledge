import { DEFAULT_GITHUB_OAUTH_CLIENT_ID } from '@inkeep/open-knowledge-core';

export function getOAuthClientId(): string {
  return process.env.OPEN_KNOWLEDGE_GITHUB_CLIENT_ID ?? DEFAULT_GITHUB_OAUTH_CLIENT_ID;
}
