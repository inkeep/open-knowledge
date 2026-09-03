import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withMicrofrontends } from '@vercel/microfrontends/next/config';
import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';
import { markdownRewrites } from './src/lib/markdown-routes';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  reactCompiler: {
    panicThreshold: 'all_errors',
  },
  turbopack: {
    root: fileURLToPath(new URL('..', import.meta.url)),
  },
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return {
      beforeFiles: markdownRewrites(),
      afterFiles: [
        {
          source: '/ingest/static/:path*',
          destination: 'https://us-assets.i.posthog.com/static/:path*',
        },
        {
          source: '/ingest/array/:path*',
          destination: 'https://us-assets.i.posthog.com/array/:path*',
        },
        {
          source: '/ingest/:path*',
          destination: 'https://us.i.posthog.com/:path*',
        },
      ],
    };
  },
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
        destination: '/docs/remote-control/overview',
        permanent: true,
      },
      {
        source: '/docs/deploy/remote-access/',
        destination: '/docs/remote-control/overview',
        permanent: true,
      },
      {
        source: '/docs/self-hosting/methods/npm',
        destination: '/docs/remote-control/methods/cli',
        permanent: true,
      },
      {
        source: '/docs/self-hosting/methods/npm/',
        destination: '/docs/remote-control/methods/cli',
        permanent: true,
      },
      {
        source: '/docs/deploy/connecting-agents',
        destination: '/docs/remote-control/connecting-agents',
        permanent: true,
      },
      {
        source: '/docs/deploy/connecting-agents/',
        destination: '/docs/remote-control/connecting-agents',
        permanent: true,
      },
      {
        source: '/docs/self-hosting',
        destination: '/docs/remote-control/overview',
        permanent: true,
      },
      {
        source: '/docs/self-hosting/',
        destination: '/docs/remote-control/overview',
        permanent: true,
      },
      {
        source: '/docs/self-hosting/overview',
        destination: '/docs/remote-control/overview',
        permanent: true,
      },
      {
        source: '/docs/self-hosting/overview/',
        destination: '/docs/remote-control/overview',
        permanent: true,
      },
      {
        source: '/docs/self-hosting/authentication',
        destination: '/docs/remote-control/authentication',
        permanent: true,
      },
      {
        source: '/docs/self-hosting/authentication/',
        destination: '/docs/remote-control/authentication',
        permanent: true,
      },
      {
        source: '/docs/self-hosting/connecting-agents',
        destination: '/docs/remote-control/connecting-agents',
        permanent: true,
      },
      {
        source: '/docs/self-hosting/connecting-agents/',
        destination: '/docs/remote-control/connecting-agents',
        permanent: true,
      },
      {
        source: '/docs/self-hosting/methods/cli',
        destination: '/docs/remote-control/methods/cli',
        permanent: true,
      },
      {
        source: '/docs/self-hosting/methods/cli/',
        destination: '/docs/remote-control/methods/cli',
        permanent: true,
      },
      {
        source: '/docs/self-hosting/methods/docker',
        destination: '/docs/remote-control/methods/docker',
        permanent: true,
      },
      {
        source: '/docs/self-hosting/methods/docker/',
        destination: '/docs/remote-control/methods/docker',
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

const microfrontendsConfig = fileURLToPath(new URL('./microfrontends.json', import.meta.url));

export default existsSync(microfrontendsConfig) ? withMicrofrontends(baseConfig) : baseConfig;
