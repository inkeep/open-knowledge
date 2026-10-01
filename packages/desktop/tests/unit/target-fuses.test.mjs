import { FuseState, FuseV1Options } from '@electron/fuses';
import { describe, expect, test } from 'vitest';
import { expectedFuseState, targetFuses } from '../../scripts/target-fuses.mjs';

describe('packaged fuse targets', () => {
  test('keep file protocol privileges on, so the packaged renderer reaches the local API without an opaque Origin', () => {
    expect(targetFuses[FuseV1Options.GrantFileProtocolExtraPrivileges]).toBe(true);
    expect(expectedFuseState(targetFuses[FuseV1Options.GrantFileProtocolExtraPrivileges])).toBe(
      FuseState.ENABLE,
    );
  });
});
