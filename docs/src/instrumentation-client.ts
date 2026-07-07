import posthog from 'posthog-js';

const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;

if (key) {
  posthog.init(key, {
    // Routed through the Next.js rewrite in next.config.ts to avoid ad-blockers
    // dropping requests to the PostHog domain. ui_host keeps in-app links
    // (toolbar, session replay) pointing at the real PostHog UI.
    api_host: '/ingest',
    ui_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.posthog.com',
    // Opt into the current defaults bundle: automatic SPA pageview + pageleave
    // capture for the App Router (no manual usePathname tracking needed).
    defaults: '2026-05-30',
  });
}
