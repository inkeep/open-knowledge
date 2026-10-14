import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { marked } from 'marked';

const REPO = 'inkeep/open-knowledge';
const REPO_URL = `https://github.com/${REPO}`;
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;

const PER_PAGE = 100;

const MAX_DATE_PAGES = 5;

const MAX_RELEASE_PAGES = 20;

const DATE_LIMIT = 30;

const RELEASE_NOTES_REQUIRED = false;

const NOTES_LAG_MS = 14 * 24 * 60 * 60 * 1000;

export const NOTES_SOURCE_MARKER = '<!-- ok-notes-source: stable-tag-tree -->';

const DOWNLOADS_BLOCK = /<!-- ok-downloads:start -->[\s\S]*?<!-- ok-downloads:end -->/g;

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

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

export function markedNotes(body: string): string | null {
  const marker = body.indexOf(NOTES_SOURCE_MARKER);
  if (marker === -1) return null;
  return body.slice(0, marker).replace(DOWNLOADS_BLOCK, '').trim();
}

interface PublishedStable {
  tag: string;
  publishedAt: number;
}

export interface MarkedNotesScan {
  notes: Map<string, string>;
  unmarkedCovered: PublishedStable[];
  earliestMarkedAt: number;
  oldestCreatedAt: number;
}

export function newMarkedNotesScan(): MarkedNotesScan {
  return {
    notes: new Map(),
    unmarkedCovered: [],
    earliestMarkedAt: Number.POSITIVE_INFINITY,
    oldestCreatedAt: Number.POSITIVE_INFINITY,
  };
}

function versionOf(tag: string): number[] {
  return STABLE_TAG.exec(tag)?.slice(1).map(Number) ?? [0, 0, 0];
}

