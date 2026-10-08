type MessageBox = (options: { type: string; message: string }) => Promise<unknown>;
declare const dialog: {
  showErrorBox: (title: string, body: string) => void;
  showMessageBox: MessageBox;
};
declare const electron: { dialog: typeof dialog };
declare const host: { showErrorBox: (title: string, body: string) => void };
declare function showErrorBox(title: string, body: string): void;
declare function showErrorDialog(title: string, body: string): Promise<void>;

export function positives(): void {
  dialog.showErrorBox('p1', 'dialog module');
  electron.dialog.showErrorBox('p2', 'namespaced electron import');
  host.showErrorBox('p3', 'injected dialog host');
}

export async function negatives(): Promise<void> {
  await dialog.showMessageBox({ type: 'error', message: 'n1 async message box' });
  await showErrorDialog('n2', 'sanctioned helper');
  showErrorBox('n3', 'bare identifier, not a dialog member');
  const n4 = 'showErrorBox' as const;
  dialog[n4]('n4', 'computed member access');
  const n5 = dialog.showErrorBox;
  void n5;
}
