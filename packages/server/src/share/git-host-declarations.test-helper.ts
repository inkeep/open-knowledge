import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';

export function useIsolatedHome(): () => string {
  let home = '';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ok-git-hosts-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  return () => home;
}

export function writeUserConfig(home: string, body: string): void {
  mkdirSync(join(home, '.ok'), { recursive: true });
  writeFileSync(join(home, '.ok', 'global.yml'), body, 'utf-8');
}

export function gitHostsYaml(...hosts: string[]): string {
  return `git:\n  hosts:\n${hosts.map((h) => `    ${h}:\n      provider: github\n`).join('')}`;
}

export function declareGitHubHosts(home: string, ...hosts: string[]): void {
  writeUserConfig(home, gitHostsYaml(...hosts));
}
