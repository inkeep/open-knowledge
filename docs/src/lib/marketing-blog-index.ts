import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import type { LlmsTxtLink } from '@/lib/llms-txt';
import { SITE_URL } from '@/lib/site';

export const BLOG_FEED_URL = `${SITE_URL}/blog/rss.xml`;

const RENDER_TIMEOUT_MS = 5_000;
const BUILD_TIMEOUT_MS = 20_000;

const BUILD_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;

const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';
const CDATA_SECTION = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

const LINK_IN_MESSAGE_MAX = 200;

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function textOf(value: string): string {
  const sections = [...value.matchAll(CDATA_SECTION)];
  if (sections.length > 0) return sections.map((section) => section[1]).join('');
  return decodeXml(value.trim());
}

function matchOutsideCdata(xml: string, needle: RegExp, from: number): RegExpExecArray | null {
  let at = from;
  for (;;) {
    needle.lastIndex = at;
    const match = needle.exec(xml);
    if (!match) return null;
    const cdata = xml.indexOf(CDATA_OPEN, at);
    if (cdata === -1 || match.index < cdata) return match;
    const end = xml.indexOf(CDATA_CLOSE, cdata + CDATA_OPEN.length);
    if (end === -1) return null;
    at = end + CDATA_CLOSE.length;
  }
}

function elements(xml: string, name: string): { found: string[]; dropped: boolean } {
  const open = new RegExp(`<${name}(?:\\s[^>]*)?>`, 'g');
  const close = new RegExp(`</${name}>`, 'g');
  const found: string[] = [];
  let at = 0;
  for (;;) {
    const opened = matchOutsideCdata(xml, open, at);
    if (!opened) return { found, dropped: false };
    const start = opened.index + opened[0].length;
    const closed = matchOutsideCdata(xml, close, start);
    const reopened = matchOutsideCdata(xml, open, start);
    if (reopened && (!closed || reopened.index < closed.index)) {
      found.push(xml.slice(start, reopened.index));
      at = reopened.index;
      continue;
    }
    if (!closed) return { found, dropped: true };
    found.push(xml.slice(start, closed.index));
    at = closed.index + closed[0].length;
  }
}

function element(item: string, name: string): string | undefined {
  const [inner] = elements(item, name).found;
  return inner === undefined ? undefined : textOf(inner);
}

function quoteForMessage(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, ' ').slice(0, LINK_IN_MESSAGE_MAX));
}

class FeedStatusError extends Error {
  override readonly name = 'FeedStatusError';
  constructor(readonly status: number) {
    super(`${BLOG_FEED_URL} responded ${status}`);
  }
}

export class EmptyBlogError extends Error {
  override readonly name = 'EmptyBlogError';
}

function isTransient(error: unknown): boolean {
  if (error instanceof FeedStatusError) return error.status >= 500;
  return error instanceof DOMException || error instanceof TypeError;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function attemptPolicy(building: boolean): { attempts: number; timeoutMs: number } {
  return building
    ? { attempts: BUILD_ATTEMPTS, timeoutMs: BUILD_TIMEOUT_MS }
    : { attempts: 1, timeoutMs: RENDER_TIMEOUT_MS };
}

export async function fetchBlogPostLinks(
  revalidateSeconds: number,
  building = false,
): Promise<LlmsTxtLink[]> {
  const { attempts, timeoutMs } = attemptPolicy(building);

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    try {
      return await attemptFetch(revalidateSeconds, timeoutMs);
    } catch (error) {
      if (!isTransient(error)) throw error;
      lastError = error;
    }
  }
  throw new Error(
    `${BLOG_FEED_URL} could not be read after ${attempts} attempt${attempts === 1 ? '' : 's'} ` +
      `(${lastError instanceof Error ? lastError.message : String(lastError)})`,
    { cause: lastError },
  );
}

