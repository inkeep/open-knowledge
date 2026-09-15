import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { getLogger } from '../logger.ts';
import { AgentLaunchError, resolveRegistryLaunch, spawnAcpAgent } from './launch.ts';
import {
  captureChild,
  compareVersions,
  npmNative,
  registryPackage,
  withAcquisitionHome,
} from './package-acquisition.test-helper.ts';

type AcquisitionFactory = (run: (home: string) => Promise<void>) => Promise<void>;

export function acquisitionFailureContract(factory: AcquisitionFactory): void {
  const log = getLogger('acquisition-contract');
  describe('native acquisition contract', () => {
    test('an admitted exact package keeps its pin', async () => {
      await factory(async () => {
        const launch = await resolveRegistryLaunch(registryPackage('is-number@7.0.0'), null, log);
        expect(launch.args).toEqual(['-y', 'is-number@7.0.0', '--version']);
      });
    });
    test('a cutoff substitutes the newest admitted version below the catalog pin', async () => {
      await factory(async (home) => {
        writeFileSync(join(home, '.npmrc'), 'before=2018-04-01T00:00:00Z\n');
        const launch = await resolveRegistryLaunch(registryPackage('is-number@7.0.0'), null, log);
        expect(launch.args).toEqual(['-y', 'is-number@6.0.0', '--version']);
      });
    });
    test('uvx retains the native cutoff refusal', async () => {
      await factory(async (home) => {
        process.env.UV_EXCLUDE_NEWER = '1970-01-01';
        const launch = await resolveRegistryLaunch(
          registryPackage('ruff@0.16.7', 'uvx'),
          null,
          log,
        );
        const result = await captureChild(
          launch.kind === 'npx' ? spawnAcpAgent(launch) : spawnAcpAgent(launch, home),
        );
        expect(result.code, result.stderr).not.toBe(0);
        expect(result.stderr).toContain('No solution found when resolving tool dependencies');
        expect(result.stderr).toContain('filtered by `exclude-newer`');
      });
    });
    test('plain ETARGET does not downgrade a nonexistent pin', async () => {
      await factory(async () => {
        const spec = 'is-number@9999.0.0';
        const control = await npmNative(['pack', spec, '--dry-run', '--ignore-scripts', '--json']);
        expect(control.code, control.stderr).not.toBe(0);
        expect(control.stderr).toContain('ETARGET');
        expect(control.stderr).not.toContain('with a date before');
        const result = await resolveRegistryLaunch(registryPackage(spec), null, log).catch(
          (error: unknown) => error,
        );
        expect(result).toBeInstanceOf(AgentLaunchError);
        expect(result).toMatchObject({
          code: 'install-failed',
          message: `Could not acquire ${spec}.`,
          machineDetail: expect.stringContaining('ETARGET'),
        });
      });
    });
    test('no admitted version reports a release-policy refusal', async () => {
      await factory(async (home) => {
        writeFileSync(join(home, '.npmrc'), 'before=1970-01-01\n');
        await expect(
          resolveRegistryLaunch(registryPackage('is-number@7.0.0'), null, log),
        ).rejects.toMatchObject({
          code: 'install-failed',
          message: expect.stringContaining("package manager's release-date policy"),
        });
      });
    });
  });
}

export async function withLocalAcquisitionRegistry(
  run: (home: string) => Promise<void>,
): Promise<void> {
  await withAcquisitionHome(async (home) => {
    const packages = new Map<string, Map<string, { bytes: Buffer; published: string }>>();
    for (const { name, version, published } of [
      { name: 'is-number', version: '7.0.0', published: '2018-07-04T15:08:58.238Z' },
      { name: 'is-number', version: '6.0.0', published: '2018-03-31T17:02:39.953Z' },
      {
        name: '@agentclientprotocol/claude-agent-acp',
        version: '0.75.1',
        published: '2018-07-04T15:08:58.238Z',
      },
    ] satisfies { name: string; version: string; published: string }[]) {
      const directory = join(home, `${name.replaceAll('/', '-')}-${version}`);
      mkdirSync(join(directory, 'package'), { recursive: true });
      writeFileSync(join(directory, 'package/package.json'), JSON.stringify({ name, version }));
      const archive = join(directory, 'fixture.tgz');
      execFileSync('tar', ['-czf', archive, '-C', directory, 'package']);
      let releases = packages.get(name);
      if (!releases) {
        releases = new Map();
        packages.set(name, releases);
      }
      releases.set(version, { bytes: readFileSync(archive), published });
    }
    const endpoint = createServer((req, res) => {
      const pathname = decodeURIComponent(req.url ?? '/');
      if (pathname === '/simple/ruff/') {
        res.setHeader('content-type', 'application/vnd.pypi.simple.v1+json');
        res.end(
          JSON.stringify({
            meta: { 'api-version': '1.1' },
            name: 'ruff',
            versions: ['0.16.7'],
            files: [
              {
                filename: 'ruff-0.16.7-py3-none-any.whl',
                url: '/refusal-only/ruff.whl',
                hashes: {},
                'upload-time': '2025-01-01T00:00:00Z',
                size: 1,
              },
            ],
          }),
        );
        return;
      }
      if (pathname === '/refusal-only/ruff.whl') {
        res.writeHead(409, { 'content-type': 'text/plain' });
        res.end(
          'This fixture covers cutoff refusal only; Python package installation is unsupported.',
        );
        return;
      }
      const archive = pathname.match(/^(.*)\/([^/]+)\.tgz$/);
      const name = (archive?.[1] ?? pathname).slice(1);
      const releases = packages.get(name);
      if (!releases) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (archive) {
        const release = releases.get(archive[2]);
        res.writeHead(release ? 200 : 404);
        res.end(release?.bytes);
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          name,
          'dist-tags': { latest: [...releases.keys()].sort(compareVersions).at(-1) },
          versions: Object.fromEntries(
            [...releases].map(([version, { bytes }]) => [
              version,
              {
                name,
                version,
                dist: {
                  tarball: `http://${req.headers.host}/${name}/${version}.tgz`,
                  shasum: createHash('sha1').update(bytes).digest('hex'),
                },
              },
            ]),
          ),
          time: Object.fromEntries(
            [...releases].map(([version, { published }]) => [version, published]),
          ),
        }),
      );
    });
    endpoint.listen(0, '127.0.0.1');
    await once(endpoint, 'listening');
    const address = endpoint.address();
    if (address === null || typeof address === 'string') throw new Error('missing port');
    process.env.npm_config_registry = `http://127.0.0.1:${address.port}/`;
    process.env.UV_OFFLINE = '0';
    process.env.UV_DEFAULT_INDEX = `http://127.0.0.1:${address.port}/simple`;
    try {
      await run(home);
    } finally {
      endpoint.closeAllConnections();
      await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    }
  });
}
