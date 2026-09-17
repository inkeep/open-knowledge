export interface CodexCatalogModel {
  readonly slug: string;
  readonly visibility?: string | null;
  readonly contextWindow: number | null;
  readonly maxContextWindow: number | null;
  readonly effectivePercent: number | null;
}

export const CODEX_CONFIG_ENV = 'CODEX_CONFIG';

const DEFAULT_EFFECTIVE_PERCENT = 95;

export function effectiveContextTokens(
  requestedTokens: number,
  model: Pick<CodexCatalogModel, 'maxContextWindow' | 'effectivePercent'>,
): number {
  if (!Number.isFinite(requestedTokens) || requestedTokens <= 0) return 0;
  const ceiling = model.maxContextWindow ?? requestedTokens;
  const granted = Math.min(Math.floor(requestedTokens), ceiling);
  const percent = model.effectivePercent ?? DEFAULT_EFFECTIVE_PERCENT;
  return Math.floor((granted * percent) / 100);
}

export function contextChoicesFor(model: CodexCatalogModel): readonly number[] {
  const ceiling = model.maxContextWindow;
  const base = model.contextWindow;
  if (ceiling === null && base === null) return [];
  if (ceiling === null) return [base as number];
  if (base === null || base >= ceiling) return [ceiling];
  return [base, ceiling];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseCodexConfigEnv(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.trim() === '') return {};
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function withCodexContextWindow(
  env: Record<string, string>,
  requestedTokens: number | null,
): Record<string, string> {
  if (requestedTokens === null || !Number.isFinite(requestedTokens) || requestedTokens <= 0) {
    return env;
  }
  const config = parseCodexConfigEnv(env[CODEX_CONFIG_ENV]);
  const next = { ...config, model_context_window: Math.floor(requestedTokens) };
  return { ...env, [CODEX_CONFIG_ENV]: JSON.stringify(next) };
}

export function isSelectableCatalogModel(model: CodexCatalogModel): boolean {
  return (model.visibility ?? 'list') === 'list';
}
