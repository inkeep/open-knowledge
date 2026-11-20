import type { AboutPanelOptionsOptions } from 'electron';
import { DESKTOP_VARIANT } from '../shared/desktop-variant.ts';

export function buildAboutPanelOptions(version: string): AboutPanelOptionsOptions {
  return {
    applicationName: DESKTOP_VARIANT.productName,
    applicationVersion: version,
    copyright: [
      'Copyright (C) 2026 Inkeep, Inc.',
      'License GPL-3.0-or-later. Free software with ABSOLUTELY NO WARRANTY.',
      'Full license: see LICENSE in the app Resources.',
      'Third-party notices: see THIRD_PARTY_NOTICES.md in the app Resources.',
      'Includes node-liblzma, Copyright (C) 2014-2015 Olivier Orabona, under LGPL-3.0; its license text is in THIRD_PARTY_NOTICES.md.',
    ].join('\n'),
  };
}
