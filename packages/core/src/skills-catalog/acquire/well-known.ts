import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  SKILL_IMPORT_MAX_BUNDLE_FILES,
  SKILL_IMPORT_MAX_FILE_BYTES,
  SKILL_IMPORT_MAX_TOTAL_BYTES,
} from '../import-limits.ts';
import { SkillFetchError } from './errors.ts';

const INDEX_CANDIDATES = [
  '/.well-known/agent-skills/index.json',
  '/.well-known/skills/index.json',
] as const;
const MAX_INDEX_BYTES = 1024 * 1024;
/** Concurrent file downloads within ONE website skill bundle. */
const SITE_FILE_CONCURRENCY = 8;

export interface WellKnownSourceSpec {
  readonly kind: 'well-known';
  readonly origin: string;
  readonly skill: string;
}

interface LegacySkillEntry {
  readonly name: string;
  readonly description: string;
  readonly files: readonly string[];
}

/** A website's parsed skill index — its base path plus every declared skill. */
export interface WellKnownIndex {
  readonly basePath: string;
  readonly skills: readonly LegacySkillEntry[];
}

export interface WellKnownFetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /**
   * An index already read for this origin. Fetching N skills from one site
   * otherwise re-reads (and re-probes both candidate paths for) the same index
   * once per skill. Callers that already hold it — a bulk import over one
   * origin — pass it here; everyone else keeps the single-fetch behavior.
   */
  readonly index?: WellKnownIndex;
}

export interface FetchedWellKnownSkill {
  readonly dir: string;
  readonly cleanup: () => void;
}

export interface WellKnownSkillSummary {
  readonly name: string;
  readonly description: string;
}

/** Redirect hops allowed before a website-skill fetch gives up. */
const MAX_REDIRECTS = 5;

/**
 * Fetch, following redirects ourselves so every hop is re-checked.
 *
 * The origin gate only ever saw the FIRST url. `fetch` follows redirects on its
 * own, so an https origin could bounce the request to http, to another host, or
 * to a link-local address, and the gate would never see it — the check passed
 * while the request went somewhere else entirely.
 *
 * Each hop must stay https and on the origin the caller validated. Anything
 * else is refused rather than followed.
 */
