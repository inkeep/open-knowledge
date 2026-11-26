import { describe, expect, test } from 'vitest';
import { GET, V1_GUIDE_TARGET } from './route';

describe('GET /updates/v1-guide', () => {
  test('redirects 302 to the v0-to-v1 migration guide with a 5-minute cache header', () => {
    const response = GET();
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(V1_GUIDE_TARGET);
    expect(response.headers.get('location')).toBe(
      'https://docs.openknowledge.com/migrate/v0-to-v1',
    );
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
  });
});
