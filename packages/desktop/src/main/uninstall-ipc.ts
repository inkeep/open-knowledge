/**
 * Main-side service for the uninstall window's `ok:uninstall:dispatch` channel.
 *
 * Kept free of `electron` imports so the whole authorization surface unit-tests
 * in the node tier; `index.ts` owns the `BrowserWindow` and passes its
 * `webContents.id` in.
 *
 * Two guarantees live here:
 *
 *   1. **Sender validation.** Only a webContents main itself registered as a
 *      live uninstall screen is answered. Any other sender — an editor window,
 *      a stale uninstall window main already finished with — gets `refused` and
 *      triggers no side effect.
 *   2. **Payload containment.** `createHandler` casts its args without runtime
 *      enforcement, so every inbound request is re-validated here. Unknown
 *      shapes are refused; recognized ones are rebuilt field by field, which is
 *      what keeps a hostile payload from smuggling extra properties into the
 *      flow code that consumes the intent.
 */

import type {
  UninstallDispatchResult,
  UninstallIntent,
  UninstallScreenSpec,
} from '@inkeep/open-knowledge-core';
import { getLogger } from './desktop-logger.ts';
import { normalizeDesktopUninstallFeedbackAnswers } from './desktop-uninstall.ts';

/** One live uninstall window, from `open()` until its disposer runs. */
interface UninstallScreenSession {
  /** What this window renders. Answered to its `ready` request. */
  readonly screen: UninstallScreenSpec;
  /** Called at most once per user action; the flow code decides what settles. */
  readonly onIntent: (intent: UninstallIntent) => void;
}

export interface UninstallScreenRegistry {
  /** Register a window's screen. Returns a disposer that unregisters it. */
  open(webContentsId: number, session: UninstallScreenSession): () => void;
  /** Service one inbound request from `webContentsId`. Never throws. */
  dispatch(webContentsId: number, request: unknown): UninstallDispatchResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Keep only the array members that can index a list. Everything else — strings
 * that look like numbers, floats, negatives, objects — is dropped rather than
 * coerced: a renderer sending `"0"` is not a renderer this code should be
 * guessing the intent of. Negatives are refused here too (defense in depth); the
 * only survivors are non-negative safe integers. Upper-bound out-of-range
 * integers still survive and are discarded downstream, where the candidate list
 * that defines "in range" actually lives.
 */
function normalizeSelectedIndexes(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (value): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
  );
}

/**
 * Every intent kind this boundary recognizes, as data. Adding a kind to
 * `UninstallIntent` fails to compile here (the `satisfies`) and again at the
 * switch's `default` (the `never`), so a new intent can't be silently dropped.
 */
const RECOGNIZED_UNINSTALL_INTENT_KINDS = {
  'picker-confirm': true,
  'picker-cancel': true,
  'survey-send': true,
  'survey-skip': true,
  'notice-confirm': true,
  'notice-cancel': true,
  'notice-reveal-log': true,
} satisfies Record<UninstallIntent['kind'], true>;

function isRecognizedUninstallIntentKind(value: unknown): value is UninstallIntent['kind'] {
  return typeof value === 'string' && value in RECOGNIZED_UNINSTALL_INTENT_KINDS;
}

/**
 * Rebuild a recognized intent from an arbitrary payload, or `null` when it is
 * not one. Rebuilding (rather than narrowing in place) is deliberate: the
 * object handed to the flow code contains only fields named here.
 */
export function normalizeUninstallIntent(raw: unknown): UninstallIntent | null {
  if (!isRecord(raw)) return null;
  if (!isRecognizedUninstallIntentKind(raw.kind)) return null;
  switch (raw.kind) {
    case 'picker-confirm':
      return {
        kind: 'picker-confirm',
        selectedIndexes: normalizeSelectedIndexes(raw.selectedIndexes),
      };
    case 'picker-cancel':
      return { kind: 'picker-cancel' };
    case 'survey-send':
      return { kind: 'survey-send', ...normalizeDesktopUninstallFeedbackAnswers(raw) };
    case 'survey-skip':
      return { kind: 'survey-skip' };
    case 'notice-confirm':
      return { kind: 'notice-confirm' };
    case 'notice-cancel':
      return { kind: 'notice-cancel' };
    case 'notice-reveal-log':
      return { kind: 'notice-reveal-log' };
    default: {
      const _exhaustive: never = raw.kind;
      return _exhaustive;
    }
  }
}

export function createUninstallScreenRegistry(): UninstallScreenRegistry {
  const sessions = new Map<number, UninstallScreenSession>();

  return {
    open(webContentsId, session) {
      sessions.set(webContentsId, session);
      return () => {
        if (sessions.get(webContentsId) === session) sessions.delete(webContentsId);
      };
    },

    dispatch(webContentsId, request) {
      const session = sessions.get(webContentsId);
      if (session === undefined) {
        // Straggler: a stale window main already finished with. Expected during
        // teardown, so debug rather than warn.
        getLogger('lifecycle').debug({ webContentsId }, 'uninstall dispatch from unknown window');
        return { kind: 'refused', reason: 'unknown-window' };
      }
      if (isRecord(request) && request.kind === 'ready') {
        return { kind: 'screen', screen: session.screen };
      }
      const intent = normalizeUninstallIntent(request);
      if (intent === null) {
        // A loaded window sending an unrecognized shape — a dev hot-reload /
        // version skew, or a future one-sided contract change. Without this the
        // user clicks a button that does nothing and nothing explains why.
        getLogger('lifecycle').warn(
          // Log the actual payload for a non-record (e.g. `42`, `null`) rather
          // than its typeof, so the entry is diagnosable. The uninstall renderer
          // is first-party (no remote content), so the value is a small refused
          // primitive, not attacker-controlled free-form input.
          { webContentsId, kind: isRecord(request) ? request.kind : request },
          'uninstall dispatch refused: unrecognized intent',
        );
        return { kind: 'refused', reason: 'invalid-intent' };
      }
      session.onIntent(intent);
      return { kind: 'accepted' };
    },
  };
}
