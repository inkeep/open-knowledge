import { describe, expect, test } from 'bun:test';
import type { OkDesktopBridge as AppBridge } from '../../../app/src/lib/desktop-bridge-types.ts';
import type {
  OkDesktopBridge as CoreBridge,
  OkEditorViewMenuStateSnapshot as CoreViewMenuState,
} from '../../../core/src/desktop-bridge.ts';
import type {
  OkEditorViewMenuStateSnapshot as BridgeViewMenuState,
  OkDesktopBridge as DesktopBridge,
} from '../../src/shared/bridge-contract.ts';
import type { EditorViewMenuStateSnapshot as IpcViewMenuState } from '../../src/shared/ipc-channels.ts';

type Eq<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

describe('OkDesktopBridge structural equivalence (F19)', () => {
  test('core ≡ desktop (method signatures)', () => {
    const _coreEqDesktop: Eq<CoreBridge, DesktopBridge> = true;
    expect(_coreEqDesktop).toBe(true);
  });

  test('core ≡ app (method signatures)', () => {
    const _coreEqApp: Eq<CoreBridge, AppBridge> = true;
    expect(_coreEqApp).toBe(true);
  });

  test('desktop ≡ app (method signatures)', () => {
    const _desktopEqApp: Eq<DesktopBridge, AppBridge> = true;
    expect(_desktopEqApp).toBe(true);
  });
});

describe('EditorViewMenuStateSnapshot 4-way structural equivalence', () => {
  test('core ≡ bridge-contract (OkEditorViewMenuStateSnapshot)', () => {
    const _eq: Eq<CoreViewMenuState, BridgeViewMenuState> = true;
    expect(_eq).toBe(true);
  });

  test('core ≡ ipc-channels (EditorViewMenuStateSnapshot)', () => {
    const _eq: Eq<CoreViewMenuState, IpcViewMenuState> = true;
    expect(_eq).toBe(true);
  });
});
