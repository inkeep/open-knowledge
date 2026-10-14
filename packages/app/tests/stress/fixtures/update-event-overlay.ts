import type { Page } from '@playwright/test';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

const UPDATE_EVENT_CHANNELS = [
  'onUpdateDownloaded',
  'onUpdateRelaunching',
  'onUpdateFetchingLatest',
  'onUpdateRelaunchFailed',
  'onWhatsNew',
  'onWhatsNewDismissed',
  'onUpdateStuckHint',
  'onUpdateManualCheck',
] as const satisfies ReadonlyArray<keyof OkDesktopBridge>;

export type UpdateEventChannel = (typeof UPDATE_EVENT_CHANNELS)[number];

export type UpdateEventPayload<C extends UpdateEventChannel> = Parameters<
  Parameters<OkDesktopBridge[C]>[0]
>[0];

export type OnboardingToastPayload = Parameters<
  Parameters<OkDesktopBridge['onboarding']['onToast']>[0]
>[0];

export type SchemaIncompatibility = NonNullable<
  Awaited<ReturnType<OkDesktopBridge['state']['query']>>['schemaIncompatibility']
>;

export interface UpdateEventOverlayConfig {
  readonly schemaIncompatibility?: SchemaIncompatibility;
  readonly freshlyCreated?: boolean;
}

export type HeldRelaunchOutcome =
  | { readonly kind: 'resolve' }
  | { readonly kind: 'reject'; readonly message: string };

type UpdateListener = (info: never) => void;
type OnboardingToastListener = (payload: OnboardingToastPayload) => void;

interface UpdateEventOverlayState {
  readonly listeners: Partial<Record<UpdateEventChannel, Set<UpdateListener>>>;
  readonly onboardingToastListeners: Set<OnboardingToastListener>;
  relaunchCalls: number;
  readonly heldRelaunches: Array<{
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  }>;
}

type OverlayWindow = Window & { __okUpdateEventOverlay__?: UpdateEventOverlayState };

interface OverlayInitArgs {
  readonly channels: readonly UpdateEventChannel[];
  readonly schemaIncompatibility: SchemaIncompatibility | null;
  readonly freshlyCreated: boolean;
}

export async function installUpdateEventOverlay(
  page: Page,
  config: UpdateEventOverlayConfig = {},
): Promise<void> {
  await page.addInitScript(
    ({ channels, schemaIncompatibility, freshlyCreated }: OverlayInitArgs) => {
      const state: UpdateEventOverlayState = {
        listeners: {},
        onboardingToastListeners: new Set(),
        relaunchCalls: 0,
        heldRelaunches: [],
      };
      const overlayWindow = window as OverlayWindow;
      overlayWindow.__okUpdateEventOverlay__ = state;

      const overlay = (bridge: OkDesktopBridge): void => {
        for (const channel of channels) {
          const listeners = new Set<UpdateListener>();
          state.listeners[channel] = listeners;
          bridge[channel] = (listener: UpdateListener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          };
        }
        bridge.onboarding.onToast = (listener) => {
          state.onboardingToastListeners.add(listener);
          return () => {
            state.onboardingToastListeners.delete(listener);
          };
        };
        bridge.update.relaunchNow = () => {
          state.relaunchCalls += 1;
          return new Promise<void>((resolve, reject) => {
            state.heldRelaunches.push({ resolve, reject });
          });
        };
        if (schemaIncompatibility !== null) {
          const query = bridge.state.query;
          bridge.state.query = async () => ({ ...(await query()), schemaIncompatibility });
        }
        if (freshlyCreated) {
          Object.assign(bridge.config, {
            freshlyCreated: true,
          } satisfies Partial<OkDesktopBridge['config']>);
        }
      };

      let installed: OkDesktopBridge | undefined;
      Object.defineProperty(overlayWindow, 'okDesktop', {
        configurable: true,
        enumerable: true,
        get: () => installed,
        set: (bridge: OkDesktopBridge | undefined) => {
          if (bridge !== undefined) overlay(bridge);
          installed = bridge;
        },
      });
    },
    {
      channels: UPDATE_EVENT_CHANNELS,
      schemaIncompatibility: config.schemaIncompatibility ?? null,
      freshlyCreated: config.freshlyCreated ?? false,
    } satisfies OverlayInitArgs,
  );
}

export async function emitUpdateEvent<C extends UpdateEventChannel>(
  page: Page,
  channel: C,
  payload: UpdateEventPayload<C>,
): Promise<void> {
  const delivered = await page.evaluate(
    ({ channel, payload }) => {
      const state = (window as OverlayWindow).__okUpdateEventOverlay__;
      if (state === undefined) return -1;
      const listeners = [...(state.listeners[channel] ?? [])];
      for (const listener of listeners) listener(payload as never);
      return listeners.length;
    },
    { channel, payload },
  );
  if (delivered === -1) {
    throw new Error('update event overlay: installUpdateEventOverlay did not run in this page');
  }
  if (delivered === 0) {
    throw new Error(
      `update event overlay: nothing subscribed to ${channel}; install the overlay before the desktop bridge`,
    );
  }
}

export async function emitOnboardingToast(
  page: Page,
  payload: OnboardingToastPayload,
): Promise<void> {
  const delivered = await page.evaluate((next: OnboardingToastPayload) => {
    const state = (window as OverlayWindow).__okUpdateEventOverlay__;
    if (state === undefined) return -1;
    const listeners = [...state.onboardingToastListeners];
    for (const listener of listeners) listener(next);
    return listeners.length;
  }, payload);
  if (delivered === -1) {
    throw new Error('update event overlay: installUpdateEventOverlay did not run in this page');
  }
  if (delivered === 0) {
    throw new Error(
      'update event overlay: nothing subscribed to onboarding.onToast; install the overlay before the desktop bridge',
    );
  }
}

export async function readRelaunchCalls(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const state = (window as OverlayWindow).__okUpdateEventOverlay__;
    if (state === undefined) {
      throw new Error('update event overlay: installUpdateEventOverlay did not run in this page');
    }
    return state.relaunchCalls;
  });
}

export async function settleHeldRelaunch(page: Page, outcome: HeldRelaunchOutcome): Promise<void> {
  const settled = await page.evaluate((next: HeldRelaunchOutcome) => {
    const held = (window as OverlayWindow).__okUpdateEventOverlay__?.heldRelaunches.shift();
    if (held === undefined) return false;
    if (next.kind === 'resolve') held.resolve();
    else held.reject(new Error(next.message));
    return true;
  }, outcome);
  if (!settled) throw new Error('update event overlay: no relaunchNow call is being held');
}
