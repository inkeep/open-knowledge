
import { existsSync, readFileSync } from 'node:fs';
import { resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { parse as parseYaml } from 'yaml';
import { getLogger } from './desktop-logger.ts';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isTerminalConsented(projectDir: string): boolean {
  const path = resolveConfigPath('project-local', projectDir);
  if (!existsSync(path)) return true;
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf-8'));
  } catch (err) {
    getLogger('terminal-consent').warn({ err }, 'config read/parse failed; failing open');
    return true;
  }
  if (!isObject(parsed)) return true;
  const terminal = parsed.terminal;
  if (!isObject(terminal)) return true;
  return terminal.enabled !== false;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const TERMINAL_CONSENT_GRACE_TIMEOUT_MS = 3000;

export async function isTerminalConsentedWithGrace(
  projectDir: string,
  {
    timeoutMs = TERMINAL_CONSENT_GRACE_TIMEOUT_MS,
    intervalMs = 50,
  }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (isTerminalConsented(projectDir)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}
