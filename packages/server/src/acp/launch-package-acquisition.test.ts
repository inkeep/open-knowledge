import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { okUserHomeDir } from '@inkeep/open-knowledge-core/server';
import { describe, expect, test } from 'vitest';
import {
  executableFacts,
  findExecutable,
} from '../../../../test-support/capabilities.test-helper.ts';
import { getLogger } from '../logger.ts';
import {
  ARGV_PROBE_PACKAGE,
  ARGV_PROBE_VERSION,
  acquisitionFailureContract,
  withLocalAcquisitionRegistry,
} from './acquisition-contract.test-helper.ts';
import {
  AgentLaunchError,
  agentSpawnPath,
  npxInstallRefused,
  resolveRegistryLaunch,
  spawnAcpAgent,
} from './launch.ts';
import { entryOutcome, npxEntries } from './npx-cache-entry.test-helper.ts';
import {
  captureChild,
  installNodeFixture,
  npmNative,
  npmOutputs,
  npmPackedVersion,
  registryPackage,
  withAcquisitionHome,
  writeExecutable,
} from './package-acquisition.test-helper.ts';

const log = getLogger('package-acquisition-test');

acquisitionFailureContract(withLocalAcquisitionRegistry, {
  uvxOnAgentSpawnPath: findExecutable('uvx', agentSpawnPath(), executableFacts),
});

describe('npx launches that OK installs before they start', () => {
  const spec = `${ARGV_PROBE_PACKAGE}@${ARGV_PROBE_VERSION}`;
  const resolveInstalled = async (reacquire = false) => {
    const launch = await resolveRegistryLaunch(
      registryPackage(spec),
      null,
      log,
      undefined,
      async (prepared) => prepared,
      { install: true, reacquire },
    );
    if (launch?.kind !== 'npx') throw new Error(`expected an npx launch, got ${launch?.kind}`);
    return launch;
  };

  test('the launch refuses to install and runs the copy its install step put in the npx cache', async () => {
    await withLocalAcquisitionRegistry(async (home) => {
      const launch = await resolveInstalled();
      expect(launch.args).toEqual(['--yes=false', '--loglevel=error', spec, '--version']);
      const installed = npxEntries(home);
      expect(installed).toHaveLength(1);
      const entry = String(installed[0]);
      expect(entryOutcome(entry, ARGV_PROBE_PACKAGE).state).toBe('complete');
      const run = await captureChild(spawnAcpAgent(launch));
      expect(run.code, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        args: ['--version'],
        script: join(entry, 'node_modules', ARGV_PROBE_PACKAGE, 'bin.js'),
      });
      expect(npxEntries(home)).toEqual([entry]);
    });
  }, 90_000);

  test('a launch whose npx cache was wiped is refused before npm installs anything, and runs once reinstalled', async () => {
    await withLocalAcquisitionRegistry(async (home) => {
      const launch = await resolveInstalled();
      const installed = npxEntries(home);
      expect(installed).toHaveLength(1);
      const entry = String(installed[0]);
      expect(entryOutcome(entry, ARGV_PROBE_PACKAGE).state).toBe('complete');
      rmSync(join(home, 'npm-cache', '_npx'), { recursive: true, force: true });
      rmSync(join(home, 'npm-cache', '_cacache'), { recursive: true, force: true });
      const refused = await captureChild(spawnAcpAgent(launch));
      expect(refused.code, refused.stdout).toBe(1);
      expect(npxInstallRefused(refused.stderr), refused.stderr).toBe(true);
      expect(npxEntries(home)).toEqual([entry]);
      expect(readdirSync(entry)).toEqual([]);
      expect(await resolveInstalled(true)).toEqual(launch);
      expect(entryOutcome(entry, ARGV_PROBE_PACKAGE).state).toBe('complete');
      const run = await captureChild(spawnAcpAgent(launch));
      expect(run.code, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        args: ['--version'],
        script: join(entry, 'node_modules', ARGV_PROBE_PACKAGE, 'bin.js'),
      });
    });
  }, 90_000);

  test.each([
    {
      silencedBy: 'loglevel=silent in the user .npmrc',
      silence: (home: string) => writeFileSync(join(home, '.npmrc'), 'loglevel=silent\n'),
    },
    {
      silencedBy: 'npm_config_loglevel=silent in the environment',
      silence: () => {
        process.env.npm_config_loglevel = 'silent';
      },
    },
  ])(
    'a launch whose npx cache was wiped still reports the refusal when $silencedBy',
    async ({ silence }) => {
      await withLocalAcquisitionRegistry(async (home) => {
        silence(home);
        const launch = await resolveInstalled();
        expect(npxEntries(home)).toHaveLength(1);
        rmSync(join(home, 'npm-cache', '_npx'), { recursive: true, force: true });
        rmSync(join(home, 'npm-cache', '_cacache'), { recursive: true, force: true });
        const refused = await captureChild(spawnAcpAgent(launch));
        expect(refused.code, refused.stdout).toBe(1);
        expect(npxInstallRefused(refused.stderr), refused.stderr).toBe(true);
      });
    },
    90_000,
  );
});

