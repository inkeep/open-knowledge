import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configureTestGitRepository } from './configure-git-fixture.test-helper.ts';

const hermeticGitEnv: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

const childEnv: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  ...hermeticGitEnv,
};

export interface ServedGitRepos {
  readonly port: number;
  readonly bytesServed: () => number;
  readonly resetBytesServed: () => void;
  readonly url: (name: string) => string;
  readonly githubRedirectEnv: () => Record<string, string>;
  readonly publish: (name: string, files: Readonly<Record<string, string | Buffer | null>>) => void;
  readonly close: () => Promise<void>;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: childEnv });
}

function untilClosed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('close', () => resolve()));
}

export async function serveGitRepos(): Promise<ServedGitRepos> {
  const root = mkdtempSync(join(tmpdir(), 'ok-served-git-'));
  const served = join(root, 'served');
  mkdirSync(served);
  const daemons = new Set<ChildProcess>();
  let bytes = 0;

  const server = createServer((socket) => {
    const daemon = spawn(
      'git',
      ['daemon', '--inetd', `--base-path=${served}`, '--export-all', served],
      { env: childEnv, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    daemons.add(daemon);
    daemon.once('close', () => {
      daemons.delete(daemon);
      socket.end();
    });
    daemon.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    socket.on('error', () => daemon.stdin.destroy());
    daemon.stdin.on('error', () => {});
    socket.pipe(daemon.stdin);
    daemon.stdout.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const publish = (name: string, files: Readonly<Record<string, string | Buffer | null>>) => {
    const source = join(root, 'sources', name);
    const bare = join(served, `${name}.git`);
    if (!existsSync(source)) {
      mkdirSync(source, { recursive: true });
      git(source, ['init', '-q']);
      git(source, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
      configureTestGitRepository(source);
    }
    for (const [path, body] of Object.entries(files)) {
      const target = join(source, path);
      if (body === null) {
        rmSync(target, { recursive: true, force: true });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
    git(source, ['add', '-A']);
    git(source, ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-q', '-m', 'publish']);
    if (!existsSync(bare)) {
      git(root, ['clone', '-q', '--bare', source, bare]);
      configureTestGitRepository(bare);
      git(bare, ['config', 'uploadpack.allowFilter', 'true']);
      git(bare, ['config', 'uploadpack.allowAnySHA1InWant', 'false']);
      git(bare, ['config', 'uploadpack.allowReachableSHA1InWant', 'false']);
      return;
    }
    git(source, ['push', '-q', '--force', bare, 'HEAD:refs/heads/main']);
  };

  return {
    port,
    bytesServed: () => bytes,
    resetBytesServed: () => {
      bytes = 0;
    },
    url: (name) => `git://127.0.0.1:${port}/${name}.git`,
    githubRedirectEnv: () => ({
      ...hermeticGitEnv,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.git://127.0.0.1:${port}/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/',
    }),
    publish,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const daemon of daemons) daemon.kill();
      await Promise.all([...daemons].map(untilClosed));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
