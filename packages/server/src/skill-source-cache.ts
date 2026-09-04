import type { Fetched, SourceSpec } from '@inkeep/open-knowledge-core/skills-catalog';
import { fetchSource } from '@inkeep/open-knowledge-core/skills-catalog';

const TTL_MS = 30_000;

interface Entry {
  readonly fetched: Promise<Fetched>;
  readonly expiresAt: number;
}

const cache = new Map<string, Entry>();

function sourceKey(spec: SourceSpec): string {
  if (spec.kind === 'git') return `git\n${spec.url}\n${spec.subpath ?? ''}`;
  if (spec.kind === 'well-known') return `wk\n${spec.origin}\n${spec.skill}`;
  return `local\n${spec.path}`;
}

function sweepExpired(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt > now) continue;
    cache.delete(key);
    void entry.fetched.then((f) => f.cleanup()).catch(() => {});
  }
}

export async function fetchCachedSource(spec: SourceSpec): Promise<Fetched> {
  if (spec.kind === 'local') return fetchSource(spec);
  const now = Date.now();
  sweepExpired(now);
  const key = sourceKey(spec);
  let entry = cache.get(key);
  if (!entry) {
    const fetched = fetchSource(spec);
    entry = { fetched, expiresAt: now + TTL_MS };
    cache.set(key, entry);
    const self = entry;
    fetched.catch(() => {
      if (cache.get(key) === self) cache.delete(key);
    });
  }
  const fetched = await entry.fetched;
  return { dir: fetched.dir, ref: fetched.ref, cleanup: () => {} };
}

export async function clearSourceCache(): Promise<void> {
  const entries = [...cache.values()];
  cache.clear();
  await Promise.all(entries.map((e) => e.fetched.then((f) => f.cleanup()).catch(() => {})));
}
