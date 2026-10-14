import { describe, expect, test } from 'vitest';
import { resolveEditorSidebarFit } from './editor-sidebar-fit';

const bothRequested = {
  filesWidthPx: 288,
  informationWidthPx: 320,
  documentMinimumPx: 300,
  filesOpen: true,
  informationOpen: true,
  preferred: null,
} as const;

describe('editor sidebar fitting', () => {
  test('both widths and the information divider must fit beside the usable document', () => {
    expect(resolveEditorSidebarFit({ ...bothRequested, widthPx: 909 })).toEqual({
      mode: 'both',
      filesDocked: true,
      informationDocked: true,
    });
    expect(resolveEditorSidebarFit({ ...bothRequested, widthPx: 908 })).toEqual({
      mode: 'single',
      filesDocked: true,
      informationDocked: false,
    });
    expect(resolveEditorSidebarFit({ ...bothRequested, widthPx: 621 })).toEqual({
      mode: 'single',
      filesDocked: true,
      informationDocked: false,
    });
    expect(resolveEditorSidebarFit({ ...bothRequested, widthPx: 620 })).toEqual({
      mode: 'cover',
      filesDocked: false,
      informationDocked: false,
    });
  });

  test('the requested sidebar wins constrained docking while both can return at sufficient width', () => {
    expect(
      resolveEditorSidebarFit({ ...bothRequested, widthPx: 800, preferred: 'information' }),
    ).toEqual({ mode: 'single', filesDocked: false, informationDocked: true });
    expect(resolveEditorSidebarFit({ ...bothRequested, widthPx: 800, preferred: 'files' })).toEqual(
      { mode: 'single', filesDocked: true, informationDocked: false },
    );
    expect(
      resolveEditorSidebarFit({ ...bothRequested, widthPx: 909, preferred: 'information' }),
    ).toEqual({ mode: 'both', filesDocked: true, informationDocked: true });
  });

  test('a wider remembered information panel puts both sidebars in cover mode even when Files alone fits', () => {
    expect(
      resolveEditorSidebarFit({ ...bothRequested, informationWidthPx: 600, widthPx: 800 }),
    ).toEqual({ mode: 'cover', filesDocked: false, informationDocked: false });
    expect(
      resolveEditorSidebarFit({ ...bothRequested, informationWidthPx: 600, widthPx: 901 }),
    ).toEqual({ mode: 'single', filesDocked: true, informationDocked: false });
  });

  test('an absent sidebar contributes no fitting budget and an explicitly hidden sidebar stays hidden', () => {
    expect(resolveEditorSidebarFit({ ...bothRequested, filesWidthPx: null, widthPx: 621 })).toEqual(
      { mode: 'both', filesDocked: false, informationDocked: true },
    );
    expect(resolveEditorSidebarFit({ ...bothRequested, filesOpen: false, widthPx: 800 })).toEqual({
      mode: 'single',
      filesDocked: false,
      informationDocked: true,
    });
    expect(
      resolveEditorSidebarFit({ ...bothRequested, informationOpen: false, widthPx: 909 }),
    ).toEqual({ mode: 'both', filesDocked: true, informationDocked: false });
  });
});
