import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { aroundEach, describe, expect, test, vi } from 'vitest';
import { getLogger } from '../logger.ts';
import { resolveRegistryLaunch, spawnAcpAgent } from './launch.ts';
import {
  captureChild,
  acquisitionDescriptors as descriptors,
  freezeNpmClock,
  native,
  newestAdmissible,
  npmNative,
  npmPackedVersion,
  npmPublicationTimes,
  registryPackage,
  withLiveAcquisitionHome,
} from './package-acquisition.test-helper.ts';
import type { RegistryAgent } from './registry.ts';

const day = 86_400_000;
const log = getLogger('acp-release-age-test');
const registrySites: RegistryAgent[] = JSON.parse(
  readFileSync(new URL('./registry-release-age.test-fixture.json', import.meta.url), 'utf8'),
);

aroundEach(async (runTest) => {
  await withLiveAcquisitionHome(async () => {
    try {
      await runTest();
    } finally {
      vi.useRealTimers();
    }
  });
});

test('the acquisition catalog snapshot matches current package descriptors', async () => {
  const result = await native('curl', [
    '-fsS',
    '--max-time',
    '20',
    'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
  ]);
  expect(result.code, result.stderr).toBe(0);
  const live: { agents: RegistryAgent[] } = JSON.parse(result.stdout);
  expect(descriptors(live.agents)).toEqual(descriptors(registrySites));
});

