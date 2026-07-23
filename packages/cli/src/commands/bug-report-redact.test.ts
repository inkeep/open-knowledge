import { describe, expect, test } from 'vitest';
import { redactContent } from './bug-report-redact.ts';

describe('redactContent', () => {
  test('leaves clean content unchanged', () => {
    const r = redactContent('just a normal log line\nwith two lines');
    expect(r.redacted).toBe('just a normal log line\nwith two lines');
    expect(r.patterns).toHaveLength(0);
    expect(r.lineCount).toBe(0);
  });

  test('redacts GitHub PATs and home paths', () => {
    const r = redactContent(`opened /Users/alice/p with ghp_${'a'.repeat(36)}`);
    expect(r.redacted).toContain('~/');
    expect(r.redacted).toContain('[REDACTED-GH-PAT]');
    expect(r.patterns).toEqual(expect.arrayContaining(['macos-home-path', 'github-pat']));
  });

  test('redacts JWTs — including a signature ending in a base64url "-" (no trailing \\b)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF1234_-';
    const r = redactContent(`reason="auth" token=${jwt} done`);
    expect(r.redacted).toContain('[REDACTED-JWT]');
    expect(r.redacted).not.toContain('eyJhbGci');
    expect(r.patterns).toContain('jwt');
  });

  test('strips URL-embedded credentials', () => {
    const r = redactContent('push https://x-access-token:supersecret@github.com/o/r.git');
    expect(r.redacted).toContain('://[REDACTED]@github.com');
    expect(r.redacted).not.toContain('supersecret');
    expect(r.patterns).toContain('url-credentials');
  });

  test('reports the changed-line count', () => {
    const r = redactContent(`clean\n/Users/bob/x\nclean`);
    expect(r.lineCount).toBe(1);
  });
});
