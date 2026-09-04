import { describe, expect, it } from 'vitest';
import { redactSecrets, SECRET_PATTERN_NAMES, scrubSecrets } from './secret-scrub.ts';

describe('scrubbing a serialized JSON payload', () => {
  it('every replacement leaves the payload parseable with its other fields intact', () => {
    const payloads: Record<string, unknown>[] = [
      { event: 'ok-fs-error', reason: 'EACCES on /Users/alice', docName: 'notes/a' },
      { home: '/Users/bob', db: 'postgres://u:p@h/x' },
      { event: 'ok-x', detail: 'authorization: Bearer abc123', docName: 'notes/b' },
      { event: 'ok-x', authorization: 'Bearer abc123', docName: 'notes/c' },
      { a: '/home/alice', b: { c: 'x/y' } },
      { msg: 'content dir /Users/alice missing entry "plan"' },
      { token: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz', docName: 'notes/d' },
    ];
    for (const payload of payloads) {
      const parsed = JSON.parse(scrubSecrets(JSON.stringify(payload))) as Record<string, unknown>;
      expect(Object.keys(parsed)).toEqual(Object.keys(payload));
    }
  });

  it('masks a bearer token however it is quoted, without breaking the line', () => {
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
    expect(scrubSecrets('/Users/Jane Doe/notes/plan.md')).not.toContain('Jane Doe');
    expect(scrubSecrets('/Users/al\\ice/x')).not.toContain('al\\ice');
    expect(scrubSecrets('/home/Jane Doe/notes')).not.toContain('Jane Doe');
  });

  it('redacts a bearer token whole when it carries a character outside token68', () => {
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
    const json = JSON.stringify({ authorization: 'Bearer "abc:123"', d: 1 });
    const scrubbed = scrubSecrets(json);
    expect(scrubbed).not.toContain('abc:123');
    expect(Object.keys(JSON.parse(scrubbed))).toEqual(['authorization', 'd']);
  });

  it('a bearer prefix at the end of a value does not run into the next key', () => {
    const json = JSON.stringify({ detail: 'authorization: Bearer ', d: 1 });
    expect(Object.keys(JSON.parse(scrubSecrets(json)))).toEqual(['detail', 'd']);
  });

  it('a bearer value containing a quote keeps the record parseable', () => {
    const curl = JSON.stringify({ cmd: 'curl -H "authorization: Bearer TOK" https://x' });
    const scrubbedCurl = scrubSecrets(curl);
    expect(scrubbedCurl).not.toContain('TOK');
    expect(Object.keys(JSON.parse(scrubbedCurl))).toEqual(['cmd']);

    for (const value of ['Bearer abc"def', 'Bearer abc\\def']) {
      const scrubbed = scrubSecrets(JSON.stringify({ authorization: value, d: 1 }));
      expect(scrubbed).not.toContain('abc');
      expect(Object.keys(JSON.parse(scrubbed))).toEqual(['authorization', 'd']);
    }
  });

  it('stopping at a backslash is the right boundary when it begins an escape', () => {
    const scrubbed = scrubSecrets(JSON.stringify({ detail: 'authorization: Bearer TOK\nafter' }));
    expect(scrubbed).not.toContain('TOK');
    expect(JSON.parse(scrubbed).detail).toContain('after');
  });

  it('a home-path collapse cannot consume the URL a credential pattern anchors on', () => {
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

  it('leaves a scrubbed Windows path in a JSON log line still parseable', () => {
    const winPath = String.raw`C:\Users\alice\AppData\Roaming\OpenKnowledge\state.json`;
    const line = JSON.stringify({ err: { code: 'EACCES', path: winPath } });

    const result = redactSecrets(line);
    expect(result.patterns).toContain('windows-home-path');
    expect(result.redacted).not.toContain('alice');
    expect(() => JSON.parse(result.redacted) as unknown).not.toThrow();
    expect((JSON.parse(result.redacted) as { err: { path: string } }).err.path).toBe(
      String.raw`~\AppData\Roaming\OpenKnowledge\state.json`,
    );

    const raw = redactSecrets(`could not read ${winPath}`);
    expect(raw.patterns).toContain('windows-home-path');
    expect(raw.redacted).not.toContain('alice');
  });

  it('scrubs a Windows profile root that ends at the account name', () => {
    const root = String.raw`C:\Users\alice`;

    const quoted = redactSecrets(JSON.stringify({ homedir: root }));
    expect(quoted.patterns).toContain('windows-home-path');
    expect(quoted.redacted).not.toContain('alice');
    expect((JSON.parse(quoted.redacted) as { homedir: string }).homedir).toBe('~');

    const mixed = redactSecrets(JSON.stringify({ homedir: root, userData: `${root}\\AppData` }));
    expect(mixed.redacted).not.toContain('alice');
    expect(JSON.parse(mixed.redacted)).toEqual({ homedir: '~', userData: String.raw`~\AppData` });

    const bare = redactSecrets(`I saved it in ${root}`);
    expect(bare.patterns).toContain('windows-home-path');
    expect(bare.redacted).toBe('I saved it in ~');
  });

  it('leaves the carriage return in place on a CRLF line', () => {
    const prose = redactSecrets('open C:\\Users\\alice failed\r');
    expect(prose.redacted).not.toContain('alice');
    expect(prose.redacted).toBe('open ~\r');

    const bare = redactSecrets('C:\\Users\\alice\r');
    expect(bare.redacted).toBe('~\r');

    const multi = redactSecrets('a C:\\Users\\alice\r\nb C:\\Users\\bob\\AppData\r\n');
    expect(multi.redacted).not.toContain('alice');
    expect(multi.redacted).not.toContain('bob');
    expect(multi.redacted).toBe('a ~\r\nb ~\\AppData\r\n');
  });

  it('scrubs a POSIX home root that ends at the account name', () => {
    const mac = redactSecrets('crashed while reading /Users/alice');
    expect(mac.patterns).toContain('macos-home-path');
    expect(mac.redacted).toBe('crashed while reading ~');

    const linux = redactSecrets('crashed while reading /home/alice');
    expect(linux.patterns).toContain('linux-home-path');
    expect(linux.redacted).toBe('crashed while reading ~');

    const sep = redactSecrets('/Users/alice/notes and /home/bob/notes');
    expect(sep.redacted).toBe('~/notes and ~/notes');
  });

  it('keeps a POSIX match inside its JSON string value', () => {
    const line = JSON.stringify({ a: '/Users/alice', b: '/Users/alice/x' });

    const result = redactSecrets(line);
    expect(result.redacted).not.toContain('alice');
    expect(() => JSON.parse(result.redacted) as unknown).not.toThrow();
    expect(JSON.parse(result.redacted)).toEqual({ a: '~', b: '~/x' });

    const trailing = redactSecrets(JSON.stringify({ p: '/home/alice\\' }));
    expect(trailing.redacted).not.toContain('alice');
    expect(() => JSON.parse(trailing.redacted) as unknown).not.toThrow();
    expect(JSON.parse(trailing.redacted)).toEqual({ p: '~\\' });
  });

  it('does not redact a lowercase REST path segment as a POSIX home root', () => {
    const result = redactSecrets('GET https://api.example.com/users/12345/profile 200');

    expect(result.patterns).toEqual([]);
    expect(result.redacted).toBe('GET https://api.example.com/users/12345/profile 200');
  });

  it('scrubs a lowercase Windows profile root', () => {
    const result = redactSecrets(String.raw`opening c:\users\alice\AppData`);

    expect(result.patterns).toContain('windows-home-path');
    expect(result.redacted).not.toContain('alice');
    expect(result.redacted).toBe(String.raw`opening ~\AppData`);
  });

  it('over-redacts prose after a terminal Windows profile root rather than leaking it', () => {
    const result = redactSecrets(String.raw`profile C:\Users\alice failed, retry`);

    expect(result.redacted).not.toContain('alice');
    expect(result.redacted).toBe('profile ~');
  });

  it('over-redacts prose after a terminal POSIX home root rather than leaking it', () => {
    const result = redactSecrets('profile /home/alice failed, retry');

    expect(result.redacted).not.toContain('alice');
    expect(result.redacted).toBe('profile ~');

    expect(redactSecrets('profile /home/alice failed, retry\\').redacted).toBe('profile ~\\');

    expect(redactSecrets('profile /home/alice failed, retry\\\\').redacted).toBe('profile ~\\\\');
  });

  it('masks both account names when one line carries two home paths', () => {
    expect(scrubSecrets('home=/Users/alice contentDir=/Users/bob/notes')).not.toContain('alice');
    expect(scrubSecrets('home=/Users/alice contentDir=/Users/bob/notes')).not.toContain('bob');
    expect(scrubSecrets(String.raw`a=C:\Users\alice b=C:\Users\bob`)).not.toContain('alice');
    expect(scrubSecrets(String.raw`a=C:\Users\alice b=C:\Users\bob`)).not.toContain('bob');
  });

  it('counts a line carrying two secrets once, not once per matching pattern', () => {
    const result = redactSecrets('ghp_0123456789abcdefghijklmnopqrstuvwxyz in /Users/alice/notes');
    expect(result.patterns).toContain('github-pat');
    expect(result.patterns).toContain('macos-home-path');
    expect(result.lineCount).toBe(1);
  });
});
