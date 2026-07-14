/**
 * Browser-safe data contracts for SSH-backed desktop projects.
 *
 * Authentication remains entirely in the desktop main process and the
 * system OpenSSH client. These records intentionally contain no passwords,
 * private keys, tokens, or arbitrary SSH arguments.
 */

/** A saved SSH destination, usually a `Host` alias from `~/.ssh/config`. */
export interface SshMachine {
  /** Stable opaque identifier used to scope project/window identity. */
  id: string;
  /** User-facing label, for example "Build box". */
  name: string;
  /** OpenSSH destination or config alias, for example `dev@example.com`. */
  host: string;
  /** Optional SSH port override. Omitted means OpenSSH config/defaults win. */
  port?: number;
}

/** Renderer-to-main input used when creating or editing a saved machine. */
export interface SshMachineDraft {
  id?: string;
  name: string;
  host: string;
  port?: number;
}

/**
 * Whether a renderer-supplied OpenSSH destination stays safe when ssh_config
 * expands `%h`/`%n` inside shell-backed directives such as ProxyCommand or
 * Match exec. IPv6 literals should use a safe Host alias instead.
 */
export function isSafeSshDestination(value: string): boolean {
  return /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(value);
}

/** A folder returned by the remote folder browser. */
export interface RemoteDirectoryEntry {
  name: string;
  path: string;
}

/** Canonical remote directory listing returned by desktop main. */
export interface RemoteDirectoryListing {
  path: string;
  parentPath: string | null;
  directories: RemoteDirectoryEntry[];
}

/** Remote project metadata frozen into an SSH-backed editor window. */
export interface RemoteProjectInfo {
  kind: 'ssh';
  machineId: string;
  machineName: string;
  /** Canonical path on the remote host. */
  path: string;
  /** Supported POSIX remote runtime, not the local desktop platform. */
  platform: 'darwin' | 'linux';
  /** Remote projects are supported only on POSIX hosts. */
  pathSeparator: '/';
}

/** Renderer-safe connection-test result. Raw SSH output never crosses IPC. */
export type SshConnectionTestResult = { ok: true } | { ok: false; error: string };

/**
 * Build a machine-scoped identity for an SSH project.
 *
 * The returned string is an opaque desktop key, not a navigable URL. Encoding
 * both components prevents two hosts with the same filesystem path from
 * colliding in recents, sessions, or the one-window-per-project map.
 */
export function remoteProjectKey(machineId: string, remotePath: string): string {
  return `ssh:${encodeURIComponent(machineId)}:${encodeURIComponent(remotePath)}`;
}

export function isRemoteProjectKey(value: string): boolean {
  if (!value.startsWith('ssh:')) return false;
  const separator = value.indexOf(':', 4);
  if (separator <= 4 || separator === value.length - 1) return false;
  try {
    return (
      decodeURIComponent(value.slice(4, separator)).length > 0 &&
      decodeURIComponent(value.slice(separator + 1)).length > 0
    );
  } catch {
    return false;
  }
}
