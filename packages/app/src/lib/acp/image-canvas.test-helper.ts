import { vi } from 'vitest';

export interface EncodedCanvas {
  readonly imageVisible: boolean;
  readonly transparentAreaColor: string;
}

export function stubImageCanvas(
  options: {
    readonly width?: number;
    readonly height?: number;
    readonly bytesPerPixel?: number;
    readonly encodes?: (type: string) => string;
  } = {},
): {
  readonly close: ReturnType<typeof vi.fn>;
  readonly encodedCanvas: (blob: Blob) => EncodedCanvas | undefined;
} {
  const close = vi.fn();
  const bytesPerPixel = options.bytesPerPixel ?? 0.05;
  const encodes = options.encodes ?? ((type: string) => type);
  const encodedCanvases = new WeakMap<Blob, EncodedCanvas>();
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: options.width ?? 3000, height: options.height ?? 2000, close })),
  );
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      readonly width: number;
      readonly height: number;
      image: 'none' | 'drawn' | 'covered' = 'none';
      transparentArea = 'transparent';
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        const context = {
          globalCompositeOperation: 'source-over',
          fillStyle: '#000000',
          drawImage: () => {
            this.image = 'drawn';
          },
          fillRect: () => {
            if (context.globalCompositeOperation === 'destination-over') {
              if (this.transparentArea === 'transparent') this.transparentArea = context.fillStyle;
              return;
            }
            if (this.image === 'drawn') this.image = 'covered';
            this.transparentArea = context.fillStyle;
          },
        };
        return context;
      }
      async convertToBlob({ type }: { type: string }) {
        const encoded = encodes(type);
        const blob = new Blob(
          [new Uint8Array(Math.round(this.width * this.height * bytesPerPixel))],
          { type: encoded },
        );
        encodedCanvases.set(blob, {
          imageVisible: this.image === 'drawn',
          transparentAreaColor:
            encoded === 'image/jpeg' && this.transparentArea === 'transparent'
              ? '#000000'
              : this.transparentArea,
        });
        return blob;
      }
    },
  );
  return { close, encodedCanvas: (blob) => encodedCanvases.get(blob) };
}
