
import Link from '@tiptap/extension-link';
import { SAFE_URL_SCHEMES } from '../markdown/safe-url.ts';

const ALLOWED_LINK_SCHEMES: ReadonlySet<string> = new Set(SAFE_URL_SCHEMES.map((s) => `${s}:`));

const PLACEHOLDER_BASE = 'https://placeholder.invalid';

function isAllowedLinkUri(url: string): boolean {
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
      sourceForm: { default: null, rendered: false },
      target: { default: null, rendered: false },
      anchor: { default: null, rendered: false },
      alias: { default: null, rendered: false },
      sourceUrlForm: { default: null, rendered: false },
      sourceTitleMarker: { default: null, rendered: false },
    };
  },
});
