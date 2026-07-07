const REPO_API_URL = 'https://api.github.com/repos/inkeep/open-knowledge';

/**
 * Public star count for the inkeep/open-knowledge repo. Shared by the docs
 * site nav (server-rendered) and the editor app's Resources menu (client
 * fetch). A missing count is benign — callers fall back to a plain "GitHub"
 * link — so every failure path (network error, timeout, non-200, schema drift)
 * collapses to null rather than throwing.
 *
 * `init` is merged over the defaults so each caller controls fetch policy:
 * the docs site passes `{ next: { revalidate: 3600 } }` to cache hourly
 * server-side; the editor app passes `{ signal }` to cancel on unmount.
 */
export async function getGitHubStars(init?: RequestInit): Promise<number | null> {
  const { signal: callerSignal, ...restInit } = init ?? {};
  // Compose the caller's signal (the app's unmount abort) WITH the 5s timeout
  // rather than letting a bare `...init` spread overwrite `signal` and drop the
  // timeout. AbortSignal.any is available in Bun, modern browsers, and Node 20+.
  const signal = callerSignal
    ? AbortSignal.any([AbortSignal.timeout(5_000), callerSignal])
    : AbortSignal.timeout(5_000);
  try {
    const res = await fetch(REPO_API_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        // GitHub's API rejects requests without a User-Agent, and undici
        // (Next's server fetch) does not set one by default. Browsers send
        // their own UA and silently drop this forbidden header, so it's inert
        // there.
        'user-agent': 'openknowledge.ai',
      },
      ...restInit,
      signal,
    });
    if (!res.ok) {
      // Surface rate-limit (429) / forbidden (403) so an absent badge is
      // distinguishable from a hidden incident in logs.
      console.warn(`[github-stars] GitHub API responded ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { stargazers_count?: unknown };
    return typeof json.stargazers_count === 'number' ? json.stargazers_count : null;
  } catch (err) {
    // Network/DNS failures and the timeout AbortError land here; warn for
    // parity with the non-2xx path so neither failure mode is silent.
    console.warn(
      `[github-stars] fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
