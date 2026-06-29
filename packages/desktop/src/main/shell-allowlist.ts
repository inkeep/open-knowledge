
export const ALLOWED_SCHEMES: ReadonlySet<string> = new Set([
  'https:',
  'http:',
  'mailto:',
  'openknowledge:',

  'claude:',

  'codex:',

  'cursor:',
]);

interface AllowlistResult {
  ok: boolean;
  reason?: string;
}

export function checkOutboundUrl(url: string): AllowlistResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { ok: false, reason: `scheme-not-allowed: ${parsed.protocol}` };
  }
  return { ok: true };
}

export function handleShellOpenExternal(deps: {
  openExternal: (url: string) => Promise<void>;
}): (url: string) => Promise<void> {
  return async (url: string) => {
    const check = checkOutboundUrl(url);
    if (!check.ok) {
      throw new Error(`shell.openExternal blocked: ${check.reason}`);
    }
    await deps.openExternal(url);
  };
}
