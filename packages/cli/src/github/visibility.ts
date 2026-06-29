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
