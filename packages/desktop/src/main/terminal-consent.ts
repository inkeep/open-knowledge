import { existsSync, readFileSync } from 'node:fs';
import { sleep } from '@inkeep/open-knowledge-core';
import { resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { parse as parseYaml } from 'yaml';
import type { TerminalShellNoticeReason } from '../shared/bridge-contract.ts';
import { getLogger } from './desktop-logger.ts';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export type TerminalShellSetting =
  | { readonly kind: 'unset' }
  | { readonly kind: 'configured'; readonly shell: string }
  | {
      readonly kind: 'invalid';
      readonly reason: Extract<TerminalShellNoticeReason, 'config-unreadable' | 'invalid-value'>;
    };

export function readTerminalShellSetting(projectDir: string): TerminalShellSetting {
  const path = resolveConfigPath('project-local', projectDir);
  if (!existsSync(path)) return { kind: 'unset' };
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf-8'));
  } catch (err) {
    getLogger('terminal-consent').warn(
      { err },
      'shell override read/parse failed; treating as unset',
    );
    return { kind: 'invalid', reason: 'config-unreadable' };
  }
  if (!isObject(parsed) || !isObject(parsed.terminal) || !('shell' in parsed.terminal)) {
    return { kind: 'unset' };
  }
  const shell = parsed.terminal.shell;
  if (typeof shell !== 'string') return { kind: 'invalid', reason: 'invalid-value' };
  if (shell.trim().length === 0) return { kind: 'unset' };
  return { kind: 'configured', shell };
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
