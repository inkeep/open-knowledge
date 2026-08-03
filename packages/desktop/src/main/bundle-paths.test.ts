import { describe, expect, test } from 'vitest';
import { appBundleRootFromExecutable, wrapperPathInBundle } from './bundle-paths.ts';

describe('wrapperPathInBundle', () => {
  test('maps packaged executable path to bundled ok.sh wrapper', () => {
    // Platform pinned: the parameter defaults to process.platform (correct
    // for the production call sites, host-dependent in tests — the CI test
    // host is Linux). Per-platform layouts are covered in install-shape.test.ts.
    expect(
      wrapperPathInBundle('/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge', 'darwin'),
    ).toBe('/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh');
  });
});

describe('appBundleRootFromExecutable', () => {
  test('darwin reduces the main binary to the .app root that also holds the helpers', () => {
    const root = appBundleRootFromExecutable(
      '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
      'darwin',
    );

    expect(root).toBe('/Applications/OpenKnowledge.app');
    // The helper apps must land inside it — they are the processes that
    // actually crash most often.
    expect(
      '/Applications/OpenKnowledge.app/Contents/Frameworks/OpenKnowledge Helper.app/Contents/MacOS/OpenKnowledge Helper'.startsWith(
        `${root}/`,
      ),
    ).toBe(true);
  });

  test('a darwin binary run outside a bundle degrades to its own directory', () => {
    // Never the filesystem root: that would make every dump on the machine
    // read as ours.
    expect(appBundleRootFromExecutable('/opt/local/bin/openknowledge', 'darwin')).toBe(
      '/opt/local/bin',
    );
  });

  test('win32 and linux use the directory the helper binaries share', () => {
    expect(appBundleRootFromExecutable('C:\\Program Files\\OK\\OpenKnowledge.exe', 'win32')).toBe(
      'C:\\Program Files\\OK',
    );
    expect(appBundleRootFromExecutable('/opt/OpenKnowledge/open-knowledge', 'linux')).toBe(
      '/opt/OpenKnowledge',
    );
  });
});
