import 'posthog-js/dist/posthog-recorder';
import posthog from 'posthog-js/dist/module.no-external';

const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;

if (key) {
  posthog.init(key, {
    api_host: '/ingest',
    ui_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.posthog.com',
    disable_external_dependency_loading: true,
    defaults: '2026-05-30',
  });
}
