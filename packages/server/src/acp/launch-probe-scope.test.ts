import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { getLogger } from '../logger.ts';
import { withLocalAcquisitionRegistry } from './acquisition-contract.test-helper.ts';
import {
  AgentLaunchError,
  type ResolvedLaunch,
  resetAcquisitionCache,
  resolveRegistryLaunch,
} from './launch.ts';
import {
  installNodeFixture,
  npmNative,
  probedDescriptors,
  registryPackage,
  withAcquisitionHome,
  writeExecutable,
  writeRecordingNpm,
} from './package-acquisition.test-helper.ts';

const log = getLogger('launch-probe-scope-test');

function acquisitionBin(home: string): { bin: string; probeLog: string } {
  const bin = join(home, 'bin');
  mkdirSync(bin);
  installNodeFixture(bin);
  writeExecutable(join(bin, 'npx'), 'process.exit(0);');
  return { bin, probeLog: join(home, 'probes.log') };
}

function recordingNpmBin(home: string): { bin: string; probeLog: string } {
  const { bin, probeLog } = acquisitionBin(home);
  writeRecordingNpm(bin, probeLog);
  return { bin, probeLog };
}

function releaseAgeNpmBin(home: string, admitted: string): { bin: string; probeLog: string } {
  const { bin, probeLog } = acquisitionBin(home);
  writeExecutable(
    join(bin, 'npm'),
    `require('node:fs').appendFileSync(${JSON.stringify(probeLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
     const spec = process.argv[3];
     const at = spec.lastIndexOf('@');
     const name = spec.slice(0, at);
     const range = spec.slice(at + 1);
     if (process.env.npm_config_before && !range.includes(' - ')) {
       process.stderr.write('npm error code ETARGET\\nnpm error notarget No matching version found for ' + spec + ' with a date before the release-age cutoff.\\n');
       process.exit(1);
     }
     const version = range.includes(' - ') ? ${JSON.stringify(admitted)} : range;
     process.stdout.write(JSON.stringify([{ name, version }]));`,
  );
  return { bin, probeLog };
}

function gatedNpmBin(
  home: string,
  gatedOutcome: 'refuse' | 'admit',
): { bin: string; probeLog: string; entered: string; release: string } {
  const { bin, probeLog } = acquisitionBin(home);
  const entered = join(home, 'entered');
  const release = join(home, 'release');
  writeExecutable(
    join(bin, 'npm'),
    `const fs = require('node:fs');
     let gated = false;
     try {
       fs.writeFileSync(${JSON.stringify(entered)}, '', { flag: 'wx' });
       gated = true;
     } catch {}
     fs.appendFileSync(${JSON.stringify(probeLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
     const spec = process.argv[3];
     const at = spec.lastIndexOf('@');
     const admit = () =>
       process.stdout.write(
         JSON.stringify([{ name: spec.slice(0, at), version: spec.slice(at + 1) }]),
       );
     const refuse = () => {
       process.stderr.write('npm error code EAGAIN\\nnpm error the fixture registry refused this probe\\n');
       process.exit(1);
     };
     const settle = () => {
       if (!fs.existsSync(${JSON.stringify(release)})) setTimeout(settle, 20);
       else if (${JSON.stringify(gatedOutcome)} === 'refuse') refuse();
       else admit();
     };
     if (gated) settle();
     else admit();`,
  );
  return { bin, probeLog, entered, release };
}

function retryRefusingNpmBin(home: string): {
  bin: string;
  probeLog: string;
  entered: string;
  release: string;
} {
  const { bin, probeLog } = acquisitionBin(home);
  const admitted = join(home, 'admitted');
  const entered = join(home, 'entered');
  const release = join(home, 'release');
  writeExecutable(
    join(bin, 'npm'),
    `const fs = require('node:fs');
     fs.appendFileSync(${JSON.stringify(probeLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
     const spec = process.argv[3];
     const at = spec.lastIndexOf('@');
     const claim = (path) => {
       try {
         fs.writeFileSync(path, '', { flag: 'wx' });
         return true;
       } catch {
         return false;
       }
     };
     const admit = () =>
       process.stdout.write(
         JSON.stringify([{ name: spec.slice(0, at), version: spec.slice(at + 1) }]),
       );
     const refuse = () => {
       process.stderr.write('npm error code EAGAIN\\nnpm error the fixture registry refused this re-acquisition\\n');
       process.exit(1);
     };
     const settle = () => {
       if (fs.existsSync(${JSON.stringify(release)})) refuse();
       else setTimeout(settle, 20);
     };
     if (claim(${JSON.stringify(admitted)}) || !claim(${JSON.stringify(entered)})) admit();
     else settle();`,
  );
  return { bin, probeLog, entered, release };
}