describe('registry package acquisition respects publication cutoffs at every catalog site', () => {
  test.each(registrySites.filter((agent) => agent.distribution.npx))(
    '$id produces an admissible npm plan or an acquisition error during the cooldown',
    async (agent) => {
      const descriptor = agent.distribution.npx?.package ?? '';
      const separator = descriptor.lastIndexOf('@');
      const packageName = descriptor.slice(0, separator);
      const ceiling = descriptor.slice(separator + 1);
      const times = await publicationTimes(packageName);
      const cutoff = Date.parse(times[ceiling]) - 1000;
      const expected = newestAdmissible(times, ceiling, cutoff);
      setPolicy(cutoff + 7 * day, 'npmrc');
      if (expected === undefined) {
        const rejected = await npmNative([
          'pack',
          `${packageName}@<=${ceiling}`,
          '--dry-run',
          '--json',
        ]);
        expect(rejected.code).toBe(1);
        expect(rejected.stderr).toMatch(/ETARGET|ENOVERSIONS/);
        await expect(resolveRegistryLaunch(agent, null, log)).rejects.toMatchObject({
          name: 'AgentLaunchError',
        });
        return;
      }
      const launch = await resolveRegistryLaunch(agent, null, log);
      const constraint = launch.args.find((arg) => arg.startsWith(`${packageName}@`));
      expect(constraint).toBeDefined();
      const result = await npmNative(['pack', constraint ?? '', '--dry-run', '--json'], launch.env);
      expect(result.code, `${agent.id}: ${result.stderr}`).toBe(0);
      expect(result.stderr).not.toContain('ETARGET');
      const selected = npmPackedVersion(result.stdout);
      expect(selected).toBe(expected);
      expect(Date.parse(times[selected])).toBeLessThan(cutoff);
    },
    150_000,
  );

  test.each(registrySites.filter((agent) => agent.distribution.uvx))(
    '$id admits an older Python release under UV_EXCLUDE_NEWER',
    async (agent) => {
      const descriptor = agent.distribution.uvx?.package ?? '';
      const [packageName, ceiling] = descriptor.split(/==|@/);
      const metadata = spawnSync(
        'curl',
        [
          '--fail',
          '--silent',
          '--show-error',
          '--max-time',
          '20',
          `https://pypi.org/pypi/${packageName}/json`,
        ],
        { encoding: 'utf8', timeout: 25_000, maxBuffer: 8 * 1024 * 1024 },
      );
      expect(metadata.status, metadata.error?.message ?? metadata.stderr).toBe(0);
      const releases: Record<string, { upload_time_iso_8601: string; yanked: boolean }[]> =
        JSON.parse(metadata.stdout).releases;
      const times = Object.fromEntries(
        Object.entries(releases).flatMap(([version, files]) => {
          const dates = files
            .filter((file) => !file.yanked)
            .map((file) => file.upload_time_iso_8601)
            .sort();
          return dates.length ? [[version, dates[0]]] : [];
        }),
      );
      const cutoff = Date.parse(times[ceiling]) - 1000;
      const expected = newestAdmissible(times, ceiling, cutoff);
      expect(expected).toBeDefined();
      process.env.UV_EXCLUDE_NEWER = new Date(cutoff).toISOString();
      const launch = await resolveRegistryLaunch(agent, null, log);
      const constraint = launch.args.find((arg) => arg.startsWith(packageName));
      expect(constraint).toBeDefined();
      const args = [
        'pip',
        'install',
        '--dry-run',
        '--no-deps',
        '--no-config',
        '--index-url',
        'https://pypi.org/simple',
        '--python-version',
        '3.13',
        '--target',
        join(process.env.HOME ?? '', 'python-target'),
      ];
      const control = spawnSync('uv', [...args, `${packageName}==${expected}`], {
        env: process.env,
        cwd: process.env.HOME,
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(control.status, control.error?.message ?? control.stderr).toBe(0);
      const result = spawnSync(
        'uv',
        [...args, (constraint ?? '').replace(`${packageName}@`, `${packageName}==`)],
        { env: launch.env, cwd: process.env.HOME, encoding: 'utf8', timeout: 60_000 },
      );
      expect(result.status, result.error?.message ?? result.stderr).toBe(0);
      const selected = result.stderr.match(new RegExp(`${packageName}==([0-9.]+)`))?.[1];
      expect(selected).toBe(expected);
      expect(Date.parse(times[selected ?? ''])).toBeLessThan(cutoff);
    },
    120_000,
  );
});

async function publicationTimes(packageName: string): Promise<Record<string, string>> {
  const result = await npmNative(['view', packageName, 'time', '--json']);
  expect(result.code, result.stderr).toBe(0);
  return npmPublicationTimes(result.stdout);
}

function setPolicy(now: number, source: 'npmrc' | 'env') {
  const home = process.env.HOME;
  expect(home).toBeDefined();
  freezeNpmClock(home ?? '', now);
  if (source === 'npmrc') writeFileSync(join(home ?? '', '.npmrc'), 'min-release-age=7\n');
  else process.env.npm_config_min_release_age = '7';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
}

describe('registry npm launch under a seven-day release cooldown', () => {
  test.each([
    { source: 'npmrc', pin: 'fresh' },
    { source: 'env', pin: 'fresh' },
    { source: 'npmrc', pin: 'admissible' },
  ] as const)(
    'launches the newest admissible adapter with $source policy and a $pin catalog pin',
    async ({ source, pin }) => {
      const packageName = '@agentclientprotocol/claude-agent-acp';
      const times = await publicationTimes(packageName);
      const ceiling = '0.77.0';
      const now = Date.parse(times[ceiling]) + 1000;
      const cutoff = now - 7 * day;
      const expected = newestAdmissible(times, ceiling, cutoff);
      expect(expected).toBeDefined();
      setPolicy(now, source);
      const control = await npmNative([
        'pack',
        `${packageName}@${expected}`,
        '--dry-run',
        '--json',
      ]);
      expect(control.code, control.stderr).toBe(0);

      const agent = registryPackage(`${packageName}@${pin === 'fresh' ? ceiling : expected}`);
      const launch = await resolveRegistryLaunch(agent, null, log);
      const result = await captureChild(
        launch.kind === 'npx'
          ? spawnAcpAgent(launch)
          : spawnAcpAgent(launch, process.env.HOME ?? ''),
        {
          timeoutMs: 90_000,
          graceMs: 1000,
        },
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).not.toContain('ETARGET');
      const cache = join(process.env.HOME ?? '', 'npm-cache', '_npx');
      const installed = readdirSync(cache)
        .map((entry) => join(cache, entry, 'node_modules', packageName, 'package.json'))
        .filter(existsSync)
        .map((path) => JSON.parse(readFileSync(path, 'utf8')).version);
      expect(installed).toEqual([expected]);
      expect(Date.parse(times[installed[0]])).toBeLessThan(cutoff);
    },
    180_000,
  );
});
