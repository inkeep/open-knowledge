import type {
  UninstallDispatchResult,
  UninstallIntent,
  UninstallScreenSpec,
} from '@inkeep/open-knowledge-core';
import { getLogger } from './desktop-logger.ts';
import { normalizeDesktopUninstallFeedbackAnswers } from './desktop-uninstall.ts';

interface UninstallScreenSession {
  readonly screen: UninstallScreenSpec;
  readonly onIntent: (intent: UninstallIntent) => void;
}

export interface UninstallScreenRegistry {
  open(webContentsId: number, session: UninstallScreenSession): () => void;
  dispatch(webContentsId: number, request: unknown): UninstallDispatchResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeSelectedIndexes(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (value): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
  );
}

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
        getLogger('lifecycle').debug({ webContentsId }, 'uninstall dispatch from unknown window');
        return { kind: 'refused', reason: 'unknown-window' };
      }
      if (isRecord(request) && request.kind === 'ready') {
        return { kind: 'screen', screen: session.screen };
      }
      const intent = normalizeUninstallIntent(request);
      if (intent === null) {
        getLogger('lifecycle').warn(
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
