export type ConfigFileDeclineReason =
  | 'permission-denied'
  | 'missing-symlink-target'
  | 'unresolved-symlink'
  | 'not-a-file'
  | 'disappeared'
  | 'unreadable';

export function configFileDeclineReason(
  error: unknown,
): Exclude<ConfigFileDeclineReason, 'missing-symlink-target'> {
  const code = (error as NodeJS.ErrnoException)?.code;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'permission-denied';
    case 'ELOOP':
      return 'unresolved-symlink';
    case 'EISDIR':
    case 'ENOTDIR':
      return 'not-a-file';
    case 'ENOENT':
      return 'disappeared';
    default:
      return 'unreadable';
  }
}

export function configFileDeclineDetail(reason: ConfigFileDeclineReason): string {
  switch (reason) {
    case 'permission-denied':
      return 'permission denied; check file and parent-directory permissions, then retry';
    case 'missing-symlink-target':
      return 'the symlink target is missing; restore the target or correct the symlink, then retry';
    case 'unresolved-symlink':
      return 'the path or symlink could not be resolved; check path permissions and repair any symlink cycle, then retry';
    case 'not-a-file':
      return 'the path is not a regular file; restore the intended configuration file, then retry';
    case 'disappeared':
      return 'the file disappeared; retry to check its current state';
    case 'unreadable':
      return 'the file could not be read; check that the path is accessible, then retry';
    default: {
      const exhaustive: never = reason;
      throw new Error(`unhandled configuration file decline reason: ${exhaustive}`);
    }
  }
}
