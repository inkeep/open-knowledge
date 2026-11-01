import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createContentFilter, createContentFilterAsync } from './content-filter.ts';

const volumes = vi.hoisted(() => ({ roots: [] as string[] }));

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  const volumeOf = (p: string) =>
    volumes.roots.find((root) => p === root || p.startsWith(`${root}${actual.sep}`));
  const relative = (from: string, to: string): string => {
    const fromVolume = volumeOf(actual.resolve(from));
    const toVolume = volumeOf(actual.resolve(to));
    if (fromVolume && toVolume && fromVolume !== toVolume) return actual.resolve(to);
    return actual.relative(from, to);
  };
  return { ...actual, relative, default: { ...actual, relative } };
});

describe('content filter when the project and its content sit on different volumes', () => {
  let projectVolume: string;
  let contentVolume: string;
  let xdgDir: string;
  let prevXdg: string | undefined;

  beforeEach(async () => {
    projectVolume = await mkdtemp(join(tmpdir(), 'content-filter-volume-c-'));
    contentVolume = await mkdtemp(join(tmpdir(), 'content-filter-volume-e-'));
    xdgDir = await mkdtemp(join(tmpdir(), 'content-filter-xdg-'));
    volumes.roots = [projectVolume, contentVolume];
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgDir;
  });

  afterEach(async () => {
    volumes.roots = [];
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    await rm(projectVolume, { recursive: true, force: true });
    await rm(contentVolume, { recursive: true, force: true });
    await rm(xdgDir, { recursive: true, force: true });
  });

  function seedDownloads(): { projectDir: string; contentDir: string } {
    const projectDir = join(projectVolume, 'ok-ephemeral-abc123');
    const contentDir = join(contentVolume, 'Downloads');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(contentDir, 'hwi_828'), { recursive: true });
    mkdirSync(join(contentDir, '.obsidian'), { recursive: true });
    writeFileSync(join(contentDir, 'satellite_p1-10.md'), '# Satellite\n');
    writeFileSync(join(contentDir, 'hwi_828', 'note.md'), '# Note\n');
    return { projectDir, contentDir };
  }

  test.each([
    ['sync', createContentFilter],
    ['async', createContentFilterAsync],
  ] as const)(
    '%s factory treats a folder on another volume as outside the project',
    async (_factory, create) => {
      const { projectDir, contentDir } = seedDownloads();

      const building = Promise.resolve().then(() => create({ projectDir, contentDir }));
      await expect(building).resolves.toBeDefined();
      const filter = await building;

      expect(filter.isExcluded('satellite_p1-10.md')).toBe(false);
      expect(filter.isExcluded('hwi_828/note.md')).toBe(false);
      expect(filter.isDirExcluded('hwi_828')).toBe(false);
      expect(filter.isPathIgnored('hwi_828/note.md')).toBe(false);
    },
  );

  test.each([
    ['sync', createContentFilter],
    ['async', createContentFilterAsync],
  ] as const)('%s factory opens a single file on another volume', async (_factory, create) => {
    const { projectDir, contentDir } = seedDownloads();

    const building = Promise.resolve().then(() =>
      create({ projectDir, contentDir, singleDocRelPath: 'satellite_p1-10.md' }),
    );
    await expect(building).resolves.toBeDefined();
    const filter = await building;

    expect(filter.isExcluded('satellite_p1-10.md')).toBe(false);
    expect(filter.isExcluded('hwi_828/note.md')).toBe(true);
  });
});