function compareVersions(a: string, b: string): number {
  const pa = versionOf(a);
  const pb = versionOf(b);
  for (let i = 0; i < 3; i++) {
    const delta = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function collectMarkedNotes(
  payload: unknown,
  scan: MarkedNotesScan,
  changelogTags: ReadonlySet<string>,
): void {
  if (!Array.isArray(payload)) return;
  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const createdAt = typeof rec.created_at === 'string' ? Date.parse(rec.created_at) : Number.NaN;
    if (Number.isFinite(createdAt))
      scan.oldestCreatedAt = Math.min(scan.oldestCreatedAt, createdAt);
    if (rec.draft || rec.prerelease) continue;
    const tag = rec.tag_name;
    if (typeof tag !== 'string' || !STABLE_TAG.test(tag)) continue;
    const publishedAt =
      typeof rec.published_at === 'string' ? Date.parse(rec.published_at) : Number.NaN;
    const notes = typeof rec.body === 'string' ? markedNotes(rec.body) : null;
    if (notes !== null) {
      if (!scan.notes.has(tag)) scan.notes.set(tag, notes);
      if (Number.isFinite(publishedAt)) {
        scan.earliestMarkedAt = Math.min(scan.earliestMarkedAt, publishedAt);
      }
    } else if (changelogTags.has(tag) && Number.isFinite(publishedAt)) {
      scan.unmarkedCovered.push({ tag, publishedAt });
    }
  }
}

export function cutoverOf(scan: MarkedNotesScan): PublishedStable | null {
  let cutover: PublishedStable | null = null;
  for (const release of scan.unmarkedCovered) {
    if (release.publishedAt >= scan.earliestMarkedAt) continue;
    if (cutover === null || compareVersions(release.tag, cutover.tag) > 0) cutover = release;
  }
  return cutover;
}

export function passedCutover(scan: MarkedNotesScan): boolean {
  const cutover = cutoverOf(scan);
  return cutover !== null && scan.oldestCreatedAt < cutover.publishedAt - NOTES_LAG_MS;
}

export interface ReleaseFeed {
  dates: Map<string, string>;
  notes: Map<string, string>;
  notesComplete: boolean;
  failure: string | null;
}

export async function fetchReleaseFeed({
  dateLimit = DATE_LIMIT,
  changelogTags,
  fetchImpl = fetch,
}: {
  dateLimit?: number;
  changelogTags: ReadonlySet<string>;
  fetchImpl?: typeof fetch;
}): Promise<ReleaseFeed> {
  const dates = new Map<string, string>();
  const scan = newMarkedNotesScan();
  let exhausted = false;
  let failure: string | null = null;
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'openknowledge.ai changelog',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  try {
    for (let page = 1; ; page++) {
      const wantDates = page <= MAX_DATE_PAGES && dates.size < dateLimit;
      if (!wantDates && passedCutover(scan)) break;
      if (page > MAX_RELEASE_PAGES) {
        failure = `stopped at the ${MAX_RELEASE_PAGES}-page cap`;
        break;
      }
      const res = await fetchImpl(`${RELEASES_API}?per_page=${PER_PAGE}&page=${page}`, { headers });
      if (!res.ok) {
        failure = `page ${page} returned HTTP ${res.status}`;
        break;
      }
      const payload = await res.json();
      if (!Array.isArray(payload)) {
        failure = `page ${page} returned a body that is not a list of releases`;
        break;
      }
      if (wantDates) collectDates(payload, dates, dateLimit);
      collectMarkedNotes(payload, scan, changelogTags);
      if (payload.length < PER_PAGE) {
        exhausted = true;
        break;
      }
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    console.warn(`[releases] date enrichment failed; building changelog without dates: ${failure}`);
  }
  return {
    dates,
    notes: scan.notes,
    notesComplete: passedCutover(scan) || exhausted,
    failure,
  };
}

function compareTagsDescending(a: ReleaseNote, b: ReleaseNote): number {
  return compareVersions(b.tag, a.tag);
}

export function mergeReleaseNotes(
  changelogReleases: ReleaseNote[],
  notes: ReadonlyMap<string, string>,
  dates: ReadonlyMap<string, string>,
): ReleaseNote[] {
  if (notes.size === 0) return changelogReleases;
  const fromBodies = [...notes].map(([tag, markdown]) => ({
    tag,
    title: tag,
    publishedAt: dates.get(tag) ?? null,
    bodyHtml: renderNotes(markdown),
    htmlUrl: `${REPO_URL}/releases/tag/${tag}`,
  }));
  return [...fromBodies, ...changelogReleases.filter((release) => !notes.has(release.tag))].sort(
    compareTagsDescending,
  );
}

export function releaseNotesFrom(feed: ReleaseFeed): ReadonlyMap<string, string> {
  if (feed.notesComplete) return feed.notes;
  const reason =
    '[releases] could not read every stable Release body back to the newest one without notes' +
    `${feed.failure ? ` (${feed.failure})` : ''}; ` +
    'the changelog cannot tell which versions have notes in their Release body.';
  if (RELEASE_NOTES_REQUIRED) throw new Error(reason);
  console.warn(`${reason} Showing packages/cli/CHANGELOG.md notes only.`);
  return new Map();
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
  const changelogTags = new Set(
    markdown.split('\n').flatMap((line) => {
      const heading = VERSION_HEADING.exec(line);
      return heading ? [`v${heading[1]}`] : [];
    }),
  );
  const feed = await fetchReleaseFeed({
    dateLimit: DATE_LIMIT,
    changelogTags,
    fetchImpl: deps.fetchImpl ?? fetch,
  });
  const changelogReleases = parseChangelog(markdown, feed.dates);
  if (changelogReleases.length === 0) {
    throw new Error(
      `[changelog] CHANGELOG.md at ${CHANGELOG_PATH} has no \`## X.Y.Z\` sections — malformed or empty.`,
    );
  }
  const releases = mergeReleaseNotes(changelogReleases, releaseNotesFrom(feed), feed.dates);
  return Number.isFinite(limit) ? releases.slice(0, limit) : releases;
}
