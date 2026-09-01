const LEADING_TAG = /^\[[^\]]{1,32}\]\s*/;
const URL_IN_LINE = /\bhttps?:\/\/\S+/;
const DEVICE_CODE = /\b[A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8})+\b/;

export interface ParsedSignInOutput {
  code?: string;
  url?: string;
  lines: string[];
}

export function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url;
  }
}

export function parseSignInOutput(raw: readonly string[]): ParsedSignInOutput {
  let code: string | undefined;
  let url: string | undefined;
  const lines: string[] = [];

  for (const rawLine of raw) {
    const line = rawLine.replace(LEADING_TAG, '').trim();
    if (line === '') continue;

    const urlMatch = line.match(URL_IN_LINE);
    if (url === undefined && urlMatch !== null) {
      url = urlMatch[0].replace(/[).,]+$/, '');
      const fromUrl = new URLSearchParams(url.split('?')[1] ?? '').get('user_code');
      if (fromUrl !== null && fromUrl !== '') code = fromUrl;
    }

    if (code === undefined) {
      const codeMatch = line.match(DEVICE_CODE);
      if (codeMatch !== null) code = codeMatch[0];
    }

    const isAboutCode = code !== undefined && line.includes(code);
    const isAboutUrl = url !== undefined && line.includes(url);
    if (!isAboutCode && !isAboutUrl) lines.push(line);
  }

  return {
    ...(code !== undefined ? { code } : {}),
    ...(url !== undefined ? { url } : {}),
    lines,
  };
}