describe('hermetic package acquisition and native dispatch', () => {
  test('the fixture latest tag is independent of release insertion order', async () => {
    await withLocalAcquisitionRegistry(async () => {
      const result = await npmNative([
        'pack',
        'is-number',
        '--dry-run',
        '--ignore-scripts',
        '--json',
      ]);
      expect(result.code, result.stderr).toBe(0);
      expect(npmPackedVersion(result.stdout)).toBe('7.0.0');
    });
  });

  test('closed custom registry preserves transport failure without a cooldown diagnosis', async () => {
    await withAcquisitionHome(async () => {
      const endpoint = createServer();
      endpoint.listen(0, '127.0.0.1');
      await once(endpoint, 'listening');
      const address = endpoint.address();
      if (address === null || typeof address === 'string') throw new Error('missing port');
      await new Promise<void>((resolve) => endpoint.close(() => resolve()));
      process.env.npm_config_registry = `http://127.0.0.1:${address.port}/`;
      const result = await resolveRegistryLaunch(
        registryPackage('is-number@7.0.0'),
        null,
        log,
      ).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(AgentLaunchError);
      expect(result).toMatchObject({
        code: 'install-failed',
        message: 'Could not acquire is-number@7.0.0.',
        machineDetail: expect.stringContaining('ECONNREFUSED'),
      });
      expect(String(result)).not.toMatch(/release-date policy|cooldown/);
    });
  });

  test.each(['auth', 'integrity'] as const)(
    'real npm preserves a custom registry %s refusal',
    async (mode) => {
      await withAcquisitionHome(async (home) => {
        const seen: string[] = [];
        const endpoint = createServer((req, res) => {
          seen.push(req.headers.authorization ?? '');
          if (mode === 'auth') {
            res.writeHead(401);
            res.end('{"error":"fixture authentication rejected"}');
            return;
          }
          if (req.url?.endsWith('.tgz')) {
            res.end('corrupted tarball');
            return;
          }
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              name: 'acquisition-fixture',
              'dist-tags': { latest: '1.0.0' },
              versions: {
                '1.0.0': {
                  name: 'acquisition-fixture',
                  version: '1.0.0',
                  dist: {
                    tarball: `http://${req.headers.host}/fixture.tgz`,
                    shasum: '0'.repeat(40),
                  },
                },
              },
              time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
            }),
          );
        });
        endpoint.listen(0, '127.0.0.1');
        await once(endpoint, 'listening');
        const address = endpoint.address();
        if (address === null || typeof address === 'string') throw new Error('missing port');
        process.env.npm_config_registry = `http://127.0.0.1:${address.port}/`;
        writeFileSync(
          join(home, '.npmrc'),
          `//127.0.0.1:${address.port}/:_authToken=fixture-only-token\n`,
        );
        try {
          const control = await npmNative([
            'pack',
            'acquisition-fixture@1.0.0',
            '--dry-run',
            '--ignore-scripts',
            '--json',
          ]);
          const code = mode === 'auth' ? 'E401' : 'EINTEGRITY';
          expect(control.stderr).toContain(code);
          expect(seen).toContain('Bearer fixture-only-token');
          const result = await resolveRegistryLaunch(
            registryPackage('acquisition-fixture@1.0.0'),
            null,
            log,
          ).catch((error: unknown) => error);
          expect(result).toBeInstanceOf(AgentLaunchError);
          expect(result).toMatchObject({
            code: 'install-failed',
            message: 'Could not acquire acquisition-fixture@1.0.0.',
            machineDetail: expect.stringContaining(code),
          });
          expect(String(result)).not.toMatch(/release-date policy|cooldown/);
        } finally {
          endpoint.closeAllConnections();
          await new Promise<void>((resolve) => endpoint.close(() => resolve()));
        }
      });
    },
    90_000,
  );

  test.each(npmOutputs)('accepts captured npm $npmVersion package metadata', async ({ pack }) => {
    await withAcquisitionHome(async (home) => {
      const bin = join(home, 'bin');
      mkdirSync(bin);
      installNodeFixture(bin);
      writeExecutable(join(bin, 'npx'), 'process.exit(0);');
      writeExecutable(
        join(bin, 'npm'),
        `process.stdout.write(${JSON.stringify(JSON.stringify(pack))});`,
      );
      const launch = await resolveRegistryLaunch(
        registryPackage('is-number@7.0.0', 'npx', { PATH: bin }),
        null,
        log,
      );
      expect(launch.args).toEqual(['-y', 'is-number@7.0.0', '--version']);
    });
  });

  test.each([
    { label: 'empty', output: {} },
    {
      label: 'multiple packages',
      output: {
        a: { name: 'is-number', version: '7.0.0' },
        b: { name: 'other', version: '1.0.0' },
      },
    },
    { label: 'wrong name', output: { other: { name: 'other', version: '7.0.0' } } },
    { label: 'above ceiling', output: { 'is-number': { name: 'is-number', version: '8.0.0' } } },
    { label: 'below exact pin', output: { 'is-number': { name: 'is-number', version: '6.0.0' } } },
    {
      label: 'prerelease',
      output: { 'is-number': { name: 'is-number', version: '7.0.0-beta.1' } },
    },
  ])('rejects $label package metadata', async ({ output }) => {
    await withAcquisitionHome(async (home) => {
      const bin = join(home, 'bin');
      mkdirSync(bin);
      installNodeFixture(bin);
      writeExecutable(join(bin, 'npx'), 'process.exit(0);');
      writeExecutable(
        join(bin, 'npm'),
        `process.stdout.write(${JSON.stringify(JSON.stringify(output))});`,
      );
      await expect(
        resolveRegistryLaunch(registryPackage('is-number@7.0.0', 'npx', { PATH: bin }), null, log),
      ).rejects.toMatchObject({ code: 'install-failed' });
    });
  });

  test.each(['missing', 'non-executable'] as const)(
    'npx without a usable npm sibling retains the catalog pin: %s',
    async (mode) => {
      await withAcquisitionHome(async (home) => {
        const bin = join(home, 'bin');
        mkdirSync(bin);
        installNodeFixture(bin);
        writeExecutable(join(bin, 'npx'), 'process.exit(0);');
        if (mode === 'non-executable') writeFileSync(join(bin, 'npm'), 'not executable');
        const launch = await resolveRegistryLaunch(
          registryPackage('is-number@7.0.0', 'npx', { PATH: bin }),
          null,
          log,
        );
        expect(launch.args).toEqual(['-y', 'is-number@7.0.0', '--version']);
      });
    },
  );

  test.each([
    { name: 'other', version: '7.0.0' },
    { name: 'is-number', version: '8.0.0' },
    { name: 'is-number', version: '6.0.0' },
  ])('names the rejected package $name@$version separately from parsing', async (selected) => {
    await withAcquisitionHome(async (home) => {
      const bin = join(home, 'bin');
      mkdirSync(bin);
      installNodeFixture(bin);
      writeExecutable(join(bin, 'npx'), 'process.exit(0);');
      writeExecutable(
        join(bin, 'npm'),
        `process.stdout.write(${JSON.stringify(JSON.stringify([selected]))});`,
      );
      await expect(
        resolveRegistryLaunch(registryPackage('is-number@7.0.0', 'npx', { PATH: bin }), null, log),
      ).rejects.toMatchObject({
        message: `npm returned ${selected.name}@${selected.version} outside the requested constraint is-number@7.0.0.`,
      });
    });
  });

  test('a failed range probe names its constraint and keeps redacted output out of the headline', async () => {
    await withAcquisitionHome(async (home) => {
      const bin = join(home, 'bin');
      mkdirSync(bin);
      installNodeFixture(bin);
      writeExecutable(join(bin, 'npx'), 'process.exit(0);');
      const detail =
        'E401 https://alice:fixture-secret@registry.example.test/private-package Authorization: Bearer fixture-token /Users/fixture-user/.npm/_logs/example.log';
      writeExecutable(
        join(bin, 'npm'),
        `
        process.stderr.write(process.argv[3].includes(' - ') ? ${JSON.stringify(detail)} : 'ETARGET No matching version found with a date before 2000-01-01');
        process.exit(1);
      `,
      );
      const result = await resolveRegistryLaunch(
        registryPackage('is-number@7.0.0', 'npx', { PATH: bin }),
        null,
        log,
      ).catch((error: unknown) => error);
      expect(result).toMatchObject({
        message: 'Could not acquire is-number@0.0.0 - 7.0.0.',
        machineDetail: expect.stringContaining('E401'),
      });
      expect(result).toBeInstanceOf(AgentLaunchError);
      if (!(result instanceof AgentLaunchError)) throw new Error('expected acquisition failure');
      expect(result.machineDetail).not.toMatch(/fixture-secret|fixture-token|fixture-user/);
      expect(result.message).not.toContain('E401');
    });
  });

  test('an install that fails without output names its exit code in the machine detail', async () => {
    await withAcquisitionHome(async (home) => {
      const bin = join(home, 'bin');
      mkdirSync(bin);
      installNodeFixture(bin);
      writeExecutable(join(bin, 'npx'), 'process.exit(3);');
      writeExecutable(
        join(bin, 'npm'),
        `process.stdout.write(${JSON.stringify(JSON.stringify([{ name: 'is-number', version: '7.0.0' }]))});`,
      );
      await expect(
        resolveRegistryLaunch(
          registryPackage('is-number@7.0.0', 'npx', { PATH: bin }),
          null,
          log,
          undefined,
          async (launch) => launch,
          { install: true },
        ),
      ).rejects.toMatchObject({
        code: 'install-failed',
        message: 'Could not install is-number@7.0.0.',
        machineDetail: 'exit code 3',
      });
    });
  });

  test.skipIf(process.platform === 'win32')(
    'an install reports the output it wrote without leaving an output file in its working directory',
    async () => {
      await withAcquisitionHome(async (home) => {
        const bin = join(home, 'bin');
        mkdirSync(bin);
        installNodeFixture(bin);
        const listing = join(home, 'npx-cwd-listing.json');
        writeExecutable(
          join(bin, 'npx'),
          `const fs = require('node:fs');
          fs.writeFileSync(${JSON.stringify(listing)}, JSON.stringify(fs.readdirSync(process.cwd())));
          process.stderr.write('npm error fixture install output\\n');
          process.exit(1);`,
        );
        writeExecutable(
          join(bin, 'npm'),
          `process.stdout.write(${JSON.stringify(JSON.stringify([{ name: 'is-number', version: '7.0.0' }]))});`,
        );
        await expect(
          resolveRegistryLaunch(
            registryPackage('is-number@7.0.0', 'npx', { PATH: bin }),
            null,
            log,
            undefined,
            async (launch) => launch,
            { install: true },
          ),
        ).rejects.toMatchObject({
          code: 'install-failed',
          message: 'Could not install is-number@7.0.0.',
          machineDetail: 'npm error fixture install output',
        });
        expect(JSON.parse(readFileSync(listing, 'utf8'))).toEqual(['package.json']);
        expect(readdirSync(join(okUserHomeDir(home), 'acp-npx-cwd'))).toEqual(['package.json']);
      });
    },
  );

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an install whose working directory refuses its output file fails as an install naming the cause',
    async () => {
      await withAcquisitionHome(async (home) => {
        const bin = join(home, 'bin');
        mkdirSync(bin);
        installNodeFixture(bin);
        writeExecutable(join(bin, 'npx'), 'process.exit(0);');
        writeExecutable(
          join(bin, 'npm'),
          `process.stdout.write(${JSON.stringify(JSON.stringify([{ name: 'is-number', version: '7.0.0' }]))});`,
        );
        const npxCwd = join(okUserHomeDir(home), 'acp-npx-cwd');
        mkdirSync(npxCwd, { recursive: true });
        writeFileSync(join(npxCwd, 'package.json'), '{}\n');
        chmodSync(npxCwd, 0o500);
        try {
          const result = await resolveRegistryLaunch(
            registryPackage('is-number@7.0.0', 'npx', { PATH: bin }),
            null,
            log,
            undefined,
            async (launch) => launch,
            { install: true },
          ).catch((error: unknown) => error);
          expect(result).toBeInstanceOf(AgentLaunchError);
          expect(result).toMatchObject({
            code: 'install-failed',
            message: 'Could not install is-number@7.0.0.',
            machineDetail: expect.stringContaining('EACCES'),
          });
        } finally {
          chmodSync(npxCwd, 0o700);
        }
      });
    },
  );

  test.each(['malformed', 'overflow', 'timeout'] as const)(
    'native npm %s output fails acquisition and releases the owned process',
    async (mode) => {
      await withAcquisitionHome(async (home) => {
        const bin = join(home, 'bin');
        mkdirSync(bin);
        installNodeFixture(bin);
        const pidPath = join(home, 'probe.pid');
        const observed = join(home, 'probe.json');
        const HUNG_NPM_SELF_EXIT_MS = 240_000;
        writeExecutable(join(bin, 'npx'), 'process.exit(0);');
        const response =
          mode === 'malformed'
            ? "process.stdout.write('{not-json');"
            : mode === 'overflow'
              ? "process.stdout.write('x'.repeat(32 * 1024 * 1024));"
              : `setTimeout(() => process.exit(0), ${HUNG_NPM_SELF_EXIT_MS});`;
        writeExecutable(
          join(bin, 'npm'),
          `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
        require('node:fs').writeFileSync(${JSON.stringify(observed)}, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));
        ${response}`,
        );
        let pid: number | undefined;
        const result = await resolveRegistryLaunch(
          registryPackage('is-number@7.0.0', 'npx', { PATH: bin }),
          null,
          log,
        ).catch((error: unknown) => error);
        if (existsSync(pidPath)) pid = Number(readFileSync(pidPath, 'utf8'));
        expect(result).toBeInstanceOf(AgentLaunchError);
        expect(result).toMatchObject({ code: 'install-failed' });
        const probe = JSON.parse(readFileSync(observed, 'utf8'));
        expect(probe.cwd).toBe(join(home, '.ok', 'acp-npx-cwd'));
        expect(probe.args).toContain('--ignore-scripts');
        if (pid === undefined) throw new Error('the npm fixture recorded no pid');
        expect(() => process.kill(pid, 0)).toThrow();
        expect(String(result).length).toBeLessThan(20_000);
      });
    },
    120_000,
  );
});
