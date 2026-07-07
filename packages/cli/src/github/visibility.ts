/**
 * Probe whether a github.com repo is anonymously readable, so the share-link
 * clone path can skip injecting the recipient's stored token. Without this
 * probe, a fine-grained PAT or org-restricted token in `~/.ok/auth.yml` causes
 * `https://USER:TOKEN@github.com/...` to 404 ("Repository not found") for any
 * repo outside the token's scope — even when that repo is public.
 *
 * Best-effort: any non-200 response, network failure, or timeout returns
 * `false` and the caller falls back to the authenticated clone path.
 *
 * github.com only. GHES has a different API base and different auth posture
 * (no anonymous read in many enterprise configs); callers MUST gate on
 * hostname before invoking.
 */

const PROBE_TIMEOUT_MS = 5000;

export type FetchFn = typeof fetch;

export async function isGitHubRepoPublic(
  owner: string,
  name: string,
  fetchFn: FetchFn = fetch,
): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const resp = await fetchFn(url, {
      signal: ac.signal,
      headers: {
        'User-Agent': 'open-knowledge-cli',
        Accept: 'application/vnd.github+json',
      },
    });
    return resp.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
