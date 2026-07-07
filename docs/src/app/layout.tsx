import type { Metadata } from 'next';
import { DM_Sans, Inter, JetBrains_Mono } from 'next/font/google';
import type { Organization, WebSite, WithContext } from 'schema-dts';
import { JsonLd } from '@/components/seo/json-ld';
import {
  GITHUB_URL,
  metaDescription,
  SITE_DESCRIPTION,
  SITE_HEADLINE,
  SITE_NAME,
  SITE_URL,
  TWITTER_HANDLE,
  X_URL,
} from '@/lib/site';
import './global.css';
import { Provider } from './provider';

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-dm-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const orgLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Inkeep',
  url: 'https://inkeep.com',
  logo: 'https://inkeep.com/images/logos/logo-with-text-black.svg',
  description:
    'Ship Agent-powered assistants and automations that boost customer experience and 10x your teams.',
  foundingDate: '2023',
  sameAs: [X_URL, GITHUB_URL],
} satisfies WithContext<Organization>;

const siteLd = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: SITE_NAME,
  alternateName: 'OpenKnowledge Docs',
  url: SITE_URL,
  description: SITE_DESCRIPTION,
} satisfies WithContext<WebSite>;

// Normalize through the same layer as every child route so the root isn't the
// lone description that bypasses metaDescription() (a no-op today at 141 chars).
const SITE_META_DESCRIPTION = metaDescription(SITE_DESCRIPTION);

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — ${SITE_HEADLINE}`,
    template: '%s · OpenKnowledge',
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  icons: {
    icon: '/ok-logo.png',
    apple: '/ok-logo.png',
  },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: `${SITE_NAME} — ${SITE_HEADLINE}`,
    description: SITE_META_DESCRIPTION,
    url: SITE_URL,
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    site: TWITTER_HANDLE,
    creator: TWITTER_HANDLE,
    title: `${SITE_NAME} — ${SITE_HEADLINE}`,
    description: SITE_META_DESCRIPTION,
  },
  verification: {
    google: 'ZeS2oQLq-M3Hut-WpCMBqfn6XhXPMQmRCx8ntea36RI',
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${dmSans.variable} ${inter.variable} ${jetbrainsMono.variable} antialiased scrollbar-thin scrollbar-track-transparent scrollbar-thumb-fd-muted-foreground/30 dark:scrollbar-thumb-fd-muted-foreground/50`}
    >
      <body>
        <JsonLd json={[orgLd, siteLd]} />
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
