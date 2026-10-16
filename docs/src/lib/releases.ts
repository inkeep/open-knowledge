import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { marked } from 'marked';

const REPO = 'inkeep/open-knowledge';
const REPO_URL = `https://github.com/${REPO}`;
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;

const PER_PAGE = 100;

const MAX_DATE_PAGES = 5;

const DATE_LIMIT = 30;

const NOTES_LAG_MS = 14 * 24 * 60 * 60 * 1000;

const RUNAWAY_PAGES = 1000;

const FETCH_ATTEMPTS = 3;

const FETCH_TIMEOUT_MS = 30_000;

const MAX_RETRY_AFTER_MS = 10_000;

const RETRY_BACKOFF_MS = 1000;

export const ALLOW_PARTIAL_CHANGELOG = 'OK_ALLOW_PARTIAL_CHANGELOG';

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
  unlisted: string[];
  earliestMarkedAt: number;
  oldestCreatedAt: number;
}

export function newMarkedNotesScan(): MarkedNotesScan {
  return {
    notes: new Map(),
    unmarkedCovered: [],
    unlisted: [],
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
    } else if (changelogTags.has(tag)) {
      if (Number.isFinite(publishedAt)) scan.unmarkedCovered.push({ tag, publishedAt });
    } else if (!scan.unlisted.includes(tag)) {
      scan.unlisted.push(tag);
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

interface PageIo {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  deadline: (ms: number) => AbortSignal;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as { code?: unknown; message?: unknown } | undefined;
  const detail =
    typeof cause?.code === 'string'
      ? cause.code
      : typeof cause?.message === 'string'
        ? cause.message
        : null;
  return detail ? `${err.message} (${detail})` : err.message;
}

function rateLimited(res: Response): boolean {
  return (
    res.status === 429 ||
    (res.status === 403 &&
      (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')))
  );
}

function httpFailure(page: number, res: Response): string {
  if (res.status === 401) {
    return `page ${page} returned HTTP 401: the GITHUB_TOKEN this build sent was refused`;
  }
  if (rateLimited(res)) return `page ${page} was rate-limited (HTTP ${res.status})`;
  return `page ${page} returned HTTP ${res.status}`;
}

type PageRead = { payload: unknown; failure: null } | { payload: null; failure: string };

async function readPage(
  page: number,
  headers: Record<string, string>,
  io: PageIo,
): Promise<PageRead> {
  const url = `${RELEASES_API}?per_page=${PER_PAGE}&page=${page}`;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    let body = '';
    try {
      res = await io.fetchImpl(url, { headers, signal: io.deadline(FETCH_TIMEOUT_MS) });
      if (res.ok) body = await res.text();
    } catch (err) {
      if (attempt >= FETCH_ATTEMPTS) {
        return {
          payload: null,
          failure: `page ${page} request failed after ${FETCH_ATTEMPTS} attempts: ${errorText(err)}`,
        };
      }
      await io.sleep(RETRY_BACKOFF_MS * attempt);
      continue;
    }
    if (res.ok) {
      try {
        return { payload: JSON.parse(body), failure: null };
      } catch (err) {
        return {
          payload: null,
          failure: `page ${page} returned a body that is not JSON: ${errorText(err)}`,
        };
      }
    }
    if (attempt < FETCH_ATTEMPTS && res.status >= 500) {
      await io.sleep(RETRY_BACKOFF_MS * attempt);
      continue;
    }
    const retryAfterMs = Number(res.headers.get('retry-after')) * 1000;
    if (
      attempt < FETCH_ATTEMPTS &&
      rateLimited(res) &&
      retryAfterMs > 0 &&
      retryAfterMs <= MAX_RETRY_AFTER_MS
    ) {
      await io.sleep(retryAfterMs);
      continue;
    }
    return { payload: null, failure: httpFailure(page, res) };
  }
}

export async function fetchReleaseFeed({
  dateLimit = DATE_LIMIT,
  changelogTags,
  fetchImpl = fetch,
  sleep = realSleep,
  deadline = (ms: number) => AbortSignal.timeout(ms),
  runawayPages = RUNAWAY_PAGES,
}: {
  dateLimit?: number;
  changelogTags: ReadonlySet<string>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  deadline?: (ms: number) => AbortSignal;
  runawayPages?: number;
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
  for (let page = 1; ; page++) {
    const wantDates = page <= MAX_DATE_PAGES && dates.size < dateLimit;
    if (!wantDates && passedCutover(scan)) break;
    if (page > runawayPages) {
      failure = `the Releases listing did not end within ${runawayPages} pages and never reached the cutover`;
      break;
    }
    const read = await readPage(page, headers, { fetchImpl, sleep, deadline });
    if (read.failure !== null) {
      failure = read.failure;
      break;
    }
    const { payload } = read;
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
  if (scan.unlisted.length > 0) {
    console.warn(
      `[releases] published stable Release(s) with no notes-source marker and no packages/cli/CHANGELOG.md section, so the changelog has no entry for them: ${scan.unlisted.join(', ')}. Restore the marked notes in each Release body and re-fire the docs deploy.`,
    );
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

type BuildEnv = Readonly<Record<string, string | undefined>>;

export function releaseNotesRequired(env: BuildEnv = process.env): boolean {
  return env.VERCEL_ENV === 'production' && env[ALLOW_PARTIAL_CHANGELOG] !== '1';
}

export function releaseNotesFrom(
  feed: ReleaseFeed,
  env: BuildEnv = process.env,
): ReadonlyMap<string, string> {
  if (feed.notesComplete) return feed.notes;
  const reason =
    '[releases] could not read every stable Release body back to the newest one without notes' +
    `${feed.failure ? ` (${feed.failure})` : ''}; ` +
    'the changelog cannot tell which versions have notes in their Release body.';
  if (releaseNotesRequired(env)) {
    throw new Error(
      `${reason} packages/cli/CHANGELOG.md is frozen, so a production build without the Release ` +
        'bodies would drop every newer stable from the live changelog. Re-run the deploy. A rate ' +
        'limit needs GITHUB_TOKEN on the Vercel project, and an HTTP 401 means the token set there ' +
        'was refused and needs replacing. Set ' +
        `${ALLOW_PARTIAL_CHANGELOG}=1 to publish the CHANGELOG.md notes alone. Runbook: RELEASES.md, ` +
        '"The docs changelog reads the Release bodies".',
    );
  }
  const production =
    env.VERCEL_ENV === 'production'
      ? ` ${ALLOW_PARTIAL_CHANGELOG}=1 is set, so this PRODUCTION build publishes it; unset it once the cause is fixed.`
      : '';
  console.warn(
    `${reason} Showing packages/cli/CHANGELOG.md notes only, so every stable newer than it is ` +
      `missing from this build's changelog.${production}`,
  );
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
  deps: {
    fetchImpl?: typeof fetch;
    env?: BuildEnv;
    sleep?: (ms: number) => Promise<void>;
  } = {},
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
    sleep: deps.sleep,
  });
  const changelogReleases = parseChangelog(markdown, feed.dates);
  if (changelogReleases.length === 0) {
    throw new Error(
      `[changelog] CHANGELOG.md at ${CHANGELOG_PATH} has no \`## X.Y.Z\` sections — malformed or empty.`,
    );
  }
  const releases = mergeReleaseNotes(
    changelogReleases,
    releaseNotesFrom(feed, deps.env ?? process.env),
    feed.dates,
  );
  return Number.isFinite(limit) ? releases.slice(0, limit) : releases;
}
