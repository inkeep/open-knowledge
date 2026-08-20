/**
 * Unit tests for the two pure helpers in the shared bug-report module.
 *
 * `zipBasename` is the load-bearing one: the renderer keys a send operation by
 * it, and Electron main independently keys the same report by `path.basename`
 * of the same zip path. The two derivations have to agree on both separators
 * for a renderer operation to name the report main is actually sending.
 */

import { describe, expect, test } from 'vitest';
import { supportMailtoUrl, zipBasename } from './bug-report-support.ts';

describe('zipBasename', () => {
  test('reduces a posix path to the filename', () => {
    expect(zipBasename('/Users/x/Library/ok/reports/ok-report-2026-08-18.zip')).toBe(
      'ok-report-2026-08-18.zip',
    );
  });

  test('reduces a Windows path to the filename', () => {
    expect(zipBasename('C:\\Users\\x\\AppData\\ok\\ok-report-2026-08-18.zip')).toBe(
      'ok-report-2026-08-18.zip',
    );
  });

  test('passes a bare filename through unchanged', () => {
    expect(zipBasename('ok-report-2026-08-18.zip')).toBe('ok-report-2026-08-18.zip');
  });
});

describe('supportMailtoUrl', () => {
  test('addresses support and percent-encodes the subject', () => {
    expect(supportMailtoUrl('Bug report OK-1234 #2')).toBe(
      'mailto:support@inkeep.com?subject=Bug%20report%20OK-1234%20%232',
    );
  });
});
