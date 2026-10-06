import {
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
  execFile,
} from 'node:child_process';
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
          FORCE_COLOR: '1',
        },
      }),
    ).rejects.toMatchObject({ name: 'CliInstallUnavailableError', exitCode: 77 });
    expect(registryReached).toBe(true);
    const installs = readdirSync(root, { recursive: true, withFileTypes: true }).filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('-debug-0.log') &&
        /\bverbose title npm install\b/.test(
          readFileSync(join(entry.parentPath, entry.name), 'utf8'),
        ),
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
    const retried = new Set([`${LEAF}@1.0.0`]);
    expect(installed.acquisition?.fetchStarts).toEqual(retried);
    expect(installed.acquisition?.progress.get('fetched')).toEqual(retried);
    expect(installed.acquisition?.progress.get('found_in_store')).toEqual(
      new Set(['file:cli.tgz', ...[PARENT, PEER].map((name) => `${name}@1.0.0`)]),
    );
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
    await expect(installation).rejects.not.toThrow('CLI fetch observer did not run');
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
    let firstInstall: Promise<{ stdout: string; stderr: string }> | undefined;
    await expect(
      installPackedCli(
        { ...fixture, env: { ...fixture.env, npm_config_fetch_timeout: '1000' } },
        {
          now: Date.now,
          executeInstall: (command, args, options) => {
            attempts++;
            firstInstall ??= promisify(execFile)(command, args, options);
            return firstInstall;
          },
        },
      ),
    ).rejects.toMatchObject({ name: 'CliInstallUnavailableError', exitCode: 77 });
    expect(attempts).toBe(3);
    expect(fixture.requests).toContain(path);
  } finally {
    await fixture.close();
  }
});

function strippingInstaller(stripped: (line: string) => boolean) {
  const installer = {
    removedLines: 0,
    now: Date.now,
    executeInstall: async (
      command: string,
      args: string[],
      options: ExecFileOptionsWithStringEncoding,
    ) => {
      const output = await promisify(execFile)(command, args, options);
      const strip = (text: string) => {
        const lines = text.split('\n');
        const kept = lines.filter((line) => !stripped(line));
        installer.removedLines += lines.length - kept.length;
        return kept.join('\n');
      };
      return { ...output, stdout: strip(output.stdout), stderr: strip(output.stderr) };
    },
  };
  return installer;
}

test('rejects a successful install without the fetch observer', async () => {
  const fixture = await createInstallFixture();
  const installer = strippingInstaller((line) => line.includes('"pnpm:fetching-progress"'));
  try {
    await expect(installPackedCli(fixture, installer)).rejects.toThrow(
      'CLI fetch observer did not run',
    );
    expect(installer.removedLines).toBeGreaterThan(0);
  } finally {
    await fixture.close();
  }
});

test('rejects an install whose reporter stream never reaches the harness', async () => {
  const fixture = await createInstallFixture();
  const installer = strippingInstaller((line) => line.startsWith('{'));
  try {
    await expect(installPackedCli(fixture, installer)).rejects.toThrow(
      'CLI fetch observer did not run',
    );
    expect(installer.removedLines).toBeGreaterThan(0);
  } finally {
    await fixture.close();
  }
});

test('rejects an install whose reporter stream stops after its first event', async () => {
  const fixture = await createInstallFixture();
  const kept: string[] = [];
  const installer = strippingInstaller((line) => {
    if (!line.startsWith('{')) return false;
    if (kept.length) return true;
    kept.push(line);
    return false;
  });
  try {
    await expect(installPackedCli(fixture, installer)).rejects.toThrow(
      'CLI fetch observer did not run',
    );
    expect(kept).toHaveLength(1);
    expect(installer.removedLines).toBeGreaterThan(0);
  } finally {
    await fixture.close();
  }
});

