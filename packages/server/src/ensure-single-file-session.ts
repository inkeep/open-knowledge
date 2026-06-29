import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath as fsRealpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isSupportedDocFile } from './doc-extensions.ts';
import { createOffCwdResolverDeps, resolveOffCwdTarget } from './off-cwd-resolver.ts';

export interface EnsureSingleFileDeps {
  readonly spawnSession: (absFile: string) => void;
  readonly isServing: (absFile: string) => Promise<boolean>;
  readonly realpath: (p: string) => Promise<string>;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 15000;

const inflight = new Map<string, Promise<boolean>>();

export function ensureSingleFileSession(
  absFile: string,
  deps: EnsureSingleFileDeps,
): Promise<boolean> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const run = async (): Promise<boolean> => {
    const key = await deps.realpath(resolve(absFile)).catch(() => resolve(absFile));
    const existing = inflight.get(key);
    if (existing) return existing;

    const work = (async (): Promise<boolean> => {
      const serving = () => deps.isServing(key).catch(() => false);
      if (await serving()) return true;
      deps.spawnSession(key);
      const deadline = now() + timeoutMs;
      while (now() < deadline) {
        await sleep(pollMs);
        if (await serving()) return true;
      }
      return false;
    })().finally(() => {
      inflight.delete(key);
    });

    inflight.set(key, work);
    return work;
  };

  return run();
}

export function __resetEnsureSingleFileInflightForTests(): void {
  inflight.clear();
}

export function createEnsureSingleFileSession(): (absFile: string) => Promise<boolean> {
  const deps: EnsureSingleFileDeps = {
    spawnSession: (absFile) => {
      if (!isSupportedDocFile(absFile) || !existsSync(absFile)) return;
      const entry = process.argv[1];
      if (!entry) {
        process.stderr.write(
          '[ensure-single-file-session] process.argv[1] is empty — cannot spawn a single-file session\n',
        );
        return;
      }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OK_SINGLE_FILE_NO_OPEN: '1',
        ELECTRON_RUN_AS_NODE: '1',
      };
      const child = spawn(process.execPath, [entry, absFile], {
        detached: true,
        stdio: 'ignore',
        env,
      });
      child.unref();
    },
    isServing: async (absFile) =>
      (await resolveOffCwdTarget(absFile, createOffCwdResolverDeps())) !== null,
    realpath: (p) => fsRealpath(p).catch(() => p),
  };
  return (absFile) => ensureSingleFileSession(absFile, deps);
}
