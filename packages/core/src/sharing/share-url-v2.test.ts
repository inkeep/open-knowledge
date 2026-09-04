import { describe, expect, test } from 'vitest';

import corpus from '../../../../test-support/fixtures/share-url-v1-v2.json' with { type: 'json' };
import {
  frozenV1CustomSchemeOutcome,
  frozenV1DecodeShareToken,
} from '../../../../test-support/share/frozen-v1-share-reader.test-helper.ts';
import {
  decodeShareUrl,
  encodeShareUrl,
  InvalidShareUrlError,
  UnsupportedShareVersionError,
} from './share-url.ts';

const v1Shares = corpus.validShares.filter((fixture) => fixture.version === 1);
const v2Shares = corpus.validShares.filter((fixture) => fixture.version === 2);

describe('fixed cross-version corpus', () => {
  test('pins the exact protocol bounds and literal maximum token', () => {
    const { bounds } = corpus;
    expect(bounds.maxCase.token).toHaveLength(bounds.maxV2TokenChars);
    expect(new TextEncoder().encode(bounds.maxCase.sharedUrl)).toHaveLength(
      bounds.maxV2SharedUrlUtf8Bytes,
    );
    expect(
      new TextEncoder().encode(`openknowledge://share?token=${bounds.maxCase.token}`),
    ).toHaveLength(bounds.maxV2CustomUriChars);
    expect(bounds.overLimitToken).toHaveLength(bounds.maxV2TokenChars + 1);
  });

  test.each(v1Shares)('$id stays byte-compatible with the frozen v1 reader', (fixture) => {
    expect(frozenV1DecodeShareToken(fixture.token)).toEqual({
      kind: 'ok',
      version: 1,
      sharedUrl: fixture.sharedUrl,
    });
    expect(decodeShareUrl(fixture.token)).toEqual({
      version: 1,
      sharedUrl: fixture.sharedUrl,
    });
    expect(encodeShareUrl(fixture.sharedUrl)).toBe(fixture.token);
  });

  test.each(corpus.legacyAliases)('$id retains historical v1 tolerance', (fixture) => {
    expect(frozenV1DecodeShareToken(fixture.token)).toEqual({
      kind: 'ok',
      version: 1,
      sharedUrl: fixture.sharedUrl,
    });
    expect(decodeShareUrl(fixture.token)).toEqual({
      version: 1,
      sharedUrl: fixture.sharedUrl,
    });
  });

  test.each(v2Shares)('$id is unsupported to the frozen v1 universal reader', (fixture) => {
    expect(frozenV1DecodeShareToken(fixture.token)).toEqual({
      kind: 'unsupported-version',
      version: 2,
    });
  });

  test.each(
    corpus.customSchemeCases.map((fixture) => [fixture.id, fixture.uri, fixture.baseline] as const),
  )('%s has the pinned frozen custom-scheme outcome', (_id, uri, expected) => {
    expect(frozenV1CustomSchemeOutcome(uri)).toBe(expected);
  });
});

describe('v2 codec and content projection', () => {
  test.each(
    v2Shares,
  )('$id decodes its repository source and content-relative target', (fixture) => {
    expect(decodeShareUrl(fixture.token)).toEqual(
      expect.objectContaining({
        version: 2,
        contentRootDepth: fixture.contentRootDepth,
        sharedUrl: fixture.sharedUrl,
        target: fixture.target,
      }),
    );
  });

  test.each(v2Shares)('$id encodes to the fixed literal token', (fixture) => {
    expect(encodeShareUrl(fixture.sharedUrl, fixture.contentRootDepth)).toBe(fixture.token);
  });

  test('depth zero continues to select the exact historical v1 representation', () => {
    const fixture = v1Shares[0];
    expect(encodeShareUrl(fixture.sharedUrl, 0)).toBe(fixture.token);
  });

  test('accepts the exact maximum v2 payload and projects its document target', () => {
    expect(decodeShareUrl(corpus.bounds.maxCase.token)).toEqual(
      expect.objectContaining({
        version: 2,
        contentRootDepth: 1,
        sharedUrl: corpus.bounds.maxCase.sharedUrl,
        target: corpus.bounds.maxCase.target,
      }),
    );
    expect(encodeShareUrl(corpus.bounds.maxCase.sharedUrl, 1)).toBe(corpus.bounds.maxCase.token);
  });

  test('rejects input one character over the v2 token bound before decoding it', () => {
    expect(() => decodeShareUrl(corpus.bounds.overLimitToken)).toThrow(
      new InvalidShareUrlError('Share token exceeds the v2 size limit'),
    );
  });

  test('retains unbounded historical v1 decoding beyond the v2 token ceiling', () => {
    const sharedUrl = `https://github.com/o/r/blob/main/${'a'.repeat(4000)}.md`;
    const token = encodeShareUrl(sharedUrl);
    expect(token.length).toBeGreaterThan(corpus.bounds.maxV2TokenChars);
    expect(decodeShareUrl(token)).toEqual({ version: 1, sharedUrl });
  });

  test('rejects obviously oversized v2 input before URL parsing', () => {
    expect(() => encodeShareUrl('x'.repeat(2986), 1)).toThrow(
      new InvalidShareUrlError('Share URL exceeds the v2 URL size limit'),
    );
  });
});

describe('v2 trust-boundary classification', () => {
  test.each(corpus.invalidTokens)('$id is invalid rather than unsupported', (fixture) => {
    expect(() => decodeShareUrl(fixture.token)).toThrow(InvalidShareUrlError);
  });

  test.each(
    corpus.invalidTokens.filter(
      (
        fixture,
      ): fixture is typeof fixture & {
        readonly sharedUrl: string;
        readonly contentRootDepth: number;
      } => fixture.sharedUrl !== undefined && fixture.contentRootDepth !== undefined,
    ),
  )('$id cannot be minted as a second spelling', (fixture) => {
    expect(() => encodeShareUrl(fixture.sharedUrl, fixture.contentRootDepth)).toThrow(
      InvalidShareUrlError,
    );
  });

  test.each(corpus.unsupportedTokens)('$id remains an unsupported future version', (fixture) => {
    let caught: unknown;
    try {
      decodeShareUrl(fixture.token);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsupportedShareVersionError);
    expect((caught as UnsupportedShareVersionError).version).toBe(fixture.version);
  });

  test('rejects a noncanonical base64url alias even when it decodes to valid v2 bytes', () => {
    const fixture = corpus.invalidTokens.find(
      (candidate) => candidate.id === 'v2-noncanonical-base64-alias',
    );
    expect(fixture).toBeDefined();
    expect(() => decodeShareUrl(fixture?.token ?? '')).toThrow(InvalidShareUrlError);
  });

  test('rejects encoded traversal before WHATWG URL normalization can erase it', () => {
    const fixture = corpus.invalidTokens.find(
      (candidate) => candidate.id === 'v2-target-encoded-dotdot',
    );
    expect(fixture).toBeDefined();
    expect(() => decodeShareUrl(fixture?.token ?? '')).toThrow(InvalidShareUrlError);
  });
});
