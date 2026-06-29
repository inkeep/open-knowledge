
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tracedMkdirSync, tracedUnlinkSync, tracedWriteFileSync } from './fs-traced.ts';

const PANE_TARGET_FILE = 'pane-target.json';

export const PANE_TARGET_TTL_MS = 30_000;

interface PaneTargetState {
  route: string;
  armedAtMs: number;
}

export function armPaneTarget(
  localDir: string,
  route: string,
  nowMs: number = Date.now(),
): boolean {
  if (!route.startsWith('#/')) return false;
  tracedMkdirSync(localDir, { recursive: true });
  const state: PaneTargetState = { route, armedAtMs: nowMs };
  tracedWriteFileSync(resolve(localDir, PANE_TARGET_FILE), JSON.stringify(state));
  return true;
}

export function readArmedPaneTarget(
  localDir: string,
  nowMs: number = Date.now(),
  ttlMs: number = PANE_TARGET_TTL_MS,
): string | null {
  const path = resolve(localDir, PANE_TARGET_FILE);
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PaneTargetState>;
    if (typeof state.route !== 'string' || typeof state.armedAtMs !== 'number') return null;
    if (nowMs - state.armedAtMs > ttlMs) return null;
    return state.route;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EIO') {
      process.stderr.write(
        `[pane-target] readArmedPaneTarget failed at ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    return null;
  }
}

export function clearArmedPaneTarget(localDir: string): void {
  const path = resolve(localDir, PANE_TARGET_FILE);
  if (!existsSync(path)) return;
  try {
    tracedUnlinkSync(path);
  } catch {
  }
}
