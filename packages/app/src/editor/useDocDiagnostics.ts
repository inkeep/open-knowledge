/**
 * Live, mode-agnostic lint diagnostics for the active document. Reads the full
 * doc text from `Y.Text('source')` — which both source mode (CodeMirror) and
 * WYSIWYG mode (Server Observer A keeps it in sync) bind to — and runs the core
 * `lintDocument` engine against the effective config. Because it reads the CRDT
 * directly (not the CodeMirror view), the Problems panel and its badge stay
 * populated in WYSIWYG mode too, where there is no source editor mounted.
 *
 * Re-lints on a 300 ms trailing-edge debounce (matching the OutlinePanel
 * convention) so keystroke bursts coalesce into one pass.
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';
import { type LintDiagnostic, type LinterConfig, lintDocument } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';

const RELINT_DEBOUNCE_MS = 300;

/**
 * Live diagnostics for `provider`'s doc under `config`. Returns `[]` when either
 * is null or linting is disabled. Recomputes on every `Y.Text('source')` change
 * (debounced) and whenever the provider or the config VALUE changes.
 *
 * The effect keys on a serialized config hash rather than object identity:
 * callers routinely pass a freshly-built config object each render (e.g.
 * `lintConfig?.effective ?? null`), and depending on identity would re-run the
 * effect — and its `setState` — every render, looping. The empty-result branch
 * also returns the prior reference when already empty so it can't re-trigger a
 * render on its own.
 */
export function useDocDiagnostics(
  provider: HocuspocusProvider | null,
  config: LinterConfig | null,
): LintDiagnostic[] {
  const configKey = config?.enabled ? JSON.stringify(config) : null;
  const [diagnostics, setDiagnostics] = useState<LintDiagnostic[]>([]);

  useEffect(() => {
    if (!provider || configKey === null) {
      setDiagnostics((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const effectiveConfig = JSON.parse(configKey) as LinterConfig;
    const ytext = provider.document.getText('source');
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const docName = provider.configuration.name;
    // The lint pass is async: drop a resolution that lands after this effect
    // has been torn down (provider/config changed) so it can't clobber the
    // next pair's diagnostics.
    const recompute = () =>
      void lintDocument(ytext.toString(), effectiveConfig, docName)
        .then((diagnostics) => {
          if (!cancelled) setDiagnostics(diagnostics);
        })
        .catch((err) => {
          // Mirror the sibling decoration pass: a lint throw (malformed config,
          // unexpected input) must not surface as an unhandled rejection.
          if (!cancelled) console.warn('[lint] lintDocument failed', err);
        });
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(recompute, RELINT_DEBOUNCE_MS);
    };
    // Initial pass for this provider/config pair, then observe for live edits.
    recompute();
    ytext.observe(schedule);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      ytext.unobserve(schedule);
    };
  }, [provider, configKey]);

  return diagnostics;
}
