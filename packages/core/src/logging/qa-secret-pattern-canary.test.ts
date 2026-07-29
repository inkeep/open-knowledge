/**
 * Exhaustive canary for every entry in `SECRET_PATTERNS`.
 *
 * Each pattern is live in the redactor and relied on by the diagnostic bundle,
 * so a regex that stopped matching (an anchor change, a character-class
 * narrowing, a dropped entry) would ship a live credential silently unless
 * something plants a matching token.
 *
 * `PLANTED` is keyed by pattern name and cross-checked against
 * `SECRET_PATTERN_NAMES`, so adding a pattern without a canary fails here
 * rather than quietly widening the untested set.
 */

import { describe, expect, it } from 'vitest';
import { redactSecrets, SECRET_PATTERN_NAMES, scrubSecrets } from './secret-scrub.ts';

/** One planted, secret-shaped token per named pattern, with the token that must vanish. */
const PLANTED: Record<string, { input: string; secret: string; marker: string }> = {
  'macos-home-path': {
    input: 'opened /Users/alice/notes/plan.md',
    secret: '/Users/alice/',
    marker: '~/',
  },
  'linux-home-path': {
    input: 'opened /home/alice/notes/plan.md',
    secret: '/home/alice/',
    marker: '~/',
  },
  'github-pat': {
    input: 'token was ghp_0123456789abcdefghijklmnopqrstuvwxyz sent',
    secret: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz',
    marker: '[REDACTED-GH-PAT]',
  },
  'aws-access-key': {
    input: 'creds AKIAIOSFODNN7EXAMPLE here',
    secret: 'AKIAIOSFODNN7EXAMPLE',
    marker: '[REDACTED-AWS-KEY]',
  },
  'anthropic-key': {
    input: 'key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
    secret: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
    marker: '[REDACTED-ANTHROPIC]',
  },
  'openai-key': {
    input: 'key=sk-abcdefghijklmnopqrstuvwxyz012345',
    secret: 'sk-abcdefghijklmnopqrstuvwxyz012345',
    marker: '[REDACTED-OPENAI]',
  },
  'bearer-token': {
    input: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
    secret: 'abcdefghijklmnopqrstuvwxyz0123456789',
    marker: '[REDACTED',
  },
  jwt: {
    input:
      'jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    secret: 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ',
    marker: '[REDACTED',
  },
  'url-credentials': {
    input: 'url=https://user:hunter2@host/db',
    secret: 'hunter2',
    marker: '://[REDACTED]@',
  },
  'github-pat-fine-grained': {
    input: 'token github_pat_11ABCDEFG0aBcDeFgHiJ012345_kLmNoPqRsTuVwXyZ sent',
    secret: 'github_pat_11ABCDEFG0aBcDeFgHiJ012345_kLmNoPqRsTuVwXyZ',
    marker: '[REDACTED-GH-PAT]',
  },
  'openai-key-modern': {
    input: 'key=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD',
    secret: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD',
    marker: '[REDACTED-OPENAI]',
  },
  'slack-token': {
    input: 'slack xoxb-24209812345-67890abcdefXYZ token',
    secret: 'xoxb-24209812345-67890abcdefXYZ',
    marker: '[REDACTED-SLACK]',
  },
  'google-api-key': {
    input: 'gkey AIzaSyA1B2C3D4E5F6G7H8I9J0KLMNOPQRSTUVW here',
    secret: 'AIzaSyA1B2C3D4E5F6G7H8I9J0KLMNOPQRSTUVW',
    marker: '[REDACTED-GOOGLE]',
  },
  'stripe-secret-key': {
    input: 'stripe sk_live_abcdefghij0123456789 here',
    secret: 'sk_live_abcdefghij0123456789',
    marker: '[REDACTED-STRIPE]',
  },
  'gitlab-pat': {
    input: 'gitlab glpat-abcdefghij0123456789XYZ done',
    secret: 'glpat-abcdefghij0123456789XYZ',
    marker: '[REDACTED-GITLAB]',
  },
  'bearer-token-json': {
    input: '{"authorization":"Bearer opaqueBearerToken1234567890abcXYZ","k":1}',
    secret: 'opaqueBearerToken1234567890abcXYZ',
    marker: '[REDACTED',
  },
};

describe('secret-pattern canary', () => {
  it('plants a canary for every named pattern (adding a pattern without one fails here)', () => {
    expect([...SECRET_PATTERN_NAMES].sort()).toEqual(Object.keys(PLANTED).sort());
  });

  for (const [name, { input, secret, marker }] of Object.entries(PLANTED)) {
    it(`scrubs a planted ${name}`, () => {
      // Planted-positive control: the raw token really is present pre-scrub, so
      // a canary that silently stopped containing its own secret can't pass.
      expect(input).toContain(secret);

      const scrubbed = scrubSecrets(input);
      expect(scrubbed).not.toContain(secret);
      expect(scrubbed).toContain(marker);

      // The line-wise redactor must attribute the hit to this pattern by name.
      expect(redactSecrets(input).patterns).toContain(name);
    });
  }

  it('scrubs every planted secret when they arrive together in one blob', () => {
    const blob = Object.values(PLANTED)
      .map((p) => p.input)
      .join('\n');
    const scrubbed = scrubSecrets(blob);
    for (const { secret } of Object.values(PLANTED)) {
      expect(scrubbed).not.toContain(secret);
    }
    expect(redactSecrets(blob).patterns.sort()).toEqual([...SECRET_PATTERN_NAMES].sort());
  });
});
