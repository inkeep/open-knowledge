import { type ExecFileOptionsWithStringEncoding, execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import YAML from 'yaml';
import { createInstallFixture, LEAF, PARENT, PEER } from './install-fixture.test-helper';
import { installPackedCli } from './packed-install.test-helper';

test('reports unavailable registry acquisition after bounded attempts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-cli-install-contract-'));
  const packageDir = join(root, 'package');
  const packDest = join(root, 'pack');
  const installPrefix = join(root, 'install');
  for (const dir of [packageDir, packDest, installPrefix]) mkdirSync(dir);
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@inkeep/open-knowledge',
      version: '1.0.0',
      dependencies: { 'ok-cli-registry-fixture': '1.0.0' },
    }),
  );
  let registryReached = false;
  const registry = createServer((_request, response) => {
    registryReached = true;
    response.writeHead(503, { 'content-type': 'text/plain' });
    response.end('registry temporarily unavailable');
  });
  await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
  const address = registry.address();
  if (!address || typeof address === 'string') throw new Error('Registry did not bind TCP');
  try {
    await expect(
      installPackedCli({
        mode: 'fresh',
        packageDir,
        packDest,
        installPrefix,
        env: {
          ...process.env,
          npm_config_registry: `http://127.0.0.1:${address.port}`,
          npm_config_fetch_retries: '0',
          npm_config_cache: join(root, 'cache'),
          FORCE_COLOR: '1',
        },
      }),
    ).rejects.toMatchObject({ name: 'CliInstallUnavailableError', exitCode: 77 });
    expect(registryReached).toBe(true);
    const logs = join(root, 'cache', '_logs');
    const installs = readdirSync(logs).filter((name) =>
      /\bverbose title npm install\b/.test(readFileSync(join(logs, name), 'utf8')),
    );
    expect(installs).toHaveLength(3);
  } finally {
    await new Promise<void>((resolve, reject) =>
      registry.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  }
});

test('runs the packed CLI with the committed transitive and peer versions', async () => {
  const fixture = await createInstallFixture();
  try {
    const installed = await installPackedCli(fixture);
    const result = await promisify(execFile)(process.execPath, [installed.cliPath]);
    expect(JSON.parse(result.stdout)).toEqual({ leaf: '1.0.0', peer: '1.0.0' });
  } finally {
    await fixture.close();
  }
});

test('keeps fresh npm resolution selectable', async () => {
  const fixture = await createInstallFixture();
  try {
    const installed = await installPackedCli({
      ...fixture,
      env: { ...fixture.env, OK_CLI_E2E_INSTALL_MODE: 'fresh' },
    });
    const result = await promisify(execFile)(process.execPath, [installed.cliPath]);
    expect(JSON.parse(result.stdout)).toEqual({ leaf: '1.1.0', peer: '1.1.0' });
    const graphPath = join(fixture.packageDir, 'test-results', 'cli-e2e-fresh-graph.json');
    expect(existsSync(graphPath)).toBe(true);
    expect(JSON.parse(readFileSync(graphPath, 'utf8'))).toMatchObject({
      packages: {
        [`node_modules/${LEAF}`]: { version: '1.1.0', integrity: expect.any(String) },
        [`node_modules/${PEER}`]: { version: '1.1.0', integrity: expect.any(String) },
      },
    });
  } finally {
    await fixture.close();
  }
});

test.each(['dist/public/index.html', 'dist/assets/skills'])(
  'rejects a packed files list that omits %s',
  async (asset) => {
    const fixture = await createInstallFixture();
    try {
      writeFileSync(
        join(fixture.packageDir, 'package.json'),
        JSON.stringify({
          ...fixture.manifest,
          files: [
            'dist/cli.mjs',
            asset === 'dist/public/index.html' ? 'dist/assets' : 'dist/public',
          ],
        }),
      );
      await expect(installPackedCli(fixture)).rejects.toThrow(`missing required asset: ${asset}`);
    } finally {
      await fixture.close();
    }
  },
);

