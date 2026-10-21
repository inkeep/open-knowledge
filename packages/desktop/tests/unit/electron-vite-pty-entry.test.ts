import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const desktopRoot = resolve(import.meta.dirname, '../..');

describe('packaged PTY utility entry', () => {
  test('builds the packaged PTY utility output from the diagnostic entry module', async () => {
    const config = (await import('../../electron.vite.config.ts')).default as {
      main?: { build?: { rolldownOptions?: { input?: Record<string, string> } } };
    };
    expect(config.main?.build?.rolldownOptions?.input?.['utility/pty-host']).toBe(
      resolve(desktopRoot, 'src/utility/pty-host-entry.ts'),
    );
  });
});
