type OkDesktopClipboard = { writeText: (text: string) => Promise<void> };

interface OkDesktopHost {
  okDesktop?: { clipboard?: OkDesktopClipboard };
}

interface NavClipboardHost {
  navigator?: {
    clipboard?: { writeText?: (text: string) => Promise<void> };
  };
}

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
  scratch.style.position = 'fixed';
  scratch.style.opacity = '0';
  scratch.style.pointerEvents = 'none';
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
      throw error;
    }
  }

  if (tryExecCommandCopy(text)) return;
  throw new Error('clipboard API unavailable');
}
