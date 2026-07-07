/**
 * Barrel re-export for `_helpers/`.
 *
 * Consumers MUST import from `./_helpers` (which resolves here). Importing
 * directly from an inner file (`./_helpers/sidebar`, `./_helpers/provider`,
 * ...) is banned by the STOP rule in
 * `packages/app/tests/integration/e2e-stop-rules.test.ts`. The
 * indirection insulates consumers from domain-grouping churn — helpers can
 * move files without touching any e2e test's imports.
 */

export { simulateCopyAndRead, simulateCutAndRead } from './clipboard.ts';
export { resetContentToFixtureBaseline } from './content-reset.ts';
export {
  focusEditor,
  selectAllAndWaitForSelection,
  waitForPmSelectionInNode,
} from './editor-state.ts';
export { filterCriticalErrors, type LogEntry } from './error-filters.ts';
export {
  type AgentIdentity,
  type ApiHelpers,
  expect,
  REQUIRED_FIXTURE_ENTRY_NAMES,
  test,
  type WorkerServer,
} from './fixtures.ts';
export { waitForGraphSimulationSettled } from './graph.ts';
export {
  installClockAfterSync,
  type WaitForProviderOptions,
  waitForActiveProviderSynced,
} from './provider.ts';
export {
  checkCollabSync,
  closeServerLog,
  getFreePort,
  killGracefully,
  openServerLog,
  prepareViteCacheDir,
  type ServerLog,
  tailServerLog,
  waitForHttpReady,
} from './server-process.ts';
export { createFileViaSidebar, createFolderViaSidebar, sidebarFileButton } from './sidebar.ts';
export {
  getSelectedItemSnapshot,
  type SelectedItemSnapshot,
  type SlashMenuWaitOptions,
  slashMenu,
  waitForSlashMenuClosed,
  waitForSlashMenuFilteredBy,
  waitForSlashMenuFirstOption,
  waitForSlashMenuOpen,
} from './slash-menu.ts';
export { createMp3Buffer, createMp4Buffer, createPngBuffer } from './upload-fixtures.ts';
