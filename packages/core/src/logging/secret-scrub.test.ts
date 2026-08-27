import { describe, expect, it } from 'vitest';
import { redactSecrets, SECRET_PATTERN_NAMES, scrubSecrets } from './secret-scrub.ts';

describe('scrubbing a serialized JSON payload', () => {
  // The renderer-log chokepoint scrubs a serialized console payload BEFORE
  // parsing it, which is the only order in which the patterns anchored on the
  // JSON wire form can fire. That order rests on one property of this list, so
  // the property is asserted here rather than left to each pattern's author: a
  // body that can cross a `"` runs out of the value it matched, and the cost is
  // a mangled record — a field silently deleted from a line that still parses,
  // or a line that no longer parses at all.
  it('every replacement leaves the payload parseable with its other fields intact', () => {
    const payloads: Record<string, unknown>[] = [
      { event: 'ok-fs-error', reason: 'EACCES on /Users/alice', docName: 'notes/a' },
      { home: '/Users/bob', db: 'postgres://u:p@h/x' },
      { event: 'ok-x', detail: 'authorization: Bearer abc123', docName: 'notes/b' },
      { event: 'ok-x', authorization: 'Bearer abc123', docName: 'notes/c' },
      { a: '/home/alice', b: { c: 'x/y' } },
      { token: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz', docName: 'notes/d' },
    ];
    for (const payload of payloads) {
      const parsed = JSON.parse(scrubSecrets(JSON.stringify(payload))) as Record<string, unknown>;
      expect(Object.keys(parsed)).toEqual(Object.keys(payload));
    }
  });

  it('masks a bearer token however it is quoted, without breaking the line', () => {
    // A class that excludes the quote cannot START on one, so a quoted token was
    // not matched at all; and against an escaped quote it took the backslash,
    // producing a line that neither parsed nor redacted. Both shapes reach this
    // through arbitrary renderer console JSON.
    const shapes = [
      'Authorization: Bearer abc123',
      'Authorization: Bearer "abc123"',
      JSON.stringify({ detail: 'authorization: Bearer "abc123"', d: 1 }),
      JSON.stringify({ detail: 'authorization: Bearer abc123', d: 1 }),
      JSON.stringify({ authorization: 'Bearer "abc123"', d: 1 }),
    ];
    for (const shape of shapes) {
      const scrubbed = scrubSecrets(shape);
      expect(scrubbed).not.toContain('abc123');
      if (shape.startsWith('{')) expect(() => JSON.parse(scrubbed)).not.toThrow();
    }
  });

  it('masks a home directory whose account name contains a space or a backslash', () => {
    // Both are legal in an account name, and these are the file's only privacy
    // patterns — excluding either from the body stops the name being masked.
    expect(scrubSecrets('/Users/Jane Doe/notes/plan.md')).not.toContain('Jane Doe');
    expect(scrubSecrets('/Users/al\\ice/x')).not.toContain('al\\ice');
    expect(scrubSecrets('/home/Jane Doe/notes')).not.toContain('Jane Doe');
  });

  it('redacts a bearer token whole when it carries a character outside token68', () => {
    // A body spelling out what a token may BE ends at the first character
    // outside that set, so the tail ships — while the audit still records the
    // pattern as having fired over that line. A fragment reported as redacted
    // is worse than a clean miss. Opaque vendor tokens and URL-encoded copies
    // are the exposed class; JWTs and the prefixed vendor formats are not.
    for (const token of ['abc:123', 'ab%2Fcd', 'a=b/c+d']) {
      expect(scrubSecrets(`Authorization: Bearer ${token}`)).toBe(
        'Authorization: Bearer [REDACTED]',
      );
      const json = JSON.stringify({ authorization: `Bearer ${token}`, d: 1 });
      const scrubbed = scrubSecrets(json);
      expect(scrubbed).not.toContain(token);
      expect(Object.keys(JSON.parse(scrubbed))).toEqual(['authorization', 'd']);
    }
  });

  it('an escaped-quoted bearer value is redacted and still leaves the line parseable', () => {
    // The lone backslash of an escaped quote used to be taken as the token's
    // first character, producing a line that neither parsed nor redacted.
    const json = JSON.stringify({ authorization: 'Bearer "abc:123"', d: 1 });
    const scrubbed = scrubSecrets(json);
    expect(scrubbed).not.toContain('abc:123');
    expect(Object.keys(JSON.parse(scrubbed))).toEqual(['authorization', 'd']);
  });

  it('a bearer prefix at the end of a value does not run into the next key', () => {
    // The quoted branch's opening `"` can bind a value's CLOSING delimiter. With
    // a permissive body it would then consume the comma and swallow the key
    // after it, which is why that one branch stays narrow.
    const json = JSON.stringify({ detail: 'authorization: Bearer ', d: 1 });
    expect(Object.keys(JSON.parse(scrubSecrets(json)))).toEqual(['detail', 'd']);
  });

  it('a bearer value containing a quote keeps the record parseable', () => {
    // The bare branch must not contain a backslash ANYWHERE, not merely start
    // on one: taking the `\` of a `\"` escape leaves the value's closing quote
    // exposed and the line stops parsing. The shape to worry about in a real
    // log is a quoted header inside a value, which this now handles whole.
    const curl = JSON.stringify({ cmd: 'curl -H "authorization: Bearer TOK" https://x' });
    const scrubbedCurl = scrubSecrets(curl);
    expect(scrubbedCurl).not.toContain('TOK');
    expect(Object.keys(JSON.parse(scrubbedCurl))).toEqual(['cmd']);

    // A token carrying a quote or a backslash of its own is not a real
    // credential shape — `b64token` excludes both — and bounding on them is
    // what buys parse safety everywhere else. So the tail after one survives,
    // which is accepted: the record stays intact and readable, where an
    // unbounded body destroyed it.
    for (const value of ['Bearer abc"def', 'Bearer abc\\def']) {
      const scrubbed = scrubSecrets(JSON.stringify({ authorization: value, d: 1 }));
      expect(scrubbed).not.toContain('abc');
      expect(Object.keys(JSON.parse(scrubbed))).toEqual(['authorization', 'd']);
    }
  });

  it('stopping at a backslash is the right boundary when it begins an escape', () => {
    // The same bound that costs a tail on a malformed token is correct here:
    // the escape starts content that is not the token, so the match ends where
    // the token does.
    const scrubbed = scrubSecrets(JSON.stringify({ detail: 'authorization: Bearer TOK\nafter' }));
    expect(scrubbed).not.toContain('TOK');
    expect(JSON.parse(scrubbed).detail).toContain('after');
  });

  it('a home-path collapse cannot consume the URL a credential pattern anchors on', () => {
    // The cosmetic path patterns run last for this reason: greedy, an unbounded
    // home-path body reached across the `://` and left the URL-credential
    // pattern nothing to match, shipping the credential verbatim.
    const scrubbed = scrubSecrets(JSON.stringify({ home: '/Users/bob', db: 'postgres://u:p@h/x' }));
    expect(scrubbed).not.toContain('u:p@h');
  });
});

describe('scrubSecrets', () => {
  it('leaves credential-free text unchanged', () => {
    const clean = 'bridge drain settled: 3 docs converged';
    expect(scrubSecrets(clean)).toBe(clean);
  });

  it('removes a GitHub personal access token', () => {
    const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const scrubbed = scrubSecrets(`token was ${secret} sent`);
    expect(scrubbed).not.toContain(secret);
    expect(scrubbed).toContain('[REDACTED-GH-PAT]');
  });

  it('removes an Anthropic API key and URL-embedded credentials', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';
    const scrubbed = scrubSecrets(`key=${key} url=https://user:hunter2@host/db`);
    expect(scrubbed).not.toContain(key);
    expect(scrubbed).not.toContain('hunter2');
    expect(scrubbed).toContain('[REDACTED-ANTHROPIC]');
    expect(scrubbed).toContain('://[REDACTED]@');
  });

  it('is idempotent: re-scrubbing already-scrubbed text is a no-op', () => {
    const once = scrubSecrets('leaked ghp_0123456789abcdefghijklmnopqrstuvwxyz here');
    expect(scrubSecrets(once)).toBe(once);
  });

  it('returns the redacted text of the shared line-wise redactor', () => {
    const input = 'a\nghp_0123456789abcdefghijklmnopqrstuvwxyz\nb';
    expect(scrubSecrets(input)).toBe(redactSecrets(input).redacted);
  });
});

describe('redactSecrets', () => {
  it('reports which named patterns matched with a per-line count', () => {
    const result = redactSecrets(
      'line one clean\nghp_0123456789abcdefghijklmnopqrstuvwxyz\n/Users/alice/notes',
    );
    expect(result.patterns).toContain('github-pat');
    expect(result.patterns).toContain('macos-home-path');
    expect(result.lineCount).toBe(2);
    expect(SECRET_PATTERN_NAMES).toContain('github-pat');
  });

  it('counts a line carrying two secrets once, not once per matching pattern', () => {
    // `lineCount` is a distinct-modified-line count surfaced to users as
    // "N line(s) scrubbed" — a single line with a token and a home path is one
    // scrubbed line, not two.
    const result = redactSecrets('ghp_0123456789abcdefghijklmnopqrstuvwxyz in /Users/alice/notes');
    expect(result.patterns).toContain('github-pat');
    expect(result.patterns).toContain('macos-home-path');
    expect(result.lineCount).toBe(1);
  });
});
