import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProcessState } from '../process-scan.ts';

export function descendantsOf(root: number): number[] {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  if (ps.error !== undefined) throw ps.error;
  if (ps.status !== 0) throw new Error(`ps exited ${ps.status}: ${ps.stderr}`);
  const children = new Map<number, number[]>();
  for (const line of ps.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || !Number.isInteger(pid) || pid === ps.pid) {
      continue;
    }
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const queue = [root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const kid of children.get(next) ?? []) {
      found.push(kid);
      queue.push(kid);
    }
  }
  return found;
}

export function processEnded(pid: number): boolean {
  const state = readProcessState(pid, {
    onProbeFailure: ({ reason }) => {
      throw new Error(`could not read the state of process ${pid}: ${reason}`);
    },
  });
  return state.status === 'gone' || state.status === 'defunct';
}

export function npxEntries(home: string): string[] {
  const npxCache = join(home, 'npm-cache', '_npx');
  return existsSync(npxCache) ? readdirSync(npxCache).map((name) => join(npxCache, name)) : [];
}

export function hasManifest(dir: string): boolean {
  return existsSync(join(dir, 'package.json'));
}

function installedPackages(entry: string): string[] {
  const modules = join(entry, 'node_modules');
  return existsSync(modules) ? readdirSync(modules).filter((name) => !name.startsWith('.')) : [];
}

export function entryOutcome(entry: string, agentName: string) {
  const packages = installedPackages(entry);
  const modules = join(entry, 'node_modules');
  const agentDir = join(modules, agentName);
  const agentDependencies = hasManifest(agentDir)
    ? Object.keys(
        (
          JSON.parse(readFileSync(join(agentDir, 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>;
          }
        ).dependencies ?? {},
      )
    : [];
  const snapshot = {
    rootManifest: hasManifest(entry),
    lock: existsSync(join(entry, 'concurrency.lock')),
    packages,
    withoutManifest: packages.filter((name) => !hasManifest(join(modules, name))),
  };
  const complete =
    snapshot.rootManifest &&
    !snapshot.lock &&
    hasManifest(agentDir) &&
    agentDependencies.every((name) => hasManifest(join(modules, name))) &&
    snapshot.withoutManifest.length === 0;
  const rolledBack = !snapshot.rootManifest && !snapshot.lock && packages.length === 0;
  const state: 'complete' | 'rolled-back' | 'partial' = complete
    ? 'complete'
    : rolledBack
      ? 'rolled-back'
      : 'partial';
  return { state, ...snapshot };
}
