
export interface AssetClickContext {
  readonly url: string;
  readonly projectRelPath: string;
  readonly ext: string;
  readonly title: string;
  readonly forceOsDelegation: boolean;
}

export interface AssetViewer {
  readonly exts: readonly string[];
  render(ctx: AssetClickContext): void;
}

export type AssetViewerLookupResult =
  | { readonly ok: true; readonly viewer: AssetViewer }
  | { readonly ok: false };
