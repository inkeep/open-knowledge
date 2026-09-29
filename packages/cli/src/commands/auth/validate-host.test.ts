import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { gitHubHostRejection, resolveAuthHost, validateGitHubHost } from './validate-host.ts';

function hostsYaml(provider: string, ...hostnames: string[]): string {
  const entries = hostnames.map((host) => `    ${host}:\n      provider: ${provider}\n`).join('');
  return `git:\n  hosts:\n${entries}`;
}

function writeOkFile(dir: string, file: string, body: string): void {
  mkdirSync(join(dir, '.ok'), { recursive: true });
  writeFileSync(join(dir, '.ok', file), body, 'utf-8');
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ok-validate-host-home-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function declare(...hostnames: string[]): void {
  writeOkFile(home, 'global.yml', hostsYaml('github', ...hostnames));
}

describe('gitHubHostRejection', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'ok-validate-host-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test('accepts github.com with no user config at all', () => {
    expect(gitHubHostRejection('github.com')).toBeNull();
  });

  test('accepts www.github.com by folding it onto github.com', () => {
    expect(gitHubHostRejection('www.github.com')).toBeNull();
  });

  test('accepts a host declared in the user config', () => {
    declare('ghes.example.com');
    expect(gitHubHostRejection('ghes.example.com')).toBeNull();
  });

  test('matches a declaration case-insensitively and ignoring the port', () => {
    declare('ghes.example.com');
    expect(gitHubHostRejection('GHES.Example.com:8443')).toBeNull();
  });

  test('rejects an undeclared self-hosted host and names the config key as the remedy', () => {
    const rejection = gitHubHostRejection('git.example.internal');
    expect(rejection).toContain('git.example.internal is not a known GitHub host');
    expect(rejection).toContain('~/.ok/global.yml');
    expect(rejection).toContain(
      'git:\n    hosts:\n      git.example.internal:\n        provider: github',
    );
  });

  test('suggests a port-free hostname as the config key', () => {
    expect(gitHubHostRejection('ghes.example.com:8443')).toContain(
      '      ghes.example.com:\n        provider: github',
    );
  });

  test('rejects a host declared with some other provider value', () => {
    writeOkFile(home, 'global.yml', hostsYaml('gitlab', 'git.example.internal'));
    expect(gitHubHostRejection('git.example.internal')).not.toBeNull();
  });

  test.each(['gitlab.com', 'bitbucket.org', 'codeberg.org', 'gitea.com', 'sr.ht', 'sourcehut.org'])(
    'rejects the formerly denylisted host %s',
    (host) => {
      expect(gitHubHostRejection(host)).not.toBeNull();
    },
  );

  test("ignores a declaration in the project's .ok/config.yml", () => {
    writeOkFile(projectDir, 'config.yml', hostsYaml('github', 'ghes.example.com'));
    expect(gitHubHostRejection('ghes.example.com')).not.toBeNull();
  });
});

describe('validateGitHubHost', () => {
  test('returns without touching the process for an accepted host', () => {
    expect(() => validateGitHubHost('github.com')).not.toThrow();
  });
});

function seedOrigin(projectDir: string, url: string): void {
  execFileSync('git', ['init', '-q'], { cwd: projectDir });
  execFileSync('git', ['remote', 'add', 'origin', url], { cwd: projectDir });
}

describe('resolveAuthHost', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'ok-resolve-auth-host-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(projectDir, { recursive: true, force: true });
  });

  test('an explicit undeclared host is rejected before an API command can use it', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => resolveAuthHost('undeclared.example.com', projectDir)).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('provider: github');
  });

  test('default project resolution reads the origin of the enclosing project from a nested cwd', () => {
    seedOrigin(projectDir, 'https://ghes.example.com/team/kb.git');
    writeOkFile(projectDir, 'config.yml', 'content:\n  dir: .\n');
    declare('ghes.example.com');
    const nestedDir = join(projectDir, 'notes', 'nested');
    mkdirSync(nestedDir, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(nestedDir);
    expect(resolveAuthHost(undefined)).toBe('ghes.example.com');
    expect(() => validateGitHubHost('ghes.example.com')).not.toThrow();
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => validateGitHubHost('undeclared.example.com')).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
  });

  test.each(['/tmp/local-repository.git', 'file:///tmp/local-repository.git'])(
    'an origin without a recognized hostname explains the parsing limitation: %s',
    (url) => {
      seedOrigin(projectDir, url);
      vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      expect(() => resolveAuthHost(undefined, projectDir)).toThrow('exit');
      const message = String(stderr.mock.calls[0]?.[0]);
      expect(message).toContain('Cannot determine');
      expect(message).not.toContain('is not a GitHub host');
      expect(message).toContain('--host');
    },
  );

  test('an explicit --host wins regardless of the origin', () => {
    seedOrigin(projectDir, 'https://git.example.internal/team/kb.git');
    expect(resolveAuthHost('github.com', projectDir)).toBe('github.com');
  });

  test('an accepted explicit enterprise host retains its port and spelling', () => {
    declare('ghes.example.com');
    expect(resolveAuthHost('GHES.Example.com:8443', projectDir)).toBe('GHES.Example.com:8443');
  });

  test('an explicit host refusal consistently names the normalized hostname', () => {
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => resolveAuthHost('GHES.Example.com:8443', projectDir)).toThrow('exit');
    const message = String(stderr.mock.calls[0]?.[0]);
    expect(message).toContain('ghes.example.com is not a known GitHub host');
    expect(message).toContain('      ghes.example.com:\n        provider: github');
    expect(message).not.toContain('GHES.Example.com');
    expect(message).not.toContain('8443');
  });

  test('a github.com origin resolves to github.com', () => {
    seedOrigin(projectDir, 'https://github.com/team/kb.git');
    expect(resolveAuthHost(undefined, projectDir)).toBe('github.com');
  });

  test('a declared enterprise origin resolves to that host', () => {
    seedOrigin(projectDir, 'https://ghes.example.com/team/kb.git');
    declare('ghes.example.com');
    expect(resolveAuthHost(undefined, projectDir)).toBe('ghes.example.com');
  });

  test('no remote at all resolves to github.com so a local project can still publish', () => {
    execFileSync('git', ['init', '-q'], { cwd: projectDir });
    expect(resolveAuthHost(undefined, projectDir)).toBe('github.com');
  });

  test('an undeclared self-hosted origin refuses and names the host and the remedy', () => {
    seedOrigin(projectDir, 'https://git.example.internal/team/kb.git');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => resolveAuthHost(undefined, projectDir)).toThrow('exit');
      expect(exit).toHaveBeenCalledWith(1);
      expect(String(stderr.mock.calls[0]?.[0])).toContain('not a GitHub host');
      expect(String(stderr.mock.calls[0]?.[0])).toContain('git.example.internal');
      expect(String(stderr.mock.calls[0]?.[0])).toContain('--host');
      expect(String(stderr.mock.calls[0]?.[0])).toContain('provider: github');
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
    }
  });
});
