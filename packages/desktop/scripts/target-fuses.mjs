#!/usr/bin/env node
import { FuseState, FuseV1Options } from '@electron/fuses';

export const targetFuses = {
  [FuseV1Options.RunAsNode]: true,
  [FuseV1Options.EnableCookieEncryption]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: true,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
};

export function fuseStateName(state) {
  switch (state) {
    case FuseState.DISABLE:
      return 'DISABLE';
    case FuseState.ENABLE:
      return 'ENABLE';
    case FuseState.REMOVED:
      return 'REMOVED';
    case FuseState.INHERIT:
      return 'INHERIT';
    default:
      return `UNKNOWN(${state})`;
  }
}

export function expectedFuseState(expectedValue) {
  return expectedValue ? FuseState.ENABLE : FuseState.DISABLE;
}
