import type { NativeMenuLabelKey } from '@inkeep/open-knowledge-core';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

export const NATIVE_MENU_MESSAGES = {
  roleAbout: msg`About {appName}`,
  roleAboutGeneric: msg`About`,
  roleServices: msg`Services`,
  roleHide: msg`Hide {appName}`,
  roleHideOthers: msg`Hide Others`,
  roleUnhide: msg`Show All`,
  roleQuit: msg`Quit {appName}`,
  roleQuitGeneric: msg`Quit`,
  roleExit: msg`Exit`,
  roleUndo: msg`Undo`,
  roleRedo: msg`Redo`,
  roleCut: msg`Cut`,
  roleCopy: msg`Copy`,
  rolePaste: msg`Paste`,
  roleSelectAll: msg`Select All`,
  roleReload: msg`Reload`,
  roleForceReload: msg`Force Reload`,
  roleToggleDevTools: msg`Toggle Developer Tools`,
  roleResetZoom: msg`Actual Size`,
  roleZoomIn: msg`Zoom In`,
  roleZoomOut: msg`Zoom Out`,
  roleToggleFullScreen: msg`Toggle Full Screen`,
  roleMinimize: msg`Minimize`,
  roleZoom: msg`Zoom`,
  roleFront: msg`Bring All to Front`,
  roleCloseWindow: msg`Close Window`,
  roleClose: msg`Close`,

  menuFile: msg`File`,
  menuEdit: msg`Edit`,
  menuView: msg`View`,
  menuTerminal: msg`Terminal`,
  menuWindow: msg`Window`,
  menuHelp: msg`Help`,

  recentProject: msg`Recent project`,
  recentFiles: msg`Recent files`,
  noRecentProjects: msg`No recent projects`,
  noRecentFiles: msg`No recent files`,
  clearMenu: msg`Clear menu`,

  addToDictionary: msg`Add to Dictionary`,
  disableSpellCheck: msg`Disable Spell Check`,
  enableSpellCheck: msg`Enable Spell Check`,
  lookUpWord: msg`Look Up "{word}"`,
  searchWithGoogle: msg`Search with Google`,
  viewInSourceMarkdown: msg`View in Source Markdown`,

  showInExplorer: msg`Show in Explorer`,
  openInFileManager: msg`Open in file manager`,
  openInDefaultApp: msg`Open in default app`,
  copyLink: msg`Copy link`,
} satisfies Record<NativeMenuLabelKey, MessageDescriptor>;

export const MENU_LABEL_TEXT_MESSAGES: readonly MessageDescriptor[] = [
  msg`Install for Claude Chat & Cowork (desktop app)`,
  msg`New Terminal Window`,
  msg`Uninstall OpenKnowledge`,
];
