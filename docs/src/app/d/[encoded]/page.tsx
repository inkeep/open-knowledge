import type { Metadata } from 'next';
import { buildShareDescription, buildSplashViewModel } from '@/lib/share-splash';
import { metaDescription, SITE_NAME, SITE_URL, TWITTER_HANDLE } from '@/lib/site';
import { SplashFallback, SplashShareView } from './splash-share-view';

export const dynamic = 'force-static';

interface SplashPageProps {
  params: Promise<{ encoded: string }>;
}

export async function generateMetadata({ params }: SplashPageProps): Promise<Metadata> {
  const { encoded } = await params;
  const view = buildSplashViewModel(encoded);

  if (view.kind !== 'ok') {
    const fallbackDescription = metaDescription(
      'Open shared documents and folders with OpenKnowledge, the AI-native markdown IDE and LLM wiki.',
    );
    return {
      title: { absolute: SITE_NAME },
      description: fallbackDescription,
      robots: { index: false, follow: true },
      openGraph: {
        siteName: SITE_NAME,
        title: SITE_NAME,
        description: fallbackDescription,
        url: `${SITE_URL}/d/${encoded}`,
        type: 'website',
      },
      twitter: {
        card: 'summary_large_image',
        site: TWITTER_HANDLE,
        creator: TWITTER_HANDLE,
        title: SITE_NAME,
        description: fallbackDescription,
      },
    };
  }

  const description = metaDescription(buildShareDescription(view));

  return {
    title: view.filename,
    description,
    robots: { index: false, follow: true },
    openGraph: {
      siteName: SITE_NAME,
      title: view.filename,
      description,
      url: `${SITE_URL}/d/${encoded}`,
      type: 'article',
    },
    twitter: {
      card: 'summary_large_image',
      site: TWITTER_HANDLE,
      creator: TWITTER_HANDLE,
      title: view.filename,
      description,
    },
  };
}

export default async function SplashPage({ params }: SplashPageProps) {
  const { encoded } = await params;
  const view = buildSplashViewModel(encoded);

  if (view.kind === 'unsupported-version') {
    return <SplashFallback heading="Update OpenKnowledge to open this share." />;
  }

  if (view.kind === 'invalid') {
    return <SplashFallback heading="Invalid share URL." />;
  }

  return <SplashShareView encoded={encoded} view={view} />;
}
