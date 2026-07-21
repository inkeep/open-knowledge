import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { marked } from 'marked';

/**
 * Stable-release data layer for `/docs/changelog`.
 *
 * CONTENT comes from the published CLI package's CHANGELOG.md, which the
 * `main-reset` workflow rewrites via `changeset version` on every stable release.
 * So the notes are derived from a file already in the repo — no API pagination, no
 * feed-walk, no build-time failure when GitHub is unreachable. Betas never touch
 * CHANGELOG.md (transient, never-committed version override), so the `## X.Y.Z`
 * sections are stable-only by construction.
 *
 * DATES aren't in CHANGELOG.md, and the docs build from agents-private, which does
 * NOT carry the `vX.Y.Z` release tags (those live on the public mirror where
 * `promote-stable` creates them). So dates come from a small, bounded GitHub API
 * call — the only reliable source here. It is deliberately BEST-EFFORT: any
 * failure (outage, rate-limit) yields fewer or no dates, never a build failure.
 * The changelog content always renders from CHANGELOG.md regardless.
 */

const REPO = 'inkeep/open-knowledge';
const REPO_URL = `https://github.com/${REPO}`;
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;

/** GitHub's max page size for the releases list. */
const PER_PAGE = 100;

/**
 * Date enrichment covers the newest releases (the visible timeline). Betas
 * dominate the feed, so a few pages comfortably reach ~30 stables; this bounds the
 * best-effort call so it can never walk the whole feed.
 */
const MAX_DATE_PAGES = 5;

/** How many of the newest stable releases to look up dates for. */
const DATE_LIMIT = 30;

/**
 * Build-time path to the published CLI package's changelog. `process.cwd()` is the
 * docs project root during `next build`/`next dev`; the changelog is one level up
 * in the sibling `packages/cli`.
 */
const CHANGELOG_PATH = join(process.cwd(), '..', 'packages', 'cli', 'CHANGELOG.md');

/** A stable release with its notes rendered to HTML — the changelog's item shape. */
export interface ReleaseNote {
  /** Git tag, e.g. `v0.30.0` — the stable version identity + URL slug. */
  tag: string;
  /** Display title (the tag). */
  title: string;
  /** ISO publish date, or null when the API didn't supply one for this release. */
  publishedAt: string | null;
  /** Release notes rendered from GFM markdown to HTML (empty string if none). */
  bodyHtml: string;
  /** Canonical GitHub release page for this tag. */
  htmlUrl: string;
}

/** `## X.Y.Z` section heading — stable versions only (a `-beta.N` suffix won't match). */
const VERSION_HEADING = /^## (\d+\.\d+\.\d+)\s*$/;

/**
 * Changeset prefixes each bullet with the source commit's short hash
 * (`- 3c124b0: …`). Strip it so the rendered notes read like the GitHub release
 * body. Anchored to the bullet marker so indented continuation lines are untouched.
 */
const HASH_PREFIX = /^(\s*[-*] )[0-9a-f]{6,40}: /gm;

/** Release notes are trusted GFM authored by maintainers via changesets. */
function renderNotes(markdown: string): string {
  const body = markdown.trim();
  if (!body) return '';
  return marked.parse(body, { gfm: true, async: false });
}

/**
 * Parse a changeset-generated CHANGELOG.md into releases, newest first (the file's
 * own order). Pure and network-free — dates are injected — so the parsing rules
 * are unit-testable in isolation. Content before the first `## X.Y.Z` heading (the
 * `# @inkeep/open-knowledge` title) is ignored.
 */
export function parseChangelog(
  markdown: string,
  dates: Map<string, string> = new Map(),
): ReleaseNote[] {
  const releases: ReleaseNote[] = [];
  let version: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (version === null) return;
    const tag = `v${version}`;
    releases.push({
      tag,
      title: tag,
      publishedAt: dates.get(tag) ?? null,
      bodyHtml: renderNotes(body.join('\n').replace(HASH_PREFIX, '$1')),
      htmlUrl: `${REPO_URL}/releases/tag/${tag}`,
    });
  };

  for (const line of markdown.split('\n')) {
    const heading = VERSION_HEADING.exec(line);
    if (heading) {
      flush();
      version = heading[1];
      body = [];
    } else if (version !== null) {
      body.push(line);
    }
  }
  flush();
  return releases;
}

