/**
 * Containment-primitive tests. The module is platform-parameterized (explicit
 * `path/posix` / `path/win32`) precisely so the Windows semantics — drive
 * roots, UNC shares, `\\?\` / `\\.\` device namespaces — can be exercised on
 * the POSIX runners that build and test the desktop app today. Nothing in
 * production executes the win32 branches yet (desktop is macOS-only), so this
 * suite is their only coverage.
 */

import { describe, expect, test } from 'bun:test';
import { isPathWithinDir } from '@inkeep/open-knowledge-server';
import { isPathWithinProject, validateSpawnPath } from './path-containment.ts';

describe('validateSpawnPath — posix', () => {
  test('accepts absolute paths and rejects relative, empty, and NUL-carrying input', () => {
    expect(validateSpawnPath('/proj/file.zip', 'darwin')).toBe(true);
    expect(validateSpawnPath('proj/file.zip', 'darwin')).toBe(false);
    expect(validateSpawnPath('./file.zip', 'linux')).toBe(false);
    expect(validateSpawnPath('', 'darwin')).toBe(false);
    expect(validateSpawnPath('/proj/fi\0le.zip', 'darwin')).toBe(false);
  });
});

describe('validateSpawnPath — win32', () => {
  test('accepts drive-letter (either separator) and UNC forms', () => {
    expect(validateSpawnPath('C:\\proj\\file.zip', 'win32')).toBe(true);
    expect(validateSpawnPath('C:/proj/file.zip', 'win32')).toBe(true);
    expect(validateSpawnPath('\\\\server\\share\\file.zip', 'win32')).toBe(true);
  });

  test('rejects relative, posix-absolute, empty, and NUL-carrying input', () => {
    expect(validateSpawnPath('proj\\file.zip', 'win32')).toBe(false);
    expect(validateSpawnPath('/proj/file.zip', 'win32')).toBe(false);
    expect(validateSpawnPath('', 'win32')).toBe(false);
    expect(validateSpawnPath('C:\\proj\\fi\0le.zip', 'win32')).toBe(false);
  });
});

describe('isPathWithinProject — posix', () => {
  test('admits the root itself and nested children', () => {
    expect(isPathWithinProject('/proj', '/proj', 'darwin')).toBe(true);
    expect(isPathWithinProject('/proj/file.zip', '/proj', 'darwin')).toBe(true);
    expect(isPathWithinProject('/proj/a/b/file.zip', '/proj', 'darwin')).toBe(true);
  });

  test('rejects dot-dot escapes, even when lexically prefixed by the root', () => {
    expect(isPathWithinProject('/proj/../etc/passwd', '/proj', 'darwin')).toBe(false);
    expect(isPathWithinProject('/proj/a/../../etc', '/proj', 'linux')).toBe(false);
  });

  test('rejects the sibling-prefix collision', () => {
    expect(isPathWithinProject('/proj-evil/file.zip', '/proj', 'darwin')).toBe(false);
  });

  test('rejects relative input on either side', () => {
    expect(isPathWithinProject('file.zip', '/proj', 'darwin')).toBe(false);
    expect(isPathWithinProject('/proj/file.zip', 'proj', 'darwin')).toBe(false);
  });
});

