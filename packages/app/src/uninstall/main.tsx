import { I18nProvider } from '@lingui/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { i18n } from '@/lib/i18n';
import { UninstallApp } from './UninstallApp';
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
