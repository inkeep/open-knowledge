/**
 * Typed `webContents.send` wrapper (main-side push-event dispatch).
 *
 * Consumers: any `src/main/*` module that needs to fire a push event to the
 * renderer (project-switched, menu-action, deep-link, ...). The Biome /
 * CI grep rule forbids raw `webContents.send` outside allowlisted IPC wrapper
 * files; this helper is the canonical path.
 *
 * Paired with `EventChannels` in `./ipc-events.ts` for channel-name + payload
 * type consistency. Subscription-side lives in the preload bridge
 * (`onProjectSwitched`, `onMenuAction`, `onDeepLink`).
 */

import type { EventChannels } from './ipc-events.ts';

/** Minimal shape of `electron.WebContents` we use for push events. */
export interface SendableWebContents {
  send(channel: string, ...args: unknown[]): void;
  /** Optional — real `WebContents` always has it, but test fakes can omit.
   *  Streaming senders use it to skip `send()` after window close (which
   *  throws and crashes main). Mirrors the pattern in `window-manager.ts`. */
  isDestroyed?(): boolean;
}

/**
 * Type-safe `webContents.send` — the channel determines the payload shape.
 *
 * Usage:
 * ```ts
 * sendToRenderer(window.webContents, 'ok:deep-link', { doc });
 * ```
 */
export function sendToRenderer<K extends keyof EventChannels>(
  webContents: SendableWebContents,
  channel: K,
  payload: EventChannels[K]['payload'],
): void {
  // biome-ignore lint/plugin/no-loosely-typed-webcontents-ipc: typed sendToRenderer factory body (precedent #14)
  webContents.send(channel, payload);
}

/** WebContents shape for {@link registerPendingDelivery}: sendable plus the
 *  one-shot readiness-event subscription. Real Electron `WebContents`
 *  satisfies it; window-manager test fakes provide `once` + `send`. */
export interface GateableWebContents extends SendableWebContents {
  once(event: 'dom-ready' | 'did-finish-load', listener: () => void): void;
}

/**
 * Register a one-shot renderer delivery gated on a renderer-readiness event —
 * call this BEFORE `loadURL`/`loadFile`. The `once` listener fires after the
 * renderer reaches `event` (default `dom-ready`), defeating the subscriber-
 * mount race in which a `send` beats the renderer's listener registration and
 * silently drops on a cold start. The register-BEFORE-load ordering is the
 * load-bearing invariant; centralizing the registration here keeps every gate
 * site consistent and documents the invariant in one place. Pass
 * `event: 'did-finish-load'` when the subscriber mounts after first paint
 * (e.g. a sonner toast) rather than at `dom-ready`.
 */
export function registerPendingDelivery<K extends keyof EventChannels>(
  webContents: GateableWebContents,
  channel: K,
  payload: EventChannels[K]['payload'],
  opts?: { readonly event?: 'dom-ready' | 'did-finish-load' },
): void {
  webContents.once(opts?.event ?? 'dom-ready', () => {
    // The window can be closed during the register→readiness race (a user
    // dismissing the loading spinner). `webContents.send` throws on a
    // destroyed WebContents and crashes main — skip the delivery instead.
    if (webContents.isDestroyed?.() === true) return;
    sendToRenderer(webContents, channel, payload);
  });
}
