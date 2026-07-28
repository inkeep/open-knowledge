import { describe, expect, test } from 'vitest';
import {
  APPIMAGE_HANDLER_DESKTOP_NAME,
  buildAppImageHandlerDesktopEntry,
  quoteExecArg,
  registerAppImageDeepLinks,
} from './appimage-integration.ts';

describe('quoteExecArg', () => {
  test('plain absolute path passes through unquoted', () => {
    expect(quoteExecArg('/home/u/Apps/OpenKnowledge-x86_64.AppImage')).toBe(
      '/home/u/Apps/OpenKnowledge-x86_64.AppImage',
    );
  });

  test('space in path gets quoted', () => {
    expect(quoteExecArg('/home/u/My Apps/OK.AppImage')).toBe('"/home/u/My Apps/OK.AppImage"');
  });

  test('reserved characters are backslash-escaped inside quotes', () => {
    expect(quoteExecArg('/tmp/we"ird$`\\.AppImage')).toBe('"/tmp/we\\"ird\\$\\`\\\\.AppImage"');
  });
});

describe('buildAppImageHandlerDesktopEntry', () => {
  const entry = buildAppImageHandlerDesktopEntry('/home/u/OpenKnowledge.AppImage');

  test('declares the x-scheme-handler MimeType with trailing semicolon', () => {
    expect(entry).toContain('MimeType=x-scheme-handler/openknowledge;');
  });

  test('Exec points at the running AppImage with %U for the clicked URL', () => {
    expect(entry).toContain('Exec=/home/u/OpenKnowledge.AppImage %U');
  });

  test('hidden from launchers (NoDisplay) — it exists only as the handler target', () => {
    expect(entry).toContain('NoDisplay=true');
  });
});

describe('registerAppImageDeepLinks', () => {
  const baseDeps = {
    platform: 'linux' as NodeJS.Platform,
    isPackaged: true,
    env: { APPIMAGE: '/home/u/OK.AppImage' } as Record<string, string | undefined>,
    homeDir: '/home/u',
  };

  function collectingDeps() {
    const writes: Array<{ path: string; content: string }> = [];
    const mkdirs: string[] = [];
    const execs: Array<{ cmd: string; args: string[] }> = [];
    return {
      writes,
      mkdirs,
      execs,
      deps: {
        ...baseDeps,
        writeFileImpl: (async (path: string, content: string) => {
          writes.push({ path, content });
        }) as never,
        mkdirImpl: (async (path: string) => {
          mkdirs.push(path);
          return undefined;
        }) as never,
        execFileImpl: (cmd: string, args: string[], cb: (err: Error | null) => void) => {
          execs.push({ cmd, args });
          cb(null);
        },
      },
    };
  }

  test('skips off-linux, unpackaged, and non-AppImage launches', async () => {
    expect(await registerAppImageDeepLinks({ ...baseDeps, platform: 'win32' })).toEqual({
      status: 'skipped',
      reason: 'not-linux',
    });
    expect(await registerAppImageDeepLinks({ ...baseDeps, isPackaged: false })).toEqual({
      status: 'skipped',
      reason: 'not-packaged',
    });
    expect(await registerAppImageDeepLinks({ ...baseDeps, env: {} })).toEqual({
      status: 'skipped',
      reason: 'not-appimage',
    });
  });

  test('writes the handler entry under ~/.local/share/applications and refreshes xdg', async () => {
    const { deps, writes, mkdirs, execs } = collectingDeps();
    const result = await registerAppImageDeepLinks(deps);
    expect(result.status).toBe('registered');
    expect(mkdirs).toEqual(['/home/u/.local/share/applications']);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(
      `/home/u/.local/share/applications/${APPIMAGE_HANDLER_DESKTOP_NAME}`,
    );
    expect(writes[0]?.content).toContain('Exec=/home/u/OK.AppImage %U');
    expect(execs.map((e) => e.cmd)).toEqual(['update-desktop-database', 'xdg-mime']);
  });

  test('honors XDG_DATA_HOME over the ~/.local/share default', async () => {
    const { deps, writes } = collectingDeps();
    deps.env = { ...deps.env, XDG_DATA_HOME: '/custom/data' };
    await registerAppImageDeepLinks(deps);
    expect(writes[0]?.path).toBe(`/custom/data/applications/${APPIMAGE_HANDLER_DESKTOP_NAME}`);
  });

  test('a write failure reports failed without throwing', async () => {
    const { deps } = collectingDeps();
    deps.writeFileImpl = (async () => {
      throw new Error('EACCES');
    }) as never;
    const result = await registerAppImageDeepLinks(deps);
    expect(result).toEqual({ status: 'failed', error: 'EACCES' });
  });
});
