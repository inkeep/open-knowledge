import { describe as _bunDescribe, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

const execFileMock = vi.fn();
let openBrowser: typeof import('./open-browser.ts')['openBrowser'];

beforeAll(async () => {
  await vi.doMock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
  });
  ({ openBrowser } = await import('./open-browser.ts'));
});

describe('openBrowser', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    execFileMock.mockReset().mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('uses "open" on darwin', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    openBrowser('http://localhost:3000');

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('open');
    expect(args).toEqual(['http://localhost:3000']);
  });

  it('uses "xdg-open" on linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    openBrowser('http://localhost:3000');

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('xdg-open');
    expect(args).toEqual(['http://localhost:3000']);
  });

  it('uses "cmd /c start" on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    openBrowser('http://localhost:3000');

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('cmd');
    expect(args).toEqual(['/c', 'start', '', 'http://localhost:3000']);
  });

  it('prints fallback message when launcher fails', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    execFileMock.mockImplementation(((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: Error | null) => void,
    ) => {
      callback(new Error('ENOENT'));
    }) as never);

    openBrowser('http://localhost:3000');

    expect(consoleSpy).toHaveBeenCalledWith(
      'Could not auto-open browser (ENOENT); visit http://localhost:3000 manually',
    );
    consoleSpy.mockRestore();
  });
});

_bunDescribe('openBrowser URL validation', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    execFileMock.mockReset().mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  const malicious = [
    'http://localhost&calc:3000',
    'http://localhost%20&%20calc:3000',
    'http://localhost"&calc:3000',
    "http://localhost'&calc:3000",
    'http://localhost|calc:3000',
    'http://localhost^calc:3000',
    'http://localhost(calc):3000',
    'http://localhost;calc:3000',
    'http://localhost$calc:3000',
    'http://localhost\\calc:3000',
    'http://localhost`calc`:3000',
    'http://localhost:3000\nmore',
    'http://localhost:3000 more',
  ];

  for (const url of malicious) {
    it(`rejects ${JSON.stringify(url)} without spawning a launcher`, () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      openBrowser(url);

      expect(execFileMock).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const [warned] = consoleSpy.mock.calls[0] as [string];
      expect(warned).toContain('Could not auto-open browser');
      expect(warned).toContain('manually');
      consoleSpy.mockRestore();
    });
  }

  it('rejects non-http(s) schemes', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    openBrowser('javascript:alert(1)');
    openBrowser('file:///etc/passwd');
    openBrowser('vbscript:msgbox(1)');
    openBrowser('data:text/html,<script>alert(1)</script>');

    expect(execFileMock).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledTimes(4);
    for (const call of consoleSpy.mock.calls) {
      expect(call[0] as string).toContain('unsupported scheme');
    }
    consoleSpy.mockRestore();
  });

  it('rejects malformed URLs', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    openBrowser('not a url');

    expect(execFileMock).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy.mock.calls[0][0] as string).toContain('invalid URL');
    consoleSpy.mockRestore();
  });

  it('accepts a normal https URL', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    openBrowser('https://example.com:8443/path');
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
