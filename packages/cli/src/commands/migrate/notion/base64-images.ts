/**
 * Extract inline base64 `data:` images to real files.
 *
 * Notion sometimes exports images inline as base64 `data:` URIs, and as
 * empty-text links (`[](data:image/png;base64,...)`) rather than image embeds —
 * so they neither render nor round-trip, and they bloat the file (a single line
 * can be ~180 KB). We decode each blob to a sibling image file and rewrite the
 * reference as an image embed `![](file)`. With `strip`, the blob is removed
 * instead. Pure: returns a plan (rewritten markdown + assets to write); the
 * driver performs the writes. Idempotent — no `data:` blobs remain afterward.
 */

export interface Base64Result {
  markdown: string;
  /** Extracted image files; `filename` is relative to the page's directory. */
  assets: Array<{ filename: string; bytes: Uint8Array }>;
}

const DATA_IMAGE = /(!?)\[([^\]]*)\]\(data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+?)\)/gi;

const EXT_BY_SUBTYPE: Record<string, string> = {
  png: 'png',
  jpeg: 'jpg',
  jpg: 'jpg',
  gif: 'gif',
  webp: 'webp',
  'svg+xml': 'svg',
};

function slugify(name: string): string {
  return (
    name
      .replace(/\.(md|mdx)$/i, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'inline'
  );
}

/**
 * @param markdown page contents
 * @param pageName the page's filename (used to derive deterministic asset names)
 * @param opts.strip when true, delete the blob instead of extracting it
 */
export function extractBase64Images(
  markdown: string,
  pageName: string,
  opts: { strip?: boolean } = {},
): Base64Result {
  const assets: Base64Result['assets'] = [];
  const slug = slugify(pageName);
  let n = 0;

  const out = markdown.replace(
    DATA_IMAGE,
    (_match, _bang, alt: string, subtype: string, payload: string) => {
      if (opts.strip) return '';
      n += 1;
      const ext =
        EXT_BY_SUBTYPE[subtype.toLowerCase()] ?? subtype.toLowerCase().replace(/[^a-z0-9]/g, '');
      const filename = `${slug}-inline-${n}.${ext}`;
      const bytes = new Uint8Array(Buffer.from(payload.replace(/\s+/g, ''), 'base64'));
      assets.push({ filename, bytes });
      return `![${alt}](${filename})`;
    },
  );

  return { markdown: out, assets };
}