async function fetchWithinOrigin(
  fetchImpl: typeof fetch,
  url: string,
  origin: string,
  init: RequestInit,
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchImpl(current, { ...init, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    if (location === null || location === '') {
      throw new SkillFetchError(`Website skill redirect carried no location: ${current}`);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new SkillFetchError(`Website skill redirect target is not a URL: ${location}`);
    }
    if (next.protocol !== 'https:' || next.origin !== origin) {
      throw new SkillFetchError(`Website skill redirect left the origin (${origin}): ${next.href}`);
    }
    current = next.href;
  }
  throw new SkillFetchError(`Website skill fetch exceeded ${MAX_REDIRECTS} redirects: ${url}`);
}

function normalizedOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SkillFetchError(`Invalid website skill origin: ${raw}`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new SkillFetchError(`Website skill origins must be credential-free HTTPS URLs: ${raw}`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new SkillFetchError(
      `Website skill origins cannot include a path, query, or fragment: ${raw}`,
    );
  }
  return url.origin;
}

function validPath(path: string): boolean {
  if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function parseLegacyIndex(value: unknown): LegacySkillEntry[] | null {
  if (!value || typeof value !== 'object') return null;
  const skills = (value as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) return null;

  const parsed: LegacySkillEntry[] = [];
  for (const candidate of skills) {
    if (!candidate || typeof candidate !== 'object') return null;
    const { name, description, files } = candidate as Record<string, unknown>;
    if (
      typeof name !== 'string' ||
      !validPath(name) ||
      name.includes('/') ||
      (description !== undefined && typeof description !== 'string') ||
      !Array.isArray(files) ||
      files.length === 0 ||
      files.length > SKILL_IMPORT_MAX_BUNDLE_FILES + 1 ||
      !files.every((file): file is string => typeof file === 'string' && validPath(file)) ||
      new Set(files).size !== files.length ||
      !files.includes('SKILL.md')
    ) {
      return null;
    }
    parsed.push({ name, description: description ?? '', files });
  }
  return parsed;
}

function childUrl(origin: string, basePath: string, skill: string, file: string): string {
  const path = [skill, ...file.split('/')].map(encodeURIComponent).join('/');
  return new URL(`${basePath}/${path}`, origin).href;
}

async function readIndex(
  origin: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ basePath: string; skills: LegacySkillEntry[] }> {
  const failures: string[] = [];
  for (const indexPath of INDEX_CANDIDATES) {
    const indexUrl = new URL(indexPath, origin).href;
    try {
      const response = await fetchWithinOrigin(fetchImpl, indexUrl, origin, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        failures.push(`${indexPath}: HTTP ${response.status}`);
        continue;
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw) > MAX_INDEX_BYTES) {
        failures.push(`${indexPath}: index exceeds ${MAX_INDEX_BYTES} bytes`);
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        failures.push(`${indexPath}: response is not JSON`);
        continue;
      }
      const skills = parseLegacyIndex(value);
      if (!skills) {
        failures.push(`${indexPath}: unsupported or malformed index`);
        continue;
      }
      return { basePath: indexPath.slice(0, -'/index.json'.length), skills };
    } catch (error) {
      failures.push(`${indexPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new SkillFetchError(`No usable website skill index at ${origin} (${failures.join('; ')})`);
}

/** Read website skill metadata without downloading any bundle files. */
export async function discoverWellKnownSkills(
  rawOrigin: string,
  opts: WellKnownFetchOptions = {},
): Promise<WellKnownSkillSummary[]> {
  const { skills } = opts.index ?? (await readWellKnownIndex(rawOrigin, opts));
  return skills.map(({ name, description }) => ({ name, description }));
}

/**
 * Read a website's skill index once, for a caller about to fetch SEVERAL skills
 * from that origin — pass the result back as `opts.index` so each fetch skips
 * its own index round trip.
 */
export async function readWellKnownIndex(
  rawOrigin: string,
  opts: WellKnownFetchOptions = {},
): Promise<WellKnownIndex> {
  const origin = normalizedOrigin(rawOrigin);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new SkillFetchError('No fetch implementation available.');
  return readIndex(origin, fetchImpl, opts.timeoutMs ?? 15_000);
}

/**
 * Fetch one legacy well-known skill bundle and materialize every declared file
 * into a temporary skill directory consumed by the normal acquisition parser.
 */
export async function fetchWellKnownSkill(
  spec: WellKnownSourceSpec,
  opts: WellKnownFetchOptions = {},
): Promise<FetchedWellKnownSkill> {
  if (!validPath(spec.skill) || spec.skill.includes('/')) {
    throw new SkillFetchError(`Invalid website skill name: ${spec.skill}`);
  }
  const origin = normalizedOrigin(spec.origin);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new SkillFetchError('No fetch implementation available.');
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const { basePath, skills } = opts.index ?? (await readIndex(origin, fetchImpl, timeoutMs));
  const entry = skills.find((candidate) => candidate.name === spec.skill);
  if (!entry) {
    throw new SkillFetchError(`Website skill index does not contain ${spec.skill}`);
  }

  const tmp = mkdtempSync(join(tmpdir(), 'ok-skill-site-'));
  const skillDir = join(tmp, entry.name);
  let totalBytes = 0;
  try {
    // Files download CONCURRENTLY. A skill's bundle is routinely 20+ small
    // reference files, and one-at-a-time made a single skill a 20-round-trip
    // wait — the whole visible cost of installing from a website source. Bounded
    // so a large bundle cannot open a connection per file against one host.
    const pending = [...entry.files];
    const fetchOne = async (file: string): Promise<void> => {
      const url = childUrl(origin, basePath, entry.name, file);
      const response = await fetchWithinOrigin(fetchImpl, url, origin, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new SkillFetchError(`Website skill file returned HTTP ${response.status}: ${file}`);
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > SKILL_IMPORT_MAX_FILE_BYTES) {
        throw new SkillFetchError(
          `Website skill file exceeds ${SKILL_IMPORT_MAX_FILE_BYTES} bytes: ${file}`,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > SKILL_IMPORT_MAX_FILE_BYTES) {
        throw new SkillFetchError(
          `Website skill file exceeds ${SKILL_IMPORT_MAX_FILE_BYTES} bytes: ${file}`,
        );
      }
      // The running total is still exact — single-threaded, and each worker adds
      // its whole file before yielding. Concurrency only means the breach is
      // noticed with up to WORKERS-1 other files already counted, which is why
      // the per-file cap above is the real bound on what one response can add.
      totalBytes += bytes.byteLength;
      if (totalBytes > SKILL_IMPORT_MAX_TOTAL_BYTES) {
        throw new SkillFetchError(
          `Website skill bundle exceeds ${SKILL_IMPORT_MAX_TOTAL_BYTES} bytes.`,
        );
      }
      const destination = join(skillDir, ...file.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    };
    const worker = async (): Promise<void> => {
      for (let file = pending.shift(); file !== undefined; file = pending.shift()) {
        await fetchOne(file);
      }
    };
    // `Promise.all` rejects on the first failure while the other workers run to
    // completion; the catch below removes the temp dir either way, so a partial
    // bundle is never returned.
    await Promise.all(
      Array.from({ length: Math.min(SITE_FILE_CONCURRENCY, pending.length) }, worker),
    );
    return { dir: skillDir, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    if (error instanceof SkillFetchError) throw error;
    throw new SkillFetchError(
      `Could not fetch website skill ${spec.skill}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
