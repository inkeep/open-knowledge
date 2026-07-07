import { describe as _bunDescribe, afterEach, beforeEach, expect, it, spyOn } from 'bun:test';

// Skip-on-CI gate (oven-sh/bun#11892): subprocess or git child spawns; Bun fails to reap children on ubuntu-latest GHA runners (oven-sh/bun#11892).
// Tests run normally locally; follow-up will narrow the leak surface.
const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

import * as cp from 'node:child_process';
import { openBrowser } from './open-browser.ts';

describe('openBrowser', () => {
  let execFileSpy: ReturnType<typeof spyOn>;
  const originalPlatform = process.platform;

  beforeEach(() => {
    execFileSpy = spyOn(cp, 'execFile').mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    execFileSpy.mockRestore();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('uses "open" on darwin', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    openBrowser('http://localhost:3000');

    expect(execFileSpy).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileSpy.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('open');
    expect(args).toEqual(['http://localhost:3000']);
  });

  it('uses "xdg-open" on linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    openBrowser('http://localhost:3000');

    expect(execFileSpy).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileSpy.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('xdg-open');
    expect(args).toEqual(['http://localhost:3000']);
  });

  it('uses "cmd /c start" on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    openBrowser('http://localhost:3000');

    expect(execFileSpy).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileSpy.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('cmd');
    expect(args).toEqual(['/c', 'start', '', 'http://localhost:3000']);
  });

  it('prints fallback message when launcher fails', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const consoleSpy = spyOn(console, 'warn').mockImplementation(() => {});

    execFileSpy.mockImplementation(((
      _cmd: string,
      _args: string[],
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

// URL validation tests run in CI (and locally). These don't spawn real child
// processes — `execFile` is fully mocked — so the Bun child-reaping issue
// (oven-sh/bun#11892) that gates the outer describe doesn't apply here. Keep
// this block at the top level using `_bunDescribe` directly so a regression
// that weakens the URL allowlist is caught by the automated pipeline.
_bunDescribe('openBrowser URL validation', () => {
  let execFileSpy: ReturnType<typeof spyOn>;
  const originalPlatform = process.platform;

  beforeEach(() => {
    execFileSpy = spyOn(cp, 'execFile').mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    execFileSpy.mockRestore();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  // Each entry would otherwise survive `cmd /c start "" <url>` and reach
  // ShellExecute on Windows. The shell-metacharacter set (& | < > ^ ( )
  // plus quote chars) is interpreted by cmd.exe BEFORE the URL is handed
  // to a browser, so a host or port smuggled in via --host / HOST /
  // .ok/config.yml could otherwise be parsed as additional commands.
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
      const consoleSpy = spyOn(console, 'warn').mockImplementation(() => {});

      openBrowser(url);

      expect(execFileSpy).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const [warned] = consoleSpy.mock.calls[0] as [string];
      expect(warned).toContain('Could not auto-open browser');
      expect(warned).toContain('manually');
      consoleSpy.mockRestore();
    });
  }

  it('rejects non-http(s) schemes', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const consoleSpy = spyOn(console, 'warn').mockImplementation(() => {});

    openBrowser('javascript:alert(1)');
    openBrowser('file:///etc/passwd');
    openBrowser('vbscript:msgbox(1)');
    openBrowser('data:text/html,<script>alert(1)</script>');

    expect(execFileSpy).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledTimes(4);
    for (const call of consoleSpy.mock.calls) {
      expect(call[0] as string).toContain('unsupported scheme');
    }
    consoleSpy.mockRestore();
  });

  it('rejects malformed URLs', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const consoleSpy = spyOn(console, 'warn').mockImplementation(() => {});

    openBrowser('not a url');

    expect(execFileSpy).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy.mock.calls[0][0] as string).toContain('invalid URL');
    consoleSpy.mockRestore();
  });

  it('accepts a normal https URL', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    openBrowser('https://example.com:8443/path');
    expect(execFileSpy).toHaveBeenCalledTimes(1);
  });
});
