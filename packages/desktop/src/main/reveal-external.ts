/**
 * Handler for `ok:shell:reveal-external` — reveal an ABSOLUTE path that lives
 * outside the caller window's project, the terminal's "this file is outside
 * your project" clickable-link flow.
 *
 * This is the one sanctioned UNCONTAINED reveal: unlike `ok:shell:reveal-asset`
 * (project-contained via `isPathWithinProject`), the whole point here is to
 * reveal a path the project boundary would reject. The security control is a
 * native confirmation dialog — main stats the path and, only if it exists, pops
 * a dialog naming it; `shell.showItemInFolder` fires solely on confirm. A
 * compromised renderer can therefore at most surface a dialog the user must
 * dismiss, never silently steer the file manager at arbitrary locations.
 *
 * Pure/deps-injected so the stat → confirm → reveal contract is unit-testable
 * without an Electron runtime.
 */

import { isAbsolute } from 'node:path';

export type RevealExternalResult =
  | { ok: true; outcome: 'revealed' | 'dismissed' }
  | { ok: false; reason: 'not-found' | 'invalid-path' | 'error' };

export interface RevealExternalDeps {
  /** Probe the absolute path: exists (any node type) / missing / unreadable. */
  readonly probe: (absPath: string) => 'exists' | 'missing' | 'unreadable';
  /** Show the confirmation dialog; resolves true iff the user chose to reveal. */
  readonly confirmReveal: (absPath: string) => Promise<boolean>;
  /** Reveal the path in the OS file manager (`shell.showItemInFolder`). */
  readonly showItemInFolder: (absPath: string) => void;
}

export async function handleRevealExternal(
  absPath: unknown,
  deps: RevealExternalDeps,
): Promise<RevealExternalResult> {
  // Absolute, non-empty, and free of C0 control chars — reject anything else
  // before touching disk. NUL is malformed; other controls (newline/CR/tab)
  // would inject extra lines into the confirmation dialog's interpolated path.
  // Codepoint scan (not a regex) so there's no control-char-in-regex to placate.
  if (typeof absPath !== 'string' || absPath.length === 0) {
    return { ok: false, reason: 'invalid-path' };
  }
  if (Array.from(absPath).some((ch) => ch.charCodeAt(0) < 0x20)) {
    return { ok: false, reason: 'invalid-path' };
  }
  if (!isAbsolute(absPath)) return { ok: false, reason: 'invalid-path' };

  const probed = deps.probe(absPath);
  if (probed === 'missing') return { ok: false, reason: 'not-found' };
  if (probed === 'unreadable') return { ok: false, reason: 'error' };

  const confirmed = await deps.confirmReveal(absPath);
  if (!confirmed) return { ok: true, outcome: 'dismissed' };

  deps.showItemInFolder(absPath);
  return { ok: true, outcome: 'revealed' };
}
