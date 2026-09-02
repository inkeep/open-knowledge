import type { OkThemeSource } from '../shared/bridge-contract.ts';

const VALID_THEME_SOURCES: ReadonlySet<OkThemeSource> = new Set(['system', 'light', 'dark']);

export function isOkThemeSource(value: unknown): value is OkThemeSource {
  return typeof value === 'string' && VALID_THEME_SOURCES.has(value as OkThemeSource);
}

interface ApplyThemeSourceDeps {
  getThemeSource: () => OkThemeSource;
  setThemeSource: (source: OkThemeSource) => void;
  warn: (line: string) => void;
}

export function applyThemeSource(deps: ApplyThemeSourceDeps, source: OkThemeSource): { ok: true } {
  if (!VALID_THEME_SOURCES.has(source)) {
    deps.warn(
      JSON.stringify({
        event: 'theme-source-set-rejected',
        received: source,
        reason: 'invalid-source',
      }),
    );
    return { ok: true };
  }

  const prevSource = deps.getThemeSource();
  deps.setThemeSource(source);
  deps.warn(
    JSON.stringify({
      event: 'theme-source-set',
      source,
      prevSource,
      trigger: 'ipc',
    }),
  );
  return { ok: true };
}
