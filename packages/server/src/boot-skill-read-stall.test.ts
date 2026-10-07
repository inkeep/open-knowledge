import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test, vi } from 'vitest';
import { bootServer } from './boot.ts';
import { ConfigSchema } from './config/schema.ts';
import { scanGlobalInPlaceSkillsAsync } from './in-place-skills.ts';

const SLOW_READ_MS = 3_000;

const fixture = vi.hoisted(() => ({
  home: undefined as string | undefined,
  slowFile: undefined as string | undefined,
  slowReads: 0,
  lockedFile: undefined as string | undefined,
  lockedReads: 0,
}));

vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, homedir: () => fixture.home ?? os.homedir() };
});

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    if (fixture.lockedFile !== undefined && String(args[0]) === fixture.lockedFile) {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
    if (fixture.slowFile !== undefined && String(args[0]) === fixture.slowFile) {
      fixture.slowReads += 1;
      const until = performance.now() + SLOW_READ_MS;
      while (performance.now() < until) {}
    }
    return fs.readFileSync(...args);
  }) as typeof fs.readFileSync;
  return { ...fs, default: { ...fs, readFileSync }, readFileSync };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const fsp = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = (async (...args: Parameters<typeof fsp.readFile>) => {
    if (fixture.lockedFile !== undefined && String(args[0]) === fixture.lockedFile) {
      fixture.lockedReads += 1;
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
    if (fixture.slowFile !== undefined && String(args[0]) === fixture.slowFile) {
      fixture.slowReads += 1;
      await sleep(SLOW_READ_MS);
    }
    return fsp.readFile(...args);
  }) as typeof fsp.readFile;
  return { ...fsp, default: { ...fsp, readFile }, readFile };
});

test('a slow-to-read global skill bundle stalls neither boot nor a skills request made while it is read', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ok-boot-skill-home-'));
  const projectDir = await mkdtemp(join(tmpdir(), 'ok-boot-skill-project-'));
  const skillDir = join(home, '.codex', 'skills', 'heavy-skill');
  await mkdir(join(skillDir, 'assets'), { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: heavy-skill\ndescription: A skill with a large bundle.\n---\n# Heavy\n',
  );
  const slowFile = join(skillDir, 'assets', 'model.bin');
  await writeFile(slowFile, Buffer.from([0, 1, 2, 3]));
  await mkdir(join(skillDir, 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(skillDir, 'node_modules', 'dep', 'index.js'), 'export {};\n');
  await mkdir(join(projectDir, '.ok'), { recursive: true });
  await writeFile(join(projectDir, '.ok', 'config.yml'), '');
  await writeFile(join(projectDir, 'a.md'), '# a\n');
  fixture.home = home;
  fixture.slowFile = slowFile;

  let worstStallMs = 0;
  let lastTick = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    worstStallMs = Math.max(worstStallMs, now - lastTick);
    lastTick = now;
  }, 10);

  let booted: Awaited<ReturnType<typeof bootServer>> | undefined;
  try {
    booted = await bootServer({
      host: '127.0.0.1',
      config: ConfigSchema.parse({}),
      contentDir: projectDir,
      configHomedirOverride: home,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      ephemeral: true,
    });
    await booted.ready;
    const skills = await fetch(`http://127.0.0.1:${booted.port}/api/skills`);
    expect(skills.status).toBe(200);
    await scanGlobalInPlaceSkillsAsync(home);
  } finally {
    clearInterval(heartbeat);
    await booted?.destroy('test');
    fixture.home = undefined;
    fixture.slowFile = undefined;
    await rm(home, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }

  expect(fixture.slowReads).toBe(1);
  expect(worstStallMs).toBeLessThan(SLOW_READ_MS / 2);
});

test('a folder that becomes a skill after its first read-ahead is still read off the event loop', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ok-late-skill-home-'));
  const skillDir = join(home, '.codex', 'skills', 'late-skill');
  await mkdir(join(skillDir, 'assets'), { recursive: true });
  fixture.slowReads = 0;
  let worstStallMs = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    expect(await scanGlobalInPlaceSkillsAsync(home)).toEqual([]);
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: late-skill\ndescription: Written after its folder.\n---\n# Late\n',
    );
    const slowFile = join(skillDir, 'assets', 'model.bin');
    await writeFile(slowFile, Buffer.from([0, 1, 2, 3]));
    fixture.slowFile = slowFile;

    let lastTick = performance.now();
    heartbeat = setInterval(() => {
      const now = performance.now();
      worstStallMs = Math.max(worstStallMs, now - lastTick);
      lastTick = now;
    }, 10);
    const skills = await scanGlobalInPlaceSkillsAsync(home);
    expect(skills.map((s) => s.name)).toEqual(['late-skill']);
    await sleep(50);
  } finally {
    clearInterval(heartbeat);
    fixture.slowFile = undefined;
    await rm(home, { recursive: true, force: true });
  }

  expect(fixture.slowReads).toBe(1);
  expect(worstStallMs).toBeLessThan(SLOW_READ_MS / 2);
});

test('a skill whose bundle cannot be read is read ahead once, not on every scan', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ok-locked-skill-home-'));
  const skillDir = join(home, '.codex', 'skills', 'locked-skill');
  await mkdir(join(skillDir, 'assets'), { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: locked-skill\ndescription: One file is locked.\n---\n# Locked\n',
  );
  const lockedFile = join(skillDir, 'assets', 'locked.bin');
  await writeFile(lockedFile, Buffer.from([0, 1]));
  fixture.lockedFile = lockedFile;
  fixture.lockedReads = 0;
  try {
    await scanGlobalInPlaceSkillsAsync(home);
    await scanGlobalInPlaceSkillsAsync(home);
    await scanGlobalInPlaceSkillsAsync(home);
  } finally {
    fixture.lockedFile = undefined;
    await rm(home, { recursive: true, force: true });
  }
  expect(fixture.lockedReads).toBe(1);
});
