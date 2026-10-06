import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import password from '@inquirer/password';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../../../test-support/configure-git-fixture.test-helper.ts';
import { clearTokenFromAllBackends, FileBackend } from '../../auth/token-store.ts';
import { shareNameCheckCommand } from '../share/name-check.ts';
import { shareOwnersCommand } from '../share/owners.ts';
import { patCommand } from './pat.ts';
import { signoutCommand } from './signout.ts';
import { statusCommand } from './status.ts';

vi.mock('@inquirer/password', () => ({ default: vi.fn() }));
vi.mock('../../auth/gh-detect.ts', () => ({ detectGh: () => ({ available: false }) }));
vi.mock('../../auth/token-store.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/token-store.ts')>()),
  clearTokenFromAllBackends: vi.fn().mockResolvedValue({ touched: ['file'] }),
}));

let projectDir: string;
let home: string;

function declareInUserConfig(host: string): void {
  mkdirSync(join(home, '.ok'));
  writeFileSync(
    join(home, '.ok', 'global.yml'),
    `git:\n  hosts:\n    ${host}:\n      provider: github\n`,
  );
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'ok-auth-command-host-'));
  home = mkdtempSync(join(tmpdir(), 'ok-auth-command-host-home-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  execFileSync('git', ['init', '-q'], { cwd: projectDir });
  configureTestGitRepository(projectDir);
  vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('explicit signout removes a legacy credential even without a provider declaration', async () => {
  await signoutCommand().parseAsync(['--host', 'legacy.example.com'], { from: 'user' });
  expect(clearTokenFromAllBackends).toHaveBeenCalledWith('legacy.example.com');
});

test('implicit signout refuses a generic origin without clearing another credential', async () => {
  execFileSync('git', ['remote', 'add', 'origin', 'https://git.example.com/team/kb.git'], {
    cwd: projectDir,
  });
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  await expect(signoutCommand().parseAsync([], { from: 'user' })).rejects.toThrow('exit');
  expect(clearTokenFromAllBackends).not.toHaveBeenCalled();
  const message = vi
    .mocked(process.stderr.write)
    .mock.calls.map(([text]) => text)
    .join('');
  expect(message).toContain('ok auth signout --host git.example.com');
  expect(message).toContain('remove stored local credentials');
  expect(message).toContain('No provider declaration is required');
  expect(message).not.toContain('sign-in');
  expect(message).not.toContain('global.yml');
});

test.each(['/tmp/local-repository.git', 'file:///tmp/local-repository.git'])(
  'implicit signout asks for a credential hostname when origin cannot supply one: %s',
  async (url) => {
    execFileSync('git', ['remote', 'add', 'origin', url], { cwd: projectDir });
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    await expect(signoutCommand().parseAsync([], { from: 'user' })).rejects.toThrow('exit');
    expect(clearTokenFromAllBackends).not.toHaveBeenCalled();
    const message = vi
      .mocked(process.stderr.write)
      .mock.calls.map(([text]) => text)
      .join('');
    expect(message).toContain('Cannot determine');
    expect(message).toContain('ok auth signout --host <hostname>');
    expect(message).toContain('remove stored local credentials');
    expect(message).not.toContain('sign-in');
    expect(message).not.toContain('global.yml');
    expect(message).not.toContain('null');
  },
);

test('PAT prompt names the resolved enterprise destination before reading a token', async () => {
  execFileSync('git', ['remote', 'add', 'origin', 'https://ghes.example.com/team/kb.git'], {
    cwd: projectDir,
  });
  declareInUserConfig('ghes.example.com');
  vi.mocked(password).mockRejectedValue(new Error('prompt cancelled'));
  const store = new FileBackend(join(projectDir, 'auth.yml'));
  const save = vi.spyOn(store, 'set');
  await expect(patCommand(async () => store).parseAsync([], { from: 'user' })).rejects.toThrow(
    'prompt cancelled',
  );
  expect(password).toHaveBeenCalledWith({ message: 'Enter PAT for ghes.example.com:' });
  expect(save).not.toHaveBeenCalled();
});

test('PAT refuses an undeclared explicit host before opening the token prompt', async () => {
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  const getStore = vi.fn(async () => new FileBackend(join(projectDir, 'auth.yml')));
  await expect(
    patCommand(getStore).parseAsync(['--host', 'undeclared.example.com'], { from: 'user' }),
  ).rejects.toThrow('exit');
  expect(getStore).not.toHaveBeenCalled();
  expect(password).not.toHaveBeenCalled();
});

test('status on an explicit non-GitHub host reports the stored token without asking GitHub', async () => {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const store = new FileBackend(join(projectDir, 'auth.yml'));
  await store.set('gitea.internal', 'alice', 'tok', { gitProtocol: 'https' });
  await expect(
    statusCommand(async () => store).parseAsync(['--host', 'gitea.internal', '--json'], {
      from: 'user',
    }),
  ).rejects.toThrow('exit');
  expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
    type: 'status',
    host: 'gitea.internal',
    backend: 'file',
    authenticated: false,
    unverified: true,
    login: 'alice',
  });
  expect(exit).toHaveBeenCalledWith(0);
});

