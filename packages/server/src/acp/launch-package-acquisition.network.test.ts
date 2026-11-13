import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { describe, expect, test } from 'vitest';
import { spawnUnderOwnerLifeline } from '../../../../test-support/owner-lifeline.ts';
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

const managedRuntimeTimeoutMs = 300_000;
const managedAgentPackage = '@agentclientprotocol/codex-acp@1.11.0';
const tsxLoader = createRequire(import.meta.url).resolve('tsx');

test(
  'the product installs Node v24.22.3 and initializes an ACP agent',
  async (ctx) => {
    const started = performance.now();
    await withLiveAcquisitionHome(async (home) => {
      const entry = {
        ...registryPackage(managedAgentPackage),
        distribution: { npx: { package: managedAgentPackage } },
      };
      const probe = String.raw`
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { ensureManagedRuntime } from ${JSON.stringify(new URL('./managed-runtime.ts', import.meta.url).href)};
import { resolveRegistryLaunch, rewriteLaunchToManagedRuntime } from ${JSON.stringify(new URL('./launch.ts', import.meta.url).href)};
import { PinoLogger } from ${JSON.stringify(new URL('../logger.ts', import.meta.url).href)};
const log = new PinoLogger('managed-runtime-network-probe', { consoleDestination: 2 });
const runtime = await ensureManagedRuntime('node', log, { root: join(process.env.HOME, 'runtimes') });
const launch = rewriteLaunchToManagedRuntime(await resolveRegistryLaunch(${JSON.stringify(entry)}, null, log), runtime);
const node = join(runtime.binDir, process.platform === 'win32' ? 'node.exe' : 'node');
const agent = spawn(launch.cmd, launch.args, {
  cwd: process.env.HOME, env: launch.env, stdio: ['pipe', 'pipe', 'inherit'],
});
const closed = once(agent, 'close');
const lines = createInterface({ input: agent.stdout });
agent.stdin.write(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: ${JSON.stringify(PROTOCOL_VERSION)}, clientCapabilities: {},
    clientInfo: { name: 'managed-runtime-network-test', version: '1.0.0' } },
}) + '\n');
let initialized = false;
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id !== 1 || message.method !== undefined) continue;
  if (message.error || message.result?.protocolVersion !== ${JSON.stringify(PROTOCOL_VERSION)}) {
    throw new Error('ACP initialize failed: ' + JSON.stringify(message));
  }
  process.stderr.write('ACP initialized: ' + JSON.stringify(message.result.agentInfo) + '\n');
  initialized = true;
  agent.stdin.end();
  break;
}
if (!initialized) throw new Error('ACP agent closed before initialize completed');
const [code, signal] = await closed;
if (code !== 0 || signal !== null) throw new Error('ACP agent exit: ' + JSON.stringify({ code, signal }));
console.log(execFileSync(node, ['--version'], { encoding: 'utf8' }).trim());
`;
      ctx.signal.throwIfAborted();
      const remaining = Math.floor(managedRuntimeTimeoutMs - (performance.now() - started));
      if (remaining <= 0) throw new Error('No test budget remains for the managed agent probe');
      const holder = spawnUnderOwnerLifeline(
        process.execPath,
        ['--import', tsxLoader, '--conditions=development', '--input-type=module', '--eval', probe],
        { cwd: home, env: process.env },
      );
      const captured = captureChild(holder.child, { timeoutMs: remaining });
      ctx.onTestFinished(async () => {
        holder.child.stdin.destroy();
        const result = await captured;
        if (ctx.signal.aborted) console.error(result.stderr);
      });
      const result = await captured;
      const status = await holder.commandResult;
      if (status === null || status.code !== 0 || status.signal !== null) {
        throw new Error(`Managed agent probe failed: ${JSON.stringify(status)}\n${result.stderr}`);
      }
      expect(result.stdout.trim(), result.stderr).toBe('v24.22.3');
      console.info('Managed Node version:', result.stdout.trim());
      console.info(result.stderr.split('\n').find((line) => line.startsWith('ACP initialized:')));
    });
  },
  managedRuntimeTimeoutMs,
);