async function attemptFetch(revalidateSeconds: number, timeoutMs: number): Promise<LlmsTxtLink[]> {
  const response = await fetch(BLOG_FEED_URL, {
    signal: AbortSignal.timeout(timeoutMs),
    next: { revalidate: revalidateSeconds },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new FeedStatusError(response.status);
  }

  return readPosts(await response.text());
}

function readPost(item: string, postPrefix: string): LlmsTxtLink | string {
  const title = element(item, 'title');
  const link = element(item, 'link');
  if (!title || !link) return 'an <item> with no <title> or no <link>';
  if (!link.startsWith(postPrefix) || link.slice(postPrefix.length).includes('/')) {
    return `${quoteForMessage(link)} is not a post at ${postPrefix}<slug>`;
  }
  const description = element(item, 'description');
  return { url: `${link}.md`, name: title, ...(description ? { description } : {}) };
}

function readPosts(xml: string): LlmsTxtLink[] {
  if (!/<rss[\s>]/.test(xml)) {
    throw new Error(
      `${BLOG_FEED_URL} is not an RSS feed — a different document, or an error page served ` +
        'with a 200',
    );
  }

  const complete = xml.trimEnd().endsWith('</rss>');
  const { found: items, dropped } = elements(xml, 'item');
  const damage = !complete
    ? 'ends before </rss>, so it is truncated'
    : dropped
      ? 'leaves an <item> unclosed, so it is malformed'
      : null;
  if (items.length === 0) {
    if (damage) {
      throw new Error(`${BLOG_FEED_URL} ${damage} — it is not an empty blog`);
    }
    throw new EmptyBlogError(`${BLOG_FEED_URL} lists no posts`);
  }
  if (damage) {
    console.warn(
      `llms.txt: ${BLOG_FEED_URL} ${damage}, so posts after that point may be missing from ` +
        'this index',
    );
  }

  const postPrefix = `${SITE_URL}/blog/`;
  const posts: LlmsTxtLink[] = [];
  const skipped: string[] = [];
  for (const item of items) {
    const read = readPost(item, postPrefix);
    if (typeof read === 'string') skipped.push(read);
    else posts.push(read);
  }

  if (posts.length === 0) {
    throw new Error(
      `${BLOG_FEED_URL} lists ${items.length} item${items.length === 1 ? '' : 's'} and not one ` +
        `is a post (${skipped[0]}) — either this is not the blog feed this reads (a different ` +
        'document, or a canonical host that drifted between the two apps), or the post URL ' +
        'shape changed',
    );
  }
  for (const reason of skipped) {
    console.warn(`llms.txt: skipping a ${BLOG_FEED_URL} item — ${reason}`);
  }
  return posts;
}

const ALLOW_BLOGLESS = 'OK_ALLOW_BLOGLESS_LLMS_TXT';

function isOffVercelCi(): boolean {
  return Boolean(process.env.CI) && !process.env.VERCEL;
}

export async function blogPostLinks(revalidateSeconds: number): Promise<LlmsTxtLink[]> {
  const building = process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD;
  if (building && isOffVercelCi()) {
    console.warn(
      `llms.txt: omitting blog posts — a CI build off Vercel publishes nothing, so it does not ` +
        `read ${BLOG_FEED_URL}`,
    );
    return [];
  }

  try {
    return await fetchBlogPostLinks(revalidateSeconds, building);
  } catch (error) {
    if (!building) throw error;

    if (process.env.VERCEL_ENV === 'production' && !(error instanceof EmptyBlogError)) {
      if (process.env[ALLOW_BLOGLESS] !== '1') {
        throw new Error(
          `llms.txt: refusing to publish a production build with no blog posts. ${describe(error)}, ` +
            'and the index would ship a Blog section with no posts in it for the life of this ' +
            'deployment. Confirm the marketing zone serves that URL and redeploy this commit; ' +
            `set ${ALLOW_BLOGLESS}=1 to publish without the posts.`,
          { cause: error },
        );
      }
      console.warn(
        `llms.txt: ${ALLOW_BLOGLESS}=1 is set, so this PRODUCTION build publishes an index with ` +
          `no blog posts in it. ${describe(error)}. Unset it once the cause is fixed.`,
      );
    }

    console.warn(`llms.txt: omitting blog posts — ${describe(error)}`, error);
    return [];
  }
}

function describe(error: unknown): string {
  if (error instanceof EmptyBlogError) return 'the blog lists no posts';
  return error instanceof Error ? error.message : String(error);
}