test('status with no --host on a non-GitHub origin reports the stored token for that host', async () => {
  execFileSync('git', ['remote', 'add', 'origin', 'https://gitea.internal/team/kb.git'], {
    cwd: projectDir,
  });
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const store = new FileBackend(join(projectDir, 'auth.yml'));
  await store.set('gitea.internal', 'alice', 'tok', { gitProtocol: 'https' });
  await expect(
    statusCommand(async () => store).parseAsync(['--json'], { from: 'user' }),
  ).rejects.toThrow('exit');
  expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
    host: 'gitea.internal',
    unverified: true,
    login: 'alice',
  });
});

test('status with no --host on a non-GitHub origin with nothing stored names ok auth token', async () => {
  execFileSync('git', ['remote', 'add', 'origin', 'git@gitea.internal:team/kb.git'], {
    cwd: projectDir,
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  const store = new FileBackend(join(projectDir, 'auth.yml'));
  await expect(statusCommand(async () => store).parseAsync([], { from: 'user' })).rejects.toThrow(
    'exit',
  );
  const written = vi
    .mocked(process.stderr.write)
    .mock.calls.map((c) => String(c[0]))
    .join('');
  expect(written).toContain('ok auth token --host gitea.internal --username <username>');
  expect(written).not.toContain('declare it in');
  expect(exit).toHaveBeenCalledWith(1);
});

test('status with no --host on an origin with a port reports the token stored for host:port', async () => {
  execFileSync('git', ['remote', 'add', 'origin', 'https://Git.Corp.example:8443/team/kb.git'], {
    cwd: projectDir,
  });
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const store = new FileBackend(join(projectDir, 'auth.yml'));
  await store.set('git.corp.example:8443', 'alice', 'tok', { gitProtocol: 'https' });
  await expect(
    statusCommand(async () => store).parseAsync(['--json'], { from: 'user' }),
  ).rejects.toThrow('exit');
  expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
    host: 'git.corp.example:8443',
    unverified: true,
    login: 'alice',
  });
});

test('status with no --host on a ported origin with nothing stored names the host with its port', async () => {
  execFileSync('git', ['remote', 'add', 'origin', 'https://git.corp.example:8443/team/kb.git'], {
    cwd: projectDir,
  });
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  const store = new FileBackend(join(projectDir, 'auth.yml'));
  await expect(statusCommand(async () => store).parseAsync([], { from: 'user' })).rejects.toThrow(
    'exit',
  );
  const written = vi
    .mocked(process.stderr.write)
    .mock.calls.map((c) => String(c[0]))
    .join('');
  expect(written).toContain('ok auth token --host git.corp.example:8443 --username <username>');
});

test('status with no --host on an origin URL deeper than owner/repo still finds the host', async () => {
  execFileSync('git', ['remote', 'add', 'origin', 'https://gitlab.corp.example/group/sub/kb.git'], {
    cwd: projectDir,
  });
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const store = new FileBackend(join(projectDir, 'auth.yml'));
  await store.set('gitlab.corp.example', 'oauth2', 'tok', { gitProtocol: 'https' });
  await expect(
    statusCommand(async () => store).parseAsync(['--json'], { from: 'user' }),
  ).rejects.toThrow('exit');
  expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
    host: 'gitlab.corp.example',
    unverified: true,
    login: 'oauth2',
  });
});

test('status --host on a non-GitHub host matches the stored key regardless of case or :443', async () => {
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const store = new FileBackend(join(projectDir, 'auth.yml'));
  await store.set('gitea.internal', 'alice', 'tok', { gitProtocol: 'https' });
  await expect(
    statusCommand(async () => store).parseAsync(['--host', 'Gitea.Internal:443', '--json'], {
      from: 'user',
    }),
  ).rejects.toThrow('exit');
  expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
    host: 'gitea.internal',
    unverified: true,
    login: 'alice',
  });
});

