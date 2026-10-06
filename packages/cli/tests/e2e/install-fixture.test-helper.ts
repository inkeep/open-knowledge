import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { z } from 'zod';

const execute = promisify(execFile);
export const PARENT = 'ok-cli-fixture-parent';
export const LEAF = 'ok-cli-fixture-leaf';
export const PEER = 'ok-cli-fixture-peer';

export async function createInstallFixture(optionalParent = false) {
  const root = mkdtempSync(join(tmpdir(), 'ok-cli-graph-'));
  const packageDir = join(root, 'packages', 'cli');
  const packDest = join(root, 'pack');
  const installPrefix = join(root, 'install');
  const archives = new Map<string, Buffer>();
  const metadata = new Map<string, Record<string, unknown>>();
  const responses = new Map<string, number | 'reset' | 'timeout'>();
  const oneShotResponses = new Map<string, number[]>();
  const requests: string[] = [];
  const registry = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
    requests.push(path);
    const failure = oneShotResponses.get(path)?.shift() ?? responses.get(path);
    if (failure === 'timeout') return;
    if (failure === 'reset') {
      response.destroy();
      return;
    }
    if (failure) {
      response.writeHead(failure);
      response.end('fixture registry response');
      return;
    }
    const archive = archives.get(path);
    if (archive) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(archive);
      return;
    }
    const manifest = metadata.get(path);
    response.writeHead(manifest ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify(manifest ?? { error: 'not found' }));
  });
  await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
  const address = registry.address();
  if (!address || typeof address === 'string') throw new Error('Registry did not bind TCP');
  const registryUrl = `http://127.0.0.1:${address.port}`;
  const env = {
    ...process.env,
    npm_config_registry: registryUrl,
    npm_config_fetch_retries: '0',
    pnpm_config_registry: registryUrl,
    pnpm_config_cache_dir: join(root, 'pnpm-cache'),
    pnpm_config_fetch_retries: '0',
  };
  const close = async () => {
    await new Promise<void>((resolve, reject) =>
      registry.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  };
  try {
    const resolutions: Record<string, { integrity: string; tarball: string }> = {};
    for (const name of [LEAF, PEER, PARENT]) {
      const versions: Record<string, unknown> = {};
      for (const version of name === PARENT ? ['1.0.0'] : ['1.0.0', '1.1.0']) {
        const dir = join(root, 'registry-packages', `${name}-${version}`);
        mkdirSync(dir, { recursive: true });
        const manifest = {
          name,
          version,
          main: 'index.cjs',
          ...(name === PARENT
            ? { dependencies: { [LEAF]: '^1.0.0' }, peerDependencies: { [PEER]: '^1.0.0' } }
            : {}),
        };
        writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
        writeFileSync(
          join(dir, 'index.cjs'),
          name === PARENT
            ? `module.exports = { leaf: require('${LEAF}'), peer: require('${PEER}') };\n`
            : `module.exports = '${version}';\n`,
        );
        const result = await execute('npm', ['pack', '--ignore-scripts', '--json'], {
          cwd: dir,
          env: { ...env, npm_config_cache: join(root, 'pack-cache') },
        });
        const [packed] = z
          .array(z.object({ filename: z.string(), integrity: z.string() }))
          .nonempty()
          .parse(JSON.parse(result.stdout));
        const path = `/${name}/-/${packed.filename}`;
        archives.set(path, readFileSync(join(dir, packed.filename)));
        const resolution = { integrity: packed.integrity, tarball: `${registryUrl}${path}` };
        resolutions[`${name}@${version}`] = resolution;
        versions[version] = { ...manifest, dist: resolution };
      }
      metadata.set(`/${name}`, {
        name,
        'dist-tags': { latest: name === PARENT ? '1.0.0' : '1.1.0' },
        versions,
      });
    }
    for (const path of [
      packageDir,
      packDest,
      installPrefix,
      join(packageDir, 'dist/public'),
      join(packageDir, 'dist/assets/skills'),
    ]) {
      mkdirSync(path, { recursive: true });
    }
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: z
          .object({ packageManager: z.string() })
          .parse(
            JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')),
          ).packageManager,
      }),
    );
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      YAML.stringify({
        packages: ['packages/*'],
        storeDir: join(root, 'store'),
        pmOnFail: 'ignore',
      }),
    );
    const manifest = {
      name: '@inkeep/open-knowledge',
      version: '1.0.0',
      type: 'module',
      bin: { ok: 'dist/cli.mjs' },
      files: ['dist'],
      dependencies: { [PEER]: '^1.0.0', ...(!optionalParent ? { [PARENT]: '^1.0.0' } : {}) },
      ...(optionalParent ? { optionalDependencies: { [PARENT]: '^1.0.0' } } : {}),
    };
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify(manifest));
    writeFileSync(
      join(packageDir, 'dist/cli.mjs'),
      `#!/usr/bin/env node\nimport { createRequire } from 'node:module';\nconsole.log(JSON.stringify(createRequire(import.meta.url)('${PARENT}')));\n`,
    );
    writeFileSync(join(packageDir, 'dist/public/index.html'), '<title>CLI fixture</title>');
    writeFileSync(join(packageDir, 'dist/assets/skills/SKILL.md'), '# CLI fixture\n');
    const parentVersion = `1.0.0(${PEER}@1.0.0)`;
    const lock = {
      lockfileVersion: '9.0',
      settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
      importers: {
        'packages/cli': {
          dependencies: {
            [PEER]: { specifier: '^1.0.0', version: '1.0.0' },
            ...(!optionalParent
              ? { [PARENT]: { specifier: '^1.0.0', version: parentVersion } }
              : {}),
          },
          ...(optionalParent
            ? {
                optionalDependencies: { [PARENT]: { specifier: '^1.0.0', version: parentVersion } },
              }
            : {}),
        },
      },
      packages: {
        [`${PARENT}@1.0.0`]: {
          resolution: resolutions[`${PARENT}@1.0.0`],
          peerDependencies: { [PEER]: '^1.0.0' },
        },
        [`${LEAF}@1.0.0`]: { resolution: resolutions[`${LEAF}@1.0.0`] },
        [`${PEER}@1.0.0`]: { resolution: resolutions[`${PEER}@1.0.0`] },
      },
      snapshots: {
        [`${PARENT}@${parentVersion}`]: {
          dependencies: { [LEAF]: '1.0.0', [PEER]: '1.0.0' },
          ...(optionalParent ? { optional: true } : {}),
        },
        [`${LEAF}@1.0.0`]: optionalParent ? { optional: true } : {},
        [`${PEER}@1.0.0`]: {},
      },
    };
    const lockPath = join(root, 'pnpm-lock.yaml');
    writeFileSync(lockPath, YAML.stringify(lock));
    return {
      root,
      packageDir,
      packDest,
      installPrefix,
      env,
      close,
      requests,
      responses,
      oneShotResponses,
      manifest,
      lock,
      lockPath,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
