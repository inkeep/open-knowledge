import type { Fetched, SourceSpec } from '@inkeep/open-knowledge-core/skills-catalog';
import { fetchSource } from '@inkeep/open-knowledge-core/skills-catalog';

/**
 * A shallow clone of a repo is the expensive step behind every skill preview and
 * discover, and one repo holds many skills: previewing N siblings from one source
 * used to clone it N times (and a hover-then-open on the same source cloned it
 * twice more). This caches the fetched clone by resolved source so siblings, and
 * a discover followed by a preview, reuse ONE clone.
 *
 * The window is short on purpose: the remote HEAD can move, so a stale entry is
 * a momentary wrong figure, not a lasting one. Local sources read in place with
 * nothing to amortize, so they bypass the cache entirely.
 */
const TTL_MS = 30_000;

interface Entry {
  readonly fetched: Promise<Fetched>;
  readonly expiresAt: number;
}

const cache = new Map<string, Entry>();

/**
 * Key the clone by the RESOLVED source, not by skill name: two skills in one
 * repo resolve to the same spec and must share the clone. Distinct repos, refs,
 * or website bundles produce distinct keys so they never serve each other's
 * bytes. A website bundle materializes one skill at a time, so its key carries
 * the skill. The separator is a newline, which no URL or path field can contain,
 * so fields can never realign into a collision.
 */
function sourceKey(spec: SourceSpec): string {
  if (spec.kind === 'git') return `git\n${spec.url}\n${spec.subpath ?? ''}`;
  if (spec.kind === 'well-known') return `wk\n${spec.origin}\n${spec.skill}`;
  return `local\n${spec.path}`;
}

function sweepExpired(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt > now) continue;
    cache.delete(key);
    // Remove the temp clone once its fetch settles. A rejected fetch left no
    // directory behind, and a removal that races another cleanup is harmless,
    // so swallow either way.
    void entry.fetched.then((f) => f.cleanup()).catch(() => {});
  }
}

/**
 * `fetchSource` behind a short-lived, source-keyed clone cache. Every caller gets
 * a view whose `cleanup` is a no-op: the cache owns the real temp-dir removal on
 * expiry, so one caller finishing can't delete a clone another is still reading.
 *
 * The PROMISE is cached (not just the settled value) so concurrent siblings
 * dedupe the in-flight clone rather than each starting their own. A rejected
 * fetch evicts itself so a transient failure doesn't pin the source as broken for
 * the whole window.
 */
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
    // Only evict our own entry: a slow reject must not delete a fresh clone a
    // later call already put under the same key.
    const self = entry;
    fetched.catch(() => {
      if (cache.get(key) === self) cache.delete(key);
    });
  }
  const fetched = await entry.fetched;
  return { dir: fetched.dir, ref: fetched.ref, cleanup: () => {} };
}

/**
 * Evict every cached clone and remove its temp dir. Tests call this between cases
 * so a cached clone never leaks or bleeds into the next case.
 */
export async function clearSourceCache(): Promise<void> {
  const entries = [...cache.values()];
  cache.clear();
  await Promise.all(entries.map((e) => e.fetched.then((f) => f.cleanup()).catch(() => {})));
}
