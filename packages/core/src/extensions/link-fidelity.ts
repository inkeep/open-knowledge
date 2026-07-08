/**
 * Link mark override for source-text fidelity.
 *
 * Extends @tiptap/extension-link and adds fidelity attributes for link
 * style (inline, full, collapsed, shortcut) and reference label. LinkFidelity
 * itself inherits the stock link plugins (autolink, linkOnPaste, click
 * handling), but the app-side `InternalLink` subclass overrides
 * `addProseMirrorPlugins` to drop them in favour of OK's own linkify/paste/
 * click surfaces — so in the app those stock plugins are not active.
 *
 * Markdown parsing/serialization is handled by the unified pipeline (packages/core/src/markdown/).
 */

import Link from '@tiptap/extension-link';
import { SAFE_URL_SCHEMES } from '../markdown/safe-url.ts';

const ALLOWED_LINK_SCHEMES: ReadonlySet<string> = new Set(SAFE_URL_SCHEMES.map((s) => `${s}:`));

const PLACEHOLDER_BASE = 'https://placeholder.invalid';

/**
 * Known `linkStyle` values. The producer side (e.g. the app's typed-autolink
 * plugin) and the PM→mdast serializer branch on these string literals; typing
 * both against this union turns a drifted value (rename/typo) into a compile
 * error instead of a silently mis-serialized link.
 */
export type LinkStyle = 'inline' | 'full' | 'collapsed' | 'shortcut' | 'autolink' | 'gfm-autolink';

/**
 * Allowlist gate for link-mark creation paths: TipTap's autolinker /
 * linkOnPaste / setLink inputs and the app clipboard dispatcher's lone-URL
 * paste classifier. Bare relative URLs (e.g. `/foo`, `./bar`, `#hash`)
 * parse against `PLACEHOLDER_BASE` and inherit `https:`, so they pass
 * without a special case. Storage-layer mdast→PM (`MarkdownManager`)
 * intentionally bypasses this hook — see AGENTS.md "Storage never
 * sanitizes; render-time layers do." Render-time defenses
 * (`rehypeSanitizeUrls`, `isSafeNavigationUrl`, `sanitizeComponentProps`)
 * cover egress.
 */
export function isAllowedLinkUri(url: string): boolean {
  try {
    const parsed = new URL(url, PLACEHOLDER_BASE);
    return ALLOWED_LINK_SCHEMES.has(parsed.protocol.toLowerCase());
  } catch {
    return false;
  }
}

export const LinkFidelity = Link.extend({
  priority: 60,

  addOptions() {
    return {
      openOnClick: false,
      enableClickSelection: false,
      linkOnPaste: true,
      autolink: true,
      protocols: [] as string[],
      defaultProtocol: 'http',
      HTMLAttributes: {
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      isAllowedUri: isAllowedLinkUri,
      validate: isAllowedLinkUri,
      shouldAutoLink: () => true,
    };
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      linkStyle: { default: 'inline', rendered: false },
      refLabel: { default: null, rendered: false },
      // When handlers.wikiLinkEmbed dispatches a non-image wiki-embed to a
      // link-marked text, it tags the mark with `sourceForm='wikiembed'` +
      // preserves `target`/`anchor`/`alias` separately from the resolved
      // `href`. markHandlers.link reads the tag to round-trip back to
      // mdast wikiLinkEmbed. All four default null and `rendered: false`
      // so plain markdown links round-trip unchanged.
      sourceForm: { default: null, rendered: false },
      target: { default: null, rendered: false },
      anchor: { default: null, rendered: false },
      alias: { default: null, rendered: false },
      // Inline-link source-form fidelity. `sourceUrlForm` captures
      // `[text](<url>)` vs `[text](url)`; `sourceTitleMarker` captures
      // `'`/`"`/`(` quote style for the title. Default null means default
      // emission (literal URL form, double-quote title).
      sourceUrlForm: { default: null, rendered: false },
      sourceTitleMarker: { default: null, rendered: false },
    };
  },
});
