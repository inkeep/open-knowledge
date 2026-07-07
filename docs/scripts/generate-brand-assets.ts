import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { zipSync } from 'fflate';
import sharp from 'sharp';

// Regenerates the downloadable brand kit in public/brand/ from the two logo
// React components (the single source of truth for the mark's path data).
//
// Outputs, per asset: an SVG, a high-res transparent PNG, and one zip bundling
// everything for the "Download all" affordance on /brand. The mark keeps its
// built-in drop-shadow (the depth is part of the lockup, not an added effect),
// applied to the icon exactly as the components render it.
//
// The wordmark text renders as `currentColor` in the component; here it's
// baked to a concrete ink so the file reads correctly out of context: near-
// black for light backgrounds, pure white for dark ones. The icon is full
// colour and works on either background, so it ships as a single variant.
//
// Run whenever ok-wordmark.tsx / ok-icon.tsx change: bun run generate:brand-assets

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'public', 'brand');

const INK_LIGHT = '#1a1a1a'; // wordmark on light backgrounds
const INK_DARK = '#ffffff'; // wordmark on dark backgrounds

type SvgPath = { d: string; fill: string };

// Pull every self-closing <path d=".." fill=".."> out of a component source.
// Order-preserving; ignores the <filter> defs (no `d` attribute).
function extractPaths(src: string): SvgPath[] {
  const paths: SvgPath[] = [];
  for (const el of src.match(/<path\b[\s\S]*?\/>/g) ?? []) {
    const d = el.match(/\bd="([^"]+)"/)?.[1];
    const fill = el.match(/\bfill="([^"]+)"/)?.[1];
    if (d && fill) paths.push({ d, fill });
  }
  return paths;
}

const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const iconPaths = extractPaths(read('src/components/ok-icon.tsx'));
const wordmarkPath = extractPaths(read('src/components/ok-wordmark.tsx')).find(
  (p) => p.fill === 'currentColor',
);

if (iconPaths.length !== 4) {
  throw new Error(`Expected 4 icon paths, extracted ${iconPaths.length} — check ok-icon.tsx`);
}
if (!wordmarkPath) {
  throw new Error('Could not find the currentColor wordmark path in ok-wordmark.tsx');
}

// The icon's soft drop-shadow, transcribed to standard (kebab-case) SVG from
// the `ok-wordmark-shadow` filter the components declare in JSX. Applied to the
// icon group so the downloaded mark carries the same depth as the site lockup.
const SHADOW_FILTER = `  <defs>
    <filter id="ok-shadow" x="0" y="0" width="226.297" height="251.133" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"/>
      <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
      <feOffset dy="8.35549"/>
      <feGaussianBlur stdDeviation="6.26662"/>
      <feComposite in2="hardAlpha" operator="out"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.1 0"/>
      <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow"/>
      <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow" result="shape"/>
    </filter>
  </defs>`;

const iconGroup = (paths: SvgPath[]) =>
  `  <g filter="url(#ok-shadow)">\n${paths
    .map((p) => `    <path d="${p.d}" fill="${p.fill}"/>`)
    .join('\n')}\n  </g>`;

const svgDoc = (viewBox: string, width: number, height: number, body: string) =>
  `<svg width="${width}" height="${height}" viewBox="${viewBox}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img">
  <title>OpenKnowledge</title>
${body}
${SHADOW_FILTER}
</svg>
`;

// Full lockup: icon (0–226 in x) + wordmark text, sharing the component viewBox.
const logoSvg = (ink: string) =>
  svgDoc(
    '0 0 1307 252',
    1307,
    252,
    `${iconGroup(iconPaths)}\n  <path d="${wordmarkPath.d}" fill="${ink}"/>`,
  );

const iconSvg = svgDoc('0 0 227 252', 227, 252, iconGroup(iconPaths));

type Asset = { file: string; svg: string; pngWidth: number };
const assets: Asset[] = [
  { file: 'openknowledge-logo', svg: logoSvg(INK_LIGHT), pngWidth: 2400 },
  { file: 'openknowledge-logo-white', svg: logoSvg(INK_DARK), pngWidth: 2400 },
  { file: 'openknowledge-icon', svg: iconSvg, pngWidth: 1024 },
];

mkdirSync(outDir, { recursive: true });

async function main() {
  const zipEntries: Record<string, Uint8Array> = {};

  for (const asset of assets) {
    const svgBytes = new TextEncoder().encode(asset.svg);
    writeFileSync(path.join(outDir, `${asset.file}.svg`), asset.svg);

    // density lifts the SVG rasterization DPI before the resize so the PNG
    // stays crisp at the target width; transparent background is preserved.
    const png = await sharp(Buffer.from(asset.svg), { density: 400 })
      .resize({ width: asset.pngWidth })
      .png()
      .toBuffer();
    writeFileSync(path.join(outDir, `${asset.file}.png`), png);

    zipEntries[`${asset.file}.svg`] = svgBytes;
    zipEntries[`${asset.file}.png`] = new Uint8Array(png);
    console.log(`wrote ${asset.file}.svg + ${asset.file}.png (${png.length} bytes png)`);
  }

  const zip = zipSync(zipEntries, { level: 6 });
  writeFileSync(path.join(outDir, 'openknowledge-brand.zip'), zip);
  console.log(`wrote openknowledge-brand.zip (${zip.length} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
