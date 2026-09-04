import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const probe = vi.hoisted(() => ({ throwFor: null as string | null }));

vi.mock('./fs/find-project-root.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fs/find-project-root.ts')>();
  return {
    ...actual,
    isProjectRoot: (dir: string): boolean => {
      if (probe.throwFor !== null && dir === probe.throwFor) {
        probe.throwFor = null;
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return actual.isProjectRoot(dir);
    },
  };
});

const { createContentFilter } = await import('./content-filter.ts');

describe('descendant-project probe failures', () => {
  let projectDir: string | undefined;

  afterEach(() => {
    probe.throwFor = null;
    if (projectDir !== undefined) rmSync(projectDir, { recursive: true, force: true });
    projectDir = undefined;
  });

  test('a throwing probe is not cached as a negative', () => {
    projectDir = mkdtempSync(join(tmpdir(), 'ok-descendant-probe-'));
    const nested = join(projectDir, 'nested');
    mkdirSync(join(nested, '.ok'), { recursive: true });
    writeFileSync(join(nested, '.ok', 'config.yml'), 'autoSync:\n  enabled: false\n');
    writeFileSync(join(nested, 'inside.md'), '# inside');

    const filter = createContentFilter({ projectDir, contentDir: projectDir });

    probe.throwFor = nested;
    expect(filter.isDirExcluded('nested')).toBe(false);

    expect(filter.isDirExcluded('nested')).toBe(true);
    expect(filter.isExcluded('nested/inside.md')).toBe(true);
  });
});
