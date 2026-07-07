/**
 * Single-responsibility clipboard write that prefers the Electron IPC
 * bridge when available.
 *
 *   1. `window.okDesktop.clipboard.writeText` — Electron renderer's preload
 *      bridge to the main process. The main-process clipboard call is NOT
 *      gated on the renderer's transient user activation, so this path is
 *      unconditionally reliable in the desktop app (which is OK's primary
 *      deployment context).
 *   2. `navigator.clipboard.writeText` — browser path. Requires the
 *      caller to be inside a fresh user-gesture handler (the browser
 *      Clipboard API gates the write on transient activation at call time).
 *   3. `document.execCommand('copy')` — legacy fallback when the async API
 *      is absent or rejects. The async API is additionally gated on the
 *      `clipboard-write` Permissions-Policy, which embedding hosts (e.g.
 *      the Claude preview iframe) commonly deny; execCommand is gated on
 *      user activation only, and transient activation survives the
 *      rejection microtask — so this still fires inside the original
 *      gesture and succeeds where writeText is policy-blocked.
 *
 * Callers MUST invoke this from a fresh user-gesture handler. In the share
 * flow the Share button's onClick and the Publish-to-GitHub dialog's
 * "Copy share link" button onClick both satisfy that contract; the dialog's
 * Publish submit handler intentionally does NOT auto-copy because the
 * multi-second publish would consume that activation before the write
 * could fire.
 */

type OkDesktopClipboard = { writeText: (text: string) => Promise<void> };

interface OkDesktopHost {
  okDesktop?: { clipboard?: OkDesktopClipboard };
}

interface NavClipboardHost {
  navigator?: {
    clipboard?: { writeText?: (text: string) => Promise<void> };
  };
}

/**
 * Heuristically detect that a rejected clipboard write was refused by the
 * surrounding Permissions-Policy (e.g. an iframe whose parent's `allow=`
 * attribute does not include `clipboard-write`). Browsers don't expose a
 * dedicated error subclass for this — they throw a generic NotAllowedError
 * whose wording varies: Chromium's iframe policy block says "blocked
 * because of a permissions policy"; the permission-denied variant says
 * "permission denied". Callers pair this with a top-frame check
 * (`window.self !== window.top`) before assuming the iframe story.
 */
export function isPermissionsPolicyRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name !== 'NotAllowedError') return false;
  return /permission denied|permissions policy/i.test(error.message);
}

interface ScratchTextArea {
  value: string;
  style: { position: string; opacity: string; pointerEvents: string };
  setAttribute(name: string, value: string): void;
  focus(): void;
  select(): void;
  remove(): void;
}

interface DocumentHost {
  document?: {
    body?: { appendChild(el: ScratchTextArea): void };
    createElement(tag: 'textarea'): ScratchTextArea;
    execCommand(command: 'copy'): boolean;
  };
}

function tryExecCommandCopy(text: string): boolean {
  const doc = (globalThis as DocumentHost).document;
  if (
    !doc?.body ||
    typeof doc.createElement !== 'function' ||
    typeof doc.execCommand !== 'function'
  ) {
    return false;
  }
  const scratch = doc.createElement('textarea');
  scratch.value = text;
  // Off-viewport but rendered — `display:none` breaks selection in Chromium.
  scratch.style.position = 'fixed';
  scratch.style.opacity = '0';
  scratch.style.pointerEvents = 'none';
  // Readonly prevents the mobile keyboard flash and IME interference.
  scratch.setAttribute('readonly', '');
  doc.body.appendChild(scratch);
  try {
    scratch.focus();
    scratch.select();
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    scratch.remove();
  }
}

export async function scheduleClipboardWrite(text: string): Promise<void> {
  const okClipboard = (globalThis as OkDesktopHost).okDesktop?.clipboard;
  if (okClipboard && typeof okClipboard.writeText === 'function') {
    await okClipboard.writeText(text);
    return;
  }

  const navClipboard = (globalThis as NavClipboardHost).navigator?.clipboard;
  if (navClipboard && typeof navClipboard.writeText === 'function') {
    try {
      await navClipboard.writeText(text);
      return;
    } catch (error) {
      if (tryExecCommandCopy(text)) return;
      // Rethrow the writeText rejection (not an execCommand artifact) so
      // callers' isPermissionsPolicyRefusal classification still works.
      throw error;
    }
  }

  if (tryExecCommandCopy(text)) return;
  throw new Error('clipboard API unavailable');
}
