/**
 * `OkDesktopBridge` duplication — structural-equivalence gate.
 *
 * The bridge interface lives in three separate packages by design
 * (core → canonical, desktop/src/shared → runtime consumer, app/src/lib →
 * renderer consumer). The sibling `m1-smoke.test.ts` asserts the three
 * files declare the same top-level member NAMES. This test is the
 * signature-equality complement — two copies with the same members but
 * divergent argument/return types (e.g. `openFolder(): Promise<string>`
 * vs `Promise<string | null>`) pass the name check but slip through as
 * runtime "null where string was expected" failures.
 *
 * Implementation: `Eq<X, Y>` is the classic TypeScript "types are
 * mutually assignable" pair, using a dependent-variance trick on a
 * generic function type. If the shapes diverge, the constant
 * assignments `const _coreEqDesktop: Eq<Core, Desktop> = true` produce
 * compile errors at the literal `true` (type narrows to `false`). This
 * failure mode works at PR time via `turbo run typecheck`, not just
 * when someone happens to run the bun test.
 *
 * Test-file scope: cross-package imports are permissible here because
 * test files are not shipped in the production bundle.
 */

import { describe, expect, test } from 'vitest';
import type {
  OkDesktopBridge as AppBridge,
  OkMenuDispatchRequest as AppMenuDispatchRequest,
  OkMenuRendererSnapshot as AppMenuRendererSnapshot,
} from '../../../app/src/lib/desktop-bridge-types.ts';
import type {
  OkDesktopBridge as CoreBridge,
  OkMenuDispatchRequest as CoreMenuDispatchRequest,
  OkMenuRendererSnapshot as CoreMenuRendererSnapshot,
  OkEditorViewMenuStateSnapshot as CoreViewMenuState,
} from '../../../core/src/desktop-bridge.ts';
import type {
  OkMenuDispatchRequest as BridgeMenuDispatchRequest,
  OkMenuRendererSnapshot as BridgeMenuRendererSnapshot,
  OkEditorViewMenuStateSnapshot as BridgeViewMenuState,
  OkDesktopBridge as DesktopBridge,
} from '../../src/shared/bridge-contract.ts';
import type {
  MenuDispatchRequest as IpcMenuDispatchRequest,
  MenuRendererSnapshot as IpcMenuRendererSnapshot,
  EditorViewMenuStateSnapshot as IpcViewMenuState,
} from '../../src/shared/ipc-channels.ts';

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

describe('MenuDispatchRequest / MenuRendererSnapshot 4-way structural equivalence', () => {
  // Same lockstep contract as EditorViewMenuStateSnapshot above: the
  // ipc-channels copy is reached only through the channel-args layer, so a
  // field added to the bridge copies but dropped there assigns silently
  // (superset → subset) and main never sees it. The `role`/`command` unions
  // are covered transitively — they are members of the request union.
  test('core ≡ bridge-contract ≡ app (OkMenuDispatchRequest)', () => {
    const _coreBridge: Eq<CoreMenuDispatchRequest, BridgeMenuDispatchRequest> = true;
    const _coreApp: Eq<CoreMenuDispatchRequest, AppMenuDispatchRequest> = true;
    expect(_coreBridge).toBe(true);
    expect(_coreApp).toBe(true);
  });

  test('core ≡ ipc-channels (MenuDispatchRequest)', () => {
    const _eq: Eq<CoreMenuDispatchRequest, IpcMenuDispatchRequest> = true;
    expect(_eq).toBe(true);
  });

  test('core ≡ bridge-contract ≡ app (OkMenuRendererSnapshot)', () => {
    const _coreBridge: Eq<CoreMenuRendererSnapshot, BridgeMenuRendererSnapshot> = true;
    const _coreApp: Eq<CoreMenuRendererSnapshot, AppMenuRendererSnapshot> = true;
    expect(_coreBridge).toBe(true);
    expect(_coreApp).toBe(true);
  });

  test('core ≡ ipc-channels (MenuRendererSnapshot)', () => {
    const _eq: Eq<CoreMenuRendererSnapshot, IpcMenuRendererSnapshot> = true;
    expect(_eq).toBe(true);
  });
});
