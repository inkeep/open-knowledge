import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { getLogger } from '../logger.ts';
import { acquisitionFailureContract } from './acquisition-contract.test-helper.ts';
import { resolveRegistryLaunch, spawnAcpAgent } from './launch.ts';
import {
  captureChild,
  freezeNpmClock,
  native,
  newestAdmissible,
  npmNative,
  npmPackedVersion,
  npmPublicationTimes,
  registryPackage,
  withLiveAcquisitionHome,
} from './package-acquisition.test-helper.ts';

const log = getLogger('package-acquisition-network-test');
const packageName = '@agentclientprotocol/claude-agent-acp';
const ceiling = '0.77.0';

async function npmTimes() {
  const result = await npmNative(['view', packageName, 'time', '--json']);
  expect(result.code, result.stderr).toBe(0);
  return npmPublicationTimes(result.stdout);
}

acquisitionFailureContract(withLiveAcquisitionHome);

describe('live package acquisition policy and native dispatch', () => {
  test.each([
    { policy: 'before', role: 'compatibility control' },
    { policy: 'excluded', role: 'known npm pack exclusion limitation' },
  ] as const)(
    '$role: the launch respects native $policy selection',
    async ({ policy }) => {
      await withLiveAcquisitionHome(async (home) => {
        const times = await npmTimes();
        const now = Date.parse(times[ceiling]) + 1000;
        freezeNpmClock(home, now);
        writeFileSync(join(home, '.npmrc'), 'min-release-age=7\n');
        if (policy === 'before') process.env.npm_config_before = new Date(now).toISOString();
        else
          writeFileSync(
            join(home, '.npmrc'),
            `min-release-age=7\nmin-release-age-exclude[]=${packageName}\n`,
          );
        const result = await npmNative([
          'pack',
          `${packageName}@${ceiling}`,
          '--dry-run',
          '--ignore-scripts',
          '--json',
        ]);
        const expected =
          policy === 'before' ? ceiling : newestAdmissible(times, ceiling, now - 7 * 86_400_000);
        expect(expected).toBeDefined();
        if (policy === 'before') {
          expect(result.code, result.stderr).toBe(0);
          expect(npmPackedVersion(result.stdout)).toBe(ceiling);
        } else {
          expect(result.code, result.stderr).toBe(1);
          expect(result.stderr).toMatch(/ETARGET[\s\S]*with a date before/);
          expect(expected).not.toBe(ceiling);
        }
        const launch = await resolveRegistryLaunch(
          registryPackage(`${packageName}@${ceiling}`),
          null,
          log,
        );
        expect(launch.args).toContain(`${packageName}@${expected}`);
      });
    },
    120_000,
  );

  test('a dated refusal selects an exact admissible descriptor below the package ceiling', async () => {
    await withLiveAcquisitionHome(async (home) => {
      const times = await npmTimes();
      freezeNpmClock(home, Date.parse(times[ceiling]) + 1000);
      writeFileSync(join(home, '.npmrc'), 'min-release-age=7\n');
      const control = await npmNative([
        'pack',
        `${packageName}@0.0.0 - ${ceiling}`,
        '--dry-run',
        '--ignore-scripts',
        '--json',
      ]);
      expect(control.code, control.stderr).toBe(0);
      const expected = npmPackedVersion(control.stdout);
      expect(expected).not.toBe(ceiling);
      const launch = await resolveRegistryLaunch(
        registryPackage(`${packageName}@${ceiling}`),
        null,
        log,
      );
      expect(launch.args).toEqual(['-y', `${packageName}@${expected}`, '--version']);
    });
  }, 120_000);

  test.each(['@', '=='] as const)(
    'actual uvx resolves %s exact pins below the cutoff despite an installed newer tool',
    async (separator) => {
      await withLiveAcquisitionHome(async () => {
        const response = await native('curl', [
          '-fsS',
          '--max-time',
          '20',
          'https://pypi.org/pypi/ruff/json',
        ]);
        expect(response.code, response.stderr).toBe(0);
        const metadata = JSON.parse(response.stdout);
        const version: string = metadata.info.version;
        const published: string = metadata.releases[version][0].upload_time_iso_8601;
        const installed = await native('uv', [
          'tool',
          'install',
          `ruff==${version}`,
          '--no-config',
        ]);
        expect(installed.code, installed.stderr).toBe(0);
        process.env.UV_EXCLUDE_NEWER = new Date(Date.parse(published) - 1000).toISOString();
        const control = await native('uvx', [
          '--from',
          `ruff<=${version}`,
          '--isolated',
          '--upgrade-package',
          'ruff',
          'ruff',
          '--version',
        ]);
        expect(control.code, control.stderr).toBe(0);
        expect(control.stdout.trim()).not.toBe(`ruff ${version}`);
        const launch = await resolveRegistryLaunch(
          registryPackage(`ruff${separator}${version}`, 'uvx'),
          null,
          log,
        );
        const result = await captureChild(
          launch.kind === 'npx'
            ? spawnAcpAgent(launch)
            : spawnAcpAgent(launch, process.env.HOME ?? ''),
        );
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe(control.stdout.trim());
      });
    },
    180_000,
  );
});