function countingInstaller() {
  const counter = {
    attempts: 0,
    executeInstall: (
      command: string,
      args: string[],
      options: ExecFileOptionsWithStringEncoding,
    ) => {
      counter.attempts++;
      return promisify(execFile)(command, args, options);
    },
  };
  return counter;
}

test('does not retry an optional dependency integrity mismatch', async () => {
  const fixture = await createInstallFixture(true);
  const installer = countingInstaller();
  try {
    fixture.lock.packages[`${LEAF}@1.0.0`].resolution.integrity =
      `sha512-${Buffer.alloc(64).toString('base64')}`;
    writeFileSync(fixture.lockPath, YAML.stringify(fixture.lock));
    const installation = installPackedCli(fixture, { now: Date.now, ...installer });
    await expect(installation).rejects.toThrow(
      'ERR_PNPM_TARBALL_INTEGRITY: its integrity does not match the lockfile',
    );
    await expect(installation).rejects.not.toMatchObject({ exitCode: 77 });
    expect(installer.attempts).toBe(1);
  } finally {
    await fixture.close();
  }
});

test('reports exhausted optional acquisition as unavailable', async () => {
  const fixture = await createInstallFixture(true);
  const installer = countingInstaller();
  try {
    fixture.responses.set(`/${LEAF}/-/${LEAF}-1.0.0.tgz`, 503);
    const installation = installPackedCli(fixture, { now: Date.now, ...installer });
    await expect(installation).rejects.toMatchObject({
      name: 'CliInstallUnavailableError',
      exitCode: 77,
    });
    await expect(installation).rejects.toThrow('the registry answered 503');
    expect(installer.attempts).toBe(3);
  } finally {
    await fixture.close();
  }
});

test('reports a rate-limited optional dependency as unavailable', async () => {
  const fixture = await createInstallFixture(true);
  const installer = countingInstaller();
  try {
    fixture.responses.set(`/${LEAF}/-/${LEAF}-1.0.0.tgz`, 429);
    const installation = installPackedCli(fixture, { now: Date.now, ...installer });
    await expect(installation).rejects.toMatchObject({
      name: 'CliInstallUnavailableError',
      exitCode: 77,
    });
    await expect(installation).rejects.toThrow('the registry answered 429');
    expect(installer.attempts).toBe(3);
  } finally {
    await fixture.close();
  }
});

test('retries an optional dependency whose tarball fails once and then downloads', async () => {
  const fixture = await createInstallFixture(true);
  const installer = countingInstaller();
  try {
    fixture.oneShotResponses.set(`/${LEAF}/-/${LEAF}-1.0.0.tgz`, [503]);
    const installed = await installPackedCli(fixture, { now: Date.now, ...installer });
    expect(installer.attempts).toBe(2);
    const result = await promisify(execFile)(process.execPath, [installed.cliPath]);
    expect(JSON.parse(result.stdout)).toEqual({ leaf: '1.0.0', peer: '1.0.0' });
  } finally {
    await fixture.close();
  }
});

test('retries an optional dependency whose refetch is rate-limited', async () => {
  const fixture = await createInstallFixture(true);
  const installer = countingInstaller();
  try {
    fixture.oneShotResponses.set(`/${LEAF}/-/${LEAF}-1.0.0.tgz`, [503, 429]);
    await installPackedCli(fixture, { now: Date.now, ...installer });
    expect(installer.attempts).toBe(2);
  } finally {
    await fixture.close();
  }
});

test('does not retry an unavailable package version', async () => {
  const fixture = await createInstallFixture(true);
  const installer = countingInstaller();
  try {
    fixture.responses.set(`/${LEAF}/-/${LEAF}-1.0.0.tgz`, 404);
    const installation = installPackedCli(fixture, { now: Date.now, ...installer });
    await expect(installation).rejects.toThrow('ERR_PNPM_FETCH_404: the registry answered 404');
    await expect(installation).rejects.not.toMatchObject({ exitCode: 77 });
    expect(installer.attempts).toBe(1);
  } finally {
    await fixture.close();
  }
});

