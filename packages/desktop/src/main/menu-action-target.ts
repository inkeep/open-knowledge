interface MenuActionTargetDeps<TSender, TWindow> {
  fromWebContents: (sender: TSender) => TWindow | null;
  getFocusedWindow: () => TWindow | null;
  getAllWindows: () => readonly TWindow[];
}

export function resolveMenuActionTarget<TSender, TWindow>(
  sender: TSender | null,
  deps: MenuActionTargetDeps<TSender, TWindow>,
): TWindow | null {
  if (sender != null) {
    const senderWindow = deps.fromWebContents(sender);
    if (senderWindow != null) return senderWindow;
  }
  return deps.getFocusedWindow() ?? deps.getAllWindows()[0] ?? null;
}
