import { describe, expect, test, vi } from 'vitest';

vi.mock('../shared/desktop-variant.ts', async (importActual) => {
  const actual = await importActual<typeof import('../shared/desktop-variant.ts')>();
  return { ...actual, DESKTOP_VARIANT: actual.DESKTOP_VARIANTS.beta };
});

const { buildAboutPanelOptions } = await import('./about-panel.ts');

describe('buildAboutPanelOptions', () => {
  test('carries the version, copyright, GPL license, and no-warranty notice', () => {
    const opts = buildAboutPanelOptions('9.9.9');
    expect(opts.applicationVersion).toBe('9.9.9');
    expect(opts.copyright).toMatch(/Copyright \(C\) \d{4} Inkeep, Inc\./);
    expect(opts.copyright).toContain('GPL-3.0-or-later');
    expect(opts.copyright).toMatch(/NO WARRANTY/);
  });

  test('names THIRD_PARTY_NOTICES.md in its copyright text', () => {
    expect(buildAboutPanelOptions('9.9.9').copyright).toContain('THIRD_PARTY_NOTICES.md');
  });

  test('carries the LGPL node-liblzma copyright notice among its own', () => {
    expect(buildAboutPanelOptions('9.9.9').copyright).toContain(
      'node-liblzma, Copyright (C) 2014-2015 Olivier Orabona, under LGPL-3.0',
    );
  });

  test('names the installed product rather than the Stable app', () => {
    expect(buildAboutPanelOptions('9.9.9').applicationName).toBe('OpenKnowledge Beta');
  });
});
