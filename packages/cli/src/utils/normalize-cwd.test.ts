import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { normalizeCwd } from './normalize-cwd.ts';

describe('normalizeCwd', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'ok-normalize-cwd-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('resolves relative paths to absolute paths', async () => {
    const projectDir = resolve(tmpDir, 'project');
    mkdirSync(projectDir, { recursive: true });

    const relativeProjectDir = relative(process.cwd(), projectDir);
    await expect(normalizeCwd(relativeProjectDir)).resolves.toBe(realpathSync(projectDir));
  });

  test('canonicalizes symlinked paths', async () => {
    const realProject = resolve(tmpDir, 'project-real');
    const symlinkProject = resolve(tmpDir, 'project-link');
    mkdirSync(realProject, { recursive: true });
    symlinkSync(realProject, symlinkProject);

    await expect(normalizeCwd(symlinkProject)).resolves.toBe(realpathSync(realProject));
  });

  test('falls back to the absolute path when realpath returns ENOENT', async () => {
    const missingProject = resolve(tmpDir, 'missing', 'project');
    await expect(normalizeCwd(missingProject)).resolves.toBe(missingProject);
  });
});
