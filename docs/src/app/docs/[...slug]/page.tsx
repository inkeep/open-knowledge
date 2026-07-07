import { createRelativeLink } from 'fumadocs-ui/mdx';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageMarkdownActions } from '@/components/page-markdown-actions';
import { ProductUpdatesForm } from '@/components/product-updates-form';
import { metaDescription, SITE_NAME, SITE_URL, TWITTER_HANDLE } from '@/lib/site';
import { source } from '@/lib/source';
import { getMDXComponents } from '@/mdx-components';

export default async function Page(props: PageProps<'/docs/[...slug]'>) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const hideFooter = page.data.footer === false;

  return (
    <DocsPage
      toc={page.data.toc}
      full={page.data.full}
      tableOfContent={{ footer: <ProductUpdatesForm /> }}
      footer={hideFooter ? { enabled: false } : undefined}
      // PageArticle has no bottom padding of its own; the prev/next footer
      // normally supplies it. Restore breathing room when the footer is hidden.
      article={hideFooter ? { className: 'pb-12' } : undefined}
    >
      <div className="flex items-start justify-between gap-4">
        <DocsTitle>{page.data.title}</DocsTitle>
        <PageMarkdownActions
          className="mt-1.5 shrink-0"
          markdownPath={`${page.url}.md`}
          markdownUrl={`${SITE_URL}${page.url}.md`}
        />
      </div>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps<'/docs/[...slug]'>): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  // Google has ignored <meta name="keywords"> since 2009. Bing/Yandex still
  // consider it — kept for optional per-page hinting on those engines, not
  // load-bearing for SEO. Pages without a frontmatter `keywords` field are
  // unaffected.
  const keywords = page.data.keywords
    ?.split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  const ogImageUrl = `/og/docs/${params.slug.join('/')}`;
  const description = metaDescription(page.data.description);

  return {
    title: page.data.title,
    description,
    keywords,
    alternates: {
      canonical: page.url,
    },
    openGraph: {
      type: 'article',
      siteName: SITE_NAME,
      title: page.data.title,
      description,
      url: page.url,
      images: [ogImageUrl],
    },
    twitter: {
      card: 'summary_large_image',
      site: TWITTER_HANDLE,
      creator: TWITTER_HANDLE,
      title: page.data.title,
      description,
      images: [ogImageUrl],
    },
  };
}
