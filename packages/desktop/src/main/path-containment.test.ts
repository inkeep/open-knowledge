import { isPathWithinDir } from '@inkeep/open-knowledge-server';
import { describe, expect, test } from 'vitest';
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

  test('does not apply cmd.exe grammar to a lexical containment check', () => {
    expect(isPathWithinProject('C:\\proj%20\\.ok', 'C:\\proj%20', 'win32')).toBe(true);
    expect(validateSpawnPath('C:\\proj%20\\.ok', 'win32')).toBe(false);
  });

  test('rejects dot-dot escapes and the sibling-prefix collision', () => {
    expect(isPathWithinProject('C:\\proj\\..\\windows\\evil.zip', 'C:\\proj', 'win32')).toBe(false);
    expect(isPathWithinProject('C:\\proj-evil\\file.zip', 'C:\\proj', 'win32')).toBe(false);
  });

  test('rejects a drive-letter mismatch', () => {
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
    expect(isPathWithinProject('\\\\?\\C:\\proj\\file.zip', 'C:\\proj', 'win32')).toBe(false);
    expect(isPathWithinProject('\\\\.\\pipe\\ok-pipe', 'C:\\proj', 'win32')).toBe(false);
  });
});

describe('isPathWithinProject — parity with the server isPathWithinDir', () => {
  const PARITY_VECTORS: Array<[userPath: string, root: string, platform: NodeJS.Platform]> = [
    ['/proj', '/proj', 'darwin'],
    ['/proj/file.zip', '/proj', 'darwin'],
    ['/proj/a/b/file.zip', '/proj', 'linux'],
    ['/proj/../etc/passwd', '/proj', 'darwin'],
    ['/proj/a/../../etc', '/proj', 'linux'],
    ['/proj-evil/file.zip', '/proj', 'darwin'],
    ['file.zip', '/proj', 'darwin'],
    ['/proj/file.zip', 'proj', 'darwin'],
    ['', '/proj', 'darwin'],
    ['/proj/fi\0le.zip', '/proj', 'darwin'],
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
