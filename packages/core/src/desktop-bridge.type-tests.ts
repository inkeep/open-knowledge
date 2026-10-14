import type { OkEditorViewMenuStateChange } from './desktop-bridge.ts';

const _paired: OkEditorViewMenuStateChange = {
  agentPanelVisible: false,
  wideIntent: { agentPanelVisible: true },
};
void _paired;

const _menuOnly: OkEditorViewMenuStateChange = { sidebarVisible: true };
void _menuOnly;

// @ts-expect-error -- an empty intent would update the menu and persist nothing for the changed pane.
const _emptyIntent: OkEditorViewMenuStateChange = { terminalVisible: true, wideIntent: {} };
void _emptyIntent;

// @ts-expect-error -- an intent for another pane leaves the changed pane unpersisted.
const _mismatchedIntent: OkEditorViewMenuStateChange = {
  editorVisible: true,
  wideIntent: { terminalVisible: false },
};
void _mismatchedIntent;

// @ts-expect-error -- a dock visibility change without its intent is the unpersisted case this type exists to reject.
const _missingIntent: OkEditorViewMenuStateChange = { editorVisible: true };
void _missingIntent;

const _strayIntent: OkEditorViewMenuStateChange = {
  editorVisible: true,
  // @ts-expect-error -- an intent for a pane the change does not name would persist a pane the menu did not change.
  wideIntent: { editorVisible: true, terminalVisible: false },
};
void _strayIntent;

// @ts-expect-error -- one change names one pane; every sender reports each pane separately.
const _twoPanes: OkEditorViewMenuStateChange = {
  editorVisible: true,
  terminalVisible: false,
  wideIntent: { editorVisible: true },
};
void _twoPanes;
