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
  'windows-home-path': {
    // JSON-escaped, which is the form the NDJSON log sinks actually write and
    // the one a single-backslash rule would miss.
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
    // The `:` is what does the work: it sits outside BOTH `[A-Za-z0-9]` and RFC
    // 6750's `b64token` alphabet, so either narrowing ends the match there and
    // ships the rest. The `/` is inside `b64token` and outside `[A-Za-z0-9]`,
    // and being later in the token it is inert against both narrowings named
    // here — it is carried for the narrowing that admits `:` but not `/`. A
    // pure-alphanumeric fixture survives all of them and reports nothing.
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

// Long enough that no fixture's surviving context collides with a window by
// accident, short enough to catch the tail a mid-run narrowing ships.
//
// This is an OBLIGATION ON EACH FIXTURE, not a property of the loop: it catches
// any surviving run of six or more, so a fixture must keep its
// class-distinguishing characters at least this far from its end. Park them
// closer and a narrowing that still clears the pattern's quantifier floor ships
// a tail too short for any window, and every assertion here stays green — the
// head is gone, so `not.toContain(secret)` passes, and the pattern still fired,
// so the attribution check passes too.
//
// Raising this value is the same trap from the other side, which is why the
// completeness check below pins it against the fixture set rather than leaving
// it free.
const FRAGMENT_WINDOW = 6;

/** A fixture already in serialized form, which the wrapping loop skips. */
const isSerializedPayload = (value: string): boolean => value.trimStart().startsWith('{');

describe('secret-pattern canary', () => {
  it('plants a canary for every named pattern (adding a pattern without one fails here)', () => {
    expect([...SECRET_PATTERN_NAMES].sort()).toEqual(Object.keys(PLANTED).sort());
  });

  it('keeps every planted secret long enough for the fragment loop to run on it', () => {
    // Pins `FRAGMENT_WINDOW` upward. A lower value fails loudly (windows start
    // colliding with surrounding context), but a higher one fails SILENTLY: a
    // secret shorter than the window yields no windows at all, so the fixture
    // drops out of the fragment check while its test stays green. Raising the
    // window to 8, 13 or 26 each drops a different slice of the set.
    const tooShort = Object.entries(PLANTED)
      .filter(([, { secret }]) => secret.length < FRAGMENT_WINDOW)
      .map(([name]) => name);
    expect(tooShort).toEqual([]);
  });

  for (const [name, { input, secret, marker }] of Object.entries(PLANTED)) {
    const survivalSuffix = isSerializedPayload(input) ? ' without breaking the record' : '';
    it(`scrubs a planted ${name}${survivalSuffix}`, () => {
      // Planted-positive control: the raw token really is present pre-scrub, so
      // a canary that silently stopped containing its own secret can't pass.
      expect(input).toContain(secret);

      const scrubbed = scrubSecrets(input);
      expect(scrubbed).not.toContain(secret);
      expect(scrubbed).toContain(marker);

      // No 6-character run of the token survives either. `not.toContain(secret)`
      // alone passes on a partial redaction — a narrowed character class stops
      // at the first character outside it, ships the tail, and still reports the
      // pattern as having fired, which is worse than a clean miss. Slid rather
      // than split on non-alphanumerics: a narrowing that stops PART WAY through
      // a run leaves a tail that every whole-run check still passes, and the
      // home-path secrets have no alphanumeric run this long to split out at all.
      for (let i = 0; i + FRAGMENT_WINDOW <= secret.length; i++) {
        expect(scrubbed).not.toContain(secret.slice(i, i + FRAGMENT_WINDOW));
      }

      // A fixture that is ALREADY a serialized payload never reaches the wrapping
      // loop below, so it gets the record-survives property here instead. Without
      // this, `bearer-token-json` — the one pattern named for JSON — is the only
      // planted secret `JSON.parse` is never called on anywhere in this file.
      if (isSerializedPayload(input)) {
        expect(Object.keys(JSON.parse(scrubbed))).toEqual(Object.keys(JSON.parse(input)));
      }

      // The line-wise redactor must attribute the hit to this pattern by name.
      expect(redactSecrets(input).patterns).toContain(name);
    });
  }

  for (const [name, { input, secret }] of Object.entries(PLANTED)) {
    // A fixture that is already a serialized payload gets its parse assertion in
    // the loop above instead. Wrapping it again would model a JSON document
    // nested inside a JSON string value, where the inner quotes arrive escaped
    // and no key-anchored pattern can see them — a real but separate limitation,
    // and not what this loop is for.
    if (isSerializedPayload(input)) continue;

    it(`scrubs a planted ${name} inside serialized JSON without breaking the record`, () => {
      // The renderer-log chokepoint scrubs a serialized console payload BEFORE
      // parsing it, so every pattern runs against JSON as well as free text.
      // Both halves matter and neither is implied by the free-text case above:
      // the secret must go, AND the surrounding record must survive — a body
      // that can cross a `"` runs out of the value it matched and either
      // deletes the next field or leaves nothing parseable at all.
      const payload = JSON.stringify({ event: 'ok-canary', detail: input, docName: 'notes/a' });
      // Planted-positive control, as in the loop above and for a sharper reason
      // here: `JSON.stringify` ESCAPES a `\"` or `\\`, so a future fixture
      // carrying either survives serialization in a form the raw secret no
      // longer matches. Both assertions below would then pass without the scrub
      // having done anything. Every fixture is escape-free ASCII today, which is
      // exactly why nothing would notice when one stops being.
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
