import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  attemptPolicy,
  BLOG_FEED_URL,
  blogPostLinks,
  EmptyBlogError,
  fetchBlogPostLinks,
} from './marketing-blog-index';

interface FeedItem {
  title: string;
  link: string;
  description?: string;
}

const cdata = (text: string) => `<![CDATA[${text.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;

function feed(...items: FeedItem[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    '    <title>OpenKnowledge Blog</title>',
    '    <link>https://openknowledge.ai/blog</link>',
    '    <description>News, releases, and engineering notes from the OpenKnowledge team.</description>',
    '    <atom:link href="https://openknowledge.ai/blog/rss.xml" rel="self" type="application/rss+xml" />',
    ...items.map((item) =>
      [
        '    <item>',
        `      <title>${cdata(item.title)}</title>`,
        `      <link>${item.link}</link>`,
        ...(item.description === undefined
          ? []
          : [`      <description>${cdata(item.description)}</description>`]),
        '      <pubDate>Tue, 21 Jul 2026 00:00:00 GMT</pubDate>',
        `      <guid isPermaLink="true">${item.link}</guid>`,
        '      <category>Release</category>',
        '    </item>',
      ].join('\n'),
    ),
    '  </channel>',
    '</rss>',
  ].join('\n');
}

const MARKDOWNLINT: FeedItem = {
  title: 'Keeping you and your agents in check with markdownlint',
  link: 'https://openknowledge.ai/blog/markdownlint-support',
  description:
    "Native markdownlint support in Open Knowledge: your existing config works as-is, a GUI builds one if you don't have it, and your agents see the same rules you do.",
};

const VISIMER: FeedItem = {
  title: 'Edit Mermaid diagrams visually with Visimer',
  link: 'https://openknowledge.ai/blog/edit-mermaid-diagrams-visually',
  description:
    'Edit Mermaid diagrams visually with Visimer, the open source library that powers the Mermaid editing experience in OpenKnowledge.',
};

const LIVE_FEED = feed(MARKDOWNLINT, VISIMER);

function respondWith(body: string, init: ResponseInit = {}) {
  const fetchMock = vi.fn(async () => new Response(body, init));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.useFakeTimers();
});

async function settle<T>(pending: Promise<T>): Promise<T> {
  pending.catch(() => undefined);
  await vi.runAllTimersAsync();
  return pending;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('blog posts read from the marketing zone feed', () => {
  test('lists each post as the Markdown rendition of its page, under its own title', async () => {
    respondWith(LIVE_FEED);
    expect(await fetchBlogPostLinks(3600)).toEqual([
      {
        url: 'https://openknowledge.ai/blog/markdownlint-support.md',
        name: 'Keeping you and your agents in check with markdownlint',
        description: MARKDOWNLINT.description,
      },
      {
        url: 'https://openknowledge.ai/blog/edit-mermaid-diagrams-visually.md',
        name: 'Edit Mermaid diagrams visually with Visimer',
        description: VISIMER.description,
      },
    ]);
  });

  test('reads a title the encoder split across two CDATA sections', async () => {
    respondWith(feed({ title: 'before ]]> after', link: 'https://openknowledge.ai/blog/a-post' }));
    expect((await fetchBlogPostLinks(3600))[0].name).toBe('before ]]> after');
  });

  test('decodes XML entities in a link', async () => {
    respondWith(feed({ title: 'A', link: 'https://openknowledge.ai/blog/a&amp;b' }));
    expect((await fetchBlogPostLinks(3600))[0].url).toBe('https://openknowledge.ai/blog/a&b.md');
  });

  test('carries no description when the feed has none to give', async () => {
    respondWith(feed({ title: 'A', link: 'https://openknowledge.ai/blog/a-post' }));
    expect((await fetchBlogPostLinks(3600))[0]).not.toHaveProperty('description');
  });

  test('warns when the feed ends after its last post but before the closing tag', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const whole = feed(MARKDOWNLINT);
    respondWith(whole.slice(0, whole.lastIndexOf('</item>') + '</item>'.length));
    expect((await fetchBlogPostLinks(3600)).length).toBe(1);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/ends before <\/rss>/);
  });

  test('does not cry truncation over a closing tag written inside a title or a summary', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith(
      feed(MARKDOWNLINT, {
        ...VISIMER,
        description: 'A summary that mentions </description>, </item> and <item> in passing.',
      }),
    );
    expect((await fetchBlogPostLinks(3600)).length).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });

  test('reads a closing tag written inside a title or a summary as text', async () => {
    respondWith(
      feed(
        {
          title: 'How </title> and </item> survive CDATA',
          link: 'https://openknowledge.ai/blog/closing-tags',
          description: 'A summary that mentions </description>, </item> and <item> in passing.',
        },
        VISIMER,
      ),
    );
    expect(await fetchBlogPostLinks(3600)).toEqual([
      {
        url: 'https://openknowledge.ai/blog/closing-tags.md',
        name: 'How </title> and </item> survive CDATA',
        description: 'A summary that mentions </description>, </item> and <item> in passing.',
      },
      {
        url: 'https://openknowledge.ai/blog/edit-mermaid-diagrams-visually.md',
        name: VISIMER.title,
        description: VISIMER.description,
      },
    ]);
  });

  test('an item left unclosed ends where the next one opens, so its successor is not lost', async () => {
    respondWith(feed(MARKDOWNLINT, VISIMER).replace('</item>', ''));
    expect((await fetchBlogPostLinks(3600)).map((post) => post.url)).toEqual([
      'https://openknowledge.ai/blog/markdownlint-support.md',
      'https://openknowledge.ai/blog/edit-mermaid-diagrams-visually.md',
    ]);
  });

  test('says so when a complete feed leaves an item unclosed, so a malformation is not silent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const whole = feed(MARKDOWNLINT, VISIMER);
    const lastClose = whole.lastIndexOf('</item>');
    respondWith(whole.slice(0, lastClose) + whole.slice(lastClose + '</item>'.length));
    await fetchBlogPostLinks(3600);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/leaves an <item> unclosed/);
  });

  test('skips an item that is not a post and keeps the rest, saying which it skipped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith(
      feed(
        MARKDOWNLINT,
        { title: 'Meet the team', link: 'https://openknowledge.ai/team' },
        VISIMER,
      ),
    );

    expect((await fetchBlogPostLinks(3600)).map((post) => post.url)).toEqual([
      'https://openknowledge.ai/blog/markdownlint-support.md',
      'https://openknowledge.ai/blog/edit-mermaid-diagrams-visually.md',
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('"https://openknowledge.ai/team" is not a post at');
  });

  test('keeps the link out of a log line: one line, bounded, quoted', async () => {
    const link = `https://ok.example/blog/${'x'.repeat(500)}\nforged: line`;
    respondWith(feed({ title: 'A', link }));

    const error = (await fetchBlogPostLinks(3600).catch((thrown: unknown) => thrown)) as Error;
    expect(error.message).not.toContain('\n');
    expect(error.message).toContain(JSON.stringify(link.replace(/\s+/g, ' ').slice(0, 200)));
    expect(error.message).not.toContain('x'.repeat(201));
  });

  test('asks the marketing zone for its own feed, revalidating hourly', async () => {
    const fetchMock = respondWith(LIVE_FEED);
    await fetchBlogPostLinks(3600);
    expect(fetchMock).toHaveBeenCalledWith(
      BLOG_FEED_URL,
      expect.objectContaining({ next: { revalidate: 3600 } }),
    );
    expect(BLOG_FEED_URL).toBe('https://openknowledge.ai/blog/rss.xml');
  });

  test('gives up rather than hanging on an origin that never answers', async () => {
    const fetchMock = respondWith(LIVE_FEED);
    await fetchBlogPostLinks(3600);
    const { signal } = fetchMock.mock.calls[0][1] as RequestInit;
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test('fails on an error response instead of reporting an empty blog', async () => {
    respondWith('nope', { status: 503 });
    await expect(fetchBlogPostLinks(3600)).rejects.toThrow('responded 503');
  });

  test('reads an empty feed as a content state', async () => {
    respondWith(feed());
    await expect(fetchBlogPostLinks(3600)).rejects.toThrow(EmptyBlogError);
  });

  test.each([
    [
      'an error page served with a 200',
      '<!doctype html><html><body><h1>Application error</h1></body></html>',
      'is not an RSS feed',
    ],
    [
      'a canonical host that drifted between the two apps',
      feed({ title: 'A', link: 'https://ok.example/blog/a-post' }),
      'canonical host that drifted',
    ],
    [
      'a link outside the blog',
      feed({ title: 'A', link: 'https://openknowledge.ai/team/someone' }),
      'is not a post at',
    ],
    [
      'post URLs that gained a segment',
      feed({ title: 'A', link: 'https://openknowledge.ai/blog/2026/a-post' }),
      'the post URL shape changed',
    ],
    [
      'an item with no title',
      feed({ title: '', link: 'https://openknowledge.ai/blog/a-post' }),
      'no <title> or no <link>',
    ],
    [
      'a response cut inside the first item',
      feed(MARKDOWNLINT).slice(
        0,
        feed(MARKDOWNLINT).indexOf('<link>', feed(MARKDOWNLINT).indexOf('<item')),
      ),
      'ends before </rss>, so it is truncated',
    ],
    [
      'a response cut in the channel header, before any item',
      feed(MARKDOWNLINT).slice(0, feed(MARKDOWNLINT).indexOf('<item')),
      'ends before </rss>, so it is truncated',
    ],
    [
      'a complete feed whose only item never closes',
      feed(MARKDOWNLINT).replace('</item>', ''),
      'leaves an <item> unclosed, so it is malformed',
    ],
  ])('reads %s as drift, not as an empty blog', async (_name, body, expected) => {
    respondWith(body);
    const error = await settle(fetchBlogPostLinks(3600)).catch((thrown: unknown) => thrown);

    expect(error, 'resolved instead of throwing — these links would have published').toBeInstanceOf(
      Error,
    );
    expect(error).not.toBeInstanceOf(EmptyBlogError);
    expect((error as Error).message).toContain(expected);
  });

  test.each([404, 401])('reports a %s as an Error naming the status, once', async (status) => {
    const fetchMock = vi.fn(async () => new Response('nope', { status }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await settle(fetchBlogPostLinks(3600, true)).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`responded ${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('spaces the retries rather than firing them in one burst', async () => {
    const at: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        at.push(Date.now());
        throw new TypeError('fetch failed');
      }),
    );

    await settle(fetchBlogPostLinks(3600, true)).catch(() => undefined);

    expect(at).toHaveLength(3);
    expect([at[1] - at[0], at[2] - at[1]]).toEqual([250, 500]);
  });

  test.each([
    [true, { attempts: 3, timeoutMs: 20_000 }],
    [false, { attempts: 1, timeoutMs: 5_000 }],
  ])('building=%s takes %o', (building, expected) => {
    expect(attemptPolicy(building)).toEqual(expected);
  });

  test('retries a dropped connection before believing it', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls < 3) throw new TypeError('fetch failed');
        return new Response(LIVE_FEED);
      }),
    );

    expect(await settle(fetchBlogPostLinks(3600, true))).toHaveLength(2);
    expect(calls).toBe(3);
  });

  test('does not retry a document it has already read and rejected', async () => {
    const fetchMock = respondWith('<!doctype html><title>oops</title>');
    await expect(settle(fetchBlogPostLinks(3600, true))).rejects.toThrow('is not an RSS feed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a render gives up on the first failure rather than holding itself open', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBlogPostLinks(3600)).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('failure posture', () => {
  function refuseConnection() {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function building(env: { CI?: string; VERCEL?: string; VERCEL_ENV?: string } = {}) {
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    vi.stubEnv('CI', env.CI ?? '');
    vi.stubEnv('VERCEL', env.VERCEL ?? '');
    vi.stubEnv('VERCEL_ENV', env.VERCEL_ENV ?? '');
  }

  test('propagates a fetch failure so a revalidate keeps the last good index', async () => {
    refuseConnection();
    await expect(settle(blogPostLinks(3600))).rejects.toThrow('fetch failed');
  });

  test('builds without the posts when the marketing origin is unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    building();
    refuseConnection();

    expect(await settle(blogPostLinks(3600))).toEqual([]);
    expect(warn.mock.calls[0]?.[0]).toContain('could not be read after 3 attempts');
  });

  test('returns the posts normally during a build that can reach the origin', async () => {
    building();
    respondWith(LIVE_FEED);
    expect(await settle(blogPostLinks(3600))).toHaveLength(2);
  });

  test('a CI build off Vercel never reads the feed, since it publishes nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    building({ CI: 'true' });
    const fetchMock = respondWith(LIVE_FEED);

    expect(await settle(blogPostLinks(3600))).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toContain('CI build off Vercel');
  });

  test('a Vercel build, which also sets CI, still reads the feed', async () => {
    building({ CI: '1', VERCEL: '1', VERCEL_ENV: 'preview' });
    const fetchMock = respondWith(LIVE_FEED);

    expect(await settle(blogPostLinks(3600))).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('fails the production build rather than deploying a blogless index', async () => {
    building({ CI: '1', VERCEL: '1', VERCEL_ENV: 'production' });
    const fetchMock = refuseConnection();

    await expect(settle(blogPostLinks(3600))).rejects.toThrow('refusing to publish');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('the fatal error names the URL, the remedy and the escape hatch', async () => {
    building({ VERCEL_ENV: 'production' });
    refuseConnection();

    const error = (await settle(blogPostLinks(3600)).catch((thrown: unknown) => thrown)) as Error;
    expect(error.message).toContain(BLOG_FEED_URL);
    expect(error.message).toContain('redeploy this commit');
    expect(error.message).toContain('OK_ALLOW_BLOGLESS_LLMS_TXT=1');

    const cause = error.cause as Error;
    expect(cause.message).toContain('after 3 attempts');
    expect((cause.cause as Error).message).toBe('fetch failed');
  });

  test('publishes a production build when the blog is legitimately empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    building({ VERCEL_ENV: 'production' });
    respondWith(feed());

    expect(await settle(blogPostLinks(3600))).toEqual([]);
    expect(warn.mock.calls[0]?.[0]).toContain('the blog lists no posts');
  });

  test('lets an operator publish without the posts, fail-closed', async () => {
    building({ VERCEL_ENV: 'production' });
    refuseConnection();

    vi.stubEnv('OK_ALLOW_BLOGLESS_LLMS_TXT', 'true');
    await expect(settle(blogPostLinks(3600))).rejects.toThrow('refusing to publish');

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('OK_ALLOW_BLOGLESS_LLMS_TXT', '1');
    expect(await settle(blogPostLinks(3600))).toEqual([]);
  });

  test.each([
    'preview',
    'development',
  ])('still builds without the posts on a %s deployment', async (env) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    building({ VERCEL_ENV: env });
    refuseConnection();

    expect(await settle(blogPostLinks(3600))).toEqual([]);
  });
});