test('rejects a manifest that no longer matches the committed importer', async () => {
  const fixture = await createInstallFixture();
  try {
    writeFileSync(
      join(fixture.packageDir, 'package.json'),
      JSON.stringify({
        ...fixture.manifest,
        dependencies: { ...fixture.manifest.dependencies, [PARENT]: '^2.0.0' },
      }),
    );
    await expect(installPackedCli(fixture)).rejects.toThrow('differ from the committed lockfile');
  } finally {
    await fixture.close();
  }
});

test('preserves optional platform exclusions from the committed graph', async () => {
  const fixture = await createInstallFixture(true);
  try {
    Object.assign(fixture.lock.packages[`${PARENT}@1.0.0`], { os: [`!${process.platform}`] });
    writeFileSync(fixture.lockPath, YAML.stringify(fixture.lock));
    const installed = await installPackedCli(fixture);
    const probe = promisify(execFile)(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { createRequire } from 'node:module'; const load = createRequire(process.argv[1]); console.log(load('${PEER}')); load('${PARENT}');`,
      realpathSync(installed.cliPath),
    ]);
    await expect(probe).rejects.toMatchObject({
      code: 1,
      stdout: '1.0.0\n',
      stderr: expect.stringContaining(`Cannot find module '${PARENT}'`),
    });
  } finally {
    await fixture.close();
  }
});

test('bounds transport retries for a required package', async () => {
  const fixture = await createInstallFixture();
  const path = `/${LEAF}/-/${LEAF}-1.0.0.tgz`;
  try {
    fixture.responses.set(path, 'reset');
    let attempts = 0;
    await expect(
      installPackedCli(fixture, {
        now: Date.now,
        executeInstall: (command, args, options) => {
          attempts++;
          return promisify(execFile)(command, args, options);
        },
      }),
    ).rejects.toMatchObject({ name: 'CliInstallUnavailableError', exitCode: 77 });
    expect(attempts).toBe(3);
    expect(fixture.requests.filter((request) => request === path).length).toBeGreaterThanOrEqual(3);
  } finally {
    await fixture.close();
  }
});

test('reports registry socket timeouts as unavailable', async () => {
  const fixture = await createInstallFixture();
  const path = `/${LEAF}/-/${LEAF}-1.0.0.tgz`;
  try {
    fixture.responses.set(path, 'timeout');
    let attempts = 0;
    await expect(
      installPackedCli(
        { ...fixture, env: { ...fixture.env, npm_config_fetch_timeout: '1000' } },
        {
          now: Date.now,
          executeInstall: (command, args, options) => {
            attempts++;
            return promisify(execFile)(command, args, options);
          },
        },
      ),
    ).rejects.toMatchObject({ name: 'CliInstallUnavailableError', exitCode: 77 });
    expect(attempts).toBe(3);
    expect(fixture.requests.filter((request) => request === path).length).toBeGreaterThanOrEqual(3);
  } finally {
    await fixture.close();
  }
});

test('rejects a successful install without the fetch observer', async () => {
  const fixture = await createInstallFixture();
  let installed = false;
  try {
    const installation = installPackedCli(fixture, {
      now: Date.now,
      executeInstall: async (command, args, options) => {
        const output = await promisify(execFile)(command, args, options);
        installed = true;
        const withoutFetches = (text: string) =>
          text
            .split('\n')
            .filter((line) => !line.includes('"pnpm:fetching-progress"'))
            .join('\n');
        return {
          ...output,
          stdout: withoutFetches(output.stdout),
          stderr: withoutFetches(output.stderr),
        };
      },
    });
    await expect(installation).rejects.toThrow('CLI fetch observer did not run');
    expect(installed).toBe(true);
  } finally {
    await fixture.close();
  }
});
