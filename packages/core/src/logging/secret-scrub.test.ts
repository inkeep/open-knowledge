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
      // An escaped quote inside the value: a body that stops on the backslash
      // takes it, and the content quote left behind closes the string early.
      { msg: 'content dir /Users/alice missing entry "plan"' },
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

  it('leaves a scrubbed Windows path in a JSON log line still parseable', () => {
    // The bug-bundle stages NDJSON log files and triage reads them back as
    // JSON, so a rule that swaps a doubled separator for a single one turns
    // every affected line into an invalid escape. The account name still has
    // to go, on both the raw and the JSON-escaped form of the same path.
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
    // `os.homedir()` and `USERPROFILE` both stop at the account name, so this
    // is the form the value most often takes. A rule that only terminates on a
    // trailing separator matches none of these and leaks the account name from
    // the two places it is most likely to appear: a serialised path field, and
    // a bug note the reporter typed by hand.
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
    // Content is split on `\n` alone, so a CRLF line arrives here still holding
    // its `\r`. The run has to stop before it rather than consume it, or the
    // one redacted line silently converts to LF while the rest of the file
    // keeps CRLF. The carriage return is also why the run excludes it and the
    // alternation admits it together: exclude it alone and there is nowhere for
    // the run to stop, so the match fails and the account name survives.
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
    // Same shape as the Windows root above, and the same reason: `os.homedir()`
    // stops at the account name on every platform. A rule that only terminates
    // on a trailing separator leaks it from exactly the two places it is most
    // likely to appear.
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
    // Without the quote terminator the run crosses the closing quote and eats
    // every field after it, which both destroys the structure triage reads and
    // leaves the account name sitting in what survives. The two-field case is
    // the one that shows it, since a single field hides the damage.
    const line = JSON.stringify({ a: '/Users/alice', b: '/Users/alice/x' });

    const result = redactSecrets(line);
    expect(result.redacted).not.toContain('alice');
    expect(() => JSON.parse(result.redacted) as unknown).not.toThrow();
    expect(JSON.parse(result.redacted)).toEqual({ a: '~', b: '~/x' });

    // And with the value ending ON a backslash, which is the form a path
    // actually carries once stringified. This is where the two halves meet:
    // the run stops at the closing quote AND hands its trailing backslashes
    // back, so the escape pair survives and the string still closes. Pinned
    // apart from the bare-prose give-back because a future edit that branches
    // on the terminator could break the conjunction while both halves pass.
    const trailing = redactSecrets(JSON.stringify({ p: '/home/alice\\' }));
    expect(trailing.redacted).not.toContain('alice');
    expect(() => JSON.parse(trailing.redacted) as unknown).not.toThrow();
    expect(JSON.parse(trailing.redacted)).toEqual({ p: '~\\' });
  });

  it('does not redact a lowercase REST path segment as a POSIX home root', () => {
    // The counterweight to the Windows rule's case-insensitivity, and the
    // reason the two POSIX rules cannot copy it: `/users/<id>/` is a routine
    // API route, and matching it would re-root live request logs at `~`.
    const result = redactSecrets('GET https://api.example.com/users/12345/profile 200');

    expect(result.patterns).toEqual([]);
    expect(result.redacted).toBe('GET https://api.example.com/users/12345/profile 200');
  });

  it('scrubs a lowercase Windows profile root', () => {
    // Windows paths are case-insensitive and reach the logs in whatever case
    // the producer used, so the canonical capitalisation cannot be assumed.
    // The drive letter is what makes this safe to match loosely here.
    const result = redactSecrets(String.raw`opening c:\users\alice\AppData`);

    expect(result.patterns).toContain('windows-home-path');
    expect(result.redacted).not.toContain('alice');
    expect(result.redacted).toBe(String.raw`opening ~\AppData`);
  });

  it('over-redacts prose after a terminal Windows profile root rather than leaking it', () => {
    // Spaces are admitted so a profile folder containing one still matches, and
    // the cost is that trailing prose goes with it. Pinned because it is a
    // deliberate trade, not a defect: the alternative is leaving the account
    // name in place.
    const result = redactSecrets(String.raw`profile C:\Users\alice failed, retry`);

    expect(result.redacted).not.toContain('alice');
    expect(result.redacted).toBe('profile ~');
  });

  it('over-redacts prose after a terminal POSIX home root rather than leaking it', () => {
    // The same deliberate trade as the Windows case above, pinned separately
    // because the POSIX rules reach it differently: their body admits a
    // backslash and gives one back at the end, and that give-back must not
    // shorten the match on a line that ends in prose instead.
    const result = redactSecrets('profile /home/alice failed, retry');

    expect(result.redacted).not.toContain('alice');
    expect(result.redacted).toBe('profile ~');

    // The give-back itself, which the line above never reaches, having no
    // backslash in it. A run ending on one hands it back rather than consuming
    // it, which is what keeps a `\"` escape pair intact. A rule that consumed
    // its terminator took the backslash too, so this pins the shape and not
    // only the trade.
    // Written with escapes rather than `String.raw` because a raw template
    // cannot end on a backslash: it escapes the closing backtick even there.
    expect(redactSecrets('profile /home/alice failed, retry\\').redacted).toBe('profile ~\\');

    // And at two, which is the form NDJSON actually carries: one logical
    // trailing backslash is two literal ones once stringified. Generalizes the
    // give-back rather than pinning a single instance of it, so a post-hoc
    // strip of one trailing backslash would not pass for the same behaviour.
    expect(redactSecrets('profile /home/alice failed, retry\\\\').redacted).toBe('profile ~\\\\');
  });

  it('masks both account names when one line carries two home paths', () => {
    // A rule that consumed its terminator ate the separator that opened the
    // second path, and the second name then shipped. Windows is the sharp case:
    // both separators are backslashes, so nothing but the lookahead ends the
    // first run before the next drive letter.
    expect(scrubSecrets('home=/Users/alice contentDir=/Users/bob/notes')).not.toContain('alice');
    expect(scrubSecrets('home=/Users/alice contentDir=/Users/bob/notes')).not.toContain('bob');
    expect(scrubSecrets(String.raw`a=C:\Users\alice b=C:\Users\bob`)).not.toContain('alice');
    expect(scrubSecrets(String.raw`a=C:\Users\alice b=C:\Users\bob`)).not.toContain('bob');
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
