import { posix as pathPosix } from 'node:path';

export const HELPER_BUNDLE_NAME = 'OpenKnowledge Server.app';
export const HELPER_EXECUTABLE_NAME = 'OpenKnowledge Helper';

export function resolveHelperBundleBinary(parentExecPath: string): string {
  return pathPosix.join(
    pathPosix.dirname(parentExecPath),
    '..',
    'Frameworks',
    HELPER_BUNDLE_NAME,
    'Contents',
    'MacOS',
    HELPER_EXECUTABLE_NAME,
  );
}
