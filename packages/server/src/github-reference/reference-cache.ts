import type { GitHubReferenceOutcome } from './fetch-reference.ts';

const LIVE_TTL_MS = 60_000;

const SETTLED_TTL_MS = 30 * 60_000;

const NOT_FOUND_TTL_MS = 5 * 60_000;

const UNAVAILABLE_TTL_MS = 60_000;

const MAX_ENTRIES = 256;

function ttlFor(outcome: GitHubReferenceOutcome): number {
  if (!outcome.ok) return outcome.reason === 'not-found' ? NOT_FOUND_TTL_MS : UNAVAILABLE_TTL_MS;
  const lifecycle = outcome.preview.lifecycle;
  return lifecycle === 'open' || lifecycle === 'draft' ? LIVE_TTL_MS : SETTLED_TTL_MS;
}

export class GitHubReferenceCache {
  private readonly entries = new Map<
    string,
    { readonly outcome: GitHubReferenceOutcome; readonly expiresAt: number }
  >();
  private readonly inflight = new Map<string, Promise<GitHubReferenceOutcome>>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  load(
    key: string,
    compute: () => Promise<GitHubReferenceOutcome>,
  ): Promise<GitHubReferenceOutcome> {
    const hit = this.entries.get(key);
    if (hit !== undefined && hit.expiresAt > this.now()) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return Promise.resolve(hit.outcome);
    }
    const pending = this.inflight.get(key);
    if (pending !== undefined) return pending;
    const promise = compute()
      .then((outcome) => {
        this.store(key, outcome);
        return outcome;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  private store(key: string, outcome: GitHubReferenceOutcome): void {
    this.entries.delete(key);
    this.entries.set(key, { outcome, expiresAt: this.now() + ttlFor(outcome) });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
