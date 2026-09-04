import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { marked } from 'marked';

const REPO = 'inkeep/open-knowledge';
const REPO_URL = `https://github.com/${REPO}`;
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;

const PER_PAGE = 100;

const MAX_DATE_PAGES = 5;

const DATE_LIMIT = 30;

const CHANGELOG_PATH = join(process.cwd(), '..', 'packages', 'cli', 'CHANGELOG.md');

export interface ReleaseNote {
  tag: string;
  title: string;
  publishedAt: string | null;
  bodyHtml: string;
  htmlUrl: string;
}

const VERSION_HEADING = /^## (\d+\.\d+\.\d+)\s*$/;

const HASH_PREFIX = /^(\s*[-*] )[0-9a-f]{6,40}: /gm;

function renderNotes(markdown: string): string {
  const body = markdown.trim();
  if (!body) return '';
  return marked.parse(body, { gfm: true, async: false });
}

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

export async function fetchReleaseDates(
  limit = DATE_LIMIT,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, string>> {
  const dates = new Map<string, string>();
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'openknowledge.ai changelog',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  try {
    for (let page = 1; page <= MAX_DATE_PAGES && dates.size < limit; page++) {
      const res = await fetchImpl(`${RELEASES_API}?per_page=${PER_PAGE}&page=${page}`, { headers });
      if (!res.ok) break;
      const payload = await res.json();
      collectDates(payload, dates, limit);
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

export async function loadStableReleases(
  limit = Number.POSITIVE_INFINITY,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<ReleaseNote[]> {
  const markdown = readChangelog();
  if (markdown === null) return [];
  const dates = await fetchReleaseDates(DATE_LIMIT, deps.fetchImpl ?? fetch);
  const releases = parseChangelog(markdown, dates);
  if (releases.length === 0) {
    throw new Error(
      `[changelog] CHANGELOG.md at ${CHANGELOG_PATH} has no \`## X.Y.Z\` sections — malformed or empty.`,
    );
  }
  return Number.isFinite(limit) ? releases.slice(0, limit) : releases;
}
