import { spawn } from 'node:child_process';
import { envPath, resolveWindowsCommand, terminateAgentTree, windowsCmdWrap } from '../launch.ts';
import type { CodexCatalogModel } from './codex-context.ts';

const PROBE_TIMEOUT_MS = 8_000;
const PROBE_MAX_BUFFER = 4 * 1024 * 1024;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseCodexCatalog(raw: string): readonly CodexCatalogModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const container = asRecord(parsed);
  const rows = Array.isArray(parsed) ? parsed : container.models;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const record = asRecord(row);
    const slug = record.slug;
    if (typeof slug !== 'string' || slug === '') return [];
    return [
      {
        slug,
        visibility: typeof record.visibility === 'string' ? record.visibility : null,
        contextWindow: numberOrNull(record.context_window),
        maxContextWindow: numberOrNull(record.max_context_window),
        effectivePercent: numberOrNull(record.effective_context_window_percent),
      },
    ];
  });
}

export type CodexCatalogProbe =
  | { readonly outcome: 'ok'; readonly models: readonly CodexCatalogModel[] }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'failed' };

export function codexProbeCommand(
  codexPath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { cmd: string; args: string[]; wrap: boolean; env: Record<string, string> } {
  const stringEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') stringEnv[k] = v;
  const win = platform === 'win32';
  const resolved = win ? resolveWindowsCommand(codexPath, envPath(stringEnv)) : codexPath;
  const wrap = win && /\.(cmd|bat)$/i.test(resolved);
  const composed = wrap
    ? windowsCmdWrap(resolved, ['debug', 'models'])
    : { cmd: resolved, args: ['debug', 'models'] };
  return { ...composed, wrap, env: stringEnv };
}

export async function probeCodexCatalog(
  codexPath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<CodexCatalogProbe> {
  const { cmd, args, wrap, env: stringEnv } = codexProbeCommand(codexPath, env, platform);
  return new Promise<CodexCatalogProbe>((settle) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        env: stringEnv,
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
        detached: platform !== 'win32',
        windowsHide: true,
        windowsVerbatimArguments: wrap,
      });
    } catch (err) {
      settle(
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? { outcome: 'not-found' }
          : { outcome: 'failed' },
      );
      return;
    }
    const reap = (): void => {
      void terminateAgentTree(child, { graceMs: 1_000 });
    };
    let out = '';
    let bytes = 0;
    let done = false;
    const finish = (result: CodexCatalogProbe): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle(result);
    };
    const timer = setTimeout(() => {
      reap();
      finish({ outcome: 'failed' });
    }, PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > PROBE_MAX_BUFFER) {
        reap();
        finish({ outcome: 'failed' });
        return;
      }
      out += chunk.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'ENOENT' ? { outcome: 'not-found' } : { outcome: 'failed' });
    });
    child.on('close', (code) => {
      finish(
        code === 0 ? { outcome: 'ok', models: parseCodexCatalog(out) } : { outcome: 'failed' },
      );
    });
  });
}
