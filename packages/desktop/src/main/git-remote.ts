/**
 * Read the canonical GitHub remote URL for a project, used to backfill
 * `RecentProject.gitRemoteUrl` on every project open so the share-receive
 * lookup finds previously opened projects by `{owner, repo}`.
 *
 * Why re-emit canonical form: senders may have cloned via SSH
 * (`git@github.com:owner/repo.git`) while receivers via HTTPS — both must
 * normalize to one URL for the string compare to hit.
 */

import { parseGitUrl } from '@inkeep/open-knowledge';
import { inspectGitRepository } from '@inkeep/open-knowledge-core/git-repository';

/**
 * Best-effort: returns the canonical GitHub remote URL for the project
 * at `projectPath`, or `null` if the project has no `.git/config`, no
 * `[remote "origin"]`, or a non-github.com origin. Never throws — any
 * I/O or parse error returns `null` so callers can fall through silently
 * (the field stays undefined, the user pays a one-time cost on first
 * share-receive for this project).
 */
export function readCanonicalGitHubRemoteUrl(projectPath: string): string | null {
  const inspection = inspectGitRepository(projectPath);
  if (inspection.kind !== 'repository') return null;

  const origin = inspection.repository.readRemoteUrl('origin');
  if (origin.kind !== 'configured') return null;

  const parsed = parseGitUrl(origin.url);
  if (parsed === null) return null;
  if (parsed.hostname !== 'github.com') return null;
  return `https://github.com/${parsed.owner}/${parsed.name}.git`;
}
