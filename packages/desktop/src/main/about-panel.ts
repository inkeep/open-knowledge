import { PRODUCT_NAME } from '@inkeep/open-knowledge-core';
import type { AboutPanelOptionsOptions } from 'electron';

export function buildAboutPanelOptions(version: string): AboutPanelOptionsOptions {
  return {
    applicationName: PRODUCT_NAME,
    applicationVersion: version,
    copyright: [
      'Copyright (C) 2026 Inkeep, Inc.',
      'License GPL-3.0-or-later. Free software with ABSOLUTELY NO WARRANTY.',
      'Full license: see LICENSE in the app Resources.',
    ].join('\n'),
  };
}
