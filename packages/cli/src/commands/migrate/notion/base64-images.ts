export interface Base64Result {
  markdown: string;
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
