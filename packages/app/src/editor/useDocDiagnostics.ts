import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  isEditableTextDocFile,
  type LintDiagnostic,
  type LinterConfig,
  lintDocument,
} from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';

const RELINT_DEBOUNCE_MS = 300;
const EMPTY_DIAGNOSTICS: readonly LintDiagnostic[] = Object.freeze([]);

export function useDocDiagnostics(
  provider: HocuspocusProvider | null,
  config: LinterConfig | null,
): readonly LintDiagnostic[] {
  const docName = provider?.configuration.name ?? null;
  const configKey =
    docName !== null && config?.enabled && !isEditableTextDocFile(docName)
      ? JSON.stringify(config)
      : null;
  const [diagnostics, setDiagnostics] = useState<LintDiagnostic[]>([]);

  useEffect(() => {
    if (!provider || docName === null || configKey === null) {
      setDiagnostics((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const effectiveConfig = JSON.parse(configKey) as LinterConfig;
    const ytext = provider.document.getText('source');
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const recompute = () =>
      void lintDocument(ytext.toString(), effectiveConfig, docName)
        .then((diagnostics) => {
          if (!cancelled) setDiagnostics(diagnostics);
        })
        .catch((err) => {
          if (!cancelled) console.warn('[lint] lintDocument failed', err);
        });
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(recompute, RELINT_DEBOUNCE_MS);
    };
    recompute();
    ytext.observe(schedule);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      ytext.unobserve(schedule);
    };
  }, [provider, docName, configKey]);

  return configKey === null ? EMPTY_DIAGNOSTICS : diagnostics;
}
