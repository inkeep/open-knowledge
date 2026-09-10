function rgbToHex(value: string, includeAlpha: boolean): string | null {
  const body = /^rgba?\(([^)]*)\)$/i.exec(value.trim())?.[1];
  if (body === undefined) return null;
  const parts = body.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  let hex = '#';
  for (let i = 0; i < 3; i++) {
    const n = Math.round(Number(parts[i]));
    if (!Number.isFinite(n) || n < 0 || n > 255) return null;
    hex += n.toString(16).padStart(2, '0');
  }
  if (includeAlpha) {
    const alpha = parts[3] === undefined ? 1 : Number(parts[3]);
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
    hex += Math.round(alpha * 255)
      .toString(16)
      .padStart(2, '0');
  }
  return hex;
}

let colorContext: CanvasRenderingContext2D | null = null;
let lastCanvasFailure: string | null = null;

function canvasHex(value: string, includeAlpha: boolean): string | null {
  if (typeof document === 'undefined') return null;
  try {
    if (!colorContext) {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      colorContext = canvas.getContext('2d', { willReadFrequently: true });
    }
    const ctx = colorContext;
    if (!ctx) return null;
    ctx.fillStyle = '#010203';
    ctx.fillStyle = value;
    const firstAccepted = ctx.fillStyle !== '#010203';
    ctx.fillStyle = '#fefdfc';
    ctx.fillStyle = value;
    if (!firstAccepted && ctx.fillStyle === '#fefdfc') return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const channels = ctx.getImageData(0, 0, 1, 1).data.slice(0, includeAlpha ? 4 : 3);
    lastCanvasFailure = null;
    return `#${Array.from(channels, (channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  } catch (error) {
    colorContext = null;
    const message = error instanceof Error ? error.message : String(error);
    if (lastCanvasFailure !== message) {
      lastCanvasFailure = message;
      console.warn(
        JSON.stringify({
          event: 'css-color-to-hex-canvas-failed',
          error: message,
          value,
        }),
      );
    }
    return null;
  }
}

export function cssColorToHex(value: string, options: { alpha?: boolean } = {}): string | null {
  const includeAlpha = options.alpha ?? false;
  return rgbToHex(value, includeAlpha) ?? canvasHex(value, includeAlpha);
}
