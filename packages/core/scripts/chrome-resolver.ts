import { readFileSync } from 'node:fs';
import { converter, formatHex, parse as parseColor } from 'culori';

export interface ChromeTokens {
  light: string;
  lightSidebar: string;
  dark: string;
  darkSidebar: string;
  darkCanvas: string;
}

/**
 * Find every top-level block matching the given selector exactly (e.g.
 * `:root` matches `:root {` but not `:root .foo {`; `.dark` matches `.dark {`
 * but not `.dark .activity-panel-diff {`). Returns each block's inner body.
 *
 * Exported so the preview-theme-token resolver can reuse the same exact-match
 * block scanner (it parses the identical `:root` / `.dark` / `@theme` blocks).
 */
export function findBlockBodies(css: string, selector: string): string[] {
  // Standard MDN escape — every regex metacharacter (including `.`, `]`,
  // and `\`) is escaped exactly once with one backslash so `.dark` becomes
  // `\.dark` in the compiled pattern. The character class closes after
  // `\\` (one literal backslash) and the replacement `\\$&` produces a
  // single backslash in front of the matched metacharacter.
  const selectorRe = new RegExp(
    `(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`,
    'g',
  );
  const bodies: string[] = [];
  let match: RegExpExecArray | null = selectorRe.exec(css);
  while (match !== null) {
    const braceOpen = match.index + match[0].length - 1;
    let depth = 1;
    let cursor = braceOpen + 1;
    while (cursor < css.length && depth > 0) {
      const ch = css[cursor];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      if (depth === 0) {
        bodies.push(css.slice(braceOpen + 1, cursor));
        break;
      }
      cursor += 1;
    }
    if (depth !== 0) {
      throw new Error(`chrome-resolver: unbalanced braces while scanning ${selector}`);
    }
    match = selectorRe.exec(css);
  }
  return bodies;
}

function extractTokenValue(css: string, selector: string, token: string): string {
  const bodies = findBlockBodies(css, selector);
  const declaration = new RegExp(`--${token}:\\s*([^;]+);`);
  for (const body of bodies) {
    const decl = body.match(declaration);
    if (decl && decl[1] !== undefined) {
      return decl[1].trim();
    }
  }
  throw new Error(`chrome-resolver: --${token} declaration not found in any ${selector} block`);
}

function resolveToHex(cssColor: string, label: string): string {
  const parsed = parseColor(cssColor);
  if (parsed === undefined) {
    throw new Error(`chrome-resolver: culori failed to parse ${label} value: ${cssColor}`);
  }
  const hex = formatHex(parsed);
  if (hex === undefined) {
    throw new Error(`chrome-resolver: culori failed to convert ${label} to sRGB hex: ${cssColor}`);
  }
  return hex;
}

const SIDEBAR_LIGHTNESS_OFFSET = /^oklch\(from var\(--sidebar\) calc\(l - (\d*\.?\d+)\) c h\)$/;

const toOklch = converter('oklch');

function resolveSidebarOffsetToHex(
  offsetValue: string,
  sidebarValue: string,
  label: string,
): string {
  const offset = offsetValue.match(SIDEBAR_LIGHTNESS_OFFSET)?.[1];
  if (offset === undefined) {
    throw new Error(
      `chrome-resolver: ${label} must be oklch(from var(--sidebar) calc(l - <n>) c h), got: ${offsetValue}`,
    );
  }
  const sidebar = parseColor(sidebarValue);
  if (sidebar === undefined) {
    throw new Error(
      `chrome-resolver: culori failed to parse ${label} base --sidebar: ${sidebarValue}`,
    );
  }
  const base = toOklch(sidebar);
  const hex = formatHex({ ...base, l: base.l - Number(offset) });
  if (hex === undefined) {
    throw new Error(
      `chrome-resolver: culori failed to convert ${label} to sRGB hex: ${offsetValue}`,
    );
  }
  return hex;
}

export function resolveChromeTokensFromCss(cssPath: string): ChromeTokens {
  const css = readFileSync(cssPath, 'utf8');
  const lightSidebarValue = extractTokenValue(css, ':root', 'sidebar');
  const lightDeskValue = extractTokenValue(css, ':root', 'desk');
  const darkValue = extractTokenValue(css, 'html.dark:not([data-color-theme])', 'desk');
  const darkSidebarValue = extractTokenValue(css, '.dark', 'sidebar');
  const darkCanvasValue = extractTokenValue(css, '.dark', 'background');
  return {
    light: resolveSidebarOffsetToHex(lightDeskValue, lightSidebarValue, 'light :root --desk'),
    lightSidebar: resolveToHex(lightSidebarValue, 'light sidebar'),
    dark: resolveToHex(darkValue, 'dark'),
    darkSidebar: resolveToHex(darkSidebarValue, 'dark sidebar'),
    darkCanvas: resolveToHex(darkCanvasValue, 'dark canvas'),
  };
}

export function renderChromeConstantsModule(tokens: ChromeTokens): string {
  return `export const CHROME_BG_LIGHT = '${tokens.light}' as const;
export const CHROME_BG_DARK = '${tokens.dark}' as const;
export const SIDEBAR_BG_LIGHT = '${tokens.lightSidebar}' as const;
export const SIDEBAR_BG_DARK = '${tokens.darkSidebar}' as const;
export const CANVAS_BG_DARK = '${tokens.darkCanvas}' as const;

const ROOT_FONT_SIZE_PX = 16;

export const APP_HEADER_HEIGHT_PX = 44;

export const APP_HEADER_HEIGHT = \`\${APP_HEADER_HEIGHT_PX / ROOT_FONT_SIZE_PX}rem\`;

export const REDUCED_CHROME_HEADER_HEIGHT_PX = 48;

export const REDUCED_CHROME_HEADER_HEIGHT = \`\${REDUCED_CHROME_HEADER_HEIGHT_PX / ROOT_FONT_SIZE_PX}rem\`;
`;
}
