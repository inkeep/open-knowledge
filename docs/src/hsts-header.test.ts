import { describe, expect, test } from 'vitest';
import nextConfig from '../next.config.ts';

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
