import Link from '@tiptap/extension-link';
import { SAFE_URL_SCHEMES } from '../markdown/safe-url.ts';

const ALLOWED_LINK_SCHEMES: ReadonlySet<string> = new Set(SAFE_URL_SCHEMES.map((s) => `${s}:`));

const PLACEHOLDER_BASE = 'https://placeholder.invalid';

export type LinkStyle = 'inline' | 'full' | 'collapsed' | 'shortcut' | 'autolink' | 'gfm-autolink';

export function isAllowedLinkUri(url: string): boolean {
  try {
    const parsed = new URL(url, PLACEHOLDER_BASE);
    return ALLOWED_LINK_SCHEMES.has(parsed.protocol.toLowerCase());
  } catch {
    return false;
  }
}

const DERIVATION_ERROR = 'LinkFidelity must be derived from the Link extension';

export const LinkFidelity = Link.extend({
  priority: 60,

  addOptions() {
    const inherited = this.parent?.();
    if (inherited === undefined) {
      throw new Error(DERIVATION_ERROR);
    }
    return {
      ...inherited,
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
      shouldAutoLink: () => true,
    };
  },

  addAttributes() {
    const inherited = this.parent?.();
    if (inherited === undefined) {
      throw new Error(DERIVATION_ERROR);
    }
    return {
      ...inherited,
      linkStyle: { default: 'inline', rendered: false },
      refLabel: { default: null, rendered: false },
      sourceForm: { default: null, rendered: false },
      target: { default: null, rendered: false },
      anchor: { default: null, rendered: false },
      alias: { default: null, rendered: false },
      sourceUrlForm: { default: null, rendered: false },
      sourceTitleMarker: { default: null, rendered: false },
    };
  },
});
