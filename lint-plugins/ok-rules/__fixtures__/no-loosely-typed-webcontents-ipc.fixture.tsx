// FIXTURE — drives `no-loosely-typed-webcontents-ipc.test.ts` via shell-out
// to `pnpm exec oxlint`. Not part of the main lint: `__fixtures__/` is in
// `oxlint.config.ts#ignorePatterns`, and `__fixtures__/oxlint.fixtures.json`
// re-enables the rules for the test.
//
// Six positive cases (deliberate violations — rule must fire) + four
// negative cases (clean usage on the same objects — rule must NOT fire).
// Exact-equality (`toBe(6)`) in the test catches both false-negative
// regressions (drop below 6) and false-positive widenings (above 6).

import type { IpcMain, IpcRenderer, WebContents } from 'electron';

declare const ipcMain: IpcMain;
declare const ipcRenderer: IpcRenderer;
declare const webContents: WebContents;
declare const listener: () => void;

// === Positive cases — one per banned primitive ===
webContents.send('ok:test-channel', { payload: 1 });
ipcMain.handle('ok:test-channel', async () => 'result');
ipcMain.on('ok:test-channel', () => {});
void ipcRenderer.invoke('ok:test-channel');
ipcRenderer.on('ok:test-channel', () => {});
ipcRenderer.once('ok:test-channel', () => {});

// === Negative cases — adjacent method calls on the same objects ===
// These exercise the precision of the rule. If a future widening
// matches any of these, the diagnostic count rises above 6 and `toBe(6)`
// catches the regression.

// (1) Different method on webContents (e.g., devtools open).
webContents.openDevTools();

// (2) Different method on ipcMain (the legitimate teardown counterpart
//     to `handle`). Real production code uses this; it must not fire.
ipcMain.removeHandler('ok:test-channel');

// (3) Different method on ipcRenderer (the legitimate unsubscribe).
ipcRenderer.removeListener('ok:test-channel', listener);

// (4) Bare-function call with the same NAME — unrelated to electron IPC.
//     Tests that the pattern is scoped to the member-call shape, not any
//     identifier named `send` / `handle` / `on` / `invoke` / `once`.
declare const sender: { send: (channel: string, payload: unknown) => void };
sender.send('not-electron', {});
