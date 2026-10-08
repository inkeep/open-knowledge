import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { getLogger } from './desktop-logger.ts';
import { type RestoreFocusDeps, whenWindowRevealed } from './restore-focus.ts';

export interface ErrorDialogHost {
  showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  showMessageBox(window: BrowserWindow, options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
}

function logShowFailure(title: string, err: unknown): void {
  getLogger('dialog').error({ title, err }, 'error dialog failed to show');
}

export function showErrorDialog(
  host: ErrorDialogHost,
  parent: BrowserWindow | null,
  title: string,
  body: string,
): Promise<void> {
  const options: MessageBoxOptions = {
    type: 'error',
    title,
    message: title,
    detail: body,
    buttons: ['OK'],
    defaultId: 0,
    noLink: true,
  };
  let shown: Promise<MessageBoxReturnValue>;
  try {
    shown =
      parent !== null && !parent.isDestroyed()
        ? host.showMessageBox(parent, options)
        : host.showMessageBox(options);
  } catch (err) {
    logShowFailure(title, err);
    return Promise.resolve();
  }
  return shown.then(
    () => undefined,
    (err: unknown) => logShowFailure(title, err),
  );
}

export function showErrorDialogOnceVisible(
  host: ErrorDialogHost,
  parent: BrowserWindow | null,
  title: string,
  body: string,
  reveal: RestoreFocusDeps,
): Promise<void> {
  if (parent === null) return showErrorDialog(host, null, title, body);
  return whenWindowRevealed(parent, reveal).then(() =>
    showErrorDialog(host, !parent.isDestroyed() && parent.isVisible() ? parent : null, title, body),
  );
}
