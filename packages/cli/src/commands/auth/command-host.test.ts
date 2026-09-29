import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import password from '@inquirer/password';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { clearTokenFromAllBackends, FileBackend } from '../../auth/token-store.ts';
import { shareNameCheckCommand } from '../share/name-check.ts';
import { shareOwnersCommand } from '../share/owners.ts';
import { patCommand } from './pat.ts';
import { signoutCommand } from './signout.ts';

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
