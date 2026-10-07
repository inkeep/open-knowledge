import './browser-globals';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'react-medium-image-zoom/dist/styles.css';
import 'katex/dist/katex.min.css';
import '@/globals.css';
import '@/lib/i18n';
import './browser-storage-lifecycle';
import './browser-network-check';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
