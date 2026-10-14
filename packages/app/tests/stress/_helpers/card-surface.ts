import type { Locator, Page } from '@playwright/test';

export type RgbaBytes = readonly [number, number, number, number];

export type BorderSideName = 'top' | 'right' | 'bottom' | 'left';

export interface BorderSide {
  readonly widthPx: number;
  readonly style: string;
  readonly colorAlpha: number;
}

export interface CardSurface {
  readonly backgroundAlpha: number;
  readonly borders: Readonly<Record<BorderSideName, BorderSide>>;
  readonly borderRadius: string;
  readonly boxShadow: string;
}

export interface ContrastPair {
  readonly foreground: RgbaBytes;
  readonly background: RgbaBytes;
}

export interface ScreenClip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const BORDER_SIDES: readonly BorderSideName[] = ['top', 'right', 'bottom', 'left'];

const OPAQUE = 255;

const ANTIALIAS_MARGIN_PX = 1;

async function rgbaBytesOf(page: Page, colors: readonly string[]): Promise<RgbaBytes[]> {
  return await page.evaluate((list) => {
    const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not create a color conversion context');
    return list.map((color): [number, number, number, number] => {
      context.fillStyle = '#000001';
      context.fillStyle = color;
      const parsed = context.fillStyle;
      context.fillStyle = '#000002';
      context.fillStyle = color;
      if (context.fillStyle !== parsed) {
        throw new Error(`the canvas could not parse the computed color "${color}"`);
      }
      context.clearRect(0, 0, 1, 1);
      context.fillRect(0, 0, 1, 1);
      const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
      return [red, green, blue, alpha];
    });
  }, colors);
}

async function alphaOf(page: Page, color: string): Promise<number> {
  const [bytes] = await rgbaBytesOf(page, [color]);
  if (bytes === undefined) throw new Error(`expected color bytes for "${color}"`);
  return bytes[3] / OPAQUE;
}

export async function readCardSurface(card: Locator): Promise<CardSurface> {
  const computed = await card.evaluate((el) => {
    const style = getComputedStyle(el);
    const border = (side: string) => ({
      widthPx: Number.parseFloat(style.getPropertyValue(`border-${side}-width`)),
      style: style.getPropertyValue(`border-${side}-style`),
      color: style.getPropertyValue(`border-${side}-color`),
    });
    return {
      background: style.backgroundColor,
      borders: {
        top: border('top'),
        right: border('right'),
        bottom: border('bottom'),
        left: border('left'),
      },
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
    };
  });
  const page = card.page();
  const sideOf = async ({ widthPx, style, color }: (typeof computed.borders)['top']) => ({
    widthPx,
    style,
    colorAlpha: await alphaOf(page, color),
  });
  const [backgroundAlpha, top, right, bottom, left] = await Promise.all([
    alphaOf(page, computed.background),
    sideOf(computed.borders.top),
    sideOf(computed.borders.right),
    sideOf(computed.borders.bottom),
    sideOf(computed.borders.left),
  ]);
  return {
    backgroundAlpha,
    borders: { top, right, bottom, left },
    borderRadius: computed.borderRadius,
    boxShadow: computed.boxShadow,
  };
}

export async function readBorderColors(
  card: Locator,
): Promise<Readonly<Record<BorderSideName, RgbaBytes>>> {
  const computed = await card.evaluate((el) => {
    const style = getComputedStyle(el);
    return [
      style.borderTopColor,
      style.borderRightColor,
      style.borderBottomColor,
      style.borderLeftColor,
    ];
  });
  const [top, right, bottom, left] = await rgbaBytesOf(card.page(), computed);
  if (top === undefined || right === undefined || bottom === undefined || left === undefined) {
    throw new Error('expected a border color on every side');
  }
  return { top, right, bottom, left };
}

