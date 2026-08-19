import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withMicrofrontends } from '@vercel/microfrontends/next/config';
import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

// Routing home is `/docs` — this app serves no landing page at `/`. In the
// production deployment the apex `/` is served by a separate app, so `/` never
// reaches this project there; a standalone deployment should set its default
// route to `/docs`.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  reactCompiler: {
    // Fail the build on any compiler diagnostic
    panicThreshold: 'all_errors',
  },
  // PostHog ingestion is proxied through this origin (api_host: '/ingest' in
  // instrumentation-client.ts) so ad-blockers don't drop analytics requests.
  // skipTrailingSlashRedirect keeps PostHog's trailing-slash routes reachable
  // through the rewrites below.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return {
      // Per-page raw Markdown for agents: `/docs/<slug>.md` (and `.mdx`) maps
      // to the markdown route handler at `/llms.mdx/<slug>`. Must run in
      // `beforeFiles` so it wins before the `/docs/[...slug]` page catch-all,
      // which would otherwise match `…/overview.md` as a slug segment and 404.
      beforeFiles: [
        {
          source: '/docs/:path*.md',
          destination: '/llms.mdx/:path*',
        },
        {
          source: '/docs/:path*.mdx',
          destination: '/llms.mdx/:path*',
        },
      ],
      afterFiles: [
        {
          source: '/ingest/static/:path*',
          destination: 'https://us-assets.i.posthog.com/static/:path*',
        },
        {
          source: '/ingest/array/:path*',
          destination: 'https://us-assets.i.posthog.com/array/:path*',
        },
        // Catch-all must come last — the static/array asset rules above must win.
        {
          source: '/ingest/:path*',
          destination: 'https://us.i.posthog.com/:path*',
        },
      ],
    };
  },
  // HSTS with `includeSubDomains; preload` (Vercel's injected default is
  // max-age only). Chrome blocks a download when ANY hop in its redirect
  // chain is plain http — so a visit starting at
  // http://openknowledge.ai/download/beta gets "Insecure download blocked"
  // for the DMG even though Vercel 308s to https immediately. Preload-list
  // membership (hstspreload.org) makes browsers rewrite to https before the
  // first request, removing the http hop entirely; the directives below are
  // the list's eligibility requirements. Subdomain-wide TLS is safe: DNS is
  // a wildcard onto Vercel and every host terminates TLS there.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
  // Redirects for deleted docs pages — the prior `Install` page was folded
  // into Quickstart when the docs pivoted to a desktop-app-first story.
  // Trailing-slash variants are listed explicitly: skipTrailingSlashRedirect
  // (set above for the PostHog proxy) disables Next's automatic slash
  // normalization, so `/path/` no longer falls through to the `/path` rule.
  async redirects() {
    return [
      {
        source: '/docs/get-started/install',
        destination: '/docs/get-started/quickstart',
        permanent: true,
      },
      {
        source: '/docs/get-started/install/',
        destination: '/docs/get-started/quickstart',
        permanent: true,
      },
      {
        source: '/docs/features/templates',
        destination: '/docs/advanced/folders-and-templates',
        permanent: true,
      },
      {
        source: '/docs/features/templates/',
        destination: '/docs/advanced/folders-and-templates',
        permanent: true,
      },
      {
        source: '/docs/get-started/obsidian',
        destination: '/docs/migrate/obsidian',
        permanent: true,
      },
      {
        source: '/docs/get-started/obsidian/',
        destination: '/docs/migrate/obsidian',
        permanent: true,
      },
      {
        source: '/docs/deploy/remote-access',
        destination: '/docs/self-hosting/overview',
        permanent: true,
      },
      {
        source: '/docs/deploy/remote-access/',
        destination: '/docs/self-hosting/overview',
        permanent: true,
      },
      {
        source: '/docs/self-hosting/methods/npm',
        destination: '/docs/self-hosting/methods/cli',
        permanent: true,
      },
      {
        source: '/docs/self-hosting/methods/npm/',
        destination: '/docs/self-hosting/methods/cli',
        permanent: true,
      },
      {
        source: '/docs/deploy/connecting-agents',
        destination: '/docs/self-hosting/connecting-agents',
        permanent: true,
      },
      {
        source: '/docs/deploy/connecting-agents/',
        destination: '/docs/self-hosting/connecting-agents',
        permanent: true,
      },
      {
        source: '/docs/advanced/content-rules/okf',
        destination: '/docs/plugins/okf',
        permanent: true,
      },
      {
        source: '/docs/advanced/content-rules/okf/',
        destination: '/docs/plugins/okf',
        permanent: true,
      },
      // `/download` has no page of its own, so the bare path 404s; forward it
      // to the stable channel. permanent:false (307, not 308) keeps it a soft
      // alias — `/download` can later become a real channel-picker page
      // without a browser-cached permanent redirect getting in the way. Both
      // slash variants are listed because skipTrailingSlashRedirect (above)
      // disables Next's automatic `/path/` → `/path` normalization.
      {
        source: '/download',
        destination: '/download/stable',
        permanent: false,
      },
      {
        source: '/download/',
        destination: '/download/stable',
        permanent: false,
      },
    ];
  },
};

const withMDX = createMDX();
const baseConfig = withMDX(nextConfig);

// `withMicrofrontends` requires a microfrontends.json that declares this app. That
// file names the private marketing app and is a Microfrontends deploy concern of
// agents-private only, so it is excluded from the public mirror — the standalone
// OSS docs build has none. Apply the wrapper only when the config is present,
// leaving the mirror (and any standalone clone) a plain Next.js app.
const microfrontendsConfig = fileURLToPath(new URL('./microfrontends.json', import.meta.url));

export default existsSync(microfrontendsConfig) ? withMicrofrontends(baseConfig) : baseConfig;