test('rejects an install whose reporter stream records no package acquisition', async () => {
  const fixture = await createInstallFixture();
  const keptLines: string[] = [];
  const installer = strippingInstaller((line) => {
    if (line.includes('"pnpm:progress"') || line.includes('"pnpm:fetching-progress"')) return true;
    keptLines.push(line);
    return false;
  });
  try {
    const installation = installPackedCli(fixture, installer);
    await installation.catch(() => undefined);
    expect(installer.removedLines).toBeGreaterThan(0);
    expect(keptLines).toContainEqual(expect.stringContaining('"importing_done"'));
    await expect(installation).rejects.toThrow('CLI fetch observer did not run');
  } finally {
    await fixture.close();
  }
});

test('rejects an install whose reporter stream stops before importing_done', async () => {
  const fixture = await createInstallFixture();
  const keptLines: string[] = [];
  const installer = strippingInstaller((line) => {
    if (line.includes('"importing_done"')) return true;
    keptLines.push(line);
    return false;
  });
  try {
    const installation = installPackedCli(fixture, installer);
    await installation.catch(() => undefined);
    expect(installer.removedLines).toBeGreaterThan(0);
    expect(keptLines).toContainEqual(
      expect.stringMatching(/"pnpm:progress".*"status":"(?:fetched|found_in_store)"/),
    );
    await expect(installation).rejects.toThrow('CLI fetch observer did not run');
  } finally {
    await fixture.close();
  }
});

test('accepts an install whose pnpm reports progress after importing_done', async () => {
  const fixture = await createInstallFixture();
  let moved = 0;
  const installer = {
    now: Date.now,
    executeInstall: async (
      command: string,
      args: string[],
      options: ExecFileOptionsWithStringEncoding,
    ) => {
      const output = await promisify(execFile)(command, args, options);
      const reorder = (text: string) => {
        const lines = text.split('\n');
        const done = lines.findIndex((line) => line.includes('"importing_done"'));
        const late = lines.findIndex(
          (line, index) =>
            index < done && line.includes('"pnpm:progress"') && line.includes('"fetched"'),
        );
        if (done < 0 || late < 0) return text;
        const [line] = lines.splice(late, 1);
        lines.splice(done, 0, line);
        moved++;
        return lines.join('\n');
      };
      return { ...output, stdout: reorder(output.stdout), stderr: reorder(output.stderr) };
    },
  };
  try {
    await expect(installPackedCli(fixture, installer)).resolves.toMatchObject({
      cliPath: expect.any(String),
    });
    expect(moved).toBe(1);
  } finally {
    await fixture.close();
  }
});

function outdatedLockfileInstaller() {
  const installer = {
    attempts: 0,
    exits: [] as { code: unknown; killed: unknown; signal: unknown; output: string }[],
    now: Date.now,
    executeInstall: async (
      command: string,
      args: string[],
      options: ExecFileOptionsWithStringEncoding,
    ) => {
      installer.attempts++;
      const manifestPath = join(String(options.cwd), 'package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          dependencies: { ...manifest.dependencies, [LEAF]: '1.1.0' },
        }),
      );
      return promisify(execFile)(command, args, options).catch(
        (error: ExecFileException & { stdout: string; stderr: string }) => {
          installer.exits.push({
            code: error.code,
            killed: error.killed,
            signal: error.signal,
            output: `${error.stdout}\n${error.stderr}`,
          });
          throw error;
        },
      );
    },
  };
  return installer;
}

test("rejects a locked install that pnpm refuses before fetching with pnpm's own error", async () => {
  const fixture = await createInstallFixture();
  const installer = outdatedLockfileInstaller();
  try {
    const installation = installPackedCli(fixture, installer);
    await expect(installation).rejects.toThrow('ERR_PNPM_OUTDATED_LOCKFILE');
    expect(installer.exits).toEqual([
      {
        code: expect.any(Number),
        killed: false,
        signal: null,
        output: expect.stringContaining('ERR_PNPM_OUTDATED_LOCKFILE'),
      },
    ]);
    expect(installer.exits).not.toContainEqual(
      expect.objectContaining({ output: expect.stringContaining('"pnpm:fetching-progress"') }),
    );
    await expect(installation).rejects.not.toMatchObject({ exitCode: 77 });
    expect(installer.attempts).toBe(1);
    await expect(installation).rejects.not.toThrow('CLI fetch observer did not run');
  } finally {
    await fixture.close();
  }
});

