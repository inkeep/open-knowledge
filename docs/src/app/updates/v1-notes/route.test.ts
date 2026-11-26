import { describe, expect, test } from 'vitest';
import { GET, V1_NOTES_TARGET } from './route';

describe('GET /updates/v1-notes', () => {
  test('redirects 302 to the release notes destination with a 5-minute cache header', () => {
    const response = GET();
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(V1_NOTES_TARGET);
    expect(response.headers.get('location')).toBe('https://openknowledge.ai/docs/changelog');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
  });
});