/**
 * Collect `vX.Y.Z` → published_at from one releases-API page into `dates` (stable,
 * published releases only). Defensive against payload shape drift — a malformed
 * entry is skipped, never thrown, since dates are best-effort.
 */
export function collectDates(payload: unknown, dates: Map<string, string>, limit: number): void {
  if (!Array.isArray(payload)) return;
  for (const entry of payload) {
    if (dates.size >= limit) return;
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    if (rec.draft || rec.prerelease) continue;
    const tag = rec.tag_name;
    const date = rec.published_at;
    if (typeof tag === 'string' && typeof date === 'string' && !dates.has(tag)) {
      dates.set(tag, date);
    }
  }
}

/**
 * Best-effort map of `vX.Y.Z` → ISO publish date for the newest `limit` stable
 * releases. Bounded to {@link MAX_DATE_PAGES} and fully degradable: any HTTP,
 * network, or parse failure returns the dates collected so far (possibly none) —
 * it never throws, so it can never fail the docs build. `fetchImpl` is injectable
 * for tests.
 */
export async function fetchReleaseDates(
  limit = DATE_LIMIT,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, string>> {
  const dates = new Map<string, string>();
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    accept: 'application/vnd.github+json',
    // GitHub rejects requests without a User-Agent; undici sets none by default.
    'user-agent': 'openknowledge.ai changelog',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  try {
    for (let page = 1; page <= MAX_DATE_PAGES && dates.size < limit; page++) {
      const res = await fetchImpl(`${RELEASES_API}?per_page=${PER_PAGE}&page=${page}`, { headers });
      if (!res.ok) break;
      const payload = await res.json();
      collectDates(payload, dates, limit);
      // Short page = end of the feed; stop even if we have fewer than `limit`.
      if (!Array.isArray(payload) || payload.length < PER_PAGE) break;
    }
  } catch (err) {
    console.warn(
      `[releases] date enrichment failed; building changelog without dates: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return dates;
}

/**
 * Read the changelog file, or `null` when it's absent. Absence is expected in the
 * public mirror (the copybara manifest excludes `packages/**​/CHANGELOG.md`) and in
 * any standalone clone of the OSS repo — there the changelog degrades to empty
 * rather than failing the build. The live docs deploy from agents-private always
 * has the file. A non-ENOENT error (permissions, I/O) still throws.
 */
function readChangelog(): string | null {
  try {
    return readFileSync(CHANGELOG_PATH, 'utf8');
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT') {
      console.warn(
        `[changelog] CHANGELOG.md not found at ${CHANGELOG_PATH}; building an empty changelog. ` +
          'Expected in the public mirror (CHANGELOG.md is not mirrored). In a real docs deploy this ' +
          "means files outside the root aren't checked out — enable 'Include files outside the Root " +
          "Directory' on the Vercel project.",
      );
      return null;
    }
    throw err;
  }
}

/**
 * Load stable releases from CHANGELOG.md with notes rendered to HTML, newest
 * first. Content is read from the local file (fails the build only if the file is
 * missing/empty); dates are best-effort from the API. `limit` caps the count
 * (default: all) for callers that only want the newest N.
 */
export async function loadStableReleases(
  limit = Number.POSITIVE_INFINITY,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<ReleaseNote[]> {
  const markdown = readChangelog();
  if (markdown === null) return []; // file absent (public mirror) — empty changelog
  const dates = await fetchReleaseDates(DATE_LIMIT, deps.fetchImpl ?? fetch);
  const releases = parseChangelog(markdown, dates);
  if (releases.length === 0) {
    // The file is present but has no `## X.Y.Z` sections — malformed, not the
    // expected-absent case above. Fail loud so a broken file can't ship silently.
    throw new Error(
      `[changelog] CHANGELOG.md at ${CHANGELOG_PATH} has no \`## X.Y.Z\` sections — malformed or empty.`,
    );
  }
  return Number.isFinite(limit) ? releases.slice(0, limit) : releases;
}