type InstallFixture = Awaited<ReturnType<typeof createInstallFixture>>;

function readPackedCli(packDest: string) {
  const archives = readdirSync(packDest).filter((name) => name.endsWith('.tgz'));
  expect(archives).toHaveLength(1);
  return readFileSync(join(packDest, archives[0]));
}

function tarballRequestsSince(fixture: InstallFixture, start: number) {
  return fixture.requests.slice(start).filter((path) => path.endsWith('.tgz'));
}

function newInstallPrefix(fixture: InstallFixture) {
  const installPrefix = join(fixture.root, 'warm-install');
  mkdirSync(installPrefix);
  return installPrefix;
}

test.each([
  { cli: 'the same packed CLI again', rebuild: false },
  { cli: 'a rebuilt packed CLI', rebuild: true },
])('installs $cli on the store an earlier install filled', async ({ rebuild }) => {
  const fixture = await createInstallFixture();
  try {
    const coldStart = fixture.requests.length;
    const cold = await installPackedCli(fixture);
    expect(new Set(tarballRequestsSince(fixture, coldStart))).toEqual(
      new Set([LEAF, PARENT, PEER].map((name) => `/${name}/-/${name}-1.0.0.tgz`)),
    );
    const coldFetches = new Set([
      'file:cli.tgz',
      ...[LEAF, PARENT, PEER].map((name) => `${name}@1.0.0`),
    ]);
    expect(cold.acquisition?.fetchStarts).toEqual(coldFetches);
    expect(cold.acquisition?.progress.get('fetched')).toEqual(coldFetches);
    const firstPack = readPackedCli(fixture.packDest);
    if (rebuild) {
      const cli = join(fixture.packageDir, 'dist/cli.mjs');
      writeFileSync(cli, `${readFileSync(cli, 'utf8')}\n`);
    }
    const installPrefix = newInstallPrefix(fixture);
    const warmStart = fixture.requests.length;
    const installation = installPackedCli({ ...fixture, installPrefix });
    await installation.catch(() => undefined);
    expect(readPackedCli(fixture.packDest).equals(firstPack)).toBe(!rebuild);
    expect(tarballRequestsSince(fixture, warmStart)).toEqual([]);
    await expect(installation).resolves.toMatchObject({ cliPath: expect.any(String) });
    const { cliPath, acquisition } = await installation;
    const warmFetches = new Set(rebuild ? ['file:cli.tgz'] : []);
    expect(acquisition?.progress.get('found_in_store')).toEqual(
      new Set([...coldFetches].filter((id) => !warmFetches.has(id))),
    );
    expect(acquisition?.fetchStarts).toEqual(warmFetches);
    expect(acquisition?.progress.get('fetched') ?? new Set()).toEqual(warmFetches);
    const result = await promisify(execFile)(process.execPath, [cliPath]);
    expect(JSON.parse(result.stdout)).toEqual({ leaf: '1.0.0', peer: '1.0.0' });
  } finally {
    await fixture.close();
  }
});

test('rejects an unavailable optional package on a store that holds the rest of the graph', async () => {
  const fixture = await createInstallFixture(true);
  const tarball = `/${LEAF}/-/${LEAF}-1.0.0.tgz`;
  try {
    fixture.responses.set(tarball, 404);
    await expect(installPackedCli(fixture)).rejects.toThrow('ERR_PNPM_FETCH_404');
    const installPrefix = newInstallPrefix(fixture);
    const warmStart = fixture.requests.length;
    const installer = countingInstaller();
    const installation = installPackedCli(
      { ...fixture, installPrefix },
      { now: Date.now, ...installer },
    );
    await expect(installation).rejects.toThrow('ERR_PNPM_FETCH_404: the registry answered 404');
    await expect(installation).rejects.not.toThrow('CLI fetch observer did not run');
    await expect(installation).rejects.not.toMatchObject({ exitCode: 77 });
    expect(installer.attempts).toBe(1);
    expect(new Set(tarballRequestsSince(fixture, warmStart))).toEqual(new Set([tarball]));
  } finally {
    await fixture.close();
  }
});
