import { parseSkillsShSearch } from '../search.ts';
import { parseSkillsShCatalogSource } from '../source-fields.ts';
import { parseSkillsShSource, parseSource, SkillFetchError, type SourceSpec } from './fetch.ts';

interface FetchResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<FetchResponseLike>;

export interface ResolvedSkillsShImportSource {
  source: string;
  skill: string;
  publisher?: string;
  spec: SourceSpec;
}

export interface SkillsShWebsiteSource {
  readonly hostname: string;
  readonly skill?: string;
}

function normalizeSkillLookup(s: string): string {
  return s.trim().toLowerCase();
}

function skillSearchIdSlug(id: string): string {
  return id.split('/').filter(Boolean).pop() ?? id;
}

/** Recognize a website catalog source or its canonical skills.sh page URL. */
export function parseSkillsShWebsiteSource(rawSource: string): SkillsShWebsiteSource | null {
  const directSource = parseSkillsShCatalogSource(rawSource.trim());
  if (directSource?.kind === 'site') return { hostname: directSource.hostname };

  const ref = parseSkillsShSource(rawSource);
  if (!ref) return null;
  const pageSource = parseSkillsShCatalogSource(ref.owner);
  return pageSource?.kind === 'site' ? { hostname: pageSource.hostname, skill: ref.skill } : null;
}

/**
 * Resolve a skills.sh page or website catalog source to the typed source that
 * acquisition can fetch. Returns `null` for ordinary git/local sources.
 */
export async function resolveSkillsShImportSource(
  rawSource: string,
  requestedSkill?: string,
  opts: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  } = {},
): Promise<ResolvedSkillsShImportSource | null> {
  const websiteSource = parseSkillsShWebsiteSource(rawSource);
  if (websiteSource) {
    const skill = requestedSkill ?? websiteSource.skill;
    if (!skill) {
      throw new SkillFetchError('Website skill sources require a skill name.');
    }
    return {
      source: websiteSource.hostname,
      skill,
      publisher: websiteSource.hostname,
      spec: {
        kind: 'well-known',
        origin: `https://${websiteSource.hostname}`,
        skill,
      },
    };
  }

  const ref = parseSkillsShSource(rawSource);
  if (!ref) return null;

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new SkillFetchError('No fetch implementation available.');

  const query = requestedSkill ?? ref.skill;
  const wantedSkill = normalizeSkillLookup(query);
  const wantedOwner = normalizeSkillLookup(ref.owner);
  let payload: unknown;
  try {
    const r = await fetchImpl(
      `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=30`,
      { signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) },
    );
    if (!r.ok) throw new SkillFetchError(`skills.sh lookup failed with HTTP ${r.status}`);
    payload = await r.json();
  } catch (e) {
    if (e instanceof SkillFetchError) throw e;
    // A network failure, the AbortSignal.timeout firing, or a malformed JSON body
    // reject with a non-SkillFetchError; wrap them so the import/reimport routes
    // return a 400 "Could not fetch source" instead of an opaque 500.
    throw new SkillFetchError(
      `skills.sh lookup failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const results = parseSkillsShSearch(payload);
  const match = results.find((result) => {
    const owner = result.publisher ? normalizeSkillLookup(result.publisher) : '';
    if (owner !== wantedOwner) return false;
    const resultName = normalizeSkillLookup(result.name);
    const resultSlug = normalizeSkillLookup(skillSearchIdSlug(result.id));
    return resultName === wantedSkill || resultSlug === wantedSkill;
  });
  if (!match) {
    throw new SkillFetchError(`No skills.sh result matched ${ref.owner}/${ref.skill}`);
  }
  // `match.source` is untrusted external data. It may yield a repository or a
  // strictly validated website hostname, but never a local-path shape (`/etc`,
  // `~/.ssh`) that could turn a compromised response into a host filesystem read.
  const catalogSource = parseSkillsShCatalogSource(match.source);
  const spec =
    catalogSource?.kind === 'site'
      ? ({
          kind: 'well-known',
          origin: `https://${catalogSource.hostname}`,
          skill: requestedSkill ?? match.name,
        } satisfies SourceSpec)
      : parseSource(match.source);
  if (!spec || spec.kind === 'local') {
    throw new SkillFetchError(
      `skills.sh returned an unsafe source for ${ref.owner}/${ref.skill}: ${match.source}`,
    );
  }
  return {
    source: match.source,
    skill: requestedSkill ?? match.name,
    ...(match.publisher ? { publisher: match.publisher } : {}),
    spec,
  };
}
