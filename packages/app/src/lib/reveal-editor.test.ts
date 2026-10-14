import { afterEach, describe, expect, test } from 'vitest';
import {
  __resetPaneVisibilityStoreForTests,
  type PaneVisibility,
  type PaneVisibilityRequest,
  paneVisibilityStore,
} from './pane-visibility-store';
import { revealEditor, revealEditorBeforeActing } from './reveal-editor';

const SHOWN: PaneVisibility = { open: true, onScreen: true };
const HIDDEN: PaneVisibility = { open: false, onScreen: false };

function recordRequests(): PaneVisibilityRequest[] {
  const requests: PaneVisibilityRequest[] = [];
  paneVisibilityStore.subscribeRequests((request) => requests.push(request));
  return requests;
}

afterEach(() => __resetPaneVisibilityStoreForTests());

describe('revealing the editor', () => {
  test('every reveal is handed to the editor, whether it reads hidden or shown', () => {
    const requests = recordRequests();
    paneVisibilityStore.publish({ editor: SHOWN, agents: null, terminal: null });
    revealEditor();
    revealEditorBeforeActing();

    paneVisibilityStore.publish({ editor: HIDDEN, agents: null, terminal: null });
    revealEditor();
    revealEditorBeforeActing();

    expect(requests).toEqual([
      { pane: 'editor', open: true },
      { pane: 'editor', open: true },
      { pane: 'editor', open: true },
      { pane: 'editor', open: true },
    ]);
  });
});