describe('isPathWithinProject — win32', () => {
  test('admits the root itself and nested children, with either or mixed separators', () => {
    expect(isPathWithinProject('C:\\proj', 'C:\\proj', 'win32')).toBe(true);
    expect(isPathWithinProject('C:\\proj\\file.zip', 'C:\\proj', 'win32')).toBe(true);
    expect(isPathWithinProject('C:/proj/sub/file.zip', 'C:\\proj', 'win32')).toBe(true);
  });

  test('drive roots compare case-insensitively', () => {
    expect(isPathWithinProject('c:\\proj\\file.zip', 'C:\\proj', 'win32')).toBe(true);
  });

  test('rejects dot-dot escapes and the sibling-prefix collision', () => {
    expect(isPathWithinProject('C:\\proj\\..\\windows\\evil.zip', 'C:\\proj', 'win32')).toBe(false);
    expect(isPathWithinProject('C:\\proj-evil\\file.zip', 'C:\\proj', 'win32')).toBe(false);
  });

  test('rejects a drive-letter mismatch', () => {
    // Without the canonical-root check, `path.win32.relative` returns the
    // absolute "to" path for cross-drive inputs and the `..`-shape probes
    // never fire — this is the case the root comparison exists for.
    expect(isPathWithinProject('D:\\proj\\file.zip', 'C:\\proj', 'win32')).toBe(false);
  });

  test('admits within a UNC share and rejects share or server mismatches', () => {
    expect(
      isPathWithinProject('\\\\server\\share\\dir\\file.zip', '\\\\server\\share\\dir', 'win32'),
    ).toBe(true);
    expect(
      isPathWithinProject('\\\\server\\share2\\file.zip', '\\\\server\\share\\dir', 'win32'),
    ).toBe(false);
    expect(
      isPathWithinProject('\\\\server2\\share\\file.zip', '\\\\server\\share\\dir', 'win32'),
    ).toBe(false);
  });

  test('rejects a UNC path against a drive-letter root', () => {
    expect(isPathWithinProject('\\\\server\\share\\file.zip', 'C:\\proj', 'win32')).toBe(false);
  });

  test('rejects device-namespace paths against a drive-letter root', () => {
    // `\\?\C:\proj\...` names the same file as `C:\proj\...` but carries a
    // distinct canonical root (`\\?\C:\`), so it must not read as contained.
    expect(isPathWithinProject('\\\\?\\C:\\proj\\file.zip', 'C:\\proj', 'win32')).toBe(false);
    expect(isPathWithinProject('\\\\.\\pipe\\ok-pipe', 'C:\\proj', 'win32')).toBe(false);
  });
});

describe('isPathWithinProject — parity with the server isPathWithinDir', () => {
  // The two functions implement one security contract from independent copies
  // (see the module header's consolidation note). This matrix pins them to
  // identical verdicts so a fix or hardening applied to only one of them
  // fails here instead of drifting silently. Lexical, symlink-free vectors
  // only — neither implementation resolves symlinks.
  const PARITY_VECTORS: Array<[userPath: string, root: string, platform: NodeJS.Platform]> = [
    // POSIX: root itself, nested children, dot-dot escapes, sibling prefix.
    ['/proj', '/proj', 'darwin'],
    ['/proj/file.zip', '/proj', 'darwin'],
    ['/proj/a/b/file.zip', '/proj', 'linux'],
    ['/proj/../etc/passwd', '/proj', 'darwin'],
    ['/proj/a/../../etc', '/proj', 'linux'],
    ['/proj-evil/file.zip', '/proj', 'darwin'],
    // Malformed inputs: relative on either side, empty, NUL byte.
    ['file.zip', '/proj', 'darwin'],
    ['/proj/file.zip', 'proj', 'darwin'],
    ['', '/proj', 'darwin'],
    ['/proj/fi\0le.zip', '/proj', 'darwin'],
    // Windows: drive letters (either separator, case-insensitive roots),
    // dot-dot escapes, cross-drive, UNC shares, device namespaces.
    ['C:\\proj', 'C:\\proj', 'win32'],
    ['C:\\proj\\file.zip', 'C:\\proj', 'win32'],
    ['C:/proj/sub/file.zip', 'C:\\proj', 'win32'],
    ['c:\\proj\\file.zip', 'C:\\proj', 'win32'],
    ['C:\\proj\\..\\windows\\evil.zip', 'C:\\proj', 'win32'],
    ['C:\\proj-evil\\file.zip', 'C:\\proj', 'win32'],
    ['D:\\proj\\file.zip', 'C:\\proj', 'win32'],
    ['\\\\server\\share\\dir\\file.zip', '\\\\server\\share\\dir', 'win32'],
    ['\\\\server\\share2\\file.zip', '\\\\server\\share\\dir', 'win32'],
    ['\\\\server2\\share\\file.zip', '\\\\server\\share\\dir', 'win32'],
    ['\\\\server\\share\\file.zip', 'C:\\proj', 'win32'],
    ['\\\\?\\C:\\proj\\file.zip', 'C:\\proj', 'win32'],
    ['\\\\.\\pipe\\ok-pipe', 'C:\\proj', 'win32'],
    ['/proj/file.zip', 'C:\\proj', 'win32'],
  ];

  for (const [userPath, root, platform] of PARITY_VECTORS) {
    test(`${platform}: ${JSON.stringify(userPath)} vs ${JSON.stringify(root)}`, () => {
      expect(isPathWithinProject(userPath, root, platform)).toBe(
        isPathWithinDir(userPath, root, platform),
      );
    });
  }
});
