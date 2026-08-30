import type { OkMenuActionOrigin, OkMenuDispatchRequest } from '../shared/bridge-contract.ts';

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

/**
 * How a menu action reached the renderer. Stated EXPLICITLY by whoever dispatches
 * it, never inferred from the `sender` argument.
 *
 * `sender` exists to pick the target window. It used to double as the provenance
 * bit, which fused two unrelated questions and defaulted the wrong way: anything
 * that passed a sender to choose a window was stamped launcher-borne, so a future
 * main-side forwarder would have delayed its screenshot waiting for a launcher
 * that was never on screen. With an explicit argument the safe value is the
 * default and opting in is deliberate.
 */
export const LAUNCHER_FREE_ORIGIN: OkMenuActionOrigin = Object.freeze({ launcherBorne: false });

/**
 * The dispatching surface is transient and the user went through it only to REACH
 * the action, so it is an artifact of filing rather than the report's subject and
 * the screenshot must wait for it to unmount.
 *
 * Used for renderer-originated `ok:menu:dispatch` traffic. In the product that is
 * the renderer-drawn Windows and Linux menu bar (a Radix popper on screen when the
 * action fires). The smoke tier borrows the same channel to drive terminal actions
 * — those are stamped launcher-borne too, harmlessly, because no terminal action
 * reads the origin. Only the report-bug path does.
 */
export const LAUNCHER_BORNE_ORIGIN: OkMenuActionOrigin = Object.freeze({ launcherBorne: true });

/**
 * Origin for every kind of renderer-initiated `ok:menu:dispatch`, as data.
 *
 * Adding a kind to `OkMenuDispatchRequest` fails to compile here (the
 * `satisfies`), so a new renderer entry point cannot inherit a classification by
 * omission — it has to be decided. Same shape as the intent roster in
 * `uninstall-ipc.ts`.
 *
 * `menu-action` is the only launcher-borne one: in the product it is the
 * renderer-drawn Windows and Linux menu bar, the one platform where that bar is
 * the only menu route to the reporter. Getting it wrong there means a bug report
 * screenshotting its own open dropdown instead of the screen the user meant to
 * report.
 *
 * What this does NOT cover: `sendMenuAction`'s `origin` parameter still defaults
 * to launcher-free, so a caller that drops the argument entirely gets the wrong
 * answer here just as silently as a bare literal would have. The map makes the
 * mapping total and testable; it does not make passing it mandatory. Keeping the
 * safe value in the default position is still right for every other caller —
 * this one kind is the exception, and it is the reason the call site threads an
 * explicit origin rather than relying on the default.
 */
const ORIGIN_BY_DISPATCH_KIND = {
  query: LAUNCHER_FREE_ORIGIN,
  'menu-action': LAUNCHER_BORNE_ORIGIN,
  command: LAUNCHER_FREE_ORIGIN,
  'open-recent-project': LAUNCHER_FREE_ORIGIN,
  role: LAUNCHER_FREE_ORIGIN,
} satisfies Record<OkMenuDispatchRequest['kind'], OkMenuActionOrigin>;

/** The classified kinds, so a test derives its roster instead of duplicating it. */
export const MENU_DISPATCH_KINDS = Object.keys(
  ORIGIN_BY_DISPATCH_KIND,
) as OkMenuDispatchRequest['kind'][];

export function originForMenuDispatch(kind: OkMenuDispatchRequest['kind']): OkMenuActionOrigin {
  return ORIGIN_BY_DISPATCH_KIND[kind];
}