test('PAT on a ported non-GitHub origin names ok auth token with the port kept', async () => {
  execFileSync('git', ['remote', 'add', 'origin', 'https://git.corp.example:8443/team/kb.git'], {
    cwd: projectDir,
  });
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  await expect(
    patCommand(async () => new FileBackend(join(projectDir, 'auth.yml'))).parseAsync([], {
      from: 'user',
    }),
  ).rejects.toThrow('exit');
  const written = vi
    .mocked(process.stderr.write)
    .mock.calls.map((c) => String(c[0]))
    .join('');
  expect(written).toContain("this project's git remote is git.corp.example,");
  expect(written).toContain('ok auth token --host git.corp.example:8443 --username <username>');
  expect(password).not.toHaveBeenCalled();
});

test('PAT on an origin deeper than owner/repo names the host and ok auth token', async () => {
  execFileSync('git', ['remote', 'add', 'origin', 'https://gitlab.corp.example/group/sub/kb.git'], {
    cwd: projectDir,
  });
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  await expect(
    patCommand(async () => new FileBackend(join(projectDir, 'auth.yml'))).parseAsync([], {
      from: 'user',
    }),
  ).rejects.toThrow('exit');
  const written = vi
    .mocked(process.stderr.write)
    .mock.calls.map((c) => String(c[0]))
    .join('');
  expect(written).toContain(
    "this project's git remote is gitlab.corp.example, which is not a GitHub host",
  );
  expect(written).toContain('ok auth token --host gitlab.corp.example --username <username>');
  expect(written).not.toContain('Cannot determine');
  expect(written).not.toContain('declare it in');
  expect(password).not.toHaveBeenCalled();
});

test('implicit signout on an origin deeper than owner/repo names the host in the lead', async () => {
  execFileSync('git', ['remote', 'add', 'origin', 'https://gitlab.corp.example/group/sub/kb.git'], {
    cwd: projectDir,
  });
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  await expect(signoutCommand().parseAsync([], { from: 'user' })).rejects.toThrow('exit');
  const written = vi
    .mocked(process.stderr.write)
    .mock.calls.map((c) => String(c[0]))
    .join('');
  expect(written).toContain("This project's git remote is gitlab.corp.example");
  expect(written).toContain('ok auth signout --host gitlab.corp.example');
  expect(written).not.toContain('Cannot determine');
});

test('explicit signout of a non-GitHub host clears the key git asks for', async () => {
  await signoutCommand().parseAsync(['--host', 'Git.Corp.example:443'], { from: 'user' });
  expect(clearTokenFromAllBackends).toHaveBeenCalledWith('git.corp.example');
});

test('implicit signout on a ported origin names the host with its port', async () => {
  execFileSync('git', ['remote', 'add', 'origin', 'https://git.corp.example:8443/team/kb.git'], {
    cwd: projectDir,
  });
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  await expect(signoutCommand().parseAsync([], { from: 'user' })).rejects.toThrow('exit');
  const written = vi
    .mocked(process.stderr.write)
    .mock.calls.map((c) => String(c[0]))
    .join('');
  expect(written).toContain('ok auth signout --host git.corp.example:8443');
  expect(clearTokenFromAllBackends).not.toHaveBeenCalled();
});

test.each(['owners', 'name-check'])(
  'share %s honors the user-level declaration from a nested directory',
  async (name) => {
    declareInUserConfig('ghes.example.com');
    const nestedDir = join(projectDir, 'notes');
    mkdirSync(nestedDir);
    vi.mocked(process.cwd).mockReturnValue(nestedDir);
    const store = new FileBackend(join(projectDir, 'auth.yml'));
    const get = vi.spyOn(store, 'get').mockRejectedValue(new Error('token lookup reached'));
    const command =
      name === 'owners'
        ? shareOwnersCommand(async () => store)
        : shareNameCheckCommand(async () => store);
    const args = ['--host', 'ghes.example.com'];
    if (name === 'name-check') args.push('--owner', 'team', '--name', 'kb');
    await expect(command.parseAsync(args, { from: 'user' })).rejects.toThrow(
      'token lookup reached',
    );
    expect(get).toHaveBeenCalledWith('ghes.example.com');
  },
);
