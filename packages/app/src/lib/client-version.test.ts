import { afterEach, describe, expect, test, vi } from 'vitest';

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const CURSOR_PANE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Cursor/1.7.33 Chrome/138.0.7204.251 Electron/37.7.0 Safari/537.36';

async function loadInSurface(env: { userAgent: string; okDesktop?: object }) {
  vi.stubGlobal('navigator', { userAgent: env.userAgent });
  vi.stubGlobal('window', env.okDesktop === undefined ? {} : { okDesktop: env.okDesktop });
  vi.resetModules();
  return import('./client-version.ts');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('browser client-version reader', () => {
  test('a plain browser tab sends kind=browser on headers and the collab token', async () => {
    const mod = await loadInSurface({ userAgent: CHROME_UA });
    expect(mod.CLIENT_SURFACE).toBe('browser');
    expect(mod.browserClientVersionHeaders()).toEqual({
      'x-ok-client-protocol': '2',
      'x-ok-client-runtime': mod.BROWSER_RUNTIME_VERSION,
      'x-ok-client-kind': 'browser',
    });
    const fields = mod.browserClientVersionTokenFields();
    expect(fields).toEqual({
      clientProtocolVersion: 2,
      clientRuntimeVersion: mod.BROWSER_RUNTIME_VERSION,
      clientKind: 'browser',
    });
    expect(typeof fields.clientProtocolVersion).toBe('number');
  });

  test('the OK Desktop window sends kind=desktop', async () => {
    const mod = await loadInSurface({ userAgent: CHROME_UA, okDesktop: {} });
    expect(mod.CLIENT_SURFACE).toBe('desktop');
    expect(mod.browserClientVersionHeaders()['x-ok-client-kind']).toBe('desktop');
    expect(mod.browserClientVersionTokenFields().clientKind).toBe('desktop');
  });

  test('an agent host pane sends its embedded host', async () => {
    const mod = await loadInSurface({ userAgent: CURSOR_PANE_UA });
    expect(mod.CLIENT_SURFACE).toBe('embedded:cursor');
    expect(mod.browserClientVersionHeaders()['x-ok-client-kind']).toBe('embedded:cursor');
    expect(mod.browserClientVersionTokenFields().clientKind).toBe('embedded:cursor');
  });

  test('runtime resolves to a non-empty string', async () => {
    const mod = await loadInSurface({ userAgent: CHROME_UA });
    expect(typeof mod.BROWSER_RUNTIME_VERSION).toBe('string');
    expect(mod.BROWSER_RUNTIME_VERSION.length).toBeGreaterThan(0);
  });
});
