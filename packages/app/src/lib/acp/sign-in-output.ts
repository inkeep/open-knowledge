/**
 * Reads the stderr an agent prints while signing in and pulls out the two
 * things a device-code flow asks the user to act on: the code the browser wants
 * confirmed, and the URL to confirm it at.
 *
 * Agents have no structured channel for this — the sign-in happens before any
 * session exists — so prose is all there is. Everything here is therefore a
 * guess that must fail safe: anything unrecognized is handed back verbatim in
 * `lines`, so a flow shaped differently still shows the user what it said.
 */

/** `[acp/auth] `, `[auth] ` — a logging tag, not something the user needs. */
const LEADING_TAG = /^\[[^\]]{1,32}\]\s*/;
const URL_IN_LINE = /\bhttps?:\/\/\S+/;
/**
 * RFC 8628 user codes are short, case-insensitive, and usually grouped with a
 * dash (`WDJB-MJHT`, `CRQT-NXNT`). Requiring the dash and upper case is what
 * keeps ordinary words out; a flow that formats its code differently falls
 * through to the raw lines rather than being mangled.
 */
const DEVICE_CODE = /\b[A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8})+\b/;

export interface ParsedSignInOutput {
  /** The code the user has to match against their browser, if one was found. */
  code?: string;
  /** Where to complete the sign-in, if a URL was printed. */
  url?: string;
  /** Whatever is left, tag-stripped — empty when everything was recognized. */
  lines: string[];
}

/** Strip the query string and scheme: `authkit.cline.bot/device` reads as a
 *  place, where the full URL with an embedded code reads as noise. */
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
      // A code carried in the URL beats one scraped from prose: it is the
      // value the server issued, not a lookalike in a sentence.
      const fromUrl = new URLSearchParams(url.split('?')[1] ?? '').get('user_code');
      if (fromUrl !== null && fromUrl !== '') code = fromUrl;
    }

    if (code === undefined) {
      const codeMatch = line.match(DEVICE_CODE);
      if (codeMatch !== null) code = codeMatch[0];
    }

    // A line that only announced the code or the URL is now represented by
    // them; keeping it would say the same thing twice.
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
