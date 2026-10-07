import { describe, expect, test } from 'vitest';
import { DESKTOP_VARIANTS } from './desktop-variant.ts';
import { PUBLIC_RELEASES_URL, releasesPageUrl, releaseUrlFor } from './release-links.ts';

describe('release links', () => {
  test('stable and beta builds publish their release pages on the public repository', () => {
    expect(releasesPageUrl(DESKTOP_VARIANTS.stable)).toBe(
      'https://github.com/inkeep/open-knowledge/releases',
    );
    expect(releasesPageUrl(DESKTOP_VARIANTS.beta)).toBe(PUBLIC_RELEASES_URL);
    expect(releasesPageUrl(DESKTOP_VARIANTS['legacy-beta'])).toBe(PUBLIC_RELEASES_URL);
  });

  test('a release tag URL defaults to the public releases page', () => {
    expect(releaseUrlFor('0.83.0-beta.8')).toBe(
      'https://github.com/inkeep/open-knowledge/releases/tag/v0.83.0-beta.8',
    );
  });

  test('a release tag URL is built under the releases page it is given', () => {
    expect(
      releaseUrlFor('0.81.5-cloud.1343', 'https://github.com/inkeep/agents-private/releases'),
    ).toBe('https://github.com/inkeep/agents-private/releases/tag/v0.81.5-cloud.1343');
  });

  test('a release tag URL percent-encodes the version', () => {
    expect(releaseUrlFor('1.2.3/../x')).toBe(
      'https://github.com/inkeep/open-knowledge/releases/tag/v1.2.3%2F..%2Fx',
    );
  });
});
