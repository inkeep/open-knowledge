import { describe, expect, test } from 'vitest';
import { DOC_PANEL_ID, findResidualPanelId } from './editor-area-rail-registry';

describe('residual panel discovery in the side panel row', () => {
  test('finds the workspace column beside the side panel, in either order', () => {
    expect(findResidualPanelId(['workspace-main', DOC_PANEL_ID])).toBe('workspace-main');
    expect(findResidualPanelId([DOC_PANEL_ID, 'workspace-main'])).toBe('workspace-main');
  });

  test('a row holding only the side panel has no residual', () => {
    expect(findResidualPanelId([DOC_PANEL_ID])).toBeNull();
  });

  test('an unregistered second column breaks residual resolution', () => {
    expect(findResidualPanelId(['workspace-main', 'stray-column', DOC_PANEL_ID])).toBeNull();
  });
});
