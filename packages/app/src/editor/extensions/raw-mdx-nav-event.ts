/**
 * RAW_MDX_NAV_EVENT — window CustomEvent for "navigate to broken MDX in source mode".
 *
 * The app-layer RawMdxFallback NodeView (plain DOM) and the PropPanel
 * both dispatch this event; EditorPane + SourceEditor listen for it.
 */

export const RAW_MDX_NAV_EVENT = 'raw-mdx-nav';

export interface RawMdxNavDetail {
  /** Character offset from start of source where the broken region begins. */
  offset: number;
}
