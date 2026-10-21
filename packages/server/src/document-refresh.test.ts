import { CONFIG_DOC_NAMES } from '@inkeep/open-knowledge-core';
import { describe, expect, test, vi } from 'vitest';
import { SYSTEM_DOC_NAME } from './cc1-broadcast.ts';
import {
  createReconnectRefreshExtension,
  type RefreshDocumentsFromDisk,
} from './document-refresh.ts';
import { createManualClock } from './watcher-clock.test-helper.ts';

type HookPayload = { documentName: string };

function extensionWith(refresh: RefreshDocumentsFromDisk) {
  const clock = createManualClock(1_000_000);
  const extension = createReconnectRefreshExtension({ clock, refresh });
  const hooks = extension as unknown as {
    afterLoadDocument(payload: HookPayload): Promise<void>;
    connected(payload: HookPayload): Promise<void>;
  };
  return { clock, hooks };
}

describe('re-read on reconnect', () => {
  test('a connection more than a second after the last read re-reads that document', async () => {
    const refresh = vi.fn<RefreshDocumentsFromDisk>(async () => ({ checked: 1, found: 0 }));
    const { clock, hooks } = extensionWith(refresh);

    await hooks.afterLoadDocument({ documentName: 'notes' });
    await hooks.connected({ documentName: 'notes' });
    expect(refresh).not.toHaveBeenCalled();

    clock.advance(1_000);
    await hooks.connected({ documentName: 'notes' });
    expect(refresh).toHaveBeenCalledWith(['notes'], 'reconnect');

    await hooks.connected({ documentName: 'notes' });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('the system document and config documents are never re-read', async () => {
    const refresh = vi.fn<RefreshDocumentsFromDisk>(async () => ({ checked: 0, found: 0 }));
    const { clock, hooks } = extensionWith(refresh);
    const reserved = [SYSTEM_DOC_NAME, ...CONFIG_DOC_NAMES];

    for (const documentName of reserved) await hooks.afterLoadDocument({ documentName });
    clock.advance(5_000);
    for (const documentName of reserved) await hooks.connected({ documentName });

    expect(reserved.length).toBeGreaterThan(1);
    expect(refresh).not.toHaveBeenCalled();
  });
});
