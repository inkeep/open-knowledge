/**
 * Entry for the `uninstall.html` renderer — the self-uninstall flow's own
 * window, separate from the editor entry in `src/main.tsx`.
 *
 * **This entry must connect to nothing.** The survey and completion screens
 * render *after* `ok uninstall --yes` has stopped the local Hocuspocus server
 * and removed `~/.ok`, so nothing reachable from here may touch the editor,
 * the CRDT stack, a provider pool, or the server bootstrap. Everything loads
 * eagerly (no dynamic `import()`) so the later screens paint from memory once
 * teardown is under way.
 */
import { I18nProvider } from '@lingui/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Side-effect import: loads + activates the i18n catalog before first render.
import { i18n } from '@/lib/i18n';
import { UninstallApp } from './UninstallApp';
// Both faces the screens reference: Inter for `--font-sans`, JetBrains Mono for
// `--font-mono` (project paths, source badges, the mono-uppercase filled
// buttons). Without the mono import the window falls back to system mono.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '../globals.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <UninstallApp />
    </I18nProvider>
  </StrictMode>,
);