const HOUR_MS = 60 * 60 * 1000;

const awaitGate = (entered: string): Promise<void> =>
  vi.waitFor(() => expect(existsSync(entered)).toBe(true), { timeout: 15_000, interval: 20 });

async function awaitGateOffFakeClock(entered: string): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (!existsSync(entered)) {
    if (performance.now() > deadline) throw new Error(`the gated probe never entered: ${entered}`);
    await new Promise((settle) => setTimeout(settle, 20));
  }
}

function pinnedOpen(
  descriptor: string,
  env: Record<string, string>,
  acquisition?: { reacquire: true },
): Promise<ResolvedLaunch | null> {
  return resolveRegistryLaunch(
    registryPackage(descriptor, 'npx', env),
    null,
    log,
    undefined,
    (candidate) => Promise.resolve(candidate),
    acquisition,
  );
}

describe('registry launch probe scope', () => {
  test('repeated opens of one pinned adapter acquire it once per process', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog } = recordingNpmBin(home);
      const env = { PATH: bin };
      const first = await resolveRegistryLaunch(
        registryPackage('probe-scope-fixture@7.0.0', 'npx', env),
        null,
        log,
      );
      const second = await resolveRegistryLaunch(
        registryPackage('probe-scope-fixture@7.0.0', 'npx', env),
        null,
        log,
      );
      const third = await resolveRegistryLaunch(
        registryPackage('probe-scope-fixture@7.0.0', 'npx', env),
        null,
        log,
      );

      expect(first.args).toEqual(['-y', 'probe-scope-fixture@7.0.0', '--version']);
      expect(second.args).toEqual(first.args);
      expect(third.args).toEqual(first.args);
      expect(probedDescriptors(probeLog)).toEqual(['probe-scope-fixture@7.0.0']);
    });
  });

  test('a resolved acquisition reports how long its probe took', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, entered, release } = gatedNpmBin(home, 'admit');
      const env = { PATH: bin };
      const resolutions: { source: string; elapsedMs: number }[] = [];
      const acquisition = {
        onResolved: (resolution: { source: string; elapsedMs: number }) => {
          resolutions.push(resolution);
        },
      };
      const open = (): Promise<ResolvedLaunch | null> =>
        resolveRegistryLaunch(
          registryPackage('elapsed-probe-fixture@7.0.0', 'npx', env),
          null,
          log,
          undefined,
          (candidate) => Promise.resolve(candidate),
          acquisition,
        );

      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const startedAt = new Date('2026-09-17T00:00:00Z');
        vi.setSystemTime(startedAt);
        const probing = open();
        await awaitGateOffFakeClock(entered);
        vi.setSystemTime(new Date(startedAt.getTime() + 5_000));
        writeFileSync(release, '');
        await probing;
        await open();

        expect(resolutions.map((entry) => entry.source)).toEqual(['probe', 'memo']);
        expect(resolutions[0]?.elapsedMs).toBe(5_000);
        expect(resolutions[1]?.elapsedMs).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  }, 30_000);

  test('a distinct pin is acquired on its own rather than served from another pin', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog } = recordingNpmBin(home);
      const env = { PATH: bin };
      const ceiling = await resolveRegistryLaunch(
        registryPackage('probe-scope-fixture@7.0.0', 'npx', env),
        null,
        log,
      );
      const lower = await resolveRegistryLaunch(
        registryPackage('probe-scope-fixture@6.0.0', 'npx', env),
        null,
        log,
      );
      const other = await resolveRegistryLaunch(
        registryPackage('other-probe-fixture@7.0.0', 'npx', env),
        null,
        log,
      );

      expect(ceiling.args).toEqual(['-y', 'probe-scope-fixture@7.0.0', '--version']);
      expect(lower.args).toEqual(['-y', 'probe-scope-fixture@6.0.0', '--version']);
      expect(other.args).toEqual(['-y', 'other-probe-fixture@7.0.0', '--version']);
      expect(probedDescriptors(probeLog)).toEqual([
        'probe-scope-fixture@7.0.0',
        'probe-scope-fixture@6.0.0',
        'other-probe-fixture@7.0.0',
      ]);
    });
  });

  test('two adapters sharing a pin but not their npm configuration are acquired apart', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog } = releaseAgeNpmBin(home, '6.0.0');
      const descriptor = 'shared-pin-fixture@7.0.0';

      const bounded = await resolveRegistryLaunch(
        registryPackage(descriptor, 'npx', {
          PATH: bin,
          npm_config_before: '2018-04-01T00:00:00Z',
        }),
        null,
        log,
      );
      const unbounded = await resolveRegistryLaunch(
        registryPackage(descriptor, 'npx', { PATH: bin }),
        null,
        log,
      );

      expect(bounded.args).toEqual(['-y', 'shared-pin-fixture@6.0.0', '--version']);
      expect(unbounded.args).toEqual(['-y', 'shared-pin-fixture@7.0.0', '--version']);
      expect(probedDescriptors(probeLog)).toEqual([
        descriptor,
        'shared-pin-fixture@0.0.0 - 7.0.0',
        descriptor,
      ]);
    });
  });

  test('a release-age-bounded acquisition is re-probed once its freshness window closes', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog } = releaseAgeNpmBin(home, '6.0.0');
      const env = { PATH: bin, npm_config_before: '2018-04-01T00:00:00Z' };
      const descriptor = 'aged-probe-fixture@7.0.0';
      const boundedProbe = ['aged-probe-fixture@7.0.0', 'aged-probe-fixture@0.0.0 - 7.0.0'];
      const resolve = () =>
        resolveRegistryLaunch(registryPackage(descriptor, 'npx', env), null, log);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-09-17T00:00:00Z'));
        const first = await resolve();
        expect(first.args).toEqual(['-y', 'aged-probe-fixture@6.0.0', '--version']);
        expect(probedDescriptors(probeLog)).toEqual(boundedProbe);

        vi.setSystemTime(new Date('2026-09-17T00:30:00Z'));
        const withinWindow = await resolve();
        expect(withinWindow.args).toEqual(first.args);
        expect(probedDescriptors(probeLog)).toEqual(boundedProbe);

        vi.setSystemTime(new Date(Date.now() + HOUR_MS));
        const afterWindow = await resolve();
        expect(afterWindow.args).toEqual(first.args);
        expect(probedDescriptors(probeLog)).toEqual([...boundedProbe, ...boundedProbe]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  test('an exact pin stays acquired for the process however long it is held', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog } = recordingNpmBin(home);
      const env = { PATH: bin };
      const resolve = () =>
        resolveRegistryLaunch(registryPackage('probe-scope-fixture@7.0.0', 'npx', env), null, log);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-09-17T00:00:00Z'));
        const first = await resolve();

        vi.setSystemTime(new Date(Date.now() + 48 * HOUR_MS));
        const later = await resolve();

        expect(later.args).toEqual(first.args);
        expect(probedDescriptors(probeLog)).toEqual(['probe-scope-fixture@7.0.0']);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  test('overlapping opens of one pinned adapter share a single probe', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog, entered, release } = gatedNpmBin(home, 'admit');
      const env = { PATH: bin };
      const descriptor = 'concurrent-probe-fixture@7.0.0';
      const resolve = () =>
        resolveRegistryLaunch(registryPackage(descriptor, 'npx', env), null, log);

      const first = resolve();
      const second = resolve();
      await awaitGate(entered);
      writeFileSync(release, '');
      const [opened, alsoOpened] = await Promise.all([first, second]);

      expect(opened.args).toEqual(['-y', descriptor, '--version']);
      expect(alsoOpened.args).toEqual(opened.args);
      expect(probedDescriptors(probeLog)).toEqual([descriptor]);
    });
  }, 30_000);

  test('an open that joins a probe already running for its pin is reported as joined', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog, entered, release } = gatedNpmBin(home, 'admit');
      const env = { PATH: bin };
      const descriptor = 'joined-probe-fixture@7.0.0';
      const sources: string[] = [];
      const acquisition = {
        onResolved: (resolution: { source: string }) => {
          sources.push(resolution.source);
        },
      };
      const open = (): Promise<ResolvedLaunch | null> =>
        resolveRegistryLaunch(
          registryPackage(descriptor, 'npx', env),
          null,
          log,
          undefined,
          (candidate) => Promise.resolve(candidate),
          acquisition,
        );

      const first = open();
      await awaitGate(entered);
      const second = open();
      writeFileSync(release, '');
      const [opened, alsoOpened] = await Promise.all([first, second]);

      expect(opened?.args).toEqual(['-y', descriptor, '--version']);
      expect(alsoOpened?.args).toEqual(opened?.args);
      expect(probedDescriptors(probeLog)).toEqual([descriptor]);
      expect(
        sources,
        'a caller that joined an open probe must not be reported as having originated it',
      ).toEqual(['probe', 'joined']);
    });
  }, 30_000);

  test('a failed acquisition is not remembered, so the next open probes again', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog, release } = gatedNpmBin(home, 'refuse');
      writeFileSync(release, '');
      const env = { PATH: bin };
      const descriptor = 'refused-probe-fixture@7.0.0';
      const resolve = () =>
        resolveRegistryLaunch(registryPackage(descriptor, 'npx', env), null, log);

      const refused = await resolve().catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(AgentLaunchError);

      const recovered = await resolve();

      expect(recovered.args).toEqual(['-y', descriptor, '--version']);
      expect(probedDescriptors(probeLog)).toEqual([descriptor, descriptor]);
    });
  }, 30_000);

  test('an acquisition that found no npm sibling is attempted again on the next open', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog } = acquisitionBin(home);
      const env = { PATH: bin };
      const descriptor = 'unprobed-fixture@7.0.0';
      const resolve = () =>
        resolveRegistryLaunch(registryPackage(descriptor, 'npx', env), null, log);

      const forwarded = await resolve();
      expect(forwarded.args).toEqual(['-y', descriptor, '--version']);
      expect(probedDescriptors(probeLog)).toEqual([]);

      writeRecordingNpm(bin, probeLog);
      const probed = await resolve();

      expect(probed.args).toEqual(['-y', descriptor, '--version']);
      expect(probedDescriptors(probeLog)).toEqual([descriptor]);
    });
  });

  test('a failing probe that outlives a reset does not evict the entry that replaced it', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog, entered, release } = gatedNpmBin(home, 'refuse');
      const env = { PATH: bin };
      const descriptor = 'evicted-probe-fixture@7.0.0';
      const resolve = () =>
        resolveRegistryLaunch(registryPackage(descriptor, 'npx', env), null, log);

      const stalled = resolve().catch((error: unknown) => error);
      await awaitGate(entered);
      resetAcquisitionCache();
      const replacement = await resolve();
      writeFileSync(release, '');
      expect(replacement.args).toEqual(['-y', descriptor, '--version']);
      expect(await stalled).toBeInstanceOf(AgentLaunchError);

      const reused = await resolve();

      expect(reused.args).toEqual(replacement.args);
      expect(probedDescriptors(probeLog)).toEqual([descriptor, descriptor]);
    });
  }, 30_000);

  test('a refused re-acquisition still serves the held pin to an open that never asked for one', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog, entered, release } = retryRefusingNpmBin(home);
      const env = { PATH: bin };
      const descriptor = 'retry-bystander-fixture@7.0.0';
      const open = (acquisition?: { reacquire: true }) => pinnedOpen(descriptor, env, acquisition);
      const acquired = ['-y', descriptor, '--version'];

      const cold = await open();
      expect(cold?.args).toEqual(acquired);

      const retried = open({ reacquire: true }).catch((error: unknown) => error);
      await awaitGate(entered);
      const bystander = open().catch((error: unknown) => error);
      writeFileSync(release, '');

      expect(await retried).toBeInstanceOf(AgentLaunchError);
      expect(
        await bystander,
        'an open that never asked to re-acquire must not inherit the retry failure',
      ).toMatchObject({ args: acquired });

      const afterRefusal = await open();

      expect(afterRefusal?.args).toEqual(acquired);
      expect(probedDescriptors(probeLog)).toEqual([descriptor, descriptor]);
    });
  }, 30_000);

  test('a re-acquisition joins the probe already open for its pin', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog, entered, release } = gatedNpmBin(home, 'admit');
      const env = { PATH: bin };
      const descriptor = 'retry-single-flight-fixture@7.0.0';
      const open = (acquisition?: { reacquire: true }) => pinnedOpen(descriptor, env, acquisition);

      const cold = open();
      await awaitGate(entered);
      const retried = open({ reacquire: true });
      writeFileSync(release, '');
      const [opened, reacquired] = await Promise.all([cold, retried]);

      expect(opened?.args).toEqual(['-y', descriptor, '--version']);
      expect(reacquired?.args).toEqual(opened?.args);
      expect(probedDescriptors(probeLog)).toEqual([descriptor]);
    });
  }, 30_000);

  test('a re-acquisition joins a refresh already open over the held pin', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog, entered, release } = retryRefusingNpmBin(home);
      const env = { PATH: bin };
      const descriptor = 'retry-revalidating-fixture@7.0.0';
      const open = (acquisition?: { reacquire: true }) => pinnedOpen(descriptor, env, acquisition);
      const acquired = ['-y', descriptor, '--version'];

      const cold = await open();
      expect(cold?.args).toEqual(acquired);

      const retried = open({ reacquire: true }).catch((error: unknown) => error);
      await awaitGate(entered);
      const alsoRetried = open({ reacquire: true }).catch((error: unknown) => error);
      writeFileSync(release, '');

      expect(await retried).toBeInstanceOf(AgentLaunchError);
      expect(
        await alsoRetried,
        'a re-acquisition arriving over a refresh already in flight must share it rather than open a second probe',
      ).toBeInstanceOf(AgentLaunchError);
      expect(probedDescriptors(probeLog)).toEqual([descriptor, descriptor]);

      const afterRefusal = await open();

      expect(afterRefusal?.args).toEqual(acquired);
      expect(probedDescriptors(probeLog)).toEqual([descriptor, descriptor]);
    });
  }, 30_000);

  test('an unreachable registry still launches a pin the local npm cache can answer', async () => {
    await withLocalAcquisitionRegistry(async (home, control) => {
      const warm = await npmNative([
        'pack',
        'is-number@7.0.0',
        '--dry-run',
        '--ignore-scripts',
        '--json',
      ]);
      expect(warm.code, warm.stderr).toBe(0);

      await control.closeRegistry();

      const uncached = await npmNative([
        'pack',
        '@agentclientprotocol/claude-agent-acp@0.75.1',
        '--dry-run',
        '--ignore-scripts',
        '--json',
      ]);
      expect(uncached.code, `${home}: the registry must be unreachable`).not.toBe(0);
      expect(uncached.stderr).toContain('ECONNREFUSED');

      const offline = await npmNative([
        'pack',
        'is-number@7.0.0',
        '--dry-run',
        '--ignore-scripts',
        '--json',
        '--offline',
      ]);
      expect(offline.code, 'the local cache must hold an answer').toBe(0);

      const launch = await resolveRegistryLaunch(registryPackage('is-number@7.0.0'), null, log);
      expect(launch.args).toEqual(['-y', 'is-number@7.0.0', '--version']);

      const refused = await resolveRegistryLaunch(
        registryPackage('@agentclientprotocol/claude-agent-acp@0.75.1'),
        null,
        log,
      ).catch((error: unknown) => error);
      expect(
        refused,
        'a pin the cache cannot answer must fail acquisition rather than reach npx unvalidated',
      ).toBeInstanceOf(AgentLaunchError);
      expect(refused).toMatchObject({
        code: 'install-failed',
        machineDetail: expect.stringContaining('ECONNREFUSED'),
      });
    });
  }, 90_000);
});
