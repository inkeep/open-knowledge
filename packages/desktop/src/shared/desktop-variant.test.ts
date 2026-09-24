import { describe, expect, test } from 'vitest';
import {
  DESKTOP_VARIANTS,
  type DesktopVariantName,
  parseDesktopVariantName,
} from './desktop-variant.ts';

describe('desktop variant identities', () => {
  test('keeps Stable on every existing identity', () => {
    expect(DESKTOP_VARIANTS.stable).toMatchObject({
      appId: 'com.inkeep.open-knowledge',
      productName: 'OpenKnowledge',
      artifactName: 'OpenKnowledge',
      protocolScheme: 'openknowledge',
      updateChannel: 'latest',
      cliCommandNames: ['ok', 'open-knowledge'],
    });
  });

  test('gives every variant a disjoint persistent identity', () => {
    const identities = [DESKTOP_VARIANTS.stable, DESKTOP_VARIANTS.beta];
    const keys: Array<keyof (typeof identities)[number]> = [
      'appId',
      'productName',
      'artifactName',
      'packageName',
      'protocolScheme',
      'updateChannel',
      'linuxExecutableName',
    ];
    for (const key of keys) {
      expect(new Set(identities.map((identity) => identity[key])).size).toBe(identities.length);
    }
    expect(new Set(identities.flatMap((identity) => identity.cliCommandNames)).size).toBe(4);
  });

  test('keeps legacy Beta on the original identity and manifest contract', () => {
    expect(DESKTOP_VARIANTS['legacy-beta']).toEqual({
      ...DESKTOP_VARIANTS.stable,
      updateChannel: 'beta',
      feedChannel: 'beta',
    });
    expect(DESKTOP_VARIANTS.beta.feedChannel).toBe('beta-product');
  });

  test.each<[string | undefined, DesktopVariantName]>([
    [undefined, 'stable'],
    ['', 'stable'],
    [' BETA ', 'beta'],
    ['legacy-beta', 'legacy-beta'],
  ])('parses %j as %s', (raw, expected) => {
    expect(parseDesktopVariantName(raw)).toBe(expected);
  });

  test('rejects unknown variants before a build starts', () => {
    expect(() => parseDesktopVariantName('nightly')).toThrow(/stable or beta/);
  });
});
