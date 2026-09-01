import { parseGitUrl } from '@inkeep/open-knowledge';
import { classifyGitHubShareHost } from '@inkeep/open-knowledge-core';
import { inspectGitRepository } from '@inkeep/open-knowledge-core/git-repository';

export function readCanonicalGitHubRemoteUrl(projectPath: string): string | null {
  const inspection = inspectGitRepository(projectPath);
  if (inspection.kind !== 'repository') return null;

  const origin = inspection.repository.readRemoteUrl('origin');
  if (origin.kind !== 'configured') return null;

  return canonicalizeGitHubRemoteUrl(origin.url);
}

export function canonicalizeGitHubRemoteUrl(url: string): string | null {
  const parsed = parseGitUrl(url);
  if (parsed === null) return null;
  const foldedHost = classifyGitHubShareHost(parsed.hostname);
  if (foldedHost === null) return null;
  return `https://${foldedHost}/${parsed.owner}/${parsed.name}.git`;
}
