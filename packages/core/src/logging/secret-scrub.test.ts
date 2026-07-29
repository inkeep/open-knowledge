import { describe, expect, it } from 'vitest';
import { redactSecrets, SECRET_PATTERN_NAMES, scrubSecrets } from './secret-scrub.ts';

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
