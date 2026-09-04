import { describe, expect, it } from 'vitest';
import { redactSecrets, SECRET_PATTERN_NAMES, scrubSecrets } from './secret-scrub.ts';

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
  'windows-home-path': {
    input: String.raw`{"path":"C:\\Users\\alice\\AppData\\Roaming\\OpenKnowledge\\state.json"}`,
    secret: String.raw`C:\\Users\\alice`,
    marker: '~',
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
    input: 'Authorization: Bearer abcdef:ghijkl/mnopqrstuvwxyz0123456789',
    secret: 'abcdef:ghijkl/mnopqrstuvwxyz0123456789',
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
    input: 'key=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF',
    secret: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF',
    marker: '[REDACTED-OPENAI]',
  },
  'slack-token': {
    input: 'slack xoxb-24209812345-67890abcdefXYZABC token',
    secret: 'xoxb-24209812345-67890abcdefXYZABC',
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
    input: 'gitlab glpat-abcdefghij0123456789XYZABC done',
    secret: 'glpat-abcdefghij0123456789XYZABC',
    marker: '[REDACTED-GITLAB]',
  },
  'bearer-token-json': {
    input: '{"authorization":"Bearer opaque:Tokenv1/1234567890abcXYZ","k":1}',
    secret: 'opaque:Tokenv1/1234567890abcXYZ',
    marker: '[REDACTED',
  },
};

const FRAGMENT_WINDOW = 6;

const isSerializedPayload = (value: string): boolean => value.trimStart().startsWith('{');

describe('secret-pattern canary', () => {
  it('plants a canary for every named pattern (adding a pattern without one fails here)', () => {
    expect([...SECRET_PATTERN_NAMES].sort()).toEqual(Object.keys(PLANTED).sort());
  });

  it('keeps every planted secret long enough for the fragment loop to run on it', () => {
    const tooShort = Object.entries(PLANTED)
      .filter(([, { secret }]) => secret.length < FRAGMENT_WINDOW)
      .map(([name]) => name);
    expect(tooShort).toEqual([]);
  });

  for (const [name, { input, secret, marker }] of Object.entries(PLANTED)) {
    const survivalSuffix = isSerializedPayload(input) ? ' without breaking the record' : '';
    it(`scrubs a planted ${name}${survivalSuffix}`, () => {
      expect(input).toContain(secret);

      const scrubbed = scrubSecrets(input);
      expect(scrubbed).not.toContain(secret);
      expect(scrubbed).toContain(marker);

      for (let i = 0; i + FRAGMENT_WINDOW <= secret.length; i++) {
        expect(scrubbed).not.toContain(secret.slice(i, i + FRAGMENT_WINDOW));
      }

      if (isSerializedPayload(input)) {
        expect(Object.keys(JSON.parse(scrubbed))).toEqual(Object.keys(JSON.parse(input)));
      }

      expect(redactSecrets(input).patterns).toContain(name);
    });
  }

  for (const [name, { input, secret }] of Object.entries(PLANTED)) {
    if (isSerializedPayload(input)) continue;

    it(`scrubs a planted ${name} inside serialized JSON without breaking the record`, () => {
      const payload = JSON.stringify({ event: 'ok-canary', detail: input, docName: 'notes/a' });
      expect(payload).toContain(secret);
      const scrubbed = scrubSecrets(payload);
      expect(scrubbed).not.toContain(secret);
      expect(Object.keys(JSON.parse(scrubbed))).toEqual(['event', 'detail', 'docName']);
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
