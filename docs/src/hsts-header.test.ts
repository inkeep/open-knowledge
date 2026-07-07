import { describe, expect, test } from 'bun:test';
import nextConfig from '../next.config.ts';

/**
 * Chrome blocks a download when ANY hop in its redirect chain is plain http,
 * so a visit starting at http://openknowledge.ai/download/beta gets
 * "Insecure download blocked" for the DMG even though Vercel upgrades to
 * https immediately. The durable fix is HSTS preload-list membership
 * (hstspreload.org), which rewrites navigations to https before the first
 * request. These tests pin the list's eligibility requirements: max-age of
 * at least one year, `includeSubDomains`, and `preload`, served on every
 * path (the list checker fetches `/`). Weakening or scoping down this
 * header silently drops the domain from preload eligibility.
 */
describe('Strict-Transport-Security header (hstspreload.org eligibility)', () => {
  async function getStsRule() {
    const rules = (await nextConfig.headers?.()) ?? [];
    for (const rule of rules) {
      const sts = rule.headers.find((h) => h.key.toLowerCase() === 'strict-transport-security');
      if (sts) return { source: rule.source, value: sts.value };
    }
    return null;
  }

  test('header is configured and covers every path including the root', async () => {
    const rule = await getStsRule();
    expect(rule).not.toBeNull();
    // `/:path*` matches zero or more segments — `/` included, which is the
    // exact URL the preload-list checker inspects.
    expect(rule?.source).toBe('/:path*');
  });

  test('max-age is at least one year (preload-list minimum)', async () => {
    const rule = await getStsRule();
    const maxAge = rule?.value.match(/max-age=(\d+)/)?.[1];
    expect(Number(maxAge)).toBeGreaterThanOrEqual(31536000);
  });

  test('includeSubDomains and preload directives are present', async () => {
    const rule = await getStsRule();
    expect(rule?.value).toContain('includeSubDomains');
    expect(rule?.value).toContain('preload');
  });
});