export async function readRootColor(page: Page, customProperty: string): Promise<RgbaBytes> {
  const value = await page.evaluate(
    (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
    customProperty,
  );
  if (value === '') throw new Error(`the document root defines no ${customProperty}`);
  const [bytes] = await rgbaBytesOf(page, [value]);
  if (bytes === undefined) throw new Error(`expected color bytes for ${customProperty}`);
  return bytes;
}

function blendOver(top: RgbaBytes, bottom: RgbaBytes): RgbaBytes {
  const alpha = top[3] / OPAQUE;
  const channel = (index: 0 | 1 | 2): number => top[index] * alpha + bottom[index] * (1 - alpha);
  return [channel(0), channel(1), channel(2), OPAQUE];
}

export async function readContrastPair(
  foreground: Locator,
  background: Locator,
): Promise<ContrastPair> {
  const backgroundElement = await background.elementHandle();
  if (!backgroundElement) throw new Error('the contrast background locator resolved to no element');
  try {
    const computed = await foreground.evaluate((foregroundElement, backgroundNode) => {
      const layers: string[] = [];
      for (let current: Element | null = backgroundNode; current; current = current.parentElement) {
        layers.push(getComputedStyle(current).backgroundColor);
      }
      return { foreground: getComputedStyle(foregroundElement).color, layers };
    }, backgroundElement);
    const [foregroundColor, ...layers] = await rgbaBytesOf(foreground.page(), [
      computed.foreground,
      ...computed.layers,
    ]);
    if (foregroundColor === undefined) throw new Error('expected the foreground color bytes');
    const opaqueIndex = layers.findIndex((layer) => layer[3] === OPAQUE);
    const base = layers[opaqueIndex];
    if (base === undefined) throw new Error('the contrast background has no opaque ancestor');
    const composite = layers.slice(0, opaqueIndex).reduceRight(blendOver, base);
    return { foreground: foregroundColor, background: composite };
  } finally {
    await backgroundElement.dispose();
  }
}

function linearChannel(channel: number): number {
  const normalized = channel / OPAQUE;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([red, green, blue]: RgbaBytes): number {
  return 0.2126 * linearChannel(red) + 0.7152 * linearChannel(green) + 0.0722 * linearChannel(blue);
}

export function contrastRatioOf({ foreground, background }: ContrastPair): number {
  const text = relativeLuminance(blendOver(foreground, background));
  const surface = relativeLuminance(background);
  return (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05);
}

export async function innerClipsOf(card: Locator): Promise<readonly ScreenClip[]> {
  const geometry = await card.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const largest = (...values: string[]) =>
      Math.max(...values.map((value) => Number.parseFloat(value)));
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      radius: largest(
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ),
      border: largest(
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth,
      ),
    };
  });
  const band = (insetX: number, insetY: number): ScreenClip => {
    const x = Math.ceil(geometry.left + insetX + ANTIALIAS_MARGIN_PX);
    const y = Math.ceil(geometry.top + insetY + ANTIALIAS_MARGIN_PX);
    const right = Math.floor(geometry.right - insetX - ANTIALIAS_MARGIN_PX);
    const bottom = Math.floor(geometry.bottom - insetY - ANTIALIAS_MARGIN_PX);
    if (right <= x || bottom <= y)
      throw new Error('the card is too small to clip inside its corners');
    return { x, y, width: right - x, height: bottom - y };
  };
  return [band(geometry.radius, geometry.border), band(geometry.border, geometry.radius)];
}

export async function countDifferingPixels(
  page: Page,
  first: Buffer,
  second: Buffer,
): Promise<number> {
  if (first.equals(second)) return 0;
  return await page.evaluate(
    async ([firstBase64, secondBase64]) => {
      const decode = async (base64: string): Promise<ImageData> => {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
          colorSpaceConversion: 'none',
          premultiplyAlpha: 'none',
        });
        const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', {
          willReadFrequently: true,
        });
        if (!context) throw new Error('Could not create an image decoding context');
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [a, b] = await Promise.all([decode(firstBase64), decode(secondBase64)]);
      if (a.width !== b.width || a.height !== b.height) return Number.POSITIVE_INFINITY;
      let differing = 0;
      for (let offset = 0; offset < a.data.length; offset += 4) {
        if (
          a.data[offset] !== b.data[offset] ||
          a.data[offset + 1] !== b.data[offset + 1] ||
          a.data[offset + 2] !== b.data[offset + 2] ||
          a.data[offset + 3] !== b.data[offset + 3]
        ) {
          differing += 1;
        }
      }
      return differing;
    },
    [first.toString('base64'), second.toString('base64')] as const,
  );
}
