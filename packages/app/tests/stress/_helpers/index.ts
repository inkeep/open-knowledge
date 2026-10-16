export { acpCatalogBody } from './acp-catalog.ts';
export {
  DESKTOP_HEADER_PLATFORM_NAMES,
  DESKTOP_HEADER_PLATFORMS,
  type DesktopHeaderHost,
  MAC_WINDOW_BUTTONS_WIDTH_PX,
  MAC_WINDOW_BUTTONS_X_PX,
  openDesktopHeader,
  settledHeaderFit,
  settleFrames,
  type WindowControls,
  windowControlsOf,
} from './app-header-host.ts';
export {
  AUDIT_CONSOLE_RECORD_CASES,
  chromiumResourceFailureRecord,
} from './audit-console-records.test-helper.ts';
export {
  BORDER_SIDES,
  type BorderSide,
  type BorderSideName,
  type CardSurface,
  type ContrastPair,
  contrastRatioOf,
  countDifferingPixels,
  innerClipsOf,
  type RgbaBytes,
  readBorderColors,
  readCardSurface,
  readContrastPair,
  readRootColor,
  type ScreenClip,
} from './card-surface.ts';
export { simulateCopyAndRead, simulateCutAndRead } from './clipboard.ts';
export { resetContentToFixtureBaseline } from './content-reset.ts';
export {
  type CardPlacement,
  CORNER_STACK_TEST_ID,
  type ControlReach,
  cornerStack,
  cornerStackColumn,
  expectDocumentOpen,
  FLOATING_AND_HIT_TESTABLE,
  feedbackCard,
  identityOf,
  newsletterCard,
  noticeList,
  noticeWithText,
  placementOf,
  REACHABLE,
  reachOf,
  SAME_NODE,
  sidebarTrigger,
} from './corner-stack.ts';
export { afterEditorFocusSync, PROSEMIRROR_FOCUS_SYNC_DELAY_MS } from './editor-focus-sync.ts';
export {
  type CaretPlacement,
  focusEditor,
  placeCaretAtEndOfText,
  primeFullLayout,
  selectAllAndWaitForSelection,
  selectText,
  waitForPmSelectionInNode,
} from './editor-state.ts';
export { filterCriticalErrors, type LogEntry } from './error-filters.ts';
export {
  type ExternalLinkCue,
  externalLinkCueSnapshot,
  hasExternalCue,
} from './external-link-cue.ts';
export {
  FEEDBACK_NUDGE_KEY,
  seedFeedbackEligibleDocs,
  seedFeedbackNudgeStateBeforeLoad,
} from './feedback-nudge.ts';
export {
  type AgentIdentity,
  type ApiHelpers,
  expect,
  isConcurrentOverwriteRefusal,
  REQUIRED_FIXTURE_ENTRY_NAMES,
  test,
  type WorkerServer,
} from './fixtures.ts';
export { waitForGraphSimulationSettled } from './graph.ts';
export { waitForImageDecoded } from './image.ts';
export {
  assertLanded,
  CHUNK_WRAPPER_SELECTOR,
  injectForcedEstimateError,
  landingMarkCount,
  readEditorCaretLine,
  readSourceCaretHead,
  readWysiwygCaretHead,
  scrollWysiwygBlockToTop,
  TOOLBAR_OVERLAP_PX,
  toggleMode,
  waitForLandingSettled,
} from './landing.ts';
export {
  arrangeTerminalAlone,
  CHAT_PANE_CARD,
  type DesktopLayoutOptions,
  EDITOR_PANE_CARD,
  expectEditorHidden,
  type HeaderPane,
  headerPaneButton,
  type LayoutViewport,
  openDesktopLayout,
  openWebLayout,
  presetTerminalPlacement,
  runPaletteCommand,
  setHeaderPane,
  stubAgentCatalog,
  terminalPaneCard,
} from './pane-layout.ts';
export {
  appSourcesIn,
  servedEntryScriptRoute,
  servedModuleRoute,
  servedModuleUrl,
} from './prebuilt/served-modules.ts';
export {
  installClockAfterSync,
  type WaitForProviderOptions,
  waitForActiveProviderSynced,
} from './provider.ts';
export { escapeRegExp } from './regexp.ts';
export { matchIsWithinReadableScrollport } from './scrollport.ts';
export {
  type BoundViteEndpoint,
  beginViteStartup,
  checkCollabSync,
  closeServerLog,
  createViteStartupRequest,
  getFreePort,
  killGracefully,
  openServerLog,
  prepareViteCacheDir,
  type ServerLog,
  tailServerLog,
  waitForBoundViteEndpoint,
  waitForHttpReady,
} from './server-process.ts';
export {
  openColorThemes,
  openProjectPluginsPanel,
  openSettingsSection,
  SETTINGS_PANEL_TIMEOUT_MS,
  setPluginEnabled,
  waitForSettingsPanel,
} from './settings.ts';
export {
  createFileViaSidebar,
  createFolderViaSidebar,
  expectActiveEditorTab,
} from './sidebar.ts';
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
export {
  NEWSLETTER_KEY,
  NEWSLETTER_USED_UP,
  type NewsletterState,
  seedNewsletterStateBeforeLoad,
} from './subscribe-card.ts';
export { blockMarker, generateTallDoc } from './tall-doc-fixture.ts';
export { removeAllDuringTeardown } from './teardown-fs.ts';
export {
  type ArmedThemeFade,
  FADE_DURATION_MS,
  FADE_REPORT_WINDOW_MS,
  installThemeFadeProbe,
  runningRootAnimations,
  switchColorThemeAndSettleFade,
  type ThemeFadeProbeWindow,
  type ThemeFadeReport,
} from './theme-fade.ts';
export {
  createMp3Buffer,
  createMp4Buffer,
  createPngBuffer,
  uniqueAssetName,
} from './upload-fixtures.ts';
