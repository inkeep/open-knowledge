import { i18n } from '@lingui/core';
import { plural, t } from '@lingui/core/macro';
import { createElement } from 'react';
import { toast } from 'sonner';
import { ServerDriftToast } from '@/components/ServerDriftToast';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import {
  type ServerVersion,
  type ServerVersionChange,
  subscribeServerVersionChange,
} from '@/lib/server-version-store';
import { formatToolList } from '@/lib/tool-list-format';

export const STALE_TAB_RELOAD_TOAST_ID = 'stale-tab-reload';

const NAMED_UNSAVED_DOCS = 3;

export type SavedWorkResult = 'saved' | 'unsaved' | 'reconnecting';
export type ReloadRefusalReason = Exclude<SavedWorkResult, 'saved'> | 'unconfirmed';

export interface SavedWorkSource {
  awaitMismatchSettled(): Promise<void>;
  isMismatchRecycleInFlight(): boolean;
  hasUnsavedWork(): boolean;
  addUnsyncedWorkListener(cb: () => void): () => void;
}

export async function waitForSavedWork(
  source: SavedWorkSource,
  timeoutMs: number,
): Promise<SavedWorkResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), timeoutMs);
  });
  let unsubscribe = () => {};
  try {
    const recovery = source.awaitMismatchSettled().then(() => 'settled' as const);
    if ((await Promise.race([recovery, expired])) === 'expired') return 'reconnecting';
    if (source.isMismatchRecycleInFlight()) return 'reconnecting';
    if (!source.hasUnsavedWork()) return 'saved';
    const synced = new Promise<'synced'>((resolve) => {
      unsubscribe = source.addUnsyncedWorkListener(() => {
        if (!source.hasUnsavedWork()) resolve('synced');
      });
    });
    return (await Promise.race([synced, expired])) === 'synced' ? 'saved' : 'unsaved';
  } finally {
    unsubscribe();
    clearTimeout(timer);
  }
}

export function watchForSavedWork(source: SavedWorkSource, onSaved: () => void): () => void {
  let stopped = false;
  let unsubscribe = () => {};
  const check = (): void => {
    if (stopped || source.isMismatchRecycleInFlight() || source.hasUnsavedWork()) return;
    stopped = true;
    unsubscribe();
    onSaved();
  };
  const start = (): void => {
    if (stopped) return;
    unsubscribe = source.addUnsyncedWorkListener(check);
    check();
  };
  void source.awaitMismatchSettled().then(start, start);
  return () => {
    stopped = true;
    unsubscribe();
  };
}

export function staleTabReloadBody({
  loaded,
  current,
}: {
  loaded: ServerVersion;
  current: ServerVersion;
}): string {
  const serverVersion = current.runtimeVersion;
  const tabVersion = loaded.runtimeVersion;
  if (serverVersion !== null && tabVersion !== null && serverVersion !== tabVersion) {
    return t`OpenKnowledge on this computer is now v${serverVersion}, but this tab is still running v${tabVersion}.`;
  }
  return t`OpenKnowledge on this computer changed to a different build, but this tab is still running the old one.`;
}

function unsavedDocList(docNames: readonly string[]): string {
  const quoted = docNames.map((name) => t`"${name}"`);
  if (quoted.length <= NAMED_UNSAVED_DOCS) return formatToolList(quoted, i18n.locale);
  const shown = quoted.slice(0, NAMED_UNSAVED_DOCS - 1);
  const others = quoted.length - shown.length;
  return formatToolList(
    [...shown, t`${plural(others, { one: '# other', other: '# others' })}`],
    i18n.locale,
  );
}

function assertNeverRefusalReason(reason: never): never {
  throw new Error(`Unhandled reload refusal reason: ${JSON.stringify(reason)}`);
}

export function staleTabReloadRefusal(
  reason: ReloadRefusalReason,
  docNamesToOpen: readonly string[],
): string {
  switch (reason) {
    case 'reconnecting':
      return t`This tab is still reconnecting to OpenKnowledge, so it didn't reload. Try again in a moment.`;
    case 'unconfirmed':
      return t`This tab couldn't confirm that your edits are saved, so it didn't reload. Your edits are still here.`;
    case 'unsaved': {
      if (docNamesToOpen.length === 0) {
        return t`Some edits haven't reached the server yet, so the tab didn't reload. Your edits are still here.`;
      }
      const docs = unsavedDocList(docNamesToOpen);
      return t`Some edits haven't reached the server yet, so the tab didn't reload. Open ${docs} to save them, then reload.`;
    }
    default:
      return assertNeverRefusalReason(reason);
  }
}

export function installStaleTabReloadPrompt(opts: {
  bridge: OkDesktopBridge | undefined;
  waitForSavedWork: () => Promise<SavedWorkResult>;
  watchForSavedWork: (onSaved: () => void) => () => void;
  docNamesToOpen: () => readonly string[];
  reload: () => void;
}): (() => void) | undefined {
  if (opts.bridge) return undefined;

  let latest: ServerVersionChange | null = null;
  let stopWatching = () => {};

  const stopRefusal = (): void => {
    stopWatching();
    stopWatching = () => {};
  };

  const showPrompt = (change: ServerVersionChange, refusal?: string): void => {
    toast.custom(
      (id) =>
        createElement(ServerDriftToast, {
          body: staleTabReloadBody(change),
          detail:
            refusal ??
            t`Reload this tab to bring it up to date. Your edits are saved before it reloads.`,
          actionLabel: t`Reload`,
          dismissLabel: t`Not now`,
          onAction: () => {
            void reloadWhenSaved();
          },
          onDismiss: () => {
            stopRefusal();
            toast.dismiss(id);
          },
        }),
      { id: STALE_TAB_RELOAD_TOAST_ID, duration: Number.POSITIVE_INFINITY },
    );
  };

  const reloadWhenSaved = async (): Promise<void> => {
    stopRefusal();
    toast.dismiss(STALE_TAB_RELOAD_TOAST_ID);
    const savingId = toast.loading(t`Saving your edits before reloading…`, {
      duration: Number.POSITIVE_INFINITY,
    });
    let result: SavedWorkResult | 'unconfirmed';
    let failure: { errorName: string; errorMessage: string } | undefined;
    try {
      result = await opts.waitForSavedWork();
    } catch (err) {
      result = 'unconfirmed';
      failure = {
        errorName: err instanceof Error ? err.name : 'non-error-throw',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    toast.dismiss(savingId);
    if (result === 'saved') {
      opts.reload();
      return;
    }
    const reason: ReloadRefusalReason = result;
    const docNamesToOpen = opts.docNamesToOpen();
    console.warn(
      JSON.stringify({
        event: 'ok-stale-tab-reload-withheld',
        reason,
        docsToOpenCount: docNamesToOpen.length,
        ...failure,
      }),
    );
    const refusedFor = latest;
    if (!refusedFor?.drifted) return;
    showPrompt(refusedFor, staleTabReloadRefusal(reason, docNamesToOpen));
    if (reason === 'unconfirmed') return;
    stopWatching = opts.watchForSavedWork(() => {
      stopWatching = () => {};
      if (latest === refusedFor) showPrompt(refusedFor);
    });
  };

  const unsubscribe = subscribeServerVersionChange((change) => {
    latest = change;
    stopRefusal();
    if (change.drifted) {
      showPrompt(change);
    } else {
      toast.dismiss(STALE_TAB_RELOAD_TOAST_ID);
    }
  });
  return () => {
    unsubscribe();
    stopRefusal();
  };
}
